-- Preserve RPC text contracts for Stripe identifiers stored in legacy varchar columns.
create or replace function public.prepare_payment_refund(
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
    refund_status text
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
                'currency', refund_record.currency
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
        refund_record.status::text;
end;
$$;

create or replace function public.prepare_payment_reconciliation(
    p_payment_request_id uuid,
    p_user_id uuid
)
returns table (
    payment_reference uuid,
    organization_id uuid,
    payment_request_id uuid,
    stripe_checkout_session_id text,
    stripe_payment_intent_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    payment_record public.payments%rowtype;
begin
    select payment.*
    into payment_record
    from public.payments as payment
    where payment.payment_request_id = p_payment_request_id;

    if payment_record.id is null then
        raise exception 'Payment was not found.' using errcode = 'P0002';
    end if;

    if not exists (
        select 1
        from public.organization_memberships as membership
        where membership.organization_id = payment_record.organization_id
          and membership.user_id = p_user_id
          and membership.status = 'active'
          and membership.role in ('owner', 'admin', 'accountant')
    ) then
        raise exception 'You are not allowed to reconcile this payment.'
            using errcode = '42501';
    end if;

    if payment_record.stripe_checkout_session_id is null then
        raise exception 'This payment does not have a Stripe Checkout Session.'
            using errcode = '55000';
    end if;

    return query
    select
        payment_record.reference,
        payment_record.organization_id,
        p_payment_request_id,
        payment_record.stripe_checkout_session_id::text,
        payment_record.stripe_payment_intent_id::text;
end;
$$;

comment on function public.prepare_payment_refund(uuid, uuid, uuid) is
    'Prepares an idempotent full refund with legacy varchar Stripe identifier compatibility.';

comment on function public.prepare_payment_reconciliation(uuid, uuid) is
    'Prepares tenant-authorized Stripe reconciliation with legacy varchar identifier compatibility.';
