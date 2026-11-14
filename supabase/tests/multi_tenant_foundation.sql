\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email)
values
    ('00000000-0000-4000-8000-000000000001', 'owner-a@example.test'),
    ('00000000-0000-4000-8000-000000000002', 'outsider-b@example.test'),
    ('00000000-0000-4000-8000-000000000003', 'admin-a@example.test'),
    ('00000000-0000-4000-8000-000000000004', 'accountant-a@example.test'),
    ('00000000-0000-4000-8000-000000000005', 'member-a@example.test'),
    ('00000000-0000-4000-8000-000000000006', 'subcontractor-a@example.test');

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
    notification_count integer;
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

    select count(*)
    into notification_count
    from public.notification_deliveries
    where payment_request_id = current_setting('test.payment_request_a_id')::uuid
      and notification_type = 'payment_request_approved'
      and status = 'pending';

    if event_count <> 6 then
        raise exception 'Expected 6 audit events, received %.', event_count;
    end if;

    if notification_count <> 1 then
        raise exception 'Expected one pending approval notification, received %.',
            notification_count;
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

select public.set_organization_platform_fee(
    :'organization_a_id',
    'usd',
    275,
    30,
    true
);

reset role;

-- Reproduce the legacy production schema where Stripe session identifiers were
-- stored as varchar. The checkout RPC must still honor its text return contract.
alter table public.payments
    alter column stripe_checkout_session_id type varchar(255),
    alter column stripe_payment_intent_id type varchar(255),
    alter column paid_at type timestamp(0) without time zone
        using paid_at at time zone 'UTC';

set local role service_role;

select payout_account_id as payout_account_a_id
from public.prepare_subcontractor_payout_onboarding(
    :'subcontractor_a_id',
    '00000000-0000-4000-8000-000000000001'
)
\gset

select public.attach_subcontractor_stripe_account(
    :'payout_account_a_id',
    '00000000-0000-4000-8000-000000000001',
    'acct_TradeLedgerTest001',
    'full'
);

select public.sync_subcontractor_stripe_account(
    'acct_TradeLedgerTest001',
    'evt_tradeledger_account_checkout_ready',
    'account.updated',
    false,
    true,
    false,
    true,
    array[]::text[],
    array[]::text[],
    array[]::text[],
    null
);

select
    payment_reference as checkout_payment_reference,
    amount_total as checkout_amount_total,
    stripe_destination_account_id as checkout_destination_id,
    destination_charge as checkout_destination_charge,
    platform_fee_amount as checkout_platform_fee_amount,
    subcontractor_transfer_amount as checkout_transfer_amount
from public.prepare_payment_request_checkout(
    :'payment_request_a_id',
    '00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001'
)
\gset

select set_config('test.checkout_destination_id', :'checkout_destination_id', true);
select set_config(
    'test.checkout_destination_charge',
    :'checkout_destination_charge',
    true
);
select set_config(
    'test.checkout_platform_fee_amount',
    :'checkout_platform_fee_amount',
    true
);
select set_config('test.checkout_transfer_amount', :'checkout_transfer_amount', true);

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

    if current_setting('test.checkout_platform_fee_amount')::bigint <> 290
       or current_setting('test.checkout_transfer_amount')::bigint <> 9160 then
        raise exception 'Checkout did not snapshot the configured platform fee split.';
    end if;

    if current_setting('test.checkout_destination_id') <> 'acct_TradeLedgerTest001'
       or not current_setting('test.checkout_destination_charge')::boolean then
        raise exception 'Checkout was not prepared as a connected destination charge.';
    end if;
end;
$$;

select public.attach_payment_checkout_session(
    :'checkout_payment_reference',
    'cs_test_tradeledger_001'
) as attached
\gset

reset role;
update public.organization_platform_fees
set percentage_basis_points = 500, fixed_amount = 0
where organization_id = :'organization_a_id'
  and currency = 'usd';
set local role service_role;

select public.attach_payment_checkout_session(
    :'checkout_payment_reference',
    'cs_test_tradeledger_001'
) as reattached
\gset

select public.mark_payment_checkout_failed(
    :'checkout_payment_reference',
    'database_retry_regression'
) as checkout_failed
\gset

select
    payment_reference as retry_payment_reference,
    platform_fee_amount as retry_platform_fee_amount
from public.prepare_payment_request_checkout(
    :'payment_request_a_id',
    '00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002'
)
\gset

select public.attach_payment_checkout_session(
    :'retry_payment_reference',
    'cs_test_tradeledger_002'
) as retry_attached
\gset

select set_config('test.checkout_reattached', :'reattached', true);
select set_config('test.checkout_failed', :'checkout_failed', true);
select set_config('test.retry_attached', :'retry_attached', true);
select set_config(
    'test.retry_platform_fee_amount',
    :'retry_platform_fee_amount',
    true
);

select set_config(
    'test.rate_limit_first',
    public.consume_edge_rate_limit(
        'database-test',
        '00000000-0000-4000-8000-000000000001',
        2,
        60
    )::text,
    true
);
select set_config(
    'test.rate_limit_second',
    public.consume_edge_rate_limit(
        'database-test',
        '00000000-0000-4000-8000-000000000001',
        2,
        60
    )::text,
    true
);
select set_config(
    'test.rate_limit_third',
    public.consume_edge_rate_limit(
        'database-test',
        '00000000-0000-4000-8000-000000000001',
        2,
        60
    )::text,
    true
);

do $$
begin
    if not current_setting('test.checkout_reattached')::boolean then
        raise exception 'Attaching the same Checkout Session must be idempotent.';
    end if;

    if not current_setting('test.checkout_failed')::boolean
       or not current_setting('test.retry_attached')::boolean then
        raise exception 'A failed Checkout Session must support a replacement session.';
    end if;

    if current_setting('test.retry_platform_fee_amount')::bigint <> 290 then
        raise exception 'A checkout retry replaced the immutable platform fee snapshot.';
    end if;

    if not current_setting('test.rate_limit_first')::boolean
       or not current_setting('test.rate_limit_second')::boolean
       or current_setting('test.rate_limit_third')::boolean then
        raise exception 'The database rate limiter did not enforce its request limit.';
    end if;
end;
$$;

