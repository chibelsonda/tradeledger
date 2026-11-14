create table public.retainage_releases (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    payment_request_id uuid not null references public.payment_requests(id) on delete restrict,
    project_id uuid not null references public.projects(id) on delete restrict,
    subcontractor_id uuid not null references public.subcontractors(id) on delete restrict,
    payout_account_id uuid references public.subcontractor_payout_accounts(id) on delete restrict,
    requested_by uuid not null references auth.users(id) on delete restrict,
    approved_by uuid references auth.users(id) on delete restrict,
    reference uuid not null default gen_random_uuid() unique,
    reason text not null,
    amount bigint not null,
    currency varchar(3) not null,
    status text not null default 'requested',
    platform_fee_basis_points integer not null default 0,
    platform_fee_fixed_amount bigint not null default 0,
    platform_fee_amount bigint not null default 0,
    platform_fee_configured_at timestamptz,
    amount_refunded bigint not null default 0,
    requested_at timestamptz not null default now(),
    approved_at timestamptz,
    checkout_started_at timestamptz,
    paid_at timestamptz,
    failed_at timestamptz,
    canceled_at timestamptz,
    refunded_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (id, organization_id),
    foreign key (payment_request_id, organization_id)
        references public.payment_requests(id, organization_id) on delete restrict,
    foreign key (project_id, organization_id)
        references public.projects(id, organization_id) on delete restrict,
    foreign key (subcontractor_id, organization_id)
        references public.subcontractors(id, organization_id) on delete restrict,
    foreign key (payout_account_id, organization_id)
        references public.subcontractor_payout_accounts(id, organization_id) on delete restrict,
    constraint retainage_releases_positive_amount check (amount > 0),
    constraint retainage_releases_currency_format check (currency ~ '^[a-z]{3}$'),
    constraint retainage_releases_reason_length check (
        char_length(btrim(reason)) between 3 and 500
    ),
    constraint retainage_releases_status check (
        status in (
            'requested', 'approved', 'checkout_created', 'processing', 'paid',
            'failed', 'canceled', 'partially_refunded', 'refunded'
        )
    ),
    constraint retainage_releases_approval_fields check (
        status = 'requested'
        or status = 'canceled'
        or (approved_by is not null and approved_at is not null)
    ),
    constraint retainage_releases_platform_fee_basis_points_range check (
        platform_fee_basis_points between 0 and 9900
    ),
    constraint retainage_releases_platform_fee_fixed_amount_range check (
        platform_fee_fixed_amount between 0 and 99999999
    ),
    constraint retainage_releases_platform_fee_amount_range check (
        platform_fee_amount >= 0 and platform_fee_amount < amount
    ),
    constraint retainage_releases_refund_range check (
        amount_refunded between 0 and amount
    )
);

comment on table public.retainage_releases is
    'Tenant-scoped releases against the immutable retainage amount of a settled payment request.';

create index retainage_releases_organization_status_index
    on public.retainage_releases (organization_id, status, created_at desc);
create index retainage_releases_request_index
    on public.retainage_releases (payment_request_id, created_at desc);
create index retainage_releases_subcontractor_index
    on public.retainage_releases (organization_id, subcontractor_id, created_at desc);

create trigger retainage_releases_set_updated_at
before update on public.retainage_releases
for each row execute function public.set_updated_at();

alter table public.retainage_releases enable row level security;

create policy "Financial roles can read retainage releases"
    on public.retainage_releases
    for select
    to authenticated
    using (
        public.has_organization_role(
            organization_id,
            array['owner', 'admin', 'accountant']
        )
    );

revoke all on table public.retainage_releases from public, anon, authenticated;
grant select on table public.retainage_releases to authenticated;
grant select, insert, update on table public.retainage_releases to service_role;

alter table public.payments
    add column retainage_release_id uuid;

alter table public.payments
    add constraint payments_retainage_release_fk
        foreign key (retainage_release_id, organization_id)
        references public.retainage_releases(id, organization_id) on delete restrict,
    add constraint payments_retainage_release_destination_check check (
        retainage_release_id is null or destination_charge
    );

drop index if exists public.payments_payment_request_unique;
create unique index payments_payment_request_unique
    on public.payments (payment_request_id)
    where payment_request_id is not null and retainage_release_id is null;
