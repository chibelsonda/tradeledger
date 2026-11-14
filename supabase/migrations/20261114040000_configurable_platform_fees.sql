create table public.organization_platform_fees (
    organization_id uuid not null references public.organizations(id) on delete cascade,
    currency varchar(3) not null,
    enabled boolean not null default false,
    percentage_basis_points integer not null default 0,
    fixed_amount bigint not null default 0,
    created_by uuid not null references auth.users(id) on delete restrict,
    updated_by uuid not null references auth.users(id) on delete restrict,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (organization_id, currency),
    constraint organization_platform_fees_currency_format check (
        currency ~ '^[a-z]{3}$'
    ),
    constraint organization_platform_fees_percentage_range check (
        percentage_basis_points between 0 and 9900
    ),
    constraint organization_platform_fees_fixed_amount_range check (
        fixed_amount between 0 and 99999999
    ),
    constraint organization_platform_fees_enabled_value check (
        not enabled or percentage_basis_points > 0 or fixed_amount > 0
    )
);

comment on table public.organization_platform_fees is
    'Tenant-owned platform fee policies. Checkout snapshots the applicable policy before contacting Stripe.';

create index organization_platform_fees_updated_index
    on public.organization_platform_fees (organization_id, updated_at desc);

create trigger organization_platform_fees_set_updated_at
before update on public.organization_platform_fees
for each row execute function public.set_updated_at();

alter table public.organization_platform_fees enable row level security;

create policy "Financial roles can read platform fee configuration"
    on public.organization_platform_fees
    for select
    to authenticated
    using (
        public.has_organization_role(
            organization_id,
            array['owner', 'admin', 'accountant']
        )
    );

revoke all on table public.organization_platform_fees from public, anon, authenticated;
grant select on table public.organization_platform_fees to authenticated;

alter table public.payments
    add column platform_fee_basis_points integer not null default 0,
    add column platform_fee_fixed_amount bigint not null default 0,
    add column platform_fee_amount bigint not null default 0,
    add column platform_fee_configured_at timestamptz;

update public.payments
set platform_fee_configured_at = created_at
where destination_charge
  and platform_fee_configured_at is null;

alter table public.payments
    add constraint payments_platform_fee_basis_points_range check (
        platform_fee_basis_points between 0 and 9900
    ),
    add constraint payments_platform_fee_fixed_amount_range check (
        platform_fee_fixed_amount between 0 and 99999999
    ),
    add constraint payments_platform_fee_amount_range check (
        platform_fee_amount >= 0 and platform_fee_amount < amount_total
    ),
    add constraint payments_platform_fee_destination_check check (
        platform_fee_amount = 0 or destination_charge
    );

comment on column public.payments.platform_fee_amount is
    'Immutable application-fee snapshot in integer minor units for the Stripe Checkout attempt.';

create function public.set_organization_platform_fee(
    p_organization_id uuid,
    p_currency text,
    p_percentage_basis_points integer,
    p_fixed_amount bigint,
    p_enabled boolean
)
returns public.organization_platform_fees
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_user_id uuid := auth.uid();
    normalized_currency text := lower(btrim(p_currency));
    fee_record public.organization_platform_fees%rowtype;
begin
    if current_user_id is null then
        raise exception 'Authentication is required.' using errcode = '28000';
    end if;

    if not public.has_organization_role(
        p_organization_id,
        array['owner', 'admin']
    ) then
        raise exception 'You are not allowed to configure platform fees.'
            using errcode = '42501';
    end if;

    if normalized_currency !~ '^[a-z]{3}$' then
        raise exception 'Currency must be a three-letter lowercase code.'
            using errcode = '22023';
    end if;

    if p_percentage_basis_points is null
       or p_percentage_basis_points not between 0 and 9900 then
        raise exception 'Percentage fee must be between 0 and 99 percent.'
            using errcode = '22023';
    end if;

    if p_fixed_amount is null or p_fixed_amount not between 0 and 99999999 then
        raise exception 'Fixed fee must be a valid non-negative minor-unit amount.'
            using errcode = '22023';
    end if;

    if coalesce(p_enabled, false)
       and p_percentage_basis_points = 0
       and p_fixed_amount = 0 then
        raise exception 'An enabled platform fee requires a percentage or fixed amount.'
            using errcode = '22023';
    end if;

    insert into public.organization_platform_fees (
        organization_id,
        currency,
        enabled,
        percentage_basis_points,
        fixed_amount,
        created_by,
        updated_by
    ) values (
        p_organization_id,
        normalized_currency,
        coalesce(p_enabled, false),
        p_percentage_basis_points,
        p_fixed_amount,
        current_user_id,
        current_user_id
    )
    on conflict (organization_id, currency) do update
    set
        enabled = excluded.enabled,
        percentage_basis_points = excluded.percentage_basis_points,
        fixed_amount = excluded.fixed_amount,
        updated_by = current_user_id,
        updated_at = now()
    returning * into fee_record;

    insert into public.audit_events (
        organization_id,
        actor_user_id,
        action,
        entity_type,
        entity_id,
        metadata
    ) values (
        p_organization_id,
        current_user_id,
        'platform_fee.updated',
        'platform_fee_configuration',
        p_organization_id,
        jsonb_build_object(
            'currency', fee_record.currency,
            'enabled', fee_record.enabled,
            'percentage_basis_points', fee_record.percentage_basis_points,
            'fixed_amount', fee_record.fixed_amount
        )
    );

    return fee_record;