select public.process_stripe_webhook(
    'evt_tradeledger_paid_001',
    'checkout.session.completed',
    'cs_test_tradeledger_002',
    'paid',
    'pi_tradeledger_001',
    'owner-a@example.test'
) as webhook_processed
\gset

select public.process_stripe_webhook(
    'evt_tradeledger_paid_001',
    'checkout.session.completed',
    'cs_test_tradeledger_002',
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
    notification_count integer;
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

    select count(*)
    into notification_count
    from public.notification_deliveries
    where payment_request_id = current_setting('test.payment_request_a_id')::uuid;

    if request_status <> 'paid' or payment_status <> 'paid' then
        raise exception 'Expected paid request/payment, received %/%',
            request_status,
            payment_status;
    end if;

    if event_count <> 1 then
        raise exception 'Expected one idempotent Stripe event, received %.', event_count;
    end if;

    if audit_count <> 14 then
        raise exception 'Expected 14 audit events after fee setup, payout setup, and checkout retry, received %.', audit_count;
    end if;

    if notification_count <> 2 then
        raise exception 'Expected one approval and one paid notification, received %.',
            notification_count;
    end if;
end;
$$;

select
    stripe_checkout_session_id as reconciliation_session_id,
    stripe_payment_intent_id as reconciliation_payment_intent_id
from public.prepare_payment_reconciliation(
    :'payment_request_a_id',
    '00000000-0000-4000-8000-000000000001'
)
\gset

select set_config(
    'test.reconciliation_session_id',
    :'reconciliation_session_id',
    true
);
select set_config(
    'test.reconciliation_payment_intent_id',
    :'reconciliation_payment_intent_id',
    true
);

do $$
begin
    if current_setting('test.reconciliation_session_id') <> 'cs_test_tradeledger_002'
       or current_setting('test.reconciliation_payment_intent_id')
            <> 'pi_tradeledger_001' then
        raise exception 'Reconciliation preparation returned unexpected Stripe identifiers.';
    end if;
end;
$$;

do $$
begin
    begin
        perform *
        from public.claim_notification_delivery(
            current_setting('test.payment_request_a_id')::uuid,
            '00000000-0000-4000-8000-000000000002'
        );
        raise exception 'An outsider must not be able to claim a notification.';
    exception
        when insufficient_privilege then null;
    end;
end;
$$;

select delivery_id as approval_delivery_id, worker_token as approval_worker_token
from public.claim_notification_delivery(
    :'payment_request_a_id',
    '00000000-0000-4000-8000-000000000001'
)
\gset

select public.complete_notification_delivery(
    :'approval_delivery_id',
    :'approval_worker_token',
    'resend_approval_001'
) as approval_notification_completed
\gset

select delivery_id as payment_delivery_id, worker_token as payment_worker_token
from public.claim_notification_delivery(
    :'payment_request_a_id',
    '00000000-0000-4000-8000-000000000001'
)
\gset

select set_config('test.payment_delivery_id', :'payment_delivery_id', true);

select public.fail_notification_delivery(
    :'payment_delivery_id',
    :'payment_worker_token',
    'provider_unreachable',
    'Synthetic provider outage.',
    true
) as payment_notification_failure_status
\gset

do $$
declare
    delivery_record public.notification_deliveries%rowtype;
begin
    select *
    into delivery_record
    from public.notification_deliveries
    where id = current_setting('test.payment_delivery_id')::uuid;

    if delivery_record.status <> 'retry_scheduled'
       or delivery_record.attempt_count <> 1
       or delivery_record.next_attempt_at <= now() then
        raise exception 'Retry scheduling did not preserve the bounded delivery state.';
    end if;
end;
$$;

do $$
begin
    begin
        perform public.retry_notification_delivery(
            current_setting('test.payment_delivery_id')::uuid,
            '00000000-0000-4000-8000-000000000002'
        );
        raise exception 'An outsider must not be able to retry a notification.';
    exception
        when insufficient_privilege then null;
    end;
end;
$$;

select public.retry_notification_delivery(
    :'payment_delivery_id',
    '00000000-0000-4000-8000-000000000001'
) as retried_payment_request_id
\gset

select delivery_id as retried_delivery_id, worker_token as retried_worker_token
from public.claim_notification_delivery(
    :'payment_request_a_id',
    '00000000-0000-4000-8000-000000000001'
)
\gset

select public.complete_notification_delivery(
    :'retried_delivery_id',
    :'retried_worker_token',
    'resend_payment_001'
) as payment_notification_completed
\gset

do $$
begin
    begin
        perform *
        from public.reserve_waiver_document(
            current_setting('test.payment_request_a_id')::uuid,
            '00000000-0000-4000-8000-000000000002',
            '30000000-0000-4000-8000-000000000003'
        );
        raise exception 'An outsider must not be able to reserve a waiver.';
    exception
        when insufficient_privilege then null;
    end;
end;
$$;

select
    document_id as waiver_document_id,
    document_status as waiver_document_status,
    storage_path as waiver_storage_path
from public.reserve_waiver_document(
    :'payment_request_a_id',
    '00000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001'
)
\gset

select set_config('test.waiver_document_id', :'waiver_document_id', true);
select set_config('test.waiver_storage_path', :'waiver_storage_path', true);

select
    document_id as repeated_waiver_document_id,
    generation_required as repeated_generation_required
from public.reserve_waiver_document(
    :'payment_request_a_id',
    '00000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000002'
)
\gset

select set_config(
    'test.repeated_waiver_document_id',
    :'repeated_waiver_document_id',
    true
);
select set_config(
    'test.repeated_generation_required',
    :'repeated_generation_required',
    true
);

do $$
begin
    if current_setting('test.waiver_document_id')
       <> current_setting('test.repeated_waiver_document_id') then
        raise exception 'Waiver reservation must be idempotent.';
    end if;

    if current_setting('test.repeated_generation_required')::boolean then
        raise exception 'A concurrent waiver request must not steal an active lease.';
    end if;

    if current_setting('test.waiver_storage_path') not like
       current_setting('test.organization_a_id') || '/%' then
        raise exception 'Waiver storage path must begin with the tenant ID.';
    end if;
end;
$$;

select set_config(
    'test.stale_waiver_finalized',
    public.finalize_waiver_document(
        :'waiver_document_id',
        '00000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000002',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        2048
    )::text,
    true
);

do $$
begin
    if current_setting('test.stale_waiver_finalized')::boolean then
        raise exception 'A non-owner generation token finalized the waiver.';
    end if;
end;
$$;

select public.finalize_waiver_document(
    :'waiver_document_id',
    '00000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    1024
) as waiver_finalized
\gset

select document_id as downloadable_waiver_document_id
from public.prepare_waiver_download(
    :'payment_request_a_id',
    '00000000-0000-4000-8000-000000000001'
)
\gset

do $$
declare
    document_record public.waiver_documents%rowtype;
begin
    select * into document_record
    from public.waiver_documents
    where id = current_setting('test.waiver_document_id')::uuid;

    if document_record.status <> 'ready'
       or document_record.file_size <> 1024
       or document_record.generated_at is null then
        raise exception 'Expected a finalized private waiver document.';
    end if;

    begin
        perform *
        from public.prepare_waiver_download(
            current_setting('test.payment_request_a_id')::uuid,
            '00000000-0000-4000-8000-000000000002'
        );
        raise exception 'An outsider must not receive a waiver download.';
    exception
        when no_data_found then null;
    end;
end;
$$;

insert into storage.objects (bucket_id, name)
values ('waiver-documents', :'waiver_storage_path');

reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000001';

do $$
declare
    visible_private_files integer;
begin
    select count(*) into visible_private_files
    from storage.objects
    where bucket_id = 'waiver-documents';

    if visible_private_files <> 1 then
        raise exception 'The owning financial role could not read its private waiver file.';
    end if;
end;
$$;

reset role;
set local role service_role;

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
    amount as prepared_refund_amount,
    destination_charge as refund_destination_charge,
    refund_application_fee as refund_application_fee
from public.prepare_payment_refund(
    :'payment_request_a_id',
    '00000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001'
)
\gset

select set_config('test.prepared_refund_amount', :'prepared_refund_amount', true);
select set_config(
    'test.refund_destination_charge',
    :'refund_destination_charge',
    true
);
select set_config('test.refund_application_fee', :'refund_application_fee', true);

do $$
begin
    if current_setting('test.prepared_refund_amount')::bigint <> 9450 then
        raise exception 'Expected database-owned refund amount 9450, received %.',
            current_setting('test.prepared_refund_amount');
    end if;

    if not current_setting('test.refund_destination_charge')::boolean then
        raise exception 'Destination-charge refunds must reverse the transfer.';
    end if;

    if not current_setting('test.refund_application_fee')::boolean then
        raise exception 'A fee-bearing refund must return the application fee.';
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
    waiver_status text;
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

    select status into waiver_status
    from public.waiver_documents
    where payment_request_id = current_setting('test.payment_request_a_id')::uuid;

    if request_record.status <> 'refunded'
       or payment_record.status <> 'refunded'
       or request_record.refunded_amount <> 9450
       or payment_record.amount_refunded <> 9450
       or waiver_status <> 'voided' then
        raise exception 'Expected fully refunded request/payment ledger.';
    end if;

    if succeeded_refunds <> 1 then
        raise exception 'Expected one idempotent succeeded refund, received %.',
            succeeded_refunds;
    end if;
end;
$$;

do $$
begin
    begin
        perform *
        from public.reserve_waiver_document(
            current_setting('test.payment_request_a_id')::uuid,
            '00000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000004'
        );
        raise exception 'A refunded request must not generate another waiver.';
    exception
        when object_not_in_prerequisite_state then null;
    end;
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
set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000001';

select public.upsert_organization_member(
    :'organization_a_id',
    'admin-a@example.test',
    'admin'
);
select public.upsert_organization_member(
    :'organization_a_id',
    'accountant-a@example.test',
    'accountant'
);
select public.upsert_organization_member(
    :'organization_a_id',
    'member-a@example.test',
    'member'
);
select public.upsert_organization_member(
    :'organization_a_id',
    'subcontractor-a@example.test',
    'subcontractor'
);

do $$
begin
    begin
        perform public.prepare_webhook_failure_recovery(
            (
                select id
                from public.stripe_webhook_failures
                where event_id = 'evt_tradeledger_failure_unresolved_001'
            ),
            '00000000-0000-4000-8000-000000000001'
        );
        raise exception 'Authenticated clients must not execute recovery coordinator RPCs.';
    exception
        when insufficient_privilege then null;
    end;
end;
$$;

reset role;
set local role service_role;

do $$
declare
    failure_id bigint;
    recovery_plan jsonb;
    failure_record public.stripe_webhook_failures%rowtype;
    requested_audit_count integer;
    completed_audit_count integer;
begin
    select id into failure_id
    from public.stripe_webhook_failures
    where event_id = 'evt_tradeledger_failure_unresolved_001';

    begin
        perform public.prepare_webhook_failure_recovery(
            failure_id,
            '00000000-0000-4000-8000-000000000002'
        );
        raise exception 'A cross-tenant user prepared webhook recovery.';
    exception
        when insufficient_privilege then null;
    end;

    recovery_plan := public.prepare_webhook_failure_recovery(
        failure_id,
        '00000000-0000-4000-8000-000000000001'
    );

    if recovery_plan ->> 'recovery_kind' <> 'payment'
       or (recovery_plan ->> 'target_id')::uuid <>
          current_setting('test.payment_request_a_id')::uuid then
        raise exception 'Webhook recovery selected an unsafe or incorrect target: %.',
            recovery_plan;
    end if;

    select * into failure_record
    from public.stripe_webhook_failures
    where id = failure_id;

    if failure_record.recovery_status <> 'retrying'
       or failure_record.recovery_attempts <> 1
       or failure_record.last_recovery_requested_by <>
          '00000000-0000-4000-8000-000000000001'::uuid then
        raise exception 'Webhook recovery preparation was not tracked correctly.';
    end if;

    select count(*) into requested_audit_count
    from public.audit_events
    where organization_id = current_setting('test.organization_a_id')::uuid
      and action = 'webhook_failure.recovery_requested'
      and (metadata ->> 'failure_id')::bigint = failure_id;

    if requested_audit_count <> 1 then
        raise exception 'Webhook recovery request audit evidence is missing.';
    end if;

    perform public.complete_webhook_failure_recovery(
        failure_id,
        '00000000-0000-4000-8000-000000000001',
        true,
        null
    );

    select * into failure_record
    from public.stripe_webhook_failures
    where id = failure_id;

    if failure_record.recovery_status <> 'resolved'
       or failure_record.resolved_at is null
       or failure_record.resolution <> 'operator_reconciliation' then
        raise exception 'Successful webhook recovery was not resolved correctly.';
    end if;

    select count(*) into completed_audit_count
    from public.audit_events
    where organization_id = current_setting('test.organization_a_id')::uuid
      and action = 'webhook_failure.recovery_completed'
      and (metadata ->> 'failure_id')::bigint = failure_id;

    if completed_audit_count <> 1 then
        raise exception 'Webhook recovery completion audit evidence is missing.';
    end if;
end;
$$;

reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000001';

do $$
declare
    member_count integer;
begin
    select count(*)
    into member_count
    from public.list_organization_members(
        current_setting('test.organization_a_id')::uuid
    );

    if member_count <> 5 then
        raise exception 'Expected the complete five-role member roster, received %.',
            member_count;
    end if;
end;
$$;

do $$
begin
    begin
        perform public.upsert_organization_member(
            current_setting('test.organization_a_id')::uuid,
            'missing-user@example.test',
            'member'
        );
        raise exception 'An unregistered user must not be added to an organization.';
    exception
        when no_data_found then null;
    end;

    begin
        perform public.set_organization_member_status(
            current_setting('test.organization_a_id')::uuid,
            '00000000-0000-4000-8000-000000000001',
            'suspended'
        );
        raise exception 'The organization owner must not be suspended.';
    exception
        when object_not_in_prerequisite_state then null;
    end;
end;
$$;

set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000003';

select public.upsert_organization_member(
    :'organization_a_id',
    'member-a@example.test',
    'subcontractor'
);

do $$
begin
    begin
        perform public.upsert_organization_member(
            current_setting('test.organization_a_id')::uuid,
            'accountant-a@example.test',
            'admin'
        );
        raise exception 'An admin must not elevate an accountant to admin.';
    exception
        when insufficient_privilege then null;
    end;

    begin
        perform public.set_organization_member_status(
            current_setting('test.organization_a_id')::uuid,
            '00000000-0000-4000-8000-000000000004',
            'suspended'
        );
        raise exception 'An admin must not suspend an accountant.';
    exception
        when insufficient_privilege then null;
    end;
end;
$$;

set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000004';

do $$
begin
    begin
        perform *
        from public.list_organization_members(
            current_setting('test.organization_a_id')::uuid
        );
        raise exception 'An accountant must not see the member administration roster.';
    exception
        when insufficient_privilege then null;
    end;

    begin
        perform public.upsert_organization_member(
            current_setting('test.organization_a_id')::uuid,
            'member-a@example.test',
            'member'
        );
        raise exception 'An accountant must not manage members.';
    exception
        when insufficient_privilege then null;
    end;
end;
$$;

set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000001';

select public.set_organization_member_status(
    :'organization_a_id',
    '00000000-0000-4000-8000-000000000004',
    'suspended'
);
select public.set_organization_member_status(
    :'organization_a_id',
    '00000000-0000-4000-8000-000000000004',
    'active'
);

select public.create_organization('TradeLedger Demo', 'tradeledger-demo')
    as demo_organization_id
\gset

select set_config('test.demo_organization_id', :'demo_organization_id', true);

select public.seed_demo_organization(:'demo_organization_id')
    as demo_seed_result
\gset

do $$
declare
    project_count integer;
    subcontractor_count integer;
    request_count integer;
    approved_count integer;
begin
    select count(*) into project_count
    from public.projects
    where organization_id = current_setting('test.demo_organization_id')::uuid;

    select count(*) into subcontractor_count
    from public.subcontractors
    where organization_id = current_setting('test.demo_organization_id')::uuid;

    select count(*), count(*) filter (where status = 'approved')
    into request_count, approved_count
    from public.payment_requests
    where organization_id = current_setting('test.demo_organization_id')::uuid;

    if project_count <> 2
       or subcontractor_count <> 2
       or request_count <> 3
       or approved_count <> 1 then
        raise exception 'The safe demo seed produced unexpected record counts.';
    end if;

    begin
        perform public.seed_demo_organization(
            current_setting('test.demo_organization_id')::uuid
        );
        raise exception 'Demo seeding must reject a non-empty organization.';
    exception
        when object_not_in_prerequisite_state then null;
    end;
end;
$$;

do $$
declare
    demo_status record;
begin
    select * into demo_status
    from public.get_demo_workspace_status(
        current_setting('test.demo_organization_id')::uuid
    );

    if demo_status.status <> 'active'
       or demo_status.can_remove is not true
       or demo_status.reason is not null then
        raise exception 'The registered demonstration dataset should be removable.';
    end if;
end;
$$;

set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000002';

do $$
begin
    begin
        perform public.remove_demo_workspace_data(
            current_setting('test.demo_organization_id')::uuid
        );
        raise exception 'A non-owner removed another organization demonstration dataset.';
    exception
        when insufficient_privilege then null;
    end;
end;
$$;

set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000001';

select public.remove_demo_workspace_data(:'demo_organization_id');

do $$
declare
    project_count integer;
    subcontractor_count integer;
    request_count integer;
    notification_count integer;
    membership_count integer;
    removal_event_count integer;
begin
    select count(*) into project_count
    from public.projects
    where organization_id = current_setting('test.demo_organization_id')::uuid;

    select count(*) into subcontractor_count
    from public.subcontractors
    where organization_id = current_setting('test.demo_organization_id')::uuid;

    select count(*) into request_count
    from public.payment_requests
    where organization_id = current_setting('test.demo_organization_id')::uuid;

    select count(*) into notification_count
    from public.notification_deliveries
    where organization_id = current_setting('test.demo_organization_id')::uuid;

    select count(*) into membership_count
    from public.organization_memberships
    where organization_id = current_setting('test.demo_organization_id')::uuid
      and user_id = '00000000-0000-4000-8000-000000000001';

    select count(*) into removal_event_count
    from public.audit_events
    where organization_id = current_setting('test.demo_organization_id')::uuid
      and action = 'organization.demo_data_removed';

    if project_count <> 0
       or subcontractor_count <> 0
       or request_count <> 0
       or notification_count <> 0
       or membership_count <> 1
       or removal_event_count <> 1 then
        raise exception 'Demonstration cleanup did not preserve the workspace boundary correctly.';
    end if;

    if exists (
        select 1
        from public.get_demo_workspace_status(
            current_setting('test.demo_organization_id')::uuid
        )
    ) then
        raise exception 'Removed demonstration data must not remain active.';
    end if;
end;
$$;

reset role;
set local role service_role;

select payout_account_id as payout_account_a_id
from public.prepare_subcontractor_payout_onboarding(
    :'subcontractor_a_id',
    '00000000-0000-4000-8000-000000000001'
)
\gset

select public.attach_subcontractor_stripe_account(
    :'payout_account_a_id',
    '00000000-0000-4000-8000-000000000001',
    'acct_TradeLedgerTest001',
    'full'
);

select public.sync_subcontractor_stripe_account(
    'acct_TradeLedgerTest001',
    'evt_tradeledger_account_001',
    'account.updated',
    false,
    true,
    false,
    true,
    array[]::text[],
    array[]::text[],
    array[]::text[],
    null
);

set local role authenticated;
set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000001';

do $$
declare
    payout_status text;
begin
    select onboarding_status
    into payout_status
    from public.subcontractor_payout_accounts
    where subcontractor_id = current_setting('test.subcontractor_a_id')::uuid;

    if payout_status <> 'ready' then
        raise exception 'Expected ready payout status, received %.', payout_status;
    end if;

    begin
        perform stripe_account_id
        from public.subcontractor_payout_accounts
        where subcontractor_id = current_setting('test.subcontractor_a_id')::uuid;

        raise exception 'Browser roles must not be able to read Stripe account IDs.';
    exception
        when insufficient_privilege then null;
    end;
end;
$$;

reset role;
set local role service_role;

update public.payments
set stripe_payment_intent_id = 'pi_TradeLedgerPayment001'
where payment_request_id = current_setting('test.payment_request_a_id')::uuid;

select public.apply_stripe_transfer_ledger_event(
    'evt_tradeledger_transfer_created_001',
    'transfer.created',
    'tr_TradeLedgerTransfer001',
    'acct_TradeLedgerTest001',
    'pi_TradeLedgerPayment001',
    9160,
    'usd',
    'succeeded',
    0,
    'ch_TradeLedgerCharge001',
    'ch_TradeLedgerCharge001',
    '2026-11-14T02:00:00Z',
    null
) as transfer_created
\gset

select public.apply_stripe_transfer_ledger_event(
    'evt_tradeledger_transfer_created_001',
    'transfer.created',
    'tr_TradeLedgerTransfer001',
    'acct_TradeLedgerTest001',
    'pi_TradeLedgerPayment001',
    9160,
    'usd',
    'succeeded',
    0,
    'ch_TradeLedgerCharge001',
    'ch_TradeLedgerCharge001',
    '2026-11-14T02:00:00Z',
    null
) as transfer_duplicate
\gset

select set_config('test.transfer_created', :'transfer_created', true);
select set_config('test.transfer_duplicate', :'transfer_duplicate', true);

select public.apply_stripe_transfer_ledger_event(
    'evt_tradeledger_transfer_reversed_001',
    'transfer.reversed',
    'tr_TradeLedgerTransfer001',
    'acct_TradeLedgerTest001',
    'pi_TradeLedgerPayment001',
    9160,
    'usd',
    'reversed',
    9160,
    'ch_TradeLedgerCharge001',
    'ch_TradeLedgerCharge001',
    '2026-11-14T02:00:00Z',
    null
) as transfer_reversed
\gset

select public.apply_stripe_payout_ledger_event(
    'evt_tradeledger_payout_created_001',
    'payout.created',
    'acct_TradeLedgerTest001',
    'po_TradeLedgerPayout001',
    9000,
    'usd',
    'pending',
    '2026-11-16T00:00:00Z',
    null,
    null,
    '2026-11-14T03:00:00Z',
    null
) as payout_created
\gset

select public.apply_stripe_payout_ledger_event(
    'evt_tradeledger_payout_paid_001',
    'payout.paid',
    'acct_TradeLedgerTest001',
    'po_TradeLedgerPayout001',
    9000,
    'usd',
    'paid',
    '2026-11-16T00:00:00Z',
    null,
    null,
    '2026-11-14T03:00:00Z',
    null
) as payout_paid
\gset

select public.apply_stripe_payout_ledger_event(
    'evt_tradeledger_payout_stale_001',
    'payout.updated',
    'acct_TradeLedgerTest001',
    'po_TradeLedgerPayout001',
    9000,
    'usd',
    'pending',
    '2026-11-16T00:00:00Z',
    null,
    null,
    '2026-11-14T03:00:00Z',
    null
) as stale_payout_processed
\gset

do $$
declare
    transfer_record public.payment_transfers%rowtype;
    payout_record public.connected_payouts%rowtype;
    discovered_events integer;
    reversed_events integer;
begin
    select * into transfer_record
    from public.payment_transfers
    where stripe_transfer_id = 'tr_TradeLedgerTransfer001';

    select * into payout_record
    from public.connected_payouts
    where stripe_payout_id = 'po_TradeLedgerPayout001';

    select count(*) into discovered_events
    from public.audit_events
    where action in ('transfer.discovered', 'payout.discovered');

    select count(*) into reversed_events
    from public.audit_events
    where action = 'transfer.reversed'
      and entity_id = transfer_record.id;

    if not current_setting('test.transfer_created')::boolean
       or current_setting('test.transfer_duplicate')::boolean then
        raise exception 'Transfer webhook idempotency did not hold.';
    end if;

    if transfer_record.organization_id <> current_setting('test.organization_a_id')::uuid
       or transfer_record.payment_request_id <> current_setting('test.payment_request_a_id')::uuid
       or transfer_record.subcontractor_id <> current_setting('test.subcontractor_a_id')::uuid
       or transfer_record.status <> 'reversed'
       or transfer_record.reversed_amount <> 9160 then
        raise exception 'Destination-charge transfer was not reconciled to its verified payment.';
    end if;

    if payout_record.status <> 'paid' then
        raise exception 'A stale payout event regressed the terminal paid status.';
    end if;

    if transfer_record.reversed_amount <> (
        select amount_refunded - platform_fee_amount from public.payments
        where id = transfer_record.payment_id
    ) then
        raise exception 'Refund, application fee, and transfer reversal amounts are not reconciled.';
    end if;

    if discovered_events <> 2 or reversed_events <> 1 then
        raise exception 'Ledger audit events were duplicated or omitted.';
    end if;

    begin
        update public.payment_transfers set reversed_amount = amount + 1
        where id = transfer_record.id;
        raise exception 'A reversal exceeded its transfer amount.';
    exception
        when check_violation then null;
    end;

    begin
        update public.connected_payouts set currency = 'US'
        where id = payout_record.id;
        raise exception 'An invalid payout currency was accepted.';
    exception
        when check_violation then null;
    end;

    begin
        update public.connected_payouts set status = 'unknown'
        where id = payout_record.id;
        raise exception 'An invalid payout status was accepted.';
    exception
        when check_violation then null;
    end;
end;
$$;

reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000001';

do $$
declare
    transfer_count integer;
    payout_count integer;
    transfer_retainage_release_id uuid;
begin
    select count(*) into transfer_count from public.payment_transfers;
    select count(*) into payout_count from public.connected_payouts;
    select retainage_release_id into transfer_retainage_release_id
    from public.payment_transfers
    limit 1;

    if transfer_count <> 1
       or payout_count <> 1
       or (select count(*) from public.organization_platform_fees) <> 1 then
        raise exception 'The financial owner cannot read the payout ledger.';
    end if;

    begin
        perform public.prepare_payout_reconciliation(
            current_setting('test.organization_a_id')::uuid,
            '00000000-0000-4000-8000-000000000001',
            'organization',
            current_setting('test.organization_a_id')::uuid
        );
        raise exception 'A browser role invoked a service-only reconciliation RPC.';
    exception
        when insufficient_privilege then null;
    end;
end;
$$;

set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000004';

do $$
declare
    transfer_retainage_release_id uuid;
begin
    select retainage_release_id into transfer_retainage_release_id
    from public.payment_transfers
    limit 1;

    if (select count(*) from public.payment_transfers) <> 1
       or (select count(*) from public.connected_payouts) <> 1
       or (select count(*) from public.organization_platform_fees) <> 1 then
        raise exception 'The accountant cannot read financial configuration.';
    end if;

    begin
        perform public.set_organization_platform_fee(
            current_setting('test.organization_a_id')::uuid,
            'usd',
            300,
            0,
            true
        );
        raise exception 'An accountant must not update platform fee configuration.';
    exception
        when insufficient_privilege then null;
    end;
end;
$$;

set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000003';

do $$
begin
    if (select count(*) from public.payment_transfers) <> 1
       or (select count(*) from public.connected_payouts) <> 1
       or (select count(*) from public.organization_platform_fees) <> 1 then
        raise exception 'The administrator cannot read financial configuration.';
    end if;
end;
$$;

set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000006';

do $$
begin
    if (select count(*) from public.payment_transfers) <> 0
       or (select count(*) from public.connected_payouts) <> 0
       or (select count(*) from public.organization_platform_fees) <> 0 then
        raise exception 'A non-financial role can read financial configuration.';
    end if;
end;
$$;

set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000001';

select public.create_payment_request(
    :'organization_a_id',
    :'project_a_id',
    :'subcontractor_a_id',
    'Final completion retainage source',
    20000,
    1000,
    'usd'
) as retainage_source_request_id
\gset

select set_config(
    'test.retainage_source_request_id',
    :'retainage_source_request_id',
    true
);

select public.submit_payment_request(:'retainage_source_request_id');
select public.approve_payment_request(:'retainage_source_request_id');

reset role;
set local role service_role;

select payment_reference as retainage_source_payment_reference
from public.prepare_payment_request_checkout(
    :'retainage_source_request_id',
    '00000000-0000-4000-8000-000000000001',
    '11000000-0000-4000-8000-000000000001'
)
\gset

select public.attach_payment_checkout_session(
    :'retainage_source_payment_reference',
    'cs_test_retainagesource001'
);

select public.process_stripe_webhook(
    'evt_retainage_source_paid_001',
    'checkout.session.completed',
    'cs_test_retainagesource001',
    'paid',
    'pi_RetainageSource001',
    'owner-a@example.test'
);

reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000001';

select public.create_retainage_release(
    :'retainage_source_request_id',
    1000,
    'Completed final inspection and accepted punch list'
) as retainage_release_id
\gset

select set_config('test.retainage_release_id', :'retainage_release_id', true);

select reference as retainage_release_reference
from public.retainage_releases
where id = :'retainage_release_id'
\gset

do $$
begin
    begin
        perform public.create_retainage_release(
            current_setting('test.retainage_source_request_id')::uuid,
            1500,
            'Attempt to exceed the remaining retained balance'
        );
        raise exception 'A retainage release exceeded the remaining balance.';
    exception
        when invalid_parameter_value then null;
    end;

    begin
        perform * from public.prepare_retainage_release_checkout(
            current_setting('test.retainage_release_id')::uuid,
            '00000000-0000-4000-8000-000000000001',
            '12000000-0000-4000-8000-000000000001'
        );
        raise exception 'A browser role invoked the service-only retainage checkout RPC.';
    exception
        when insufficient_privilege then null;
    end;
end;
$$;

select public.approve_retainage_release(:'retainage_release_id');

reset role;
set local role service_role;

select
    payment_reference as retainage_payment_reference,
    platform_fee_amount as retainage_platform_fee_amount,
    subcontractor_transfer_amount as retainage_transfer_amount
from public.prepare_retainage_release_checkout(
    :'retainage_release_id',
    '00000000-0000-4000-8000-000000000001',
    '12000000-0000-4000-8000-000000000001'
)
\gset

select set_config(
    'test.retainage_platform_fee_amount',
    :'retainage_platform_fee_amount',
    true
);
select set_config('test.retainage_transfer_amount', :'retainage_transfer_amount', true);

select public.attach_retainage_release_checkout_session(
    :'retainage_payment_reference',
    'cs_test_retainagerelease001'
);

select public.process_retainage_release_checkout_webhook(
    'evt_retainage_release_paid_001',
    'checkout.session.completed',
    'cs_test_retainagerelease001',
    'paid',
    'pi_RetainageRelease001',
    :'retainage_release_reference'
) as retainage_release_webhook_processed
\gset

select public.process_retainage_release_checkout_webhook(
    'evt_retainage_release_paid_001',
    'checkout.session.completed',
    'cs_test_retainagerelease001',
    'paid',
    'pi_RetainageRelease001',
    :'retainage_release_reference'
) as retainage_release_webhook_duplicate
\gset

select set_config(
    'test.retainage_release_webhook_processed',
    :'retainage_release_webhook_processed',
    true
);
select set_config(
    'test.retainage_release_webhook_duplicate',
    :'retainage_release_webhook_duplicate',
    true
);

select public.apply_stripe_transfer_ledger_event(
    'evt_retainage_transfer_created_001',
    'transfer.created',
    'tr_RetainageRelease001',
    'acct_TradeLedgerTest001',
    'pi_RetainageRelease001',
    950,
    'usd',
    'succeeded',
    0,
    'ch_RetainageRelease001',
    'ch_RetainageRelease001',
    '2026-11-14T05:00:00Z',
    null
);

select
    refund_reference as retainage_refund_reference,
    amount as retainage_refund_amount,
    refund_application_fee as retainage_refund_application_fee
from public.prepare_retainage_release_refund(
    :'retainage_release_id',
    '00000000-0000-4000-8000-000000000001',
    '13000000-0000-4000-8000-000000000001'
)
\gset

select set_config('test.retainage_refund_amount', :'retainage_refund_amount', true);
select set_config(
    'test.retainage_refund_application_fee',
    :'retainage_refund_application_fee',
    true
);

select public.process_retainage_release_refund_webhook(
    'evt_retainage_refund_succeeded_001',
    'refund.updated',
    're_RetainageRelease001',
    :'retainage_refund_reference',
    'pi_RetainageRelease001',
    1000,
    'usd',
    'succeeded',
    null
) as retainage_refund_processed
\gset

select public.process_retainage_release_refund_webhook(
    'evt_retainage_refund_succeeded_001',
    'refund.updated',
    're_RetainageRelease001',
    :'retainage_refund_reference',
    'pi_RetainageRelease001',
    1000,
    'usd',
    'succeeded',
    null
) as retainage_refund_duplicate
\gset

select set_config(
    'test.retainage_refund_processed',
    :'retainage_refund_processed',
    true
);
select set_config(
    'test.retainage_refund_duplicate',
    :'retainage_refund_duplicate',
    true
);

select public.apply_stripe_transfer_ledger_event(
    'evt_retainage_transfer_reversed_001',
    'transfer.reversed',
    'tr_RetainageRelease001',
    'acct_TradeLedgerTest001',
    'pi_RetainageRelease001',
    950,
    'usd',
    'reversed',
    950,
    'ch_RetainageRelease001',
    'ch_RetainageRelease001',
    '2026-11-14T05:00:00Z',
    null
);

do $$
declare
    release_record public.retainage_releases%rowtype;
    transfer_record public.payment_transfers%rowtype;
begin
    select * into release_record
    from public.retainage_releases
    where id = current_setting('test.retainage_release_id')::uuid;

    select * into transfer_record
    from public.payment_transfers
    where retainage_release_id = release_record.id;

    if current_setting('test.retainage_platform_fee_amount')::bigint <> 50
       or current_setting('test.retainage_transfer_amount')::bigint <> 950 then
        raise exception 'Retainage checkout did not snapshot the configured fee split.';
    end if;

    if not current_setting('test.retainage_release_webhook_processed')::boolean
       or current_setting('test.retainage_release_webhook_duplicate')::boolean
       or not current_setting('test.retainage_refund_processed')::boolean
       or current_setting('test.retainage_refund_duplicate')::boolean then
        raise exception 'Retainage webhook idempotency did not hold.';
    end if;

    if current_setting('test.retainage_refund_amount')::bigint <> 1000
       or not current_setting('test.retainage_refund_application_fee')::boolean then
        raise exception 'Retainage refund did not include the release and application fee.';
    end if;

    if release_record.status <> 'refunded'
       or release_record.amount_refunded <> 1000
       or transfer_record.status <> 'reversed'
       or transfer_record.reversed_amount <> 950 then
        raise exception 'Retainage release, refund, and transfer reversal did not reconcile.';
    end if;
end;
$$;

reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000004';

do $$
declare
    report_record record;
    statement_count integer;
    unsafe_reference_count integer;
begin
    select * into report_record
    from public.get_organization_financial_report(
        current_setting('test.organization_a_id')::uuid,
        date '2026-01-01',
        date '2026-12-31',
        'usd'
    );

    if report_record.currency <> 'usd'
       or report_record.collected_amount <= 0
       or report_record.platform_fee_amount <= 0
       or report_record.payment_count < 1
       or report_record.transfer_count < 1
       or report_record.payout_count < 1 then
        raise exception 'The accountant financial summary is incomplete.';
    end if;

    select count(*), count(*) filter (
        where reference ~ '^(acct|pi|ch|tr|po|dp)_'
    )
    into statement_count, unsafe_reference_count
    from public.get_organization_financial_statement(
        current_setting('test.organization_a_id')::uuid,
        date '2026-01-01',
        date '2026-12-31',
        'usd',
        500
    );

    if statement_count < 1 or unsafe_reference_count <> 0 then
        raise exception 'The financial statement is empty or exposes a Stripe identifier.';
    end if;

    begin
        perform public.get_organization_financial_report(
            current_setting('test.organization_a_id')::uuid,
            date '2025-01-01',
            date '2026-12-31',
            null
        );
        raise exception 'An unbounded financial report period was accepted.';
    exception
        when invalid_parameter_value then null;
    end;
end;
$$;

set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000006';

do $$
begin
    begin
        perform public.get_organization_financial_report(
            current_setting('test.organization_a_id')::uuid,
            date '2026-01-01',
            date '2026-12-31',
            null
        );
        raise exception 'A non-financial member generated a financial report.';
    exception
        when insufficient_privilege then null;
    end;

    begin
        perform public.get_organization_financial_statement(
            current_setting('test.organization_a_id')::uuid,
            date '2026-01-01',
            date '2026-12-31',
            null,
            500
        );
        raise exception 'A non-financial member generated a financial statement.';
    exception
        when insufficient_privilege then null;
    end;
end;
$$;

reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000004';

do $$
begin
    if (select count(*) from public.retainage_releases) <> 1 then
        raise exception 'The accountant cannot read the retainage release ledger.';
    end if;
end;
$$;

set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000006';

do $$
begin
    if (select count(*) from public.retainage_releases) <> 0 then
        raise exception 'A non-financial member can read retainage releases.';
    end if;
end;
$$;

reset role;
set local role service_role;

select public.apply_stripe_dispute_event(
    'evt_dispute_created_001', 'charge.dispute.created',
    'dp_TradeLedgerDispute001', 'ch_TradeLedgerCharge001',
    'pi_TradeLedgerPayment001', 1000, 'usd', 'product_not_received',
    'needs_response', false, '2026-11-20T00:00:00Z', false, false, 0, null
) as dispute_created
\gset

select public.apply_stripe_dispute_event(
    'evt_dispute_created_001', 'charge.dispute.created',
    'dp_TradeLedgerDispute001', 'ch_TradeLedgerCharge001',
    'pi_TradeLedgerPayment001', 1000, 'usd', 'product_not_received',
    'needs_response', false, '2026-11-20T00:00:00Z', false, false, 0, null
) as dispute_duplicate
\gset

select public.apply_stripe_dispute_event(
    'evt_dispute_created_002', 'charge.dispute.created',
    'dp_TradeLedgerDispute002', 'ch_TradeLedgerCharge001',
    'pi_TradeLedgerPayment001', 500, 'usd', 'general',
    'under_review', false, null, true, false, 1, null
);

select public.apply_stripe_dispute_event(
    'evt_dispute_closed_001', 'charge.dispute.closed',
    'dp_TradeLedgerDispute001', 'ch_TradeLedgerCharge001',
    'pi_TradeLedgerPayment001', 1000, 'usd', 'product_not_received',
    'lost', false, '2026-11-20T00:00:00Z', true, false, 1, null
);

select public.apply_stripe_dispute_event(
    'evt_dispute_late_001', 'charge.dispute.updated',
    'dp_TradeLedgerDispute001', 'ch_TradeLedgerCharge001',
    'pi_TradeLedgerPayment001', 1000, 'usd', 'product_not_received',
    'needs_response', false, '2026-11-20T00:00:00Z', false, false, 0, null
);

select set_config('test.dispute_created', :'dispute_created', true);
select set_config('test.dispute_duplicate', :'dispute_duplicate', true);

do $$
declare dispute_record public.payment_disputes%rowtype;
begin
    select * into dispute_record from public.payment_disputes
    where stripe_dispute_id = 'dp_TradeLedgerDispute001';

    if not current_setting('test.dispute_created')::boolean
       or current_setting('test.dispute_duplicate')::boolean
       or (select count(*) from public.payment_disputes) <> 2
       or dispute_record.status <> 'lost'
       or dispute_record.evidence_submission_count <> 1 then
        raise exception 'Dispute idempotency, multiplicity, or terminal-state protection failed.';
    end if;
end;
$$;

reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000004';

do $$
begin
    if (select count(*) from public.payment_disputes) <> 2 then
        raise exception 'The accountant cannot read the dispute ledger.';
    end if;

    begin
        perform public.prepare_dispute_action(
            (select id from public.payment_disputes limit 1),
            '00000000-0000-4000-8000-000000000004',
            'sync'
        );
        raise exception 'A browser role invoked a service-only dispute RPC.';
    exception
        when insufficient_privilege then null;
    end;
end;
$$;

set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000006';

do $$
begin
    if (select count(*) from public.payment_disputes) <> 0 then
        raise exception 'A non-financial member can read payment disputes.';
    end if;
end;
$$;

reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000002';

do $$
declare
    visible_organizations integer;
    visible_projects integer;
    visible_subcontractors integer;
    visible_payout_accounts integer;
    visible_requests integer;
    visible_events integer;
    visible_payments integer;
    visible_refunds integer;
    visible_webhook_failures integer;
    visible_waivers integer;
    visible_notifications integer;
    visible_transfers integer;
    visible_connected_payouts integer;
    visible_platform_fees integer;
    visible_retainage_releases integer;
    visible_disputes integer;
    visible_private_files integer;
begin
    select count(*) into visible_organizations from public.organizations;
    select count(*) into visible_projects from public.projects;
    select count(*) into visible_subcontractors from public.subcontractors;
    select count(*) into visible_payout_accounts
    from public.subcontractor_payout_accounts;
    select count(*) into visible_requests from public.payment_requests;
    select count(*) into visible_events from public.audit_events;
    select count(*) into visible_payments from public.payments;
    select count(*) into visible_refunds from public.payment_refunds;
    select count(*) into visible_webhook_failures from public.stripe_webhook_failures;
    select count(*) into visible_waivers from public.waiver_documents;
    select count(*) into visible_notifications from public.notification_deliveries;
    select count(*) into visible_transfers from public.payment_transfers;
    select count(*) into visible_connected_payouts from public.connected_payouts;
    select count(*) into visible_platform_fees from public.organization_platform_fees;
    select count(*) into visible_retainage_releases from public.retainage_releases;
    select count(*) into visible_disputes from public.payment_disputes;
    select count(*) into visible_private_files
    from storage.objects
    where bucket_id = 'waiver-documents';

    if visible_organizations <> 0
       or visible_projects <> 0
       or visible_subcontractors <> 0
       or visible_payout_accounts <> 0
       or visible_requests <> 0
       or visible_events <> 0
       or visible_payments <> 0
       or visible_refunds <> 0
       or visible_webhook_failures <> 0
       or visible_waivers <> 0
       or visible_notifications <> 0
       or visible_transfers <> 0
       or visible_connected_payouts <> 0
       or visible_platform_fees <> 0
       or visible_retainage_releases <> 0
       or visible_disputes <> 0
       or visible_private_files <> 0 then
        raise exception 'Tenant B could see Tenant A data.';
    end if;
end;
$$;

do $$
begin
    begin
        perform public.get_organization_financial_report(
            current_setting('test.organization_a_id')::uuid,
            date '2026-01-01',
            date '2026-12-31',
            null
        );
        raise exception 'Tenant B generated Tenant A financial report.';
    exception
        when insufficient_privilege then null;
    end;

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
