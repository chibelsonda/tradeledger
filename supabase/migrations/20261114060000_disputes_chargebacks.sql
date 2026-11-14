create table public.payment_disputes (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    payment_id bigint not null references public.payments(id) on delete restrict,
    payment_request_id uuid not null references public.payment_requests(id) on delete restrict,
    retainage_release_id uuid references public.retainage_releases(id) on delete restrict,
    payment_transfer_id uuid references public.payment_transfers(id) on delete restrict,
    stripe_dispute_id text not null unique,
    stripe_charge_id text not null,
    stripe_payment_intent_id text not null,
    amount bigint not null,
    currency varchar(3) not null,
    reason text not null,
    status text not null,
    livemode boolean not null default false,
    evidence_due_at timestamptz,
    has_evidence boolean not null default false,
    evidence_past_due boolean not null default false,
    evidence_submission_count integer not null default 0,
    evidence_product_description text,
    evidence_service_date date,
    evidence_customer_email text,
    evidence_uncategorized_text text,
    evidence_saved_at timestamptz,
    evidence_submitted_at timestamptz,
    funds_withdrawn_at timestamptz,
    funds_reinstated_at timestamptz,
    recovery_status text not null default 'not_required',
    recovery_amount bigint not null default 0,
    stripe_transfer_reversal_id text,
    accepted_at timestamptz,
    closed_at timestamptz,
    last_synced_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    foreign key (payment_id, organization_id)
        references public.payments(id, organization_id) on delete restrict,
    foreign key (payment_request_id, organization_id)
        references public.payment_requests(id, organization_id) on delete restrict,
    constraint payment_disputes_amount_positive check (amount > 0),
    constraint payment_disputes_currency_format check (currency ~ '^[a-z]{3}$'),
    constraint payment_disputes_stripe_id check (
        stripe_dispute_id ~ '^dp_[A-Za-z0-9]{8,200}$'
    ),
    constraint payment_disputes_charge_id check (
        stripe_charge_id ~ '^ch_[A-Za-z0-9]{8,200}$'
    ),
    constraint payment_disputes_intent_id check (
        stripe_payment_intent_id ~ '^pi_[A-Za-z0-9]{8,200}$'
    ),
    constraint payment_disputes_status check (status in (
        'warning_needs_response', 'warning_under_review', 'warning_closed',
        'needs_response', 'under_review', 'won', 'lost', 'prevented',
        'appealable', 'appeal_under_review', 'appeal_won', 'appeal_lost'
    )),
    constraint payment_disputes_recovery_status check (
        recovery_status in ('not_required', 'pending', 'deferred', 'reversed', 'failed')
    ),
    constraint payment_disputes_recovery_amount check (
        recovery_amount between 0 and amount
    ),
    constraint payment_disputes_evidence_lengths check (
        char_length(coalesce(evidence_product_description, '')) <= 20000
        and char_length(coalesce(evidence_customer_email, '')) <= 320
        and char_length(coalesce(evidence_uncategorized_text, '')) <= 20000
    )
);

create index payment_disputes_organization_status_index
    on public.payment_disputes (organization_id, status, evidence_due_at);
create index payment_disputes_payment_index
    on public.payment_disputes (payment_id, created_at desc);
create index payment_disputes_request_index
    on public.payment_disputes (payment_request_id, created_at desc);

create trigger payment_disputes_set_updated_at
before update on public.payment_disputes
for each row execute function public.set_updated_at();

alter table public.payment_disputes enable row level security;

create policy "Financial roles can read payment disputes"
    on public.payment_disputes
    for select
    to authenticated
    using (
        public.has_organization_role(
            organization_id,
            array['owner', 'admin', 'accountant']
        )
    );

revoke all on table public.payment_disputes from public, anon, authenticated;
grant select on table public.payment_disputes to authenticated;
grant all on table public.payment_disputes to service_role;