end;
$$;

revoke all on function public.set_organization_platform_fee(
    uuid,
    text,
    integer,
    bigint,
    boolean
) from public, anon;
grant execute on function public.set_organization_platform_fee(
    uuid,
    text,
    integer,
    bigint,
    boolean
) to authenticated;

drop function public.prepare_payment_request_checkout(uuid, uuid, uuid);

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
    destination_charge boolean,
    platform_fee_amount bigint,
    subcontractor_transfer_amount bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    request_record record;
    payout_record public.subcontractor_payout_accounts%rowtype;
    existing_payment public.payments%rowtype;
    fee_record public.organization_platform_fees%rowtype;
    payer_email text;
    calculated_fee bigint := 0;
    snapshot_basis_points integer := 0;
    snapshot_fixed_amount bigint := 0;
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

    if existing_payment.id is null or existing_payment.platform_fee_configured_at is null then
        select fee.*
        into fee_record
        from public.organization_platform_fees as fee
        where fee.organization_id = request_record.organization_id
          and fee.currency = request_record.currency;

        if fee_record.enabled then
            snapshot_basis_points := fee_record.percentage_basis_points;
            snapshot_fixed_amount := fee_record.fixed_amount;
            calculated_fee := floor(
                (
                    request_record.net_amount::numeric * snapshot_basis_points + 5000
                ) / 10000
            )::bigint + snapshot_fixed_amount;
        end if;

        if calculated_fee >= request_record.net_amount then
            raise exception 'Configured platform fee must be lower than the payment amount.'
                using errcode = '55000';
        end if;
    else
        snapshot_basis_points := existing_payment.platform_fee_basis_points;
        snapshot_fixed_amount := existing_payment.platform_fee_fixed_amount;
        calculated_fee := existing_payment.platform_fee_amount;
    end if;

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
            destination_charge,
            platform_fee_basis_points,
            platform_fee_fixed_amount,
            platform_fee_amount,
            platform_fee_configured_at
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
            true,
            snapshot_basis_points,
            snapshot_fixed_amount,
            calculated_fee,
            now()
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
            platform_fee_basis_points = snapshot_basis_points,
            platform_fee_fixed_amount = snapshot_fixed_amount,
            platform_fee_amount = calculated_fee,
            platform_fee_configured_at = coalesce(
                payment.platform_fee_configured_at,
                now()
            ),
            updated_at = now()
        where payment.id = existing_payment.id
        returning payment.* into existing_payment;
    elsif existing_payment.status not in ('pending', 'processing') then
        raise exception 'This payment request already has a completed payment.'
            using errcode = '55000';
    elsif existing_payment.stripe_checkout_session_id is null then
        update public.payments as payment
        set
            destination_charge = true,
            platform_fee_basis_points = snapshot_basis_points,
            platform_fee_fixed_amount = snapshot_fixed_amount,
            platform_fee_amount = calculated_fee,
            platform_fee_configured_at = coalesce(
                payment.platform_fee_configured_at,
                now()
            ),
            updated_at = now()
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
                'destination_charge', existing_payment.destination_charge,
                'platform_fee_amount', existing_payment.platform_fee_amount,
                'subcontractor_transfer_amount',
                    existing_payment.amount_total - existing_payment.platform_fee_amount
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
        existing_payment.destination_charge,
        existing_payment.platform_fee_amount,
        existing_payment.amount_total - existing_payment.platform_fee_amount;
end;
$$;

revoke all on function public.prepare_payment_request_checkout(uuid, uuid, uuid)
    from public, anon, authenticated;
grant execute on function public.prepare_payment_request_checkout(uuid, uuid, uuid)
    to service_role;

drop function public.prepare_payment_refund(uuid, uuid, uuid);

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
    destination_charge boolean,
    refund_application_fee boolean
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
                'reverse_transfer', payment_record.destination_charge,
                'refund_application_fee', payment_record.platform_fee_amount > 0
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
        payment_record.destination_charge,
        payment_record.platform_fee_amount > 0;
end;
$$;

revoke all on function public.prepare_payment_refund(uuid, uuid, uuid)
    from public, anon, authenticated;
grant execute on function public.prepare_payment_refund(uuid, uuid, uuid)
    to service_role;
