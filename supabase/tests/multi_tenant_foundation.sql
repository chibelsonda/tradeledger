\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email)
values
    ('00000000-0000-4000-8000-000000000001', 'owner-a@example.test'),
    ('00000000-0000-4000-8000-000000000002', 'outsider-b@example.test');

set local role authenticated;
set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000001';

select public.create_organization('Alpha Trades', 'alpha-trades');

select id as organization_a_id
from public.organizations
where slug = 'alpha-trades'
\gset

select set_config('test.organization_a_id', :'organization_a_id', true);

insert into public.projects (organization_id, name, code, status)
values (:'organization_a_id', 'Cedar Kitchen', 'CEDAR-01', 'active')
returning id as project_a_id
\gset

select set_config('test.project_a_id', :'project_a_id', true);

insert into public.subcontractors (
    organization_id,
    company_name,
    contact_name,
    email,
    status
)
values (
    :'organization_a_id',
    'Fine Finish Carpentry',
    'Hector Ramirez',
    'hector@example.test',
    'active'
)
returning id as subcontractor_a_id
\gset

select set_config('test.subcontractor_a_id', :'subcontractor_a_id', true);

select public.create_payment_request(
    :'organization_a_id',
    :'project_a_id',
    :'subcontractor_a_id',
    'Kitchen trim milestone',
    10500,
    1000,
    'usd'
) as payment_request_a_id
\gset

select set_config('test.payment_request_a_id', :'payment_request_a_id', true);

do $$
declare
    request_record public.payment_requests%rowtype;
begin
    select *
    into request_record
    from public.payment_requests
    where id = current_setting('test.payment_request_a_id')::uuid;

    if request_record.gross_amount <> 10500 then
        raise exception 'Expected gross amount 10500, received %.', request_record.gross_amount;
    end if;

    if request_record.retainage_amount <> 1050 then
        raise exception 'Expected retainage amount 1050, received %.', request_record.retainage_amount;
    end if;

    if request_record.net_amount <> 9450 then
        raise exception 'Expected net amount 9450, received %.', request_record.net_amount;
    end if;
end;
$$;

select public.submit_payment_request(:'payment_request_a_id') as submitted
\gset

select public.approve_payment_request(:'payment_request_a_id') as approved
\gset

do $$
declare
    request_status text;
    event_count integer;
begin
    select status
    into request_status
    from public.payment_requests
    where id = current_setting('test.payment_request_a_id')::uuid;

    if request_status <> 'approved' then
        raise exception 'Expected approved status, received %.', request_status;
    end if;

    select count(*)
    into event_count
    from public.audit_events
    where organization_id = current_setting('test.organization_a_id')::uuid;

    if event_count <> 6 then
        raise exception 'Expected 6 audit events, received %.', event_count;
    end if;
end;
$$;

do $$
begin
    begin
        execute 'update public.audit_events set action = ''tampered''';
        raise exception 'Authenticated users must not be able to alter audit events.';
    exception
        when insufficient_privilege then null;
    end;
end;
$$;

reset role;
set local role service_role;

select
    payment_reference as checkout_payment_reference,
    amount_total as checkout_amount_total
from public.prepare_payment_request_checkout(
    :'payment_request_a_id',
    '00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001'
)
\gset

do $$
declare
    request_status text;
    ledger_amount bigint;
begin
    select status
    into request_status
    from public.payment_requests
    where id = current_setting('test.payment_request_a_id')::uuid;

    if request_status <> 'checkout_created' then
        raise exception 'Expected checkout_created status, received %.', request_status;
    end if;

    select amount_total
    into ledger_amount
    from public.payments
    where payment_request_id = current_setting('test.payment_request_a_id')::uuid;

    if ledger_amount <> 9450 then
        raise exception 'Expected database-owned checkout amount 9450, received %.', ledger_amount;
    end if;
end;
$$;

select public.attach_payment_checkout_session(
    :'checkout_payment_reference',
    'cs_test_tradeledger_001'
) as attached
\gset

select public.process_stripe_webhook(
    'evt_tradeledger_paid_001',
    'checkout.session.completed',
    'cs_test_tradeledger_001',
    'paid',
    'pi_tradeledger_001',
    'owner-a@example.test'
) as webhook_processed
\gset

