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
    destination_charge as checkout_destination_charge
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
    payment_reference as retry_payment_reference
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

    if audit_count <> 13 then
        raise exception 'Expected 13 audit events after payout setup and checkout retry, received %.', audit_count;
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
    destination_charge as refund_destination_charge
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

do $$
begin
    if current_setting('test.prepared_refund_amount')::bigint <> 9450 then
        raise exception 'Expected database-owned refund amount 9450, received %.',
            current_setting('test.prepared_refund_amount');
    end if;

    if not current_setting('test.refund_destination_charge')::boolean then
        raise exception 'Destination-charge refunds must reverse the transfer.';
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
       or visible_private_files <> 0 then
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