create unique index payments_retainage_release_unique
    on public.payments (retainage_release_id)
    where retainage_release_id is not null;

alter table public.payment_refunds
    add column retainage_release_id uuid;

alter table public.payment_refunds
    add constraint payment_refunds_retainage_release_fk
        foreign key (retainage_release_id, organization_id)
        references public.retainage_releases(id, organization_id) on delete restrict;

create index payment_refunds_retainage_release_index
    on public.payment_refunds (retainage_release_id, created_at desc)
    where retainage_release_id is not null;

alter table public.payment_transfers
    add column retainage_release_id uuid;

alter table public.payment_transfers
    add constraint payment_transfers_retainage_release_fk
        foreign key (retainage_release_id, organization_id)
        references public.retainage_releases(id, organization_id) on delete restrict;

create index payment_transfers_retainage_release_index
    on public.payment_transfers (retainage_release_id)
    where retainage_release_id is not null;

create function public.sync_payment_transfer_retainage_release()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    select payment.retainage_release_id
    into new.retainage_release_id
    from public.payments as payment
    where payment.id = new.payment_id
      and payment.organization_id = new.organization_id;

    return new;
end;
$$;

create trigger payment_transfers_sync_retainage_release
before insert on public.payment_transfers
for each row execute function public.sync_payment_transfer_retainage_release();