select public.process_stripe_webhook(
    'evt_tradeledger_paid_001',
    'checkout.session.completed',
    'cs_test_tradeledger_001',
    'paid',
    'pi_tradeledger_001',
    'owner-a@example.test'
) as duplicate_processed
\gset

do $$
declare
    request_status text;
    payment_status text;
    event_count integer;
    audit_count integer;
begin
    select status
    into request_status
    from public.payment_requests
    where id = current_setting('test.payment_request_a_id')::uuid;

    select status
    into payment_status
    from public.payments
    where payment_request_id = current_setting('test.payment_request_a_id')::uuid;

    select count(*)
    into event_count
    from public.stripe_webhook_events
    where event_id = 'evt_tradeledger_paid_001';

    select count(*)
    into audit_count
    from public.audit_events
    where organization_id = current_setting('test.organization_a_id')::uuid;

    if request_status <> 'paid' or payment_status <> 'paid' then
        raise exception 'Expected paid request/payment, received %/%',
            request_status,
            payment_status;
    end if;

    if event_count <> 1 then
        raise exception 'Expected one idempotent Stripe event, received %.', event_count;
    end if;

    if audit_count <> 8 then
        raise exception 'Expected 8 audit events after checkout, received %.', audit_count;
    end if;
end;
$$;

do $$
begin
    begin
        perform public.transition_payment_request_status(
            current_setting('test.payment_request_a_id')::uuid,
            'processing',
            null,
            '{}'::jsonb
        );
        raise exception 'A paid request must not transition back to processing.';
    exception
        when object_not_in_prerequisite_state then null;
    end;
end;
$$;

do $$
begin
    begin
        perform *
        from public.prepare_payment_refund(
            current_setting('test.payment_request_a_id')::uuid,
            '00000000-0000-4000-8000-000000000002',
            '20000000-0000-4000-8000-000000000001'
        );
        raise exception 'An outsider must not be able to prepare a refund.';
    exception
        when insufficient_privilege then null;
    end;
end;
$$;

select
    refund_reference as prepared_refund_reference,
    amount as prepared_refund_amount
from public.prepare_payment_refund(
    :'payment_request_a_id',
    '00000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001'
)
\gset

select set_config('test.prepared_refund_amount', :'prepared_refund_amount', true);

do $$
begin
    if current_setting('test.prepared_refund_amount')::bigint <> 9450 then
        raise exception 'Expected database-owned refund amount 9450, received %.',
            current_setting('test.prepared_refund_amount');
    end if;
end;
$$;

select public.apply_payment_refund_status(
    :'prepared_refund_reference',
    're_tradeledger_001',
    'succeeded',
    null,
    '00000000-0000-4000-8000-000000000001'
) as refund_applied
\gset

select public.apply_payment_refund_status(
    :'prepared_refund_reference',
    're_tradeledger_001',
    'succeeded',
    null,
    '00000000-0000-4000-8000-000000000001'
) as duplicate_refund_applied
\gset

do $$
declare
    request_record public.payment_requests%rowtype;
    payment_record public.payments%rowtype;
    succeeded_refunds integer;
begin
    select * into request_record
    from public.payment_requests
    where id = current_setting('test.payment_request_a_id')::uuid;

    select * into payment_record
    from public.payments
    where payment_request_id = current_setting('test.payment_request_a_id')::uuid;

    select count(*) into succeeded_refunds
    from public.payment_refunds
    where payment_request_id = current_setting('test.payment_request_a_id')::uuid
      and status = 'succeeded';

    if request_record.status <> 'refunded'
       or payment_record.status <> 'refunded'
       or request_record.refunded_amount <> 9450
       or payment_record.amount_refunded <> 9450 then
        raise exception 'Expected fully refunded request/payment ledger.';
    end if;

    if succeeded_refunds <> 1 then
        raise exception 'Expected one idempotent succeeded refund, received %.',
            succeeded_refunds;
    end if;
end;
$$;

