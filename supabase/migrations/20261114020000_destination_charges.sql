alter table public.payments
    add column if not exists destination_charge boolean not null default false;

comment on column public.payments.destination_charge is
    'True when Stripe Checkout routed the payment to a connected subcontractor account.';

drop function if exists public.prepare_payment_request_checkout(uuid, uuid, uuid);

create function public.prepare_payment_request_checkout(
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
    stripe_checkout_session_id text,
    stripe_destination_account_id text,
    destination_charge boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    request_record record;
    payout_record public.subcontractor_payout_accounts%rowtype;
    existing_payment public.payments%rowtype;
    payer_email text;
begin
    if p_user_id is null then
        raise exception 'Authentication is required.' using errcode = '28000';
    end if;

    select
        payment_request.id,
        payment_request.organization_id,
        payment_request.subcontractor_id,
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

    select payout_account.*
    into payout_record
    from public.subcontractor_payout_accounts as payout_account
    where payout_account.organization_id = request_record.organization_id
      and payout_account.subcontractor_id = request_record.subcontractor_id
    for update;

    if payout_record.id is null
       or payout_record.stripe_account_id is null
       or payout_record.onboarding_status <> 'ready'
       or not payout_record.payouts_enabled then
        raise exception 'The subcontractor must complete payout onboarding before checkout.'
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
            customer_email,
            destination_charge
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
            payer_email,
            true
        ) returning * into existing_payment;
    elsif request_record.status = 'failed' then
        update public.payments as payment
        set
            user_id = p_user_id,
            reference = case
                when payment.stripe_checkout_session_id is null then payment.reference
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
            destination_charge = true,
            updated_at = now()
        where payment.id = existing_payment.id
        returning payment.* into existing_payment;
    elsif existing_payment.status not in ('pending', 'processing') then
        raise exception 'This payment request already has a completed payment.'
            using errcode = '55000';
    elsif existing_payment.stripe_checkout_session_id is null then
        update public.payments as payment
        set destination_charge = true, updated_at = now()
        where payment.id = existing_payment.id
        returning payment.* into existing_payment;
    end if;

    if request_record.status in ('approved', 'failed') then
        perform public.transition_payment_request_status(
            p_payment_request_id,
            'checkout_created',
            p_user_id,
            jsonb_build_object(
                'payment_reference', existing_payment.reference,
                'destination_charge', existing_payment.destination_charge
            )
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
        existing_payment.stripe_checkout_session_id::text,
        payout_record.stripe_account_id,
        existing_payment.destination_charge;
end;
$$;

revoke all on function public.prepare_payment_request_checkout(uuid, uuid, uuid)
    from public, anon, authenticated;
grant execute on function public.prepare_payment_request_checkout(uuid, uuid, uuid)
    to service_role;

drop function if exists public.prepare_payment_refund(uuid, uuid, uuid);

create function public.prepare_payment_refund(
    p_payment_request_id uuid,
    p_user_id uuid,
    p_reference uuid
)
returns table (
    refund_reference uuid,
    organization_id uuid,
    payment_request_id uuid,
    payment_reference uuid,
    stripe_payment_intent_id text,
    stripe_refund_id text,
    amount bigint,
    currency text,
    refund_status text,
    destination_charge boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    request_record public.payment_requests%rowtype;
    payment_record public.payments%rowtype;
    refund_record public.payment_refunds%rowtype;
    remaining_amount bigint;
begin
    if p_user_id is null then
        raise exception 'Authentication is required.' using errcode = '28000';
    end if;

    select *
    into request_record
    from public.payment_requests as payment_request
    where payment_request.id = p_payment_request_id
    for update;

    if not found then
        raise exception 'Payment request was not found.' using errcode = 'P0002';
    end if;

    if not exists (
        select 1
        from public.organization_memberships as membership
        where membership.organization_id = request_record.organization_id
          and membership.user_id = p_user_id
          and membership.status = 'active'
          and membership.role in ('owner', 'accountant')
    ) then
        raise exception 'You are not allowed to refund this payment.'
            using errcode = '42501';
    end if;

    select *
    into payment_record
    from public.payments as payment
    where payment.payment_request_id = p_payment_request_id
    for update;

    if payment_record.id is null
       or payment_record.stripe_payment_intent_id is null
       or payment_record.status not in ('paid', 'partially_refunded') then
        raise exception 'Only a settled Stripe payment can be refunded.'
            using errcode = '55000';
    end if;

    remaining_amount := payment_record.amount_total - payment_record.amount_refunded;

    if remaining_amount <= 0 then
        raise exception 'This payment is already fully refunded.'
            using errcode = '55000';
    end if;

    select *
    into refund_record
    from public.payment_refunds as refund
    where refund.payment_id = payment_record.id
      and refund.status in ('pending', 'requires_action')
    order by refund.created_at desc
    limit 1
    for update;

    if refund_record.id is null then
        insert into public.payment_refunds (
            organization_id,
            payment_id,
            payment_request_id,
            reference,
            amount,
            currency,
            requested_by
        ) values (
            request_record.organization_id,
            payment_record.id,
            p_payment_request_id,
            p_reference,
            remaining_amount,
            payment_record.currency,
            p_user_id
        ) returning * into refund_record;

        insert into public.audit_events (
            organization_id,
            actor_user_id,
            action,
            entity_type,
            entity_id,
            metadata
        ) values (
            request_record.organization_id,
            p_user_id,
            'refund.requested',
            'payment_request',
            p_payment_request_id,
            jsonb_build_object(
                'refund_reference', refund_record.reference,
                'amount', refund_record.amount,
                'currency', refund_record.currency,
                'reverse_transfer', payment_record.destination_charge
            )
        );
    end if;

    return query
    select
        refund_record.reference,
        request_record.organization_id,
        p_payment_request_id,
        payment_record.reference,
        payment_record.stripe_payment_intent_id::text,
        refund_record.stripe_refund_id::text,
        refund_record.amount,
        refund_record.currency::text,
        refund_record.status::text,
        payment_record.destination_charge;
end;
$$;

revoke all on function public.prepare_payment_refund(uuid, uuid, uuid)
    from public, anon, authenticated;
grant execute on function public.prepare_payment_refund(uuid, uuid, uuid)
    to service_role;
