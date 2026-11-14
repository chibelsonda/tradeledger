alter table public.payments
    add constraint payments_id_organization_unique unique (id, organization_id);
alter table public.payment_requests
    add constraint payment_requests_id_organization_unique unique (id, organization_id);
alter table public.subcontractor_payout_accounts
    add constraint payout_accounts_id_organization_unique unique (id, organization_id);

create table public.payment_transfers (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    payment_id bigint not null references public.payments(id) on delete restrict,
    payment_request_id uuid not null references public.payment_requests(id) on delete restrict,
    subcontractor_id uuid not null references public.subcontractors(id) on delete restrict,
    payout_account_id uuid not null references public.subcontractor_payout_accounts(id) on delete restrict,
    stripe_transfer_id text not null unique,
    amount bigint not null,
    currency varchar(3) not null,
    status text not null,
    reversed_amount bigint not null default 0,
    source_transaction_id text,
    stripe_charge_id text,
    stripe_created_at timestamptz not null,
    last_synced_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    foreign key (payment_id, organization_id)
        references public.payments(id, organization_id) on delete restrict,
    foreign key (payment_request_id, organization_id)
        references public.payment_requests(id, organization_id) on delete restrict,
    foreign key (subcontractor_id, organization_id)
        references public.subcontractors(id, organization_id) on delete restrict,
    foreign key (payout_account_id, organization_id)
        references public.subcontractor_payout_accounts(id, organization_id) on delete restrict,
    constraint payment_transfers_one_per_payment unique (payment_id),
    constraint payment_transfers_positive_amount check (amount > 0),
    constraint payment_transfers_reversal_range check (
        reversed_amount between 0 and amount
    ),
    constraint payment_transfers_currency_format check (currency ~ '^[a-z]{3}$'),
    constraint payment_transfers_status check (
        status in ('pending', 'succeeded', 'partially_reversed', 'reversed', 'failed')
    ),
    constraint payment_transfers_stripe_id check (
        stripe_transfer_id ~ '^tr_[A-Za-z0-9]{8,200}$'
    ),
    constraint payment_transfers_source_id check (
        source_transaction_id is null
        or source_transaction_id ~ '^[A-Za-z]{2,12}_[A-Za-z0-9]{8,200}$'
    ),
    constraint payment_transfers_charge_id check (
        stripe_charge_id is null
        or stripe_charge_id ~ '^ch_[A-Za-z0-9]{8,200}$'
    )
);

create table public.connected_payouts (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    subcontractor_id uuid not null references public.subcontractors(id) on delete restrict,
    payout_account_id uuid not null references public.subcontractor_payout_accounts(id) on delete restrict,
    stripe_payout_id text not null unique,
    amount bigint not null,
    currency varchar(3) not null,
    status text not null,
    expected_arrival_at timestamptz,
    failure_code text,
    failure_message text,
    stripe_created_at timestamptz not null,
    last_synced_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    foreign key (subcontractor_id, organization_id)
        references public.subcontractors(id, organization_id) on delete restrict,
    foreign key (payout_account_id, organization_id)
        references public.subcontractor_payout_accounts(id, organization_id) on delete restrict,
    constraint connected_payouts_positive_amount check (amount > 0),
    constraint connected_payouts_currency_format check (currency ~ '^[a-z]{3}$'),
    constraint connected_payouts_status check (
        status in ('pending', 'in_transit', 'paid', 'failed', 'canceled')
    ),
    constraint connected_payouts_stripe_id check (
        stripe_payout_id ~ '^po_[A-Za-z0-9]{8,200}$'
    ),
    constraint connected_payouts_failure_code_length check (
        failure_code is null or char_length(failure_code) <= 120
    ),
    constraint connected_payouts_failure_message_length check (
        failure_message is null or char_length(failure_message) <= 500
    )
);

create index payment_transfers_organization_created_index
    on public.payment_transfers (organization_id, created_at desc);
create index payment_transfers_subcontractor_status_index
    on public.payment_transfers (organization_id, subcontractor_id, status, created_at desc);
create index payment_transfers_request_index
    on public.payment_transfers (payment_request_id);
create index connected_payouts_organization_created_index
    on public.connected_payouts (organization_id, created_at desc);
create index connected_payouts_subcontractor_status_index
    on public.connected_payouts (organization_id, subcontractor_id, status, created_at desc);
create index connected_payouts_account_created_index
    on public.connected_payouts (payout_account_id, stripe_created_at desc);