select public.reconcile_stripe_payment(
    :'payment_request_a_id',
    '00000000-0000-4000-8000-000000000001',
    'complete',
    'paid',
    'pi_tradeledger_001',
    '[{
        "id": "re_tradeledger_001",
        "amount": 9450,
        "currency": "usd",
        "status": "succeeded",
        "reason": "requested_by_customer",
        "failure_reason": null
    }]'::jsonb
) as reconciled_status
\gset

select set_config('test.reconciled_status', :'reconciled_status', true);

do $$
declare
    refund_count integer;
begin
    if current_setting('test.reconciled_status') <> 'refunded' then
        raise exception 'Expected refunded reconciliation status, received %.',
            current_setting('test.reconciled_status');
    end if;

    select count(*) into refund_count
    from public.payment_refunds
    where stripe_refund_id = 're_tradeledger_001';

    if refund_count <> 1 then
        raise exception 'Reconciliation duplicated the Stripe refund.';
    end if;
end;
$$;

select public.record_stripe_webhook_failure(
    'evt_tradeledger_failure_001',
    'refund.updated',
    're_tradeledger_001',
    'ledger_write_failed',
    'Synthetic processing failure.'
) as first_failure_recorded
\gset

select public.record_stripe_webhook_failure(
    'evt_tradeledger_failure_001',
    'refund.updated',
    're_tradeledger_001',
    'ledger_write_failed',
    'Synthetic processing failure on retry.'
) as retry_failure_recorded
\gset

do $$
declare
    failure_record public.stripe_webhook_failures%rowtype;
begin
    select * into failure_record
    from public.stripe_webhook_failures
    where event_id = 'evt_tradeledger_failure_001';

    if failure_record.organization_id <> current_setting('test.organization_a_id')::uuid
       or failure_record.attempts <> 2
       or failure_record.resolved_at is not null then
        raise exception 'Webhook failure retry tracking is incorrect.';
    end if;
end;
$$;

select public.resolve_stripe_webhook_failure(
    'evt_tradeledger_failure_001',
    'verified_by_contract_test'
) as failure_resolved
\gset

select public.record_stripe_webhook_failure(
    'evt_tradeledger_failure_unresolved_001',
    'refund.updated',
    're_tradeledger_001',
    'operator_attention_required',
    'Synthetic unresolved failure.'
) as unresolved_failure_recorded
\gset

reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000002';

do $$
declare
    visible_organizations integer;
    visible_projects integer;
    visible_subcontractors integer;
    visible_requests integer;
    visible_events integer;
    visible_payments integer;
    visible_refunds integer;
    visible_webhook_failures integer;
begin
    select count(*) into visible_organizations from public.organizations;
    select count(*) into visible_projects from public.projects;
    select count(*) into visible_subcontractors from public.subcontractors;
    select count(*) into visible_requests from public.payment_requests;
    select count(*) into visible_events from public.audit_events;
    select count(*) into visible_payments from public.payments;
    select count(*) into visible_refunds from public.payment_refunds;
    select count(*) into visible_webhook_failures from public.stripe_webhook_failures;

    if visible_organizations <> 0
       or visible_projects <> 0
       or visible_subcontractors <> 0
       or visible_requests <> 0
       or visible_events <> 0
       or visible_payments <> 0
       or visible_refunds <> 0
       or visible_webhook_failures <> 0 then
        raise exception 'Tenant B could see Tenant A data.';
    end if;
end;
$$;

do $$
begin
    begin
        insert into public.projects (organization_id, name, code, status)
        values (
            current_setting('test.organization_a_id')::uuid,
            'Unauthorized Project',
            'DENIED-01',
            'active'
        );

        raise exception 'Cross-tenant project creation unexpectedly succeeded.';
    exception
        when insufficient_privilege then null;
    end;
end;
$$;

do $$
declare
    created_request uuid;
begin
    created_request := public.create_payment_request(
        current_setting('test.organization_a_id')::uuid,
        current_setting('test.project_a_id')::uuid,
        current_setting('test.subcontractor_a_id')::uuid,
        'Unauthorized payment request',
        5000,
        0,
        'usd'
    );

    raise exception 'Cross-tenant payment request creation unexpectedly returned %.', created_request;
exception
    when insufficient_privilege then null;
end;
$$;

rollback;
