alter table public.stripe_webhook_failures
    add column recovery_status text not null default 'pending',
    add column recovery_attempts integer not null default 0,
    add column last_recovery_requested_at timestamptz,
    add column last_recovery_requested_by uuid references auth.users(id) on delete set null;

alter table public.stripe_webhook_failures
    add constraint stripe_webhook_failures_recovery_status check (
        recovery_status in ('pending', 'retrying', 'failed', 'resolved')
    ),
    add constraint stripe_webhook_failures_recovery_attempts check (
        recovery_attempts >= 0
    );

update public.stripe_webhook_failures
set recovery_status = 'resolved'
where resolved_at is not null;

create index stripe_webhook_failures_recovery_queue_index
    on public.stripe_webhook_failures (
        organization_id,
        recovery_status,
        last_failed_at desc
    );

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

    if tenant_id is null then
        select payout_account.organization_id into tenant_id
        from public.subcontractor_payout_accounts as payout_account
        where payout_account.stripe_account_id = p_object_id
        limit 1;
    end if;

    if tenant_id is null then
        select dispute.organization_id into tenant_id
        from public.payment_disputes as dispute
        where dispute.stripe_dispute_id = p_object_id
        limit 1;
    end if;

    insert into public.stripe_webhook_failures (
        organization_id,
        event_id,
        event_type,
        object_id,
        error_code,
        error_message,
        recovery_status
    ) values (
        tenant_id,
        p_event_id,
        p_event_type,
        p_object_id,
        nullif(left(p_error_code, 120), ''),
        left(coalesce(nullif(p_error_message, ''), 'Unknown processing error.'), 1000),
        'pending'
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
        resolution = null,
        recovery_status = 'pending';

    return true;
end;
$$;

create or replace function public.resolve_stripe_webhook_failure(
    p_event_id text,
    p_resolution text default 'processed_on_retry'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
    update public.stripe_webhook_failures
    set
        resolved_at = coalesce(resolved_at, now()),
        resolution = left(p_resolution, 240),
        recovery_status = 'resolved'
    where event_id = p_event_id;

    return found;
end;
$$;

create function public.prepare_webhook_failure_recovery(
    p_failure_id bigint,
    p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    failure_record public.stripe_webhook_failures%rowtype;
    recovery_kind text;
    recovery_target_id uuid;
begin
    if p_user_id is null then
        raise exception 'Authentication is required.' using errcode = '28000';
    end if;

    select * into failure_record
    from public.stripe_webhook_failures as failure
    where failure.id = p_failure_id
      and failure.resolved_at is null
      and failure.organization_id is not null
      and (
          failure.recovery_status <> 'retrying'
          or failure.last_recovery_requested_at < now() - interval '5 minutes'
      )
    for update;

    if not found then
        raise exception 'The unresolved webhook failure was not found.' using errcode = 'P0002';
    end if;

    if not exists (
        select 1
        from public.organization_memberships as membership
        where membership.organization_id = failure_record.organization_id
          and membership.user_id = p_user_id
          and membership.status = 'active'
          and membership.role in ('owner', 'admin', 'accountant')
    ) then
        raise exception 'You are not allowed to recover this webhook failure.'
            using errcode = '42501';
    end if;

    if failure_record.event_type = 'account.updated' then
        select payout_account.subcontractor_id into recovery_target_id
        from public.subcontractor_payout_accounts as payout_account
        where payout_account.organization_id = failure_record.organization_id
          and payout_account.stripe_account_id = failure_record.object_id;
        recovery_kind := 'connected_account';
    elsif failure_record.event_type like 'charge.dispute.%' then
        select dispute.id into recovery_target_id
        from public.payment_disputes as dispute
        where dispute.organization_id = failure_record.organization_id
          and dispute.stripe_dispute_id = failure_record.object_id;
        recovery_kind := 'dispute';
    elsif failure_record.event_type like 'payout.%' then
        select payout.id into recovery_target_id
        from public.connected_payouts as payout
        where payout.organization_id = failure_record.organization_id
          and payout.stripe_payout_id = failure_record.object_id;
        recovery_kind := 'payout';

        if recovery_target_id is null then
            select payout_account.subcontractor_id into recovery_target_id
            from public.subcontractor_payout_accounts as payout_account
            where payout_account.organization_id = failure_record.organization_id
              and payout_account.stripe_account_id = failure_record.object_id;
            recovery_kind := 'subcontractor_payouts';
        end if;
    elsif failure_record.event_type like 'transfer.%'
       or failure_record.event_type = 'charge.succeeded' then
        select transfer.payment_request_id into recovery_target_id
        from public.payment_transfers as transfer
        where transfer.organization_id = failure_record.organization_id
          and transfer.stripe_transfer_id = failure_record.object_id;
        recovery_kind := 'payment_payouts';

        if recovery_target_id is null then
            select payment.payment_request_id into recovery_target_id
            from public.payments as payment
            where payment.organization_id = failure_record.organization_id
              and payment.stripe_payment_intent_id = failure_record.object_id;
        end if;

        if recovery_target_id is null then
            select payout_account.subcontractor_id into recovery_target_id
            from public.subcontractor_payout_accounts as payout_account
            where payout_account.organization_id = failure_record.organization_id
              and payout_account.stripe_account_id = failure_record.object_id;
            recovery_kind := 'subcontractor_payouts';
        end if;
    else
        select payment.payment_request_id into recovery_target_id
        from public.payments as payment
        where payment.organization_id = failure_record.organization_id
          and (
              payment.stripe_checkout_session_id = failure_record.object_id
              or payment.stripe_payment_intent_id = failure_record.object_id
          );

        if recovery_target_id is null then
            select refund.payment_request_id into recovery_target_id
            from public.payment_refunds as refund
            where refund.organization_id = failure_record.organization_id
              and refund.stripe_refund_id = failure_record.object_id;
        end if;

        recovery_kind := 'payment';
    end if;

    if recovery_target_id is null then
        raise exception 'No safe automated recovery path is available for this failure.'
            using errcode = 'P0002';
    end if;

    update public.stripe_webhook_failures
    set
        recovery_status = 'retrying',
        recovery_attempts = recovery_attempts + 1,
        last_recovery_requested_at = now(),
        last_recovery_requested_by = p_user_id
    where id = failure_record.id;

    insert into public.audit_events (
        organization_id, actor_user_id, action, entity_type, entity_id, metadata
    ) values (
        failure_record.organization_id,
        p_user_id,
        'webhook_failure.recovery_requested',
        'stripe_webhook_failure',
        null,
        jsonb_build_object(
            'failure_id', failure_record.id,
            'event_type', failure_record.event_type,
            'recovery_kind', recovery_kind
        )
    );

    return jsonb_build_object(
        'failure_id', failure_record.id,
        'organization_id', failure_record.organization_id,
        'recovery_kind', recovery_kind,
        'target_id', recovery_target_id
    );
end;
$$;

create function public.complete_webhook_failure_recovery(
    p_failure_id bigint,
    p_user_id uuid,
    p_succeeded boolean,
    p_failure_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    failure_record public.stripe_webhook_failures%rowtype;
begin
    select * into failure_record
    from public.stripe_webhook_failures as failure
    where failure.id = p_failure_id
      and failure.organization_id is not null
    for update;

    if not found then
        raise exception 'The webhook failure was not found.' using errcode = 'P0002';
    end if;

    if not exists (
        select 1
        from public.organization_memberships as membership
        where membership.organization_id = failure_record.organization_id
          and membership.user_id = p_user_id
          and membership.status = 'active'
          and membership.role in ('owner', 'admin', 'accountant')
    ) then
        raise exception 'You are not allowed to recover this webhook failure.'
            using errcode = '42501';
    end if;

    update public.stripe_webhook_failures
    set
        recovery_status = case when p_succeeded then 'resolved' else 'failed' end,
        resolved_at = case when p_succeeded then coalesce(resolved_at, now()) else null end,
        resolution = case when p_succeeded then 'operator_reconciliation' else null end
    where id = failure_record.id;

    insert into public.audit_events (
        organization_id, actor_user_id, action, entity_type, entity_id, metadata
    ) values (
        failure_record.organization_id,
        p_user_id,
        case
            when p_succeeded then 'webhook_failure.recovery_completed'
            else 'webhook_failure.recovery_failed'
        end,
        'stripe_webhook_failure',
        null,
        jsonb_build_object(
            'failure_id', failure_record.id,
            'event_type', failure_record.event_type,
            'failure_code', nullif(left(p_failure_code, 120), '')
        )
    );

    return true;
end;
$$;

revoke all on function public.prepare_webhook_failure_recovery(bigint, uuid)
    from public, anon, authenticated;
revoke all on function public.complete_webhook_failure_recovery(bigint, uuid, boolean, text)
    from public, anon, authenticated;

grant execute on function public.prepare_webhook_failure_recovery(bigint, uuid)
    to service_role;
grant execute on function public.complete_webhook_failure_recovery(bigint, uuid, boolean, text)
    to service_role;

comment on function public.prepare_webhook_failure_recovery(bigint, uuid) is
    'Authorizes an operator and resolves a webhook incident to an existing safe reconciliation target.';
comment on function public.complete_webhook_failure_recovery(bigint, uuid, boolean, text) is
    'Records the audited outcome of an operator-requested webhook recovery attempt.';