create trigger payment_transfers_set_updated_at
before update on public.payment_transfers
for each row execute function public.set_updated_at();

create trigger connected_payouts_set_updated_at
before update on public.connected_payouts
for each row execute function public.set_updated_at();

alter table public.payment_transfers enable row level security;
alter table public.connected_payouts enable row level security;

create policy "Financial roles can read payment transfers"
    on public.payment_transfers
    for select
    to authenticated
    using (
        public.has_organization_role(
            organization_id,
            array['owner', 'admin', 'accountant']
        )
    );

create policy "Financial roles can read connected payouts"
    on public.connected_payouts
    for select
    to authenticated
    using (
        public.has_organization_role(
            organization_id,
            array['owner', 'admin', 'accountant']
        )
    );

create or replace function public.apply_stripe_transfer_ledger_event(
    p_event_id text,
    p_event_type text,
    p_stripe_transfer_id text,
    p_stripe_account_id text,
    p_payment_intent_id text,
    p_amount bigint,
    p_currency text,
    p_status text,
    p_reversed_amount bigint,
    p_source_transaction_id text,
    p_stripe_charge_id text,
    p_stripe_created_at timestamptz,
    p_actor_user_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    payout_record public.subcontractor_payout_accounts%rowtype;
    payment_record public.payments%rowtype;
    request_record public.payment_requests%rowtype;
    transfer_record public.payment_transfers%rowtype;
    inserted_count integer;
    is_new boolean := false;
    next_status text;
    next_reversed_amount bigint;
begin
    if p_event_id is not null then
        insert into public.stripe_webhook_events (
            event_id, type, processed_at, created_at, updated_at
        ) values (
            p_event_id, coalesce(p_event_type, 'transfer.updated'), now(), now(), now()
        ) on conflict (event_id) do nothing;

        get diagnostics inserted_count = row_count;
        if inserted_count = 0 then
            return false;
        end if;
    end if;

    if p_stripe_transfer_id !~ '^tr_[A-Za-z0-9]{8,200}$'
       or p_stripe_account_id !~ '^acct_[A-Za-z0-9]{8,200}$'
       or p_payment_intent_id !~ '^pi_[A-Za-z0-9]{8,200}$'
       or p_amount <= 0
       or lower(p_currency) !~ '^[a-z]{3}$'
       or p_status not in ('pending', 'succeeded', 'partially_reversed', 'reversed', 'failed')
       or p_reversed_amount not between 0 and p_amount
       or p_stripe_created_at is null then
        raise exception 'Invalid Stripe transfer ledger payload.' using errcode = '22023';
    end if;

    select * into payout_record
    from public.subcontractor_payout_accounts as payout_account
    where payout_account.stripe_account_id = p_stripe_account_id
    for update;

    if not found then
        raise exception 'Payout account was not found.' using errcode = 'P0002';
    end if;

    select * into payment_record
    from public.payments as payment
    where payment.stripe_payment_intent_id = p_payment_intent_id
    for update;

    if not found or payment_record.payment_request_id is null then
        raise exception 'Destination-charge payment was not found.' using errcode = 'P0002';
    end if;

    select * into request_record
    from public.payment_requests as payment_request
    where payment_request.id = payment_record.payment_request_id;

    if request_record.organization_id <> payout_record.organization_id
       or request_record.subcontractor_id <> payout_record.subcontractor_id
       or payment_record.organization_id <> payout_record.organization_id
       or not payment_record.destination_charge
       or lower(payment_record.currency) <> lower(p_currency)
       or p_amount > payment_record.amount_total then
        raise exception 'Stripe transfer ownership validation failed.' using errcode = '42501';
    end if;

    select * into transfer_record
    from public.payment_transfers as transfer
    where transfer.stripe_transfer_id = p_stripe_transfer_id
       or transfer.payment_id = payment_record.id
    for update;

    if transfer_record.id is null then
        insert into public.payment_transfers (
            organization_id,
            payment_id,
            payment_request_id,
            subcontractor_id,
            payout_account_id,
            stripe_transfer_id,
            amount,
            currency,
            status,
            reversed_amount,
            source_transaction_id,
            stripe_charge_id,
            stripe_created_at,
            last_synced_at
        ) values (
            payout_record.organization_id,
            payment_record.id,
            payment_record.payment_request_id,
            payout_record.subcontractor_id,
            payout_record.id,
            p_stripe_transfer_id,
            p_amount,
            lower(p_currency),
            p_status,
            p_reversed_amount,
            p_source_transaction_id,
            p_stripe_charge_id,
            p_stripe_created_at,
            now()
        ) returning * into transfer_record;
        is_new := true;

        insert into public.audit_events (
            organization_id, actor_user_id, action, entity_type, entity_id, metadata
        ) values (
            transfer_record.organization_id,
            p_actor_user_id,
            'transfer.discovered',
            'payment_transfer',
            transfer_record.id,
            jsonb_build_object(
                'payment_request_id', transfer_record.payment_request_id,
                'amount', transfer_record.amount,
                'currency', transfer_record.currency,
                'stripe_event_type', p_event_type
            )
        );

        if transfer_record.reversed_amount > 0 then
            insert into public.audit_events (
                organization_id, actor_user_id, action, entity_type, entity_id, metadata
            ) values (
                transfer_record.organization_id,
                p_actor_user_id,
                'transfer.reversed',
                'payment_transfer',
                transfer_record.id,
                jsonb_build_object(
                    'previous_reversed_amount', 0,
                    'reversed_amount', transfer_record.reversed_amount,
                    'currency', transfer_record.currency,
                    'stripe_event_type', p_event_type
                )
            );
        end if;
    else
        if transfer_record.organization_id <> payout_record.organization_id
           or transfer_record.payment_id <> payment_record.id
           or transfer_record.payout_account_id <> payout_record.id
           or transfer_record.amount <> p_amount
           or transfer_record.currency <> lower(p_currency) then
            raise exception 'Stripe transfer relationship cannot be changed.' using errcode = '42501';
        end if;

        next_reversed_amount := greatest(
            transfer_record.reversed_amount,
            p_reversed_amount
        );
        next_status := case
            when next_reversed_amount >= transfer_record.amount then 'reversed'
            when next_reversed_amount > 0 then 'partially_reversed'
            when transfer_record.status = 'succeeded' and p_status = 'pending'
                then transfer_record.status
            else p_status
        end;

        update public.payment_transfers
        set
            status = next_status,
            reversed_amount = next_reversed_amount,
            source_transaction_id = coalesce(p_source_transaction_id, source_transaction_id),
            stripe_charge_id = coalesce(p_stripe_charge_id, stripe_charge_id),
            stripe_created_at = p_stripe_created_at,
            last_synced_at = now()
        where id = transfer_record.id;
    end if;

    if not is_new and transfer_record.status <> next_status then
        insert into public.audit_events (
            organization_id, actor_user_id, action, entity_type, entity_id, metadata
        ) values (
            transfer_record.organization_id,
            p_actor_user_id,
            'transfer.status_changed',
            'payment_transfer',
            transfer_record.id,
            jsonb_build_object(
                'previous_status', transfer_record.status,
                'status', next_status,
                'stripe_event_type', p_event_type
            )
        );
    end if;

    if not is_new
       and next_reversed_amount > coalesce(transfer_record.reversed_amount, 0) then
        insert into public.audit_events (
            organization_id, actor_user_id, action, entity_type, entity_id, metadata
        ) values (
            transfer_record.organization_id,
            p_actor_user_id,
            'transfer.reversed',
            'payment_transfer',
            transfer_record.id,
            jsonb_build_object(
                'previous_reversed_amount', coalesce(transfer_record.reversed_amount, 0),
                'reversed_amount', next_reversed_amount,
                'currency', lower(p_currency),
                'stripe_event_type', p_event_type
            )
        );
    end if;

    return true;
end;
$$;

create or replace function public.apply_stripe_payout_ledger_event(
    p_event_id text,
    p_event_type text,
    p_stripe_account_id text,
    p_stripe_payout_id text,
    p_amount bigint,
    p_currency text,
    p_status text,
    p_expected_arrival_at timestamptz,
    p_failure_code text,
    p_failure_message text,
    p_stripe_created_at timestamptz,
    p_actor_user_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    payout_account_record public.subcontractor_payout_accounts%rowtype;
    payout_record public.connected_payouts%rowtype;
    inserted_count integer;
    is_new boolean := false;
begin
    if p_event_id is not null then
        insert into public.stripe_webhook_events (
            event_id, type, processed_at, created_at, updated_at
        ) values (
            p_event_id, coalesce(p_event_type, 'payout.updated'), now(), now(), now()
        ) on conflict (event_id) do nothing;

        get diagnostics inserted_count = row_count;
        if inserted_count = 0 then
            return false;
        end if;
    end if;

    if p_stripe_account_id !~ '^acct_[A-Za-z0-9]{8,200}$'
       or p_stripe_payout_id !~ '^po_[A-Za-z0-9]{8,200}$'
       or p_amount <= 0
       or lower(p_currency) !~ '^[a-z]{3}$'
       or p_status not in ('pending', 'in_transit', 'paid', 'failed', 'canceled')
       or p_stripe_created_at is null then
        raise exception 'Invalid Stripe payout ledger payload.' using errcode = '22023';
    end if;

    select * into payout_account_record
    from public.subcontractor_payout_accounts as payout_account
    where payout_account.stripe_account_id = p_stripe_account_id
    for update;

    if not found then
        raise exception 'Payout account was not found.' using errcode = 'P0002';
    end if;

    select * into payout_record
    from public.connected_payouts as payout
    where payout.stripe_payout_id = p_stripe_payout_id
    for update;

    if payout_record.id is null then
        insert into public.connected_payouts (
            organization_id,
            subcontractor_id,
            payout_account_id,
            stripe_payout_id,
            amount,
            currency,
            status,
            expected_arrival_at,
            failure_code,
            failure_message,
            stripe_created_at,
            last_synced_at
        ) values (
            payout_account_record.organization_id,
            payout_account_record.subcontractor_id,
            payout_account_record.id,
            p_stripe_payout_id,
            p_amount,
            lower(p_currency),
            p_status,
            p_expected_arrival_at,
            nullif(left(p_failure_code, 120), ''),
            nullif(left(p_failure_message, 500), ''),
            p_stripe_created_at,
            now()
        ) returning * into payout_record;
        is_new := true;

        insert into public.audit_events (
            organization_id, actor_user_id, action, entity_type, entity_id, metadata
        ) values (
            payout_record.organization_id,
            p_actor_user_id,
            'payout.discovered',
            'connected_payout',
            payout_record.id,
            jsonb_build_object(
                'amount', payout_record.amount,
                'currency', payout_record.currency,
                'status', payout_record.status,
                'stripe_event_type', p_event_type
            )
        );
    else
        if payout_record.payout_account_id <> payout_account_record.id
           or payout_record.organization_id <> payout_account_record.organization_id
           or payout_record.amount <> p_amount
           or payout_record.currency <> lower(p_currency) then
            raise exception 'Stripe payout relationship cannot be changed.' using errcode = '42501';
        end if;

        if payout_record.status in ('paid', 'failed', 'canceled')
           and payout_record.status <> p_status then
            update public.connected_payouts
            set last_synced_at = now()
            where id = payout_record.id;
            return true;
        end if;

        update public.connected_payouts
        set
            status = p_status,
            expected_arrival_at = p_expected_arrival_at,
            failure_code = nullif(left(p_failure_code, 120), ''),
            failure_message = nullif(left(p_failure_message, 500), ''),
            stripe_created_at = p_stripe_created_at,
            last_synced_at = now()
        where id = payout_record.id;
    end if;

    if (is_new or payout_record.status <> p_status)
       and p_status in ('paid', 'failed', 'canceled') then
        insert into public.audit_events (
            organization_id, actor_user_id, action, entity_type, entity_id, metadata
        ) values (
            payout_record.organization_id,
            p_actor_user_id,
            'payout.' || p_status,
            'connected_payout',
            payout_record.id,
            jsonb_build_object(
                'previous_status', case when is_new then null else payout_record.status end,
                'status', p_status,
                'failure_code', nullif(left(p_failure_code, 120), ''),
                'stripe_event_type', p_event_type
            )
        );
    end if;

    return true;
end;
$$;

create or replace function public.prepare_payout_reconciliation(
    p_organization_id uuid,
    p_user_id uuid,
    p_target_type text default 'organization',
    p_target_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    target_entity_id uuid;
    prepared jsonb;
begin
    if p_user_id is null then
        raise exception 'Authentication is required.' using errcode = '28000';
    end if;

    if p_target_type not in ('organization', 'subcontractor', 'payment', 'payout') then
        raise exception 'A valid reconciliation target is required.' using errcode = '22023';
    end if;

    if not exists (
        select 1
        from public.organization_memberships as membership
        where membership.organization_id = p_organization_id
          and membership.user_id = p_user_id
          and membership.status = 'active'
          and membership.role in ('owner', 'admin', 'accountant')
    ) then
        raise exception 'You are not allowed to reconcile this payout ledger.'
            using errcode = '42501';
    end if;

    if p_target_type = 'organization' then
        if p_target_id is not null and p_target_id <> p_organization_id then
            raise exception 'Reconciliation target was not found.' using errcode = 'P0002';
        end if;
        target_entity_id := p_organization_id;
    elsif p_target_type = 'subcontractor' then
        select subcontractor.id into target_entity_id
        from public.subcontractors as subcontractor
        where subcontractor.id = p_target_id
          and subcontractor.organization_id = p_organization_id;
    elsif p_target_type = 'payment' then
        select payment_request.id into target_entity_id
        from public.payment_requests as payment_request
        where payment_request.id = p_target_id
          and payment_request.organization_id = p_organization_id;
    else
        select payout.id into target_entity_id
        from public.connected_payouts as payout
        where payout.id = p_target_id
          and payout.organization_id = p_organization_id;
    end if;

    if target_entity_id is null then
        raise exception 'Reconciliation target was not found.' using errcode = 'P0002';
    end if;

    select jsonb_build_object(
        'organization_id', p_organization_id,
        'target_type', p_target_type,
        'target_id', target_entity_id,
        'accounts', coalesce((
            select jsonb_agg(jsonb_build_object(
                'payout_account_id', payout_account.id,
                'subcontractor_id', payout_account.subcontractor_id,
                'stripe_account_id', payout_account.stripe_account_id,
                'stripe_payout_id', case
                    when p_target_type = 'payout' then target_payout.stripe_payout_id
                    else null
                end
            ) order by payout_account.id)
            from public.subcontractor_payout_accounts as payout_account
            left join public.connected_payouts as target_payout
              on target_payout.payout_account_id = payout_account.id
             and target_payout.id = case when p_target_type = 'payout' then p_target_id else null end
            where payout_account.organization_id = p_organization_id
              and payout_account.stripe_account_id is not null
              and (
                  p_target_type = 'organization'
                  or (p_target_type = 'subcontractor' and payout_account.subcontractor_id = p_target_id)
                  or (p_target_type = 'payment' and exists (
                      select 1 from public.payment_requests as request
                      where request.id = p_target_id
                        and request.subcontractor_id = payout_account.subcontractor_id
                  ))
                  or (p_target_type = 'payout' and target_payout.id is not null)
              )
        ), '[]'::jsonb),
        'payment_intent_ids', coalesce((
            select jsonb_agg(payment.stripe_payment_intent_id order by payment.id)
            from public.payments as payment
            join public.payment_requests as request
              on request.id = payment.payment_request_id
             and request.organization_id = payment.organization_id
            where payment.organization_id = p_organization_id
              and payment.destination_charge
              and payment.stripe_payment_intent_id is not null
              and (
                  p_target_type = 'organization'
                  or (p_target_type = 'subcontractor' and request.subcontractor_id = p_target_id)
                  or (p_target_type = 'payment' and request.id = p_target_id)
              )
            limit 100
        ), '[]'::jsonb),
        'transfer_ids', coalesce((
            select jsonb_agg(transfer.stripe_transfer_id order by transfer.id)
            from public.payment_transfers as transfer
            where transfer.organization_id = p_organization_id
              and (
                  p_target_type = 'organization'
                  or (p_target_type = 'subcontractor' and transfer.subcontractor_id = p_target_id)
                  or (p_target_type = 'payment' and transfer.payment_request_id = p_target_id)
              )
            limit 100
        ), '[]'::jsonb)
    ) into prepared;

    insert into public.audit_events (
        organization_id, actor_user_id, action, entity_type, entity_id, metadata
    ) values (
        p_organization_id,
        p_user_id,
        'payout_reconciliation.requested',
        p_target_type,
        target_entity_id,
        jsonb_build_object('target_type', p_target_type)
    );

    return prepared;
end;
$$;

create or replace function public.record_payout_reconciliation_result(
    p_organization_id uuid,
    p_user_id uuid,
    p_target_type text,
    p_target_id uuid,
    p_succeeded boolean,
    p_transfer_count integer default 0,
    p_payout_count integer default 0,
    p_failure_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
    if not exists (
        select 1
        from public.organization_memberships as membership
        where membership.organization_id = p_organization_id
          and membership.user_id = p_user_id
          and membership.status = 'active'
          and membership.role in ('owner', 'admin', 'accountant')
    ) then
        raise exception 'You are not allowed to reconcile this payout ledger.'
            using errcode = '42501';
    end if;

    insert into public.audit_events (
        organization_id, actor_user_id, action, entity_type, entity_id, metadata
    ) values (
        p_organization_id,
        p_user_id,
        case
            when p_succeeded then 'payout_reconciliation.completed'
            else 'payout_reconciliation.failed'
        end,
        p_target_type,
        p_target_id,
        jsonb_build_object(
            'transfer_count', greatest(coalesce(p_transfer_count, 0), 0),
            'payout_count', greatest(coalesce(p_payout_count, 0), 0),
            'failure_code', nullif(left(p_failure_code, 120), '')
        )
    );

    return true;
end;
$$;

create or replace function public.record_stripe_webhook_failure(
    p_event_id text,
    p_event_type text,
    p_object_id text,
    p_error_code text,
    p_error_message text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    tenant_id uuid;
begin
    select payment.organization_id into tenant_id
    from public.payments as payment
    where payment.stripe_checkout_session_id = p_object_id
       or payment.stripe_payment_intent_id = p_object_id
    limit 1;

    if tenant_id is null then
        select refund.organization_id into tenant_id
        from public.payment_refunds as refund
        where refund.stripe_refund_id = p_object_id
        limit 1;
    end if;

    if tenant_id is null then
        select transfer.organization_id into tenant_id
        from public.payment_transfers as transfer
        where transfer.stripe_transfer_id = p_object_id
        limit 1;
    end if;

    if tenant_id is null then
        select payout.organization_id into tenant_id
        from public.connected_payouts as payout
        where payout.stripe_payout_id = p_object_id
        limit 1;
    end if;

    insert into public.stripe_webhook_failures (
        organization_id, event_id, event_type, object_id, error_code, error_message
    ) values (
        tenant_id,
        p_event_id,
        p_event_type,
        p_object_id,
        nullif(left(p_error_code, 120), ''),
        left(coalesce(nullif(p_error_message, ''), 'Unknown processing error.'), 1000)
    )
    on conflict (event_id) do update
    set
        organization_id = coalesce(
            public.stripe_webhook_failures.organization_id,
            excluded.organization_id
        ),
        object_id = coalesce(excluded.object_id, public.stripe_webhook_failures.object_id),
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        attempts = public.stripe_webhook_failures.attempts + 1,
        last_failed_at = now(),
        resolved_at = null,
        resolution = null;

    return true;
end;
$$;

revoke all on table public.payment_transfers from public, anon, authenticated;
revoke all on table public.connected_payouts from public, anon, authenticated;

grant select (
    id,
    organization_id,
    payment_id,
    payment_request_id,
    subcontractor_id,
    payout_account_id,
    stripe_transfer_id,
    amount,
    currency,
    status,
    reversed_amount,
    source_transaction_id,
    stripe_charge_id,
    stripe_created_at,
    last_synced_at,
    created_at,
    updated_at
) on public.payment_transfers to authenticated;

grant select (
    id,
    organization_id,
    subcontractor_id,
    payout_account_id,
    stripe_payout_id,
    amount,
    currency,
    status,
    expected_arrival_at,
    failure_code,
    failure_message,
    stripe_created_at,
    last_synced_at,
    created_at,
    updated_at
) on public.connected_payouts to authenticated;

grant all on public.payment_transfers to service_role;
grant all on public.connected_payouts to service_role;

revoke all on function public.apply_stripe_transfer_ledger_event(
    text, text, text, text, text, bigint, text, text, bigint, text, text, timestamptz, uuid
) from public, anon, authenticated;
revoke all on function public.apply_stripe_payout_ledger_event(
    text, text, text, text, bigint, text, text, timestamptz, text, text, timestamptz, uuid
) from public, anon, authenticated;
revoke all on function public.prepare_payout_reconciliation(uuid, uuid, text, uuid)
    from public, anon, authenticated;
revoke all on function public.record_payout_reconciliation_result(
    uuid, uuid, text, uuid, boolean, integer, integer, text
) from public, anon, authenticated;

grant execute on function public.apply_stripe_transfer_ledger_event(
    text, text, text, text, text, bigint, text, text, bigint, text, text, timestamptz, uuid
) to service_role;
grant execute on function public.apply_stripe_payout_ledger_event(
    text, text, text, text, bigint, text, text, timestamptz, text, text, timestamptz, uuid
) to service_role;
grant execute on function public.prepare_payout_reconciliation(uuid, uuid, text, uuid)
    to service_role;
grant execute on function public.record_payout_reconciliation_result(
    uuid, uuid, text, uuid, boolean, integer, integer, text
) to service_role;