create function public.apply_stripe_dispute_event(
    p_event_id text,
    p_event_type text,
    p_stripe_dispute_id text,
    p_stripe_charge_id text,
    p_stripe_payment_intent_id text,
    p_amount bigint,
    p_currency text,
    p_reason text,
    p_status text,
    p_livemode boolean,
    p_evidence_due_at timestamptz,
    p_has_evidence boolean,
    p_evidence_past_due boolean,
    p_evidence_submission_count integer,
    p_actor_user_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    payment_record public.payments%rowtype;
    request_record public.payment_requests%rowtype;
    transfer_record public.payment_transfers%rowtype;
    dispute_record public.payment_disputes%rowtype;
    inserted_count integer;
    next_status text;
begin
    if p_event_id is not null then
        insert into public.stripe_webhook_events (
            event_id, type, processed_at, created_at, updated_at
        ) values (
            p_event_id, coalesce(p_event_type, 'charge.dispute.updated'),
            now(), now(), now()
        ) on conflict (event_id) do nothing;

        get diagnostics inserted_count = row_count;
        if inserted_count = 0 then return false; end if;
    end if;

    if p_stripe_dispute_id !~ '^dp_[A-Za-z0-9]{8,200}$'
       or p_stripe_charge_id !~ '^ch_[A-Za-z0-9]{8,200}$'
       or p_stripe_payment_intent_id !~ '^pi_[A-Za-z0-9]{8,200}$'
       or p_amount <= 0
       or lower(p_currency) !~ '^[a-z]{3}$'
       or p_status not in (
            'warning_needs_response', 'warning_under_review', 'warning_closed',
            'needs_response', 'under_review', 'won', 'lost', 'prevented',
            'appealable', 'appeal_under_review', 'appeal_won', 'appeal_lost'
       )
       or p_evidence_submission_count < 0 then
        raise exception 'Invalid Stripe dispute payload.' using errcode = '22023';
    end if;

    select * into payment_record
    from public.payments as payment
    where payment.stripe_payment_intent_id = p_stripe_payment_intent_id
    for update;

    if not found or payment_record.organization_id is null
       or payment_record.payment_request_id is null
       or not payment_record.destination_charge then
        raise exception 'Destination-charge payment was not found.' using errcode = 'P0002';
    end if;

    select * into request_record
    from public.payment_requests
    where id = payment_record.payment_request_id;

    if request_record.organization_id <> payment_record.organization_id
       or lower(payment_record.currency) <> lower(p_currency)
       or p_amount > payment_record.amount_total then
        raise exception 'Stripe dispute ownership validation failed.' using errcode = '42501';
    end if;

    select * into transfer_record
    from public.payment_transfers
    where payment_id = payment_record.id;

    if transfer_record.id is not null
       and transfer_record.stripe_charge_id is not null
       and transfer_record.stripe_charge_id <> p_stripe_charge_id then
        raise exception 'Stripe dispute charge validation failed.' using errcode = '42501';
    end if;

    select * into dispute_record
    from public.payment_disputes
    where stripe_dispute_id = p_stripe_dispute_id
    for update;

    if dispute_record.id is null then
        insert into public.payment_disputes (
            organization_id, payment_id, payment_request_id,
            retainage_release_id, payment_transfer_id, stripe_dispute_id,
            stripe_charge_id, stripe_payment_intent_id, amount, currency,
            reason, status, livemode, evidence_due_at, has_evidence,
            evidence_past_due, evidence_submission_count, closed_at
        ) values (
            payment_record.organization_id, payment_record.id,
            payment_record.payment_request_id, payment_record.retainage_release_id,
            transfer_record.id, p_stripe_dispute_id, p_stripe_charge_id,
            p_stripe_payment_intent_id, p_amount, lower(p_currency),
            left(coalesce(p_reason, 'general'), 120), p_status, p_livemode,
            p_evidence_due_at, p_has_evidence, p_evidence_past_due,
            p_evidence_submission_count,
            case when p_status in ('won', 'lost', 'prevented', 'warning_closed', 'appeal_won', 'appeal_lost') then now() end
        ) returning * into dispute_record;

        insert into public.audit_events (
            organization_id, actor_user_id, action, entity_type, entity_id, metadata
        ) values (
            dispute_record.organization_id, p_actor_user_id, 'dispute.opened',
            'payment_dispute', dispute_record.id,
            jsonb_build_object('amount', p_amount, 'currency', lower(p_currency),
                'reason', dispute_record.reason, 'status', p_status,
                'stripe_event_type', p_event_type)
        );
    else
        if dispute_record.organization_id <> payment_record.organization_id
           or dispute_record.payment_id <> payment_record.id
           or dispute_record.amount <> p_amount
           or dispute_record.currency <> lower(p_currency)
           or dispute_record.stripe_charge_id <> p_stripe_charge_id then
            raise exception 'Stripe dispute relationship cannot be changed.' using errcode = '42501';
        end if;

        next_status := case
            when dispute_record.status in ('won', 'lost', 'prevented', 'warning_closed', 'appeal_won', 'appeal_lost')
                 and p_status not in ('appealable', 'appeal_under_review', 'appeal_won', 'appeal_lost')
                then dispute_record.status
            else p_status
        end;

        update public.payment_disputes
        set status = next_status,
            reason = left(coalesce(p_reason, reason), 120),
            evidence_due_at = p_evidence_due_at,
            has_evidence = p_has_evidence,
            evidence_past_due = p_evidence_past_due,
            evidence_submission_count = greatest(evidence_submission_count, p_evidence_submission_count),
            closed_at = case
                when next_status in ('won', 'lost', 'prevented', 'warning_closed', 'appeal_won', 'appeal_lost')
                    then coalesce(closed_at, now())
                else closed_at
            end,
            last_synced_at = now()
        where id = dispute_record.id;

        if dispute_record.status <> next_status then
            insert into public.audit_events (
                organization_id, actor_user_id, action, entity_type, entity_id, metadata
            ) values (
                dispute_record.organization_id, p_actor_user_id, 'dispute.status_changed',
                'payment_dispute', dispute_record.id,
                jsonb_build_object('previous_status', dispute_record.status,
                    'status', next_status, 'stripe_event_type', p_event_type)
            );
        end if;
    end if;

    if p_event_type = 'charge.dispute.funds_withdrawn' then
        update public.payment_disputes
        set funds_withdrawn_at = coalesce(funds_withdrawn_at, now()),
            recovery_status = case when payment_transfer_id is null then 'not_required' else 'deferred' end
        where id = dispute_record.id;
    elsif p_event_type = 'charge.dispute.funds_reinstated' then
        update public.payment_disputes
        set funds_reinstated_at = coalesce(funds_reinstated_at, now()),
            recovery_status = case when recovery_status = 'reversed' then recovery_status else 'not_required' end
        where id = dispute_record.id;
    end if;

    return true;
end;
$$;

create function public.prepare_dispute_action(
    p_dispute_id uuid,
    p_user_id uuid,
    p_action text
)
returns table (
    dispute_id uuid,
    organization_id uuid,
    stripe_dispute_id text,
    stripe_transfer_id text,
    dispute_amount bigint,
    recoverable_amount bigint,
    currency text,
    current_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    dispute_record public.payment_disputes%rowtype;
    transfer_record public.payment_transfers%rowtype;
begin
    if p_action not in ('sync', 'save_evidence', 'submit_evidence', 'accept', 'recover') then
        raise exception 'Unsupported dispute action.' using errcode = '22023';
    end if;

    select * into dispute_record from public.payment_disputes
    where id = p_dispute_id for update;
    if not found then raise exception 'Dispute was not found.' using errcode = 'P0002'; end if;

    if not exists (
        select 1 from public.organization_memberships
        where organization_id = dispute_record.organization_id
          and user_id = p_user_id and status = 'active'
          and role in ('owner', 'admin', 'accountant')
    ) then
        raise exception 'You are not allowed to manage this dispute.' using errcode = '42501';
    end if;

    if p_action in ('save_evidence', 'submit_evidence', 'accept')
       and dispute_record.status not in ('warning_needs_response', 'needs_response') then
        raise exception 'This dispute is not awaiting a response.' using errcode = '55000';
    end if;
    if p_action = 'recover' and dispute_record.status not in ('lost', 'appeal_lost') then
        raise exception 'Only a lost dispute can recover transferred funds.' using errcode = '55000';
    end if;

    select * into transfer_record from public.payment_transfers
    where id = dispute_record.payment_transfer_id for update;

    return query select dispute_record.id, dispute_record.organization_id,
        dispute_record.stripe_dispute_id, transfer_record.stripe_transfer_id,
        dispute_record.amount,
        least(dispute_record.amount,
            greatest(coalesce(transfer_record.amount, 0) - coalesce(transfer_record.reversed_amount, 0), 0)),
        dispute_record.currency::text, dispute_record.status;
end;
$$;

create function public.record_dispute_action_result(
    p_dispute_id uuid,
    p_user_id uuid,
    p_action text,
    p_product_description text default null,
    p_service_date date default null,
    p_customer_email text default null,
    p_uncategorized_text text default null,
    p_recovery_amount bigint default null,
    p_transfer_reversal_id text default null,
    p_error_message text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare dispute_record public.payment_disputes%rowtype;
begin
    select * into dispute_record from public.payment_disputes
    where id = p_dispute_id for update;
    if not found then raise exception 'Dispute was not found.' using errcode = 'P0002'; end if;

    if p_action in ('save_evidence', 'submit_evidence') then
        update public.payment_disputes set
            evidence_product_description = left(nullif(trim(p_product_description), ''), 20000),
            evidence_service_date = p_service_date,
            evidence_customer_email = left(nullif(trim(p_customer_email), ''), 320),
            evidence_uncategorized_text = left(nullif(trim(p_uncategorized_text), ''), 20000),
            evidence_saved_at = now(),
            evidence_submitted_at = case when p_action = 'submit_evidence' then now() else evidence_submitted_at end
        where id = p_dispute_id;
    elsif p_action = 'accept' then
        update public.payment_disputes set accepted_at = coalesce(accepted_at, now())
        where id = p_dispute_id;
    elsif p_action = 'recover' then
        update public.payment_disputes set
            recovery_status = case when p_error_message is null then 'reversed' else 'failed' end,
            recovery_amount = case when p_error_message is null then coalesce(p_recovery_amount, 0) else recovery_amount end,
            stripe_transfer_reversal_id = case when p_error_message is null then p_transfer_reversal_id else stripe_transfer_reversal_id end
        where id = p_dispute_id;
    end if;

    insert into public.audit_events (
        organization_id, actor_user_id, action, entity_type, entity_id, metadata
    ) values (
        dispute_record.organization_id, p_user_id, 'dispute.' || p_action,
        'payment_dispute', dispute_record.id,
        jsonb_strip_nulls(jsonb_build_object(
            'recovery_amount', p_recovery_amount,
            'currency', dispute_record.currency,
            'succeeded', p_error_message is null,
            'error', left(p_error_message, 200)
        ))
    );
    return true;
end;
$$;

revoke all on function public.apply_stripe_dispute_event(
    text, text, text, text, text, bigint, text, text, text, boolean,
    timestamptz, boolean, boolean, integer, uuid
) from public, anon, authenticated;
revoke all on function public.prepare_dispute_action(uuid, uuid, text)
    from public, anon, authenticated;
revoke all on function public.record_dispute_action_result(
    uuid, uuid, text, text, date, text, text, bigint, text, text
) from public, anon, authenticated;

grant execute on function public.apply_stripe_dispute_event(
    text, text, text, text, text, bigint, text, text, text, boolean,
    timestamptz, boolean, boolean, integer, uuid
) to service_role;
grant execute on function public.prepare_dispute_action(uuid, uuid, text)
    to service_role;
grant execute on function public.record_dispute_action_result(
    uuid, uuid, text, text, date, text, text, bigint, text, text
) to service_role;
