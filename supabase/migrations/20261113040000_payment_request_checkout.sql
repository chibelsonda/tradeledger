alter table public.payment_requests
    add column if not exists checkout_started_at timestamptz,
    add column if not exists paid_at timestamptz,
    add column if not exists failed_at timestamptz;

alter table public.payment_requests
    drop constraint if exists payment_requests_status,
    drop constraint if exists payment_requests_approval_fields;

alter table public.payment_requests
    add constraint payment_requests_status check (
        status in (
            'draft',
            'submitted',
            'approved',
            'checkout_created',
            'processing',
            'paid',
            'failed',
            'canceled'
        )
    ),
    add constraint payment_requests_approval_fields check (
        status not in (
            'approved',
            'checkout_created',
            'processing',
            'paid',
            'failed'
        )
        or (approved_by is not null and approved_at is not null)
    );

create or replace function public.transition_payment_request_status(
    p_payment_request_id uuid,
    p_next_status text,
    p_actor_user_id uuid default null,
    p_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_status text;
    request_organization_id uuid;
begin
    select payment_request.status, payment_request.organization_id
    into current_status, request_organization_id
    from public.payment_requests as payment_request
    where payment_request.id = p_payment_request_id
    for update;

    if not found then
        return false;
    end if;

    if current_status = p_next_status then
        return true;
    end if;

    if not (
        (current_status = 'approved' and p_next_status = 'checkout_created')
        or (current_status = 'failed' and p_next_status = 'checkout_created')
        or (
            current_status = 'checkout_created'
            and p_next_status in ('processing', 'paid', 'failed', 'canceled')
        )
        or (current_status = 'processing' and p_next_status in ('paid', 'failed'))
    ) then
        raise exception 'Invalid payment request transition from % to %.',
            current_status,
            p_next_status
            using errcode = '55000';
    end if;

    update public.payment_requests
    set
        status = p_next_status,
        checkout_started_at = case
            when p_next_status = 'checkout_created' then now()
            else checkout_started_at
        end,
        paid_at = case
            when p_next_status = 'paid' then coalesce(paid_at, now())
            else paid_at
        end,
        failed_at = case
            when p_next_status = 'failed' then now()
            when p_next_status = 'checkout_created' then null
            else failed_at
        end
    where id = p_payment_request_id;

    insert into public.audit_events (
        organization_id,
        actor_user_id,
        action,
        entity_type,
        entity_id,
        metadata
    ) values (
        request_organization_id,
        p_actor_user_id,
        'payment_request.' || p_next_status,
        'payment_request',
        p_payment_request_id,
        coalesce(p_metadata, '{}'::jsonb)
    );

    return true;
end;
$$;

create or replace function public.prepare_payment_request_checkout(
    p_payment_request_id uuid,
    p_user_id uuid,
    p_reference uuid
)
returns table (
    payment_id bigint,
    payment_reference uuid,
    organization_id uuid,
    payment_request_id uuid,
    request_description text,
    project_name text,
    subcontractor_name text,
    amount_total bigint,
    currency text,
    customer_email text,
    stripe_checkout_session_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    request_record record;
    existing_payment public.payments%rowtype;
    payer_email text;
begin
    if p_user_id is null then
        raise exception 'Authentication is required.' using errcode = '28000';
    end if;

    select
        payment_request.id,
        payment_request.organization_id,
        payment_request.description,
        payment_request.net_amount,
        payment_request.currency,
        payment_request.status,
        project.name as project_name,
        subcontractor.company_name as subcontractor_name
    into request_record
    from public.payment_requests as payment_request
    join public.projects as project
      on project.id = payment_request.project_id
     and project.organization_id = payment_request.organization_id
    join public.subcontractors as subcontractor
      on subcontractor.id = payment_request.subcontractor_id
     and subcontractor.organization_id = payment_request.organization_id
    where payment_request.id = p_payment_request_id
    for update of payment_request;

    if not found then
        raise exception 'Payment request was not found.' using errcode = 'P0002';
    end if;

    if not exists (
        select 1
        from public.organization_memberships as membership
        where membership.organization_id = request_record.organization_id
          and membership.user_id = p_user_id
          and membership.status = 'active'
          and membership.role in ('owner', 'admin', 'accountant')
    ) then
        raise exception 'You are not allowed to start checkout for this request.'
            using errcode = '42501';
    end if;

    if request_record.status not in ('approved', 'failed', 'checkout_created') then
        raise exception 'Only an approved payment request can start checkout.'
            using errcode = '55000';
    end if;

    select payment.*
    into existing_payment
    from public.payments as payment
    where payment.payment_request_id = p_payment_request_id
    for update;

    select user_record.email
    into payer_email
    from auth.users as user_record
    where user_record.id = p_user_id;

    if existing_payment.id is null then
        insert into public.payments (
            user_id,
            organization_id,
            payment_request_id,
            reference,
            product_name,
            unit_amount,
            quantity,
            amount_total,
            currency,
            status,
            customer_email
        ) values (
            p_user_id,
            request_record.organization_id,
            request_record.id,
            p_reference,
            'Payment request · ' || request_record.project_name,
            request_record.net_amount,
            1,
            request_record.net_amount,
            request_record.currency,
            'pending',
            payer_email
        ) returning * into existing_payment;
    elsif request_record.status = 'failed' then
        update public.payments
        set
            user_id = p_user_id,
            reference = case
                when stripe_checkout_session_id is null then reference
                else p_reference
            end,
            product_name = 'Payment request · ' || request_record.project_name,
            unit_amount = request_record.net_amount,
            quantity = 1,
            amount_total = request_record.net_amount,
            currency = request_record.currency,
            status = 'pending',
            stripe_checkout_session_id = null,
            stripe_payment_intent_id = null,
            customer_email = payer_email,
            paid_at = null,
            updated_at = now()
        where id = existing_payment.id
        returning * into existing_payment;
    elsif existing_payment.status not in ('pending', 'processing') then
        raise exception 'This payment request already has a completed payment.'
            using errcode = '55000';
    end if;

    if request_record.status in ('approved', 'failed') then
        perform public.transition_payment_request_status(
            p_payment_request_id,
            'checkout_created',
            p_user_id,
            jsonb_build_object('payment_reference', existing_payment.reference)
        );
    end if;

    return query
    select
        existing_payment.id,
        existing_payment.reference,
        request_record.organization_id,
        request_record.id,
        request_record.description,
        request_record.project_name,
        request_record.subcontractor_name,
        request_record.net_amount,
        request_record.currency::text,
        payer_email,
        existing_payment.stripe_checkout_session_id;
end;
$$;

create or replace function public.attach_payment_checkout_session(
    p_reference uuid,
    p_session_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
    update public.payments
    set stripe_checkout_session_id = p_session_id, updated_at = now()
    where reference = p_reference
      and status = 'pending'
      and stripe_checkout_session_id is null;

    return found;
end;
$$;

create or replace function public.mark_payment_checkout_failed(
    p_reference uuid,
    p_reason text default 'checkout_session_creation_failed'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    request_id uuid;
begin
    update public.payments
    set status = 'failed', updated_at = now()
    where reference = p_reference
      and status in ('pending', 'processing')
    returning payment_request_id into request_id;

    if not found then
        return false;
    end if;

    if request_id is not null then
        perform public.transition_payment_request_status(
            request_id,
            'failed',
            null,
            jsonb_build_object('reason', p_reason)
        );
    end if;

    return true;
end;
$$;

create or replace function public.process_stripe_webhook(
    p_event_id text,
    p_event_type text,
    p_session_id text,
    p_payment_status text,
    p_payment_intent_id text,
    p_customer_email text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    inserted_count integer;
    next_payment_status text;
    next_request_status text;
    linked_request_id uuid;
begin
    insert into public.stripe_webhook_events (
        event_id,
        type,
        processed_at,
        created_at,
        updated_at
    ) values (p_event_id, p_event_type, now(), now(), now())
    on conflict (event_id) do nothing;

    get diagnostics inserted_count = row_count;

    if inserted_count = 0 then
        return false;
    end if;

    next_payment_status := case
        when p_event_type = 'checkout.session.async_payment_failed' then 'failed'
        when p_event_type = 'checkout.session.expired' then 'expired'
        when p_event_type = 'checkout.session.async_payment_succeeded' then 'paid'
        when p_event_type = 'checkout.session.completed' and p_payment_status = 'paid' then 'paid'
        when p_event_type = 'checkout.session.completed' then 'processing'
        else null
    end;

    next_request_status := case
        when next_payment_status = 'paid' then 'paid'
        when next_payment_status = 'processing' then 'processing'
        when next_payment_status in ('failed', 'expired') then 'failed'
        else null
    end;

    if next_payment_status is null or p_session_id is null then
        return true;
    end if;

    update public.payments
    set
        status = next_payment_status,
        stripe_payment_intent_id = coalesce(
            p_payment_intent_id,
            stripe_payment_intent_id
        ),
        customer_email = coalesce(p_customer_email, customer_email),
        paid_at = case
            when next_payment_status = 'paid' then coalesce(paid_at, now())
            else paid_at
        end,
        updated_at = now()
    where stripe_checkout_session_id = p_session_id
    returning payment_request_id into linked_request_id;

    if not found then
        raise exception 'Payment for Stripe Checkout Session % was not found.', p_session_id;
    end if;

    if linked_request_id is not null and next_request_status is not null then
        perform public.transition_payment_request_status(
            linked_request_id,
            next_request_status,
            null,
            jsonb_build_object(
                'stripe_event_id', p_event_id,
                'stripe_event_type', p_event_type
            )
        );
    end if;

    return true;
end;
$$;

revoke all on function public.transition_payment_request_status(
    uuid,
    text,
    uuid,
    jsonb
) from public, anon, authenticated;
revoke all on function public.prepare_payment_request_checkout(
    uuid,
    uuid,
    uuid
) from public, anon, authenticated;
revoke all on function public.attach_payment_checkout_session(uuid, text)
    from public, anon, authenticated;
revoke all on function public.mark_payment_checkout_failed(uuid, text)
    from public, anon, authenticated;

grant execute on function public.transition_payment_request_status(
    uuid,
    text,
    uuid,
    jsonb
) to service_role;
grant execute on function public.prepare_payment_request_checkout(
    uuid,
    uuid,
    uuid
) to service_role;
grant execute on function public.attach_payment_checkout_session(uuid, text)
    to service_role;
grant execute on function public.mark_payment_checkout_failed(uuid, text)
    to service_role;
