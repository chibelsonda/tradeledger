create table public.notification_deliveries (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete restrict,
    payment_request_id uuid not null references public.payment_requests(id) on delete restrict,
    notification_type text not null,
    recipient_email text,
    recipient_name text not null,
    subject text not null,
    template_data jsonb not null default '{}'::jsonb,
    status text not null default 'pending',
    attempt_count integer not null default 0,
    max_attempts integer not null default 5,
    idempotency_key text not null unique,
    provider_message_id text,
    worker_token uuid,
    next_attempt_at timestamptz,
    last_attempt_at timestamptz,
    sent_at timestamptz,
    error_code text,
    error_message text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint notification_deliveries_type check (
        notification_type in ('payment_request_approved', 'payment_succeeded')
    ),
    constraint notification_deliveries_status check (
        status in ('pending', 'processing', 'retry_scheduled', 'sent', 'failed')
    ),
    constraint notification_deliveries_attempts check (
        attempt_count between 0 and max_attempts and max_attempts between 1 and 10
    ),
    constraint notification_deliveries_recipient_length check (
        recipient_email is null or char_length(recipient_email) between 3 and 320
    ),
    constraint notification_deliveries_subject_length check (
        char_length(subject) between 1 and 200
    ),
    constraint notification_deliveries_idempotency_length check (
        char_length(idempotency_key) between 1 and 256
    ),
    constraint notification_deliveries_sent_fields check (
        status <> 'sent'
        or (sent_at is not null and provider_message_id is not null)
    )
);

create index notification_deliveries_organization_created_index
    on public.notification_deliveries (organization_id, created_at desc);

create index notification_deliveries_due_index
    on public.notification_deliveries (status, next_attempt_at, created_at)
    where status in ('pending', 'retry_scheduled');

create trigger notification_deliveries_set_updated_at
before update on public.notification_deliveries
for each row execute function public.set_updated_at();

alter table public.notification_deliveries enable row level security;

create policy "Financial roles can read notification deliveries"
    on public.notification_deliveries
    for select
    to authenticated
    using (
        public.has_organization_role(
            organization_id,
            array['owner', 'admin', 'accountant']
        )
    );

create or replace function public.enqueue_payment_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    delivery_type text;
    organization_name text;
    project_name text;
    project_code text;
    subcontractor_name text;
    subcontractor_contact text;
    subcontractor_email text;
    delivery_subject text;
begin
    if new.status is not distinct from old.status then
        return new;
    end if;

    delivery_type := case new.status
        when 'approved' then 'payment_request_approved'
        when 'paid' then 'payment_succeeded'
        else null
    end;

    if delivery_type is null then
        return new;
    end if;

    select
        organization.name,
        project.name,
        project.code,
        subcontractor.company_name,
        subcontractor.contact_name,
        nullif(lower(trim(subcontractor.email)), '')
    into
        organization_name,
        project_name,
        project_code,
        subcontractor_name,
        subcontractor_contact,
        subcontractor_email
    from public.organizations as organization
    join public.projects as project on project.id = new.project_id
    join public.subcontractors as subcontractor on subcontractor.id = new.subcontractor_id
    where organization.id = new.organization_id;

    delivery_subject := case delivery_type
        when 'payment_request_approved' then
            'Payment request approved for ' || project_name
        else
            'Payment received for ' || project_name
    end;

    insert into public.notification_deliveries (
        organization_id,
        payment_request_id,
        notification_type,
        recipient_email,
        recipient_name,
        subject,
        template_data,
        status,
        idempotency_key,
        error_code,
        error_message
    ) values (
        new.organization_id,
        new.id,
        delivery_type,
        subcontractor_email,
        coalesce(nullif(trim(subcontractor_contact), ''), subcontractor_name),
        delivery_subject,
        jsonb_build_object(
            'organizationName', organization_name,
            'projectName', project_name,
            'projectCode', project_code,
            'subcontractorName', subcontractor_name,
            'description', new.description,
            'grossAmount', new.gross_amount,
            'retainageAmount', new.retainage_amount,
            'netAmount', new.net_amount,
            'currency', new.currency,
            'approvedAt', new.approved_at,
            'paidAt', new.paid_at
        ),
        case when subcontractor_email is null then 'failed' else 'pending' end,
        'tradeledger/' || delivery_type || '/' || new.id::text,
        case when subcontractor_email is null then 'recipient_missing' end,
        case
            when subcontractor_email is null
                then 'The subcontractor does not have an email address.'
        end
    )
    on conflict (idempotency_key) do nothing;

    return new;
