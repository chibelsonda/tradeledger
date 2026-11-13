-- Keep checkout compatible with projects created before the checkout-session
-- identifier column was standardized on PostgreSQL text.
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
        existing_payment.stripe_checkout_session_id::text;
end;
$$;

comment on function public.prepare_payment_request_checkout(uuid, uuid, uuid) is
    'Prepares a tenant-scoped checkout ledger entry, including compatibility with legacy varchar Stripe session columns.';