create function public.create_retainage_release(
    p_payment_request_id uuid,
    p_amount bigint,
    p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_user_id uuid := auth.uid();
    request_record public.payment_requests%rowtype;
    committed_amount bigint;
    release_id uuid;
begin
    if current_user_id is null then
        raise exception 'Authentication is required.' using errcode = '28000';
    end if;

    select * into request_record
    from public.payment_requests as payment_request
    where payment_request.id = p_payment_request_id
    for update;

    if not found then
        raise exception 'Payment request was not found.' using errcode = 'P0002';
    end if;

    if not public.has_organization_role(
        request_record.organization_id,
        array['owner', 'admin', 'accountant']
    ) then
        raise exception 'You are not allowed to request a retainage release.'
            using errcode = '42501';
    end if;

    if request_record.status <> 'paid' or request_record.retainage_amount <= 0 then
        raise exception 'Retainage can be released only from a settled request with a retained balance.'
            using errcode = '55000';
    end if;

    if p_amount is null or p_amount <= 0 then
        raise exception 'Release amount must be greater than zero.' using errcode = '22023';
    end if;

    if char_length(btrim(coalesce(p_reason, ''))) not between 3 and 500 then
        raise exception 'Release reason must be between 3 and 500 characters.'
            using errcode = '22023';
    end if;

    select coalesce(sum(release.amount - release.amount_refunded), 0)
    into committed_amount
    from public.retainage_releases as release
    where release.payment_request_id = p_payment_request_id
      and release.status <> 'canceled';

    if p_amount > request_record.retainage_amount - committed_amount then
        raise exception 'Release amount exceeds the remaining retainage balance.'
            using errcode = '22023';
    end if;

    insert into public.retainage_releases (
        organization_id,
        payment_request_id,
        project_id,
        subcontractor_id,
        requested_by,
        reason,
        amount,
        currency
    ) values (
        request_record.organization_id,
        request_record.id,
        request_record.project_id,
        request_record.subcontractor_id,
        current_user_id,
        btrim(p_reason),
        p_amount,
        request_record.currency
    ) returning id into release_id;

    insert into public.audit_events (
        organization_id, actor_user_id, action, entity_type, entity_id, metadata
    ) values (
        request_record.organization_id,
        current_user_id,
        'retainage_release.requested',
        'retainage_release',
        release_id,
        jsonb_build_object(
            'payment_request_id', request_record.id,
            'amount', p_amount,
            'currency', request_record.currency
        )
    );

    return release_id;
end;
$$;

revoke all on function public.create_retainage_release(uuid, bigint, text)
    from public, anon;
grant execute on function public.create_retainage_release(uuid, bigint, text)
    to authenticated;

create function public.approve_retainage_release(p_retainage_release_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_user_id uuid := auth.uid();
    release_record public.retainage_releases%rowtype;
begin
    select * into release_record
    from public.retainage_releases as release
    where release.id = p_retainage_release_id
    for update;

    if not found
       or not public.has_organization_role(
           release_record.organization_id,
           array['owner', 'accountant']
       ) then
        return false;
    end if;

    if release_record.status <> 'requested' then
        return false;
    end if;

    update public.retainage_releases
    set status = 'approved', approved_by = current_user_id, approved_at = now()
    where id = release_record.id;

    insert into public.audit_events (
        organization_id, actor_user_id, action, entity_type, entity_id, metadata
    ) values (
        release_record.organization_id,
        current_user_id,
        'retainage_release.approved',
        'retainage_release',
        release_record.id,
        jsonb_build_object('amount', release_record.amount, 'currency', release_record.currency)
    );

    return true;
end;
$$;

revoke all on function public.approve_retainage_release(uuid) from public, anon;
grant execute on function public.approve_retainage_release(uuid) to authenticated;

create function public.cancel_retainage_release(p_retainage_release_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_user_id uuid := auth.uid();
    release_record public.retainage_releases%rowtype;
begin
    select * into release_record
    from public.retainage_releases as release
    where release.id = p_retainage_release_id
    for update;

    if not found
       or not public.has_organization_role(
           release_record.organization_id,
           array['owner', 'admin', 'accountant']
       ) then
        return false;
    end if;

    if release_record.status not in ('requested', 'approved', 'failed') then
        return false;
    end if;

    update public.retainage_releases
    set status = 'canceled', canceled_at = now()
    where id = release_record.id;

    insert into public.audit_events (
        organization_id, actor_user_id, action, entity_type, entity_id, metadata
    ) values (
        release_record.organization_id,
        current_user_id,
        'retainage_release.canceled',
        'retainage_release',
        release_record.id,
        jsonb_build_object('previous_status', release_record.status)
    );

    return true;
end;
$$;

revoke all on function public.cancel_retainage_release(uuid) from public, anon;
grant execute on function public.cancel_retainage_release(uuid) to authenticated;

create function public.prepare_retainage_release_checkout(
    p_retainage_release_id uuid,
    p_user_id uuid,
    p_payment_reference uuid
)
returns table (
    retainage_release_id uuid,
    release_reference uuid,
    payment_reference uuid,
    organization_id uuid,
    payment_request_id uuid,
    project_name text,
    subcontractor_name text,
    release_reason text,
    amount_total bigint,
    currency text,
    customer_email text,
    stripe_checkout_session_id text,
    stripe_destination_account_id text,
    platform_fee_amount bigint,
    subcontractor_transfer_amount bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    release_record public.retainage_releases%rowtype;
    request_record public.payment_requests%rowtype;
    payout_record public.subcontractor_payout_accounts%rowtype;
    existing_payment public.payments%rowtype;
    fee_record public.organization_platform_fees%rowtype;
    payer_email text;
    project_name_value text;
    subcontractor_name_value text;
    calculated_fee bigint := 0;
    snapshot_basis_points integer := 0;
    snapshot_fixed_amount bigint := 0;
begin
    if p_user_id is null then
        raise exception 'Authentication is required.' using errcode = '28000';
    end if;

    select * into release_record
    from public.retainage_releases as release
    where release.id = p_retainage_release_id
    for update;

    if not found then
        raise exception 'Retainage release was not found.' using errcode = 'P0002';
    end if;

    if not exists (
        select 1 from public.organization_memberships as membership
        where membership.organization_id = release_record.organization_id
          and membership.user_id = p_user_id
          and membership.status = 'active'
          and membership.role in ('owner', 'admin', 'accountant')
    ) then
        raise exception 'You are not allowed to start this retainage checkout.'
            using errcode = '42501';
    end if;

    if release_record.status not in ('approved', 'failed', 'checkout_created') then
        raise exception 'Only an approved retainage release can start checkout.'
            using errcode = '55000';
    end if;

    select * into request_record
    from public.payment_requests
    where id = release_record.payment_request_id;

    if request_record.status <> 'paid' then
        raise exception 'The source payment request is no longer settled.'
            using errcode = '55000';
    end if;

    select * into payout_record
    from public.subcontractor_payout_accounts as payout_account
    where payout_account.organization_id = release_record.organization_id
      and payout_account.subcontractor_id = release_record.subcontractor_id
    for update;

    if payout_record.id is null
       or payout_record.stripe_account_id is null
       or payout_record.onboarding_status <> 'ready'
       or not payout_record.payouts_enabled then
        raise exception 'The subcontractor must be payout-ready before releasing retainage.'
            using errcode = '55000';
    end if;

    select * into existing_payment
    from public.payments as payment
    where payment.retainage_release_id = release_record.id
    for update;

    if existing_payment.id is null or release_record.platform_fee_configured_at is null then
        select * into fee_record
        from public.organization_platform_fees as fee
        where fee.organization_id = release_record.organization_id
          and fee.currency = release_record.currency;

        if fee_record.enabled then
            snapshot_basis_points := fee_record.percentage_basis_points;
            snapshot_fixed_amount := fee_record.fixed_amount;
            calculated_fee := floor(
                (release_record.amount::numeric * snapshot_basis_points + 5000) / 10000
            )::bigint + snapshot_fixed_amount;
        end if;

        if calculated_fee >= release_record.amount then
            raise exception 'Configured platform fee must be lower than the release amount.'
                using errcode = '55000';
        end if;
    else
        snapshot_basis_points := release_record.platform_fee_basis_points;
        snapshot_fixed_amount := release_record.platform_fee_fixed_amount;
        calculated_fee := release_record.platform_fee_amount;
    end if;

    select email into payer_email from auth.users where id = p_user_id;
    select name into project_name_value from public.projects where id = release_record.project_id;
    select company_name into subcontractor_name_value
    from public.subcontractors where id = release_record.subcontractor_id;

    if existing_payment.id is null then
        insert into public.payments (
            user_id, organization_id, payment_request_id, retainage_release_id,
            reference, product_name, unit_amount, quantity, amount_total, currency,
            status, customer_email, destination_charge, platform_fee_basis_points,
            platform_fee_fixed_amount, platform_fee_amount, platform_fee_configured_at
        ) values (
            p_user_id, release_record.organization_id, release_record.payment_request_id,
            release_record.id, p_payment_reference,
            'Retainage release · ' || project_name_value,
            release_record.amount, 1, release_record.amount, release_record.currency,
            'pending', payer_email, true, snapshot_basis_points,
            snapshot_fixed_amount, calculated_fee, now()
        ) returning * into existing_payment;
    elsif release_record.status = 'failed' then
        update public.payments as payment
        set
            user_id = p_user_id,
            reference = case
                when payment.stripe_checkout_session_id is null then payment.reference
                else p_payment_reference
            end,
            status = 'pending',
            stripe_checkout_session_id = null,
            stripe_payment_intent_id = null,
            customer_email = payer_email,
            paid_at = null,
            updated_at = now()
        where payment.id = existing_payment.id
        returning payment.* into existing_payment;
    elsif existing_payment.status not in ('pending', 'processing') then
        raise exception 'This retainage release already has a completed payment.'
            using errcode = '55000';
    end if;

    update public.retainage_releases
    set
        status = 'checkout_created',
        payout_account_id = payout_record.id,
        platform_fee_basis_points = snapshot_basis_points,
        platform_fee_fixed_amount = snapshot_fixed_amount,
        platform_fee_amount = calculated_fee,
        platform_fee_configured_at = coalesce(platform_fee_configured_at, now()),
        checkout_started_at = coalesce(checkout_started_at, now()),
        failed_at = null
    where id = release_record.id;

    if release_record.status in ('approved', 'failed') then
        insert into public.audit_events (
            organization_id, actor_user_id, action, entity_type, entity_id, metadata
        ) values (
            release_record.organization_id,
            p_user_id,
            'retainage_release.checkout_started',
            'retainage_release',
            release_record.id,
            jsonb_build_object(
                'amount', release_record.amount,
                'currency', release_record.currency,
                'platform_fee_amount', calculated_fee
            )
        );
    end if;

    return query select
        release_record.id,
        release_record.reference,
        existing_payment.reference,
        release_record.organization_id,
        release_record.payment_request_id,
        project_name_value,
        subcontractor_name_value,
        release_record.reason,
        release_record.amount,
        release_record.currency::text,
        payer_email,
        existing_payment.stripe_checkout_session_id::text,
        payout_record.stripe_account_id,
        calculated_fee,
        release_record.amount - calculated_fee;
end;
$$;

revoke all on function public.prepare_retainage_release_checkout(uuid, uuid, uuid)
    from public, anon, authenticated;
grant execute on function public.prepare_retainage_release_checkout(uuid, uuid, uuid)
    to service_role;

create function public.attach_retainage_release_checkout_session(
    p_payment_reference uuid,
    p_session_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_session_id !~ '^cs_(test_|live_)?[A-Za-z0-9_]{8,240}$' then
        raise exception 'Invalid Stripe Checkout Session identifier.' using errcode = '22023';
    end if;

    update public.payments as payment
    set stripe_checkout_session_id = p_session_id, status = 'processing', updated_at = now()
    where payment.reference = p_payment_reference
      and payment.retainage_release_id is not null
      and payment.status in ('pending', 'processing')
      and (
          payment.stripe_checkout_session_id is null
          or payment.stripe_checkout_session_id = p_session_id
      );

    return found;
end;
$$;

revoke all on function public.attach_retainage_release_checkout_session(uuid, text)
    from public, anon, authenticated;
grant execute on function public.attach_retainage_release_checkout_session(uuid, text)
    to service_role;

create function public.mark_retainage_release_checkout_failed(
    p_payment_reference uuid,
    p_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    payment_record public.payments%rowtype;
begin
    select * into payment_record
    from public.payments
    where reference = p_payment_reference
      and retainage_release_id is not null
    for update;

    if not found or payment_record.status not in ('pending', 'processing') then
        return false;
    end if;

    update public.payments set status = 'failed', updated_at = now()
    where id = payment_record.id;

    update public.retainage_releases
    set status = 'failed', failed_at = now()
    where id = payment_record.retainage_release_id;

    insert into public.audit_events (
        organization_id, action, entity_type, entity_id, metadata
    ) values (
        payment_record.organization_id,
        'retainage_release.checkout_failed',
        'retainage_release',
        payment_record.retainage_release_id,
        jsonb_build_object('reason', left(coalesce(p_reason, 'checkout_failed'), 120))
    );

    return true;
end;
$$;

revoke all on function public.mark_retainage_release_checkout_failed(uuid, text)
    from public, anon, authenticated;
grant execute on function public.mark_retainage_release_checkout_failed(uuid, text)
    to service_role;

create function public.process_retainage_release_checkout_webhook(
    p_event_id text,
    p_event_type text,
    p_session_id text,
    p_payment_status text,
    p_payment_intent_id text,
    p_release_reference uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    inserted_count integer;
    payment_record public.payments%rowtype;
    release_record public.retainage_releases%rowtype;
    next_status text;
begin
    insert into public.stripe_webhook_events (
        event_id, type, processed_at, created_at, updated_at
    ) values (p_event_id, p_event_type, now(), now(), now())
    on conflict (event_id) do nothing;

    get diagnostics inserted_count = row_count;
    if inserted_count = 0 then return false; end if;

    select payment.* into payment_record
    from public.payments as payment
    join public.retainage_releases as release
      on release.id = payment.retainage_release_id
    where payment.stripe_checkout_session_id = p_session_id
      and release.reference = p_release_reference
    for update of payment;

    if not found then
        raise exception 'Retainage release payment was not found.' using errcode = 'P0002';
    end if;

    select * into release_record
    from public.retainage_releases
    where id = payment_record.retainage_release_id
    for update;

    next_status := case
        when p_payment_status = 'paid' then 'paid'
        when p_event_type in (
            'checkout.session.expired',
            'checkout.session.async_payment_failed'
        ) then 'failed'
        else 'processing'
    end;

    update public.payments
    set
        stripe_payment_intent_id = coalesce(p_payment_intent_id, stripe_payment_intent_id),
        status = case
            when next_status = 'paid' then 'paid'
            when next_status = 'failed' then 'failed'
            else 'processing'
        end,
        paid_at = case when next_status = 'paid' then coalesce(paid_at, now()) else paid_at end,
        updated_at = now()
    where id = payment_record.id;

    update public.retainage_releases
    set
        status = next_status,
        paid_at = case when next_status = 'paid' then coalesce(paid_at, now()) else paid_at end,
        failed_at = case when next_status = 'failed' then now() else null end
    where id = release_record.id;

    if release_record.status <> next_status then
        insert into public.audit_events (
            organization_id, action, entity_type, entity_id, metadata
        ) values (
            release_record.organization_id,
            case
                when next_status = 'paid' then 'retainage_release.paid'
                when next_status = 'failed' then 'retainage_release.checkout_failed'
                else 'retainage_release.processing'
            end,
            'retainage_release',
            release_record.id,
            jsonb_build_object(
                'previous_status', release_record.status,
                'status', next_status,
                'stripe_event_type', p_event_type
            )
        );
    end if;

    return true;
end;
$$;

revoke all on function public.process_retainage_release_checkout_webhook(
    text, text, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.process_retainage_release_checkout_webhook(
    text, text, text, text, text, uuid
) to service_role;

create function public.prepare_retainage_release_refund(
    p_retainage_release_id uuid,
    p_user_id uuid,
    p_reference uuid
)
returns table (
    refund_reference uuid,
    organization_id uuid,
    retainage_release_id uuid,
    payment_request_id uuid,
    payment_reference uuid,
    stripe_payment_intent_id text,
    stripe_refund_id text,
    amount bigint,
    currency text,
    refund_status text,
    refund_application_fee boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    release_record public.retainage_releases%rowtype;
    payment_record public.payments%rowtype;
    refund_record public.payment_refunds%rowtype;
    remaining_amount bigint;
begin
    select * into release_record
    from public.retainage_releases
    where id = p_retainage_release_id
    for update;

    if not found then
        raise exception 'Retainage release was not found.' using errcode = 'P0002';
    end if;

    if not exists (
        select 1 from public.organization_memberships as membership
        where membership.organization_id = release_record.organization_id
          and membership.user_id = p_user_id
          and membership.status = 'active'
          and membership.role in ('owner', 'accountant')
    ) then
        raise exception 'You are not allowed to refund this retainage release.'
            using errcode = '42501';
    end if;

    select payment.* into payment_record
    from public.payments as payment
    where payment.retainage_release_id = release_record.id
    for update;

    if not found
       or payment_record.stripe_payment_intent_id is null
       or payment_record.status not in ('paid', 'partially_refunded') then
        raise exception 'Only a settled retainage release can be refunded.'
            using errcode = '55000';
    end if;

    remaining_amount := payment_record.amount_total - payment_record.amount_refunded;
    if remaining_amount <= 0 then
        raise exception 'This retainage release is already fully refunded.'
            using errcode = '55000';
    end if;

    select * into refund_record
    from public.payment_refunds as refund
    where refund.retainage_release_id = release_record.id
      and refund.status in ('pending', 'requires_action')
    order by refund.created_at desc
    limit 1
    for update;

    if refund_record.id is null then
        insert into public.payment_refunds (
            organization_id, payment_id, payment_request_id, retainage_release_id,
            reference, amount, currency, requested_by
        ) values (
            release_record.organization_id, payment_record.id,
            release_record.payment_request_id, release_record.id,
            p_reference, remaining_amount, release_record.currency, p_user_id
        ) returning * into refund_record;

        insert into public.audit_events (
            organization_id, actor_user_id, action, entity_type, entity_id, metadata
        ) values (
            release_record.organization_id,
            p_user_id,
            'retainage_release.refund_requested',
            'retainage_release',
            release_record.id,
            jsonb_build_object('amount', remaining_amount, 'currency', release_record.currency)
        );
    end if;

    return query select
        refund_record.reference,
        release_record.organization_id,
        release_record.id,
        release_record.payment_request_id,
        payment_record.reference,
        payment_record.stripe_payment_intent_id::text,
        refund_record.stripe_refund_id::text,
        refund_record.amount,
        refund_record.currency::text,
        refund_record.status::text,
        payment_record.platform_fee_amount > 0;
end;
$$;

revoke all on function public.prepare_retainage_release_refund(uuid, uuid, uuid)
    from public, anon, authenticated;
grant execute on function public.prepare_retainage_release_refund(uuid, uuid, uuid)
    to service_role;

create function public.apply_retainage_release_refund_status(
    p_refund_reference uuid,
    p_stripe_refund_id text,
    p_status text,
    p_failure_reason text default null,
    p_actor_user_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    refund_record public.payment_refunds%rowtype;
    release_record public.retainage_releases%rowtype;
    refunded_total bigint;
    next_status text;
begin
    select * into refund_record
    from public.payment_refunds
    where reference = p_refund_reference
      and retainage_release_id is not null
    for update;

    if not found then return false; end if;

    select * into release_record
    from public.retainage_releases
    where id = refund_record.retainage_release_id
    for update;

    update public.payment_refunds
    set
        stripe_refund_id = coalesce(p_stripe_refund_id, stripe_refund_id),
        status = p_status,
        failure_reason = left(p_failure_reason, 500),
        completed_at = case when p_status = 'succeeded' then coalesce(completed_at, now()) else completed_at end,
        updated_at = now()
    where id = refund_record.id;

    select coalesce(sum(amount), 0) into refunded_total
    from public.payment_refunds
    where payment_id = refund_record.payment_id
      and status = 'succeeded';

    if p_status = 'succeeded' then
        next_status := case
            when refunded_total >= release_record.amount then 'refunded'
            else 'partially_refunded'
        end;

        update public.payments
        set
            amount_refunded = least(refunded_total, amount_total),
            status = case
                when refunded_total >= amount_total then 'refunded'
                else 'partially_refunded'
            end,
            refunded_at = now(),
            updated_at = now()
        where id = refund_record.payment_id;

        update public.retainage_releases
        set
            amount_refunded = least(refunded_total, amount),
            status = next_status,
            refunded_at = now()
        where id = release_record.id;

        if release_record.status <> next_status then
            insert into public.audit_events (
                organization_id, actor_user_id, action, entity_type, entity_id, metadata
            ) values (
                release_record.organization_id,
                p_actor_user_id,
                'retainage_release.refunded',
                'retainage_release',
                release_record.id,
                jsonb_build_object(
                    'amount_refunded', least(refunded_total, release_record.amount),
                    'currency', release_record.currency,
                    'status', next_status
                )
            );
        end if;
    end if;

    return true;
end;
$$;

revoke all on function public.apply_retainage_release_refund_status(
    uuid, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.apply_retainage_release_refund_status(
    uuid, text, text, text, uuid
) to service_role;

create function public.process_retainage_release_refund_webhook(
    p_event_id text,
    p_event_type text,
    p_stripe_refund_id text,
    p_refund_reference uuid,
    p_payment_intent_id text,
    p_amount bigint,
    p_currency text,
    p_status text,
    p_failure_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    inserted_count integer;
    refund_record public.payment_refunds%rowtype;
    payment_record public.payments%rowtype;
begin
    insert into public.stripe_webhook_events (
        event_id, type, processed_at, created_at, updated_at
    ) values (p_event_id, p_event_type, now(), now(), now())
    on conflict (event_id) do nothing;

    get diagnostics inserted_count = row_count;
    if inserted_count = 0 then return false; end if;

    select * into refund_record
    from public.payment_refunds
    where retainage_release_id is not null
      and (reference = p_refund_reference or stripe_refund_id = p_stripe_refund_id)
    for update;

    if not found then
        raise exception 'Retainage release refund was not found.' using errcode = 'P0002';
    end if;

    select * into payment_record from public.payments where id = refund_record.payment_id;

    if payment_record.stripe_payment_intent_id <> p_payment_intent_id
       or refund_record.amount <> p_amount
       or refund_record.currency <> lower(p_currency) then
        raise exception 'Retainage refund ownership validation failed.' using errcode = '42501';
    end if;

    return public.apply_retainage_release_refund_status(
        refund_record.reference,
        p_stripe_refund_id,
        p_status,
        p_failure_reason,
        null
    );
end;
$$;

revoke all on function public.process_retainage_release_refund_webhook(
    text, text, text, uuid, text, bigint, text, text, text
) from public, anon, authenticated;
grant execute on function public.process_retainage_release_refund_webhook(
    text, text, text, uuid, text, bigint, text, text, text
) to service_role;