end;
$$;

create trigger payment_requests_enqueue_notification
after update of status on public.payment_requests
for each row execute function public.enqueue_payment_notification();

create or replace function public.claim_notification_delivery(
    p_payment_request_id uuid,
    p_user_id uuid default null
)
returns table (
    delivery_id uuid,
    worker_token uuid,
    notification_type text,
    recipient_email text,
    recipient_name text,
    subject text,
    template_data jsonb,
    idempotency_key text,
    attempt_count integer,
    max_attempts integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    request_organization_id uuid;
begin
    select payment_request.organization_id
    into request_organization_id
    from public.payment_requests as payment_request
    where payment_request.id = p_payment_request_id;

    if request_organization_id is null then
        raise exception 'The payment request was not found.' using errcode = 'P0002';
    end if;

    if p_user_id is not null and not exists (
        select 1
        from public.organization_memberships as membership
        where membership.organization_id = request_organization_id
          and membership.user_id = p_user_id
          and membership.status = 'active'
          and membership.role in ('owner', 'admin', 'accountant')
    ) then
        raise exception 'You are not allowed to dispatch this notification.'
            using errcode = '42501';
    end if;

    update public.notification_deliveries as delivery
    set
        status = 'retry_scheduled',
        worker_token = null,
        next_attempt_at = now(),
        error_code = 'claim_expired',
        error_message = 'A previous delivery claim expired before completion.'
    where delivery.payment_request_id = p_payment_request_id
      and delivery.status = 'processing'
      and delivery.last_attempt_at < now() - interval '10 minutes';

    return query
    with candidate as (
        select delivery.id
        from public.notification_deliveries as delivery
        where delivery.payment_request_id = p_payment_request_id
          and delivery.recipient_email is not null
          and delivery.attempt_count < delivery.max_attempts
          and (
              delivery.status = 'pending'
              or (
                  delivery.status = 'retry_scheduled'
                  and coalesce(delivery.next_attempt_at, now()) <= now()
              )
          )
        order by delivery.created_at
        for update skip locked
        limit 1
    ), claimed as (
        update public.notification_deliveries as delivery
        set
            status = 'processing',
            worker_token = gen_random_uuid(),
            attempt_count = delivery.attempt_count + 1,
            last_attempt_at = now(),
            next_attempt_at = null,
            error_code = null,
            error_message = null
        from candidate
        where delivery.id = candidate.id
        returning delivery.*
    )
    select
        claimed.id,
        claimed.worker_token,
        claimed.notification_type,
        claimed.recipient_email,
        claimed.recipient_name,
        claimed.subject,
        claimed.template_data,
        claimed.idempotency_key,
        claimed.attempt_count,
        claimed.max_attempts
    from claimed;
end;
$$;

create or replace function public.complete_notification_delivery(
    p_delivery_id uuid,
    p_worker_token uuid,
    p_provider_message_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    completed_delivery public.notification_deliveries%rowtype;
begin
    update public.notification_deliveries
    set
        status = 'sent',
        provider_message_id = left(p_provider_message_id, 255),
        worker_token = null,
        next_attempt_at = null,
        sent_at = now(),
        error_code = null,
        error_message = null
    where id = p_delivery_id
      and worker_token = p_worker_token
      and status = 'processing'
    returning * into completed_delivery;

    if not found then
        return false;
    end if;

    insert into public.audit_events (
        organization_id,
        actor_user_id,
        action,
        entity_type,
        entity_id,
        metadata
    ) values (
        completed_delivery.organization_id,
        null,
        'notification.sent',
        'notification_delivery',
        completed_delivery.id,
        jsonb_build_object(
            'notification_type', completed_delivery.notification_type,
            'payment_request_id', completed_delivery.payment_request_id,
            'provider_message_id', left(p_provider_message_id, 255)
        )
    );

    return true;
end;
$$;

create or replace function public.fail_notification_delivery(
    p_delivery_id uuid,
    p_worker_token uuid,
    p_error_code text,
    p_error_message text,
    p_retryable boolean
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    delivery_record public.notification_deliveries%rowtype;
    next_status text;
begin
    select *
    into delivery_record
    from public.notification_deliveries
    where id = p_delivery_id
      and worker_token = p_worker_token
      and status = 'processing'
    for update;

    if not found then
        raise exception 'The notification delivery claim is no longer active.'
            using errcode = '55000';
    end if;

    next_status := case
        when p_retryable and delivery_record.attempt_count < delivery_record.max_attempts
            then 'retry_scheduled'
        else 'failed'
    end;

    update public.notification_deliveries
    set
        status = next_status,
        worker_token = null,
        next_attempt_at = case
            when next_status = 'retry_scheduled' then
                now() + make_interval(
                    secs => least(
                        900,
                        30 * power(2, greatest(delivery_record.attempt_count - 1, 0))::integer
                    )
                )
            else null
        end,
        error_code = left(coalesce(nullif(p_error_code, ''), 'delivery_failed'), 120),
        error_message = left(coalesce(nullif(p_error_message, ''), 'Email delivery failed.'), 1000)
    where id = delivery_record.id;

    if next_status = 'failed' then
        insert into public.audit_events (
            organization_id,
            actor_user_id,
            action,
            entity_type,
            entity_id,
            metadata
        ) values (
            delivery_record.organization_id,
            null,
            'notification.failed',
            'notification_delivery',
            delivery_record.id,
            jsonb_build_object(
                'notification_type', delivery_record.notification_type,
                'payment_request_id', delivery_record.payment_request_id,
                'error_code', left(coalesce(nullif(p_error_code, ''), 'delivery_failed'), 120)
            )
        );
    end if;

    return next_status;
end;
$$;

create or replace function public.retry_notification_delivery(
    p_delivery_id uuid,
    p_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    delivery_record public.notification_deliveries%rowtype;
    current_recipient text;
begin
    select delivery.*
    into delivery_record
    from public.notification_deliveries as delivery
    where delivery.id = p_delivery_id;

    if not found then
        raise exception 'The notification delivery was not found.' using errcode = 'P0002';
    end if;

    if not exists (
        select 1
        from public.organization_memberships as membership
        where membership.organization_id = delivery_record.organization_id
          and membership.user_id = p_user_id
          and membership.status = 'active'
          and membership.role in ('owner', 'admin', 'accountant')
    ) then
        raise exception 'You are not allowed to retry this notification.'
            using errcode = '42501';
    end if;

    select nullif(lower(trim(subcontractor.email)), '')
    into current_recipient
    from public.payment_requests as payment_request
    join public.subcontractors as subcontractor
      on subcontractor.id = payment_request.subcontractor_id
    where payment_request.id = delivery_record.payment_request_id;

    update public.notification_deliveries
    set
        recipient_email = current_recipient,
        status = case when current_recipient is null then 'failed' else 'pending' end,
        attempt_count = 0,
        worker_token = null,
        next_attempt_at = null,
        sent_at = null,
        provider_message_id = null,
        error_code = case when current_recipient is null then 'recipient_missing' end,
        error_message = case
            when current_recipient is null
                then 'The subcontractor does not have an email address.'
        end
    where id = delivery_record.id
      and status in ('failed', 'retry_scheduled');

    if not found then
        raise exception 'Only failed or scheduled notifications can be retried.'
            using errcode = '55000';
    end if;

    return delivery_record.payment_request_id;
end;
$$;

revoke all on table public.notification_deliveries from anon, authenticated;
grant select on table public.notification_deliveries to authenticated;
grant all on table public.notification_deliveries to service_role;

revoke all on function public.enqueue_payment_notification() from public, anon, authenticated;
revoke all on function public.claim_notification_delivery(uuid, uuid) from public, anon, authenticated;
revoke all on function public.complete_notification_delivery(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.fail_notification_delivery(uuid, uuid, text, text, boolean) from public, anon, authenticated;
revoke all on function public.retry_notification_delivery(uuid, uuid) from public, anon, authenticated;

grant execute on function public.enqueue_payment_notification() to service_role;
grant execute on function public.claim_notification_delivery(uuid, uuid) to service_role;
grant execute on function public.complete_notification_delivery(uuid, uuid, text) to service_role;
grant execute on function public.fail_notification_delivery(uuid, uuid, text, text, boolean) to service_role;
grant execute on function public.retry_notification_delivery(uuid, uuid) to service_role;
