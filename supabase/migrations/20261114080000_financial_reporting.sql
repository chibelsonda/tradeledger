create or replace function public.get_organization_financial_report(
    p_organization_id uuid,
    p_period_start date,
    p_period_end date,
    p_currency text default null
)
returns table (
    currency text,
    collected_amount bigint,
    refunded_amount bigint,
    platform_fee_amount bigint,
    routed_amount bigint,
    reversed_amount bigint,
    paid_out_amount bigint,
    failed_payout_amount bigint,
    disputed_amount bigint,
    payment_count bigint,
    refund_count bigint,
    transfer_count bigint,
    payout_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    normalized_currency text := nullif(lower(trim(coalesce(p_currency, ''))), '');
    period_start timestamptz;
    period_end_exclusive timestamptz;
begin
    if auth.uid() is null then
        raise exception 'Authentication is required.' using errcode = '42501';
    end if;

    if not public.has_organization_role(
        p_organization_id,
        array['owner', 'admin', 'accountant']
    ) then
        raise exception 'Financial report access is not permitted.' using errcode = '42501';
    end if;

    if p_period_start is null
       or p_period_end is null
       or p_period_end < p_period_start
       or p_period_end - p_period_start > 366 then
        raise exception 'The reporting period must be between 1 and 367 days.'
            using errcode = '22023';
    end if;

    if normalized_currency is not null
       and normalized_currency !~ '^[a-z]{3}$' then
        raise exception 'Currency must be a three-letter code.' using errcode = '22023';
    end if;

    period_start := p_period_start::timestamptz;
    period_end_exclusive := (p_period_end + 1)::timestamptz;

    return query
    with payment_totals as (
        select
            payment.currency::text as currency,
            sum(payment.amount_total)::bigint as collected_amount,
            sum(payment.platform_fee_amount)::bigint as platform_fee_amount,
            count(*)::bigint as payment_count
        from public.payments as payment
        where payment.organization_id = p_organization_id
          and payment.status in ('paid', 'partially_refunded', 'refunded')
          and coalesce(payment.paid_at, payment.created_at) >= period_start
          and coalesce(payment.paid_at, payment.created_at) < period_end_exclusive
          and (normalized_currency is null or payment.currency = normalized_currency)
        group by payment.currency
    ),
    refund_totals as (
        select
            refund.currency::text as currency,
            sum(refund.amount)::bigint as refunded_amount,
            count(*)::bigint as refund_count
        from public.payment_refunds as refund
        where refund.organization_id = p_organization_id
          and refund.status = 'succeeded'
          and coalesce(refund.completed_at, refund.created_at) >= period_start
          and coalesce(refund.completed_at, refund.created_at) < period_end_exclusive
          and (normalized_currency is null or refund.currency = normalized_currency)
        group by refund.currency
    ),
    transfer_totals as (
        select
            transfer.currency::text as currency,
            sum(transfer.amount)::bigint as routed_amount,
            sum(transfer.reversed_amount)::bigint as reversed_amount,
            count(*)::bigint as transfer_count
        from public.payment_transfers as transfer
        where transfer.organization_id = p_organization_id
          and transfer.stripe_created_at >= period_start
          and transfer.stripe_created_at < period_end_exclusive
          and (normalized_currency is null or transfer.currency = normalized_currency)
        group by transfer.currency
    ),
    payout_totals as (
        select
            payout.currency::text as currency,
            sum(payout.amount) filter (where payout.status = 'paid')::bigint
                as paid_out_amount,
            sum(payout.amount) filter (where payout.status = 'failed')::bigint
                as failed_payout_amount,
            count(*)::bigint as payout_count
        from public.connected_payouts as payout
        where payout.organization_id = p_organization_id
          and payout.stripe_created_at >= period_start
          and payout.stripe_created_at < period_end_exclusive
          and (normalized_currency is null or payout.currency = normalized_currency)
        group by payout.currency
    ),
    dispute_totals as (
        select
            dispute.currency::text as currency,
            sum(dispute.amount)::bigint as disputed_amount
        from public.payment_disputes as dispute
        where dispute.organization_id = p_organization_id
          and dispute.created_at >= period_start
          and dispute.created_at < period_end_exclusive
          and dispute.status not in ('won', 'prevented', 'appeal_won', 'warning_closed')
          and (normalized_currency is null or dispute.currency = normalized_currency)
        group by dispute.currency
    ),
    currencies as (
        select payment_totals.currency from payment_totals
        union select refund_totals.currency from refund_totals
        union select transfer_totals.currency from transfer_totals
        union select payout_totals.currency from payout_totals
        union select dispute_totals.currency from dispute_totals
    )
    select
        currencies.currency,
        coalesce(payment_totals.collected_amount, 0)::bigint,
        coalesce(refund_totals.refunded_amount, 0)::bigint,
        coalesce(payment_totals.platform_fee_amount, 0)::bigint,
        coalesce(transfer_totals.routed_amount, 0)::bigint,
        coalesce(transfer_totals.reversed_amount, 0)::bigint,
        coalesce(payout_totals.paid_out_amount, 0)::bigint,
        coalesce(payout_totals.failed_payout_amount, 0)::bigint,
        coalesce(dispute_totals.disputed_amount, 0)::bigint,
        coalesce(payment_totals.payment_count, 0)::bigint,
        coalesce(refund_totals.refund_count, 0)::bigint,
        coalesce(transfer_totals.transfer_count, 0)::bigint,
        coalesce(payout_totals.payout_count, 0)::bigint
    from currencies
    left join payment_totals using (currency)
    left join refund_totals using (currency)
    left join transfer_totals using (currency)
    left join payout_totals using (currency)
    left join dispute_totals using (currency)
    order by currencies.currency;
end;
$$;

create or replace function public.get_organization_financial_statement(
    p_organization_id uuid,
    p_period_start date,
    p_period_end date,
    p_currency text default null,
    p_limit integer default 500
)
returns table (
    occurred_at timestamptz,
    entry_type text,
    reference text,
    description text,
    project_name text,
    subcontractor_name text,
    amount bigint,
    currency text,
    status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    normalized_currency text := nullif(lower(trim(coalesce(p_currency, ''))), '');
    period_start timestamptz;
    period_end_exclusive timestamptz;
begin
    if auth.uid() is null then
        raise exception 'Authentication is required.' using errcode = '42501';
    end if;

    if not public.has_organization_role(
        p_organization_id,
        array['owner', 'admin', 'accountant']
    ) then
        raise exception 'Financial statement access is not permitted.' using errcode = '42501';
    end if;

    if p_period_start is null
       or p_period_end is null
       or p_period_end < p_period_start
       or p_period_end - p_period_start > 366 then
        raise exception 'The reporting period must be between 1 and 367 days.'
            using errcode = '22023';
    end if;

    if normalized_currency is not null
       and normalized_currency !~ '^[a-z]{3}$' then
        raise exception 'Currency must be a three-letter code.' using errcode = '22023';
    end if;

    if p_limit is null or p_limit < 1 or p_limit > 1000 then
        raise exception 'Statement limit must be between 1 and 1000.' using errcode = '22023';
    end if;

    period_start := p_period_start::timestamptz;
    period_end_exclusive := (p_period_end + 1)::timestamptz;

    return query
    select
        activity.occurred_at,
        activity.entry_type,
        activity.reference,
        activity.description,
        activity.project_name,
        activity.subcontractor_name,
        activity.amount,
        activity.currency,
        activity.status
    from (
        select
            coalesce(payment.paid_at, payment.created_at)::timestamptz as occurred_at,
            'payment'::text as entry_type,
            payment.reference::text as reference,
            request.description::text as description,
            project.name::text as project_name,
            subcontractor.company_name::text as subcontractor_name,
            payment.amount_total::bigint as amount,
            payment.currency::text as currency,
            payment.status::text as status
        from public.payments as payment
        join public.payment_requests as request on request.id = payment.payment_request_id
        join public.projects as project on project.id = request.project_id
        join public.subcontractors as subcontractor on subcontractor.id = request.subcontractor_id
        where payment.organization_id = p_organization_id
          and payment.status in ('paid', 'partially_refunded', 'refunded')

        union all

        select
            coalesce(refund.completed_at, refund.created_at),
            'refund'::text,
            refund.reference::text,
            request.description::text,
            project.name::text,
            subcontractor.company_name::text,
            -refund.amount::bigint,
            refund.currency::text,
            refund.status::text
        from public.payment_refunds as refund
        join public.payment_requests as request on request.id = refund.payment_request_id
        join public.projects as project on project.id = request.project_id
        join public.subcontractors as subcontractor on subcontractor.id = request.subcontractor_id
        where refund.organization_id = p_organization_id

        union all

        select
            transfer.stripe_created_at,
            'transfer'::text,
            ('TRANSFER-' || upper(left(transfer.id::text, 8)))::text,
            request.description::text,
            project.name::text,
            subcontractor.company_name::text,
            -transfer.amount::bigint,
            transfer.currency::text,
            transfer.status::text
        from public.payment_transfers as transfer
        join public.payment_requests as request on request.id = transfer.payment_request_id
        join public.projects as project on project.id = request.project_id
        join public.subcontractors as subcontractor on subcontractor.id = transfer.subcontractor_id
        where transfer.organization_id = p_organization_id

        union all

        select
            transfer.updated_at,
            'transfer_reversal'::text,
            ('REVERSAL-' || upper(left(transfer.id::text, 8)))::text,
            request.description::text,
            project.name::text,
            subcontractor.company_name::text,
            transfer.reversed_amount::bigint,
            transfer.currency::text,
            transfer.status::text
        from public.payment_transfers as transfer
        join public.payment_requests as request on request.id = transfer.payment_request_id
        join public.projects as project on project.id = request.project_id
        join public.subcontractors as subcontractor on subcontractor.id = transfer.subcontractor_id
        where transfer.organization_id = p_organization_id
          and transfer.reversed_amount > 0

        union all

        select
            payout.stripe_created_at,
            'payout'::text,
            ('PAYOUT-' || upper(left(payout.id::text, 8)))::text,
            'Connected bank payout'::text,
            null::text,
            subcontractor.company_name::text,
            -payout.amount::bigint,
            payout.currency::text,
            payout.status::text
        from public.connected_payouts as payout
        join public.subcontractors as subcontractor on subcontractor.id = payout.subcontractor_id
        where payout.organization_id = p_organization_id

        union all

        select
            dispute.created_at,
            'dispute'::text,
            ('DISPUTE-' || upper(left(dispute.id::text, 8)))::text,
            request.description::text,
            project.name::text,
            subcontractor.company_name::text,
            -dispute.amount::bigint,
            dispute.currency::text,
            dispute.status::text
        from public.payment_disputes as dispute
        join public.payment_requests as request on request.id = dispute.payment_request_id
        join public.projects as project on project.id = request.project_id
        join public.subcontractors as subcontractor on subcontractor.id = request.subcontractor_id
        where dispute.organization_id = p_organization_id
    ) as activity
    where activity.occurred_at >= period_start
      and activity.occurred_at < period_end_exclusive
      and (normalized_currency is null or activity.currency = normalized_currency)
    order by activity.occurred_at desc, activity.entry_type, activity.reference
    limit p_limit;
end;
$$;

revoke all on function public.get_organization_financial_report(uuid, date, date, text)
    from public, anon, authenticated;
revoke all on function public.get_organization_financial_statement(uuid, date, date, text, integer)
    from public, anon, authenticated;

grant execute on function public.get_organization_financial_report(uuid, date, date, text)
    to authenticated, service_role;
grant execute on function public.get_organization_financial_statement(uuid, date, date, text, integer)
    to authenticated, service_role;

comment on function public.get_organization_financial_report(uuid, date, date, text) is
    'Returns tenant-authorized financial totals by currency without exposing Stripe identifiers.';
comment on function public.get_organization_financial_statement(uuid, date, date, text, integer) is
    'Returns a bounded tenant-authorized financial activity statement without sensitive account data.';
