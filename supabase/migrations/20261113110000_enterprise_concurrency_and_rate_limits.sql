-- Close races at external-service boundaries and provide a database-backed,
-- concurrency-safe rate-limit primitive for authenticated Edge Functions.

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
    set
        stripe_checkout_session_id = p_session_id,
        updated_at = now()
    where reference = p_reference
      and status = 'pending'
      and (
          stripe_checkout_session_id is null
          or stripe_checkout_session_id = p_session_id
      );

    -- Re-attaching the same Stripe session is an idempotent success. This is
    -- required when two callers receive the same Stripe idempotency result.
    return found;
end;
$$;

alter table public.waiver_documents
    add column generation_token uuid,
    add column generation_started_at timestamptz;

-- Any in-flight generation from the pre-lease implementation must be retried
-- so that it cannot finalize without proving ownership of a generation lease.
update public.waiver_documents
set
    status = 'failed',
    failure_reason = 'Generation must be retried after the document safety upgrade.'
where status = 'generating';

alter table public.waiver_documents
    add constraint waiver_documents_generation_lease check (
        status <> 'generating'
        or (generation_token is not null and generation_started_at is not null)
    );

drop function public.reserve_waiver_document(uuid, uuid);
drop function public.finalize_waiver_document(uuid, uuid, text, integer);
drop function public.fail_waiver_document(uuid, text);

create function public.reserve_waiver_document(
    p_payment_request_id uuid,
    p_user_id uuid,
    p_generation_token uuid
)
returns table (
    document_id uuid,
    document_status text,
    storage_path text,
    file_name text,
    organization_id uuid,
    organization_name text,
    payment_request_id uuid,
    payment_reference uuid,
    project_name text,
    project_code text,
    subcontractor_name text,
    subcontractor_contact text,
    description text,
    gross_amount bigint,
    retainage_amount bigint,
    net_amount bigint,
    currency text,
    paid_at timestamptz,
    generation_required boolean,
    generation_token uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    request_record public.payment_requests%rowtype;
    payment_record public.payments%rowtype;
    document_record public.waiver_documents%rowtype;
    organization_record public.organizations%rowtype;
    project_record public.projects%rowtype;
    subcontractor_record public.subcontractors%rowtype;
    document_id_value uuid;
    document_file_name text;
    document_storage_path text;
    generation_required_value boolean := false;
begin
    if p_user_id is null then
        raise exception 'Authentication is required.' using errcode = '28000';
    end if;

    if p_generation_token is null then
        raise exception 'A generation token is required.' using errcode = '22023';
    end if;

    select * into request_record
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
        raise exception 'You are not allowed to generate this waiver.'
            using errcode = '42501';
    end if;

    if request_record.status <> 'paid' or request_record.refunded_amount <> 0 then
        raise exception 'A waiver can only be generated for a paid, non-refunded request.'
            using errcode = '55000';
    end if;

    select * into payment_record
    from public.payments as payment
    where payment.payment_request_id = p_payment_request_id
      and payment.status = 'paid'
      and payment.amount_refunded = 0
    for update;

    if not found or payment_record.paid_at is null then
        raise exception 'A settled payment was not found for this request.'
            using errcode = '55000';
    end if;

    select * into organization_record
    from public.organizations as organization
    where organization.id = request_record.organization_id;

    select * into project_record
    from public.projects as project
    where project.id = request_record.project_id;

    select * into subcontractor_record
    from public.subcontractors as subcontractor
    where subcontractor.id = request_record.subcontractor_id;

    select * into document_record
    from public.waiver_documents as waiver
    where waiver.payment_request_id = p_payment_request_id
    for update;

    if document_record.status = 'voided' then
        raise exception 'This waiver was voided after the payment changed.'
            using errcode = '55000';
    end if;

    if document_record.id is null then
        document_id_value := gen_random_uuid();
        document_file_name := 'payment-waiver-'
            || lower(regexp_replace(project_record.code, '[^a-zA-Z0-9]+', '-', 'g'))
            || '-' || left(payment_record.reference::text, 8) || '.pdf';
        document_storage_path := request_record.organization_id::text
            || '/' || p_payment_request_id::text
            || '/' || p_generation_token::text || '.pdf';

        insert into public.waiver_documents (
            id,
            organization_id,
            payment_request_id,
            payment_id,
            storage_path,
            file_name,
            generated_by,
            generation_token,
            generation_started_at
        ) values (
            document_id_value,
            request_record.organization_id,
            p_payment_request_id,
            payment_record.id,
            document_storage_path,
            document_file_name,
            p_user_id,
            p_generation_token,
            now()
        ) returning * into document_record;

        generation_required_value := true;

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
            'waiver.requested',
            'waiver_document',
            document_record.id,
            jsonb_build_object('payment_request_id', p_payment_request_id)
        );
    elsif document_record.status = 'failed'
       or (
           document_record.status = 'generating'
           and document_record.generation_started_at < now() - interval '5 minutes'
       ) then
        document_storage_path := request_record.organization_id::text
            || '/' || p_payment_request_id::text
            || '/' || p_generation_token::text || '.pdf';

        update public.waiver_documents
        set
            status = 'generating',
            storage_path = document_storage_path,
            generated_by = p_user_id,
            generated_at = null,
            sha256 = null,
            file_size = null,
            failure_reason = null,
            generation_token = p_generation_token,
            generation_started_at = now()
        where id = document_record.id
        returning * into document_record;

        generation_required_value := true;
    elsif document_record.status = 'generating'
       and document_record.generation_token = p_generation_token then
        generation_required_value := true;
    end if;

    return query
    select
        document_record.id,
        document_record.status,
        document_record.storage_path,
        document_record.file_name,
        request_record.organization_id,
        organization_record.name,
        p_payment_request_id,
        payment_record.reference,
        project_record.name,
        project_record.code,
        subcontractor_record.company_name,
        coalesce(subcontractor_record.contact_name, subcontractor_record.email),
        request_record.description,
        request_record.gross_amount,
        request_record.retainage_amount,
        request_record.net_amount,
        request_record.currency::text,
        payment_record.paid_at,
        generation_required_value,
        document_record.generation_token;
end;
$$;

create function public.finalize_waiver_document(
    p_document_id uuid,
    p_user_id uuid,
    p_generation_token uuid,
    p_sha256 text,
    p_file_size integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    document_record public.waiver_documents%rowtype;
begin
    select * into document_record
    from public.waiver_documents as waiver
    where waiver.id = p_document_id
    for update;

    if not found then
        return false;
    end if;

    if not exists (
        select 1
        from public.organization_memberships as membership
        where membership.organization_id = document_record.organization_id
          and membership.user_id = p_user_id
          and membership.status = 'active'
          and membership.role in ('owner', 'accountant')
    ) then
        raise exception 'You are not allowed to finalize this waiver.'
            using errcode = '42501';
    end if;

    if document_record.status = 'ready' then
        return document_record.generation_token = p_generation_token
            and document_record.sha256 = lower(p_sha256)
            and document_record.file_size = p_file_size;
    end if;

    if document_record.status <> 'generating'
       or document_record.generation_token <> p_generation_token then
        return false;
    end if;

    update public.waiver_documents
    set
        status = 'ready',
        generated_at = now(),
        sha256 = lower(p_sha256),
        file_size = p_file_size,
        failure_reason = null
    where id = p_document_id;

    insert into public.audit_events (
        organization_id,
        actor_user_id,
        action,
        entity_type,
        entity_id,
        metadata
    ) values (
        document_record.organization_id,
        p_user_id,
        'waiver.generated',
        'waiver_document',
        p_document_id,
        jsonb_build_object(
            'payment_request_id', document_record.payment_request_id,
            'sha256', lower(p_sha256),
            'file_size', p_file_size
        )
    );

    return true;
end;
$$;

create function public.fail_waiver_document(
    p_document_id uuid,
    p_generation_token uuid,
    p_failure_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
    update public.waiver_documents
    set
        status = 'failed',
        failure_reason = left(
            coalesce(nullif(p_failure_reason, ''), 'Document generation failed.'),
            500
        )
    where id = p_document_id
      and status = 'generating'
      and generation_token = p_generation_token;

    return found;
end;
$$;

create table public.edge_rate_limits (
    bucket text not null,
    subject uuid not null,
    window_started_at timestamptz not null,
    request_count integer not null,
    primary key (bucket, subject),
    constraint edge_rate_limits_bucket check (bucket ~ '^[a-z0-9][a-z0-9:_-]{1,63}$'),
    constraint edge_rate_limits_request_count check (request_count > 0)
);

alter table public.edge_rate_limits enable row level security;

create function public.consume_edge_rate_limit(
    p_bucket text,
    p_subject uuid,
    p_limit integer,
    p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_count integer;
begin
    if p_subject is null
       or p_limit < 1
       or p_window_seconds < 1
       or p_bucket !~ '^[a-z0-9][a-z0-9:_-]{1,63}$' then
        raise exception 'Invalid rate-limit configuration.' using errcode = '22023';
    end if;

    insert into public.edge_rate_limits (
        bucket,
        subject,
        window_started_at,
        request_count
    ) values (
        p_bucket,
        p_subject,
        now(),
        1
    )
    on conflict (bucket, subject) do update
    set
        window_started_at = case
            when public.edge_rate_limits.window_started_at
                <= now() - make_interval(secs => p_window_seconds)
                then now()
            else public.edge_rate_limits.window_started_at
        end,
        request_count = case
            when public.edge_rate_limits.window_started_at
                <= now() - make_interval(secs => p_window_seconds)
                then 1
            else public.edge_rate_limits.request_count + 1
        end
    returning request_count into current_count;

    return current_count <= p_limit;
end;
$$;

revoke all on table public.edge_rate_limits from public, anon, authenticated;
grant all on table public.edge_rate_limits to service_role;

revoke all on function public.reserve_waiver_document(uuid, uuid, uuid)
    from public, anon, authenticated;
revoke all on function public.finalize_waiver_document(uuid, uuid, uuid, text, integer)
    from public, anon, authenticated;
revoke all on function public.fail_waiver_document(uuid, uuid, text)
    from public, anon, authenticated;
revoke all on function public.consume_edge_rate_limit(text, uuid, integer, integer)
    from public, anon, authenticated;

grant execute on function public.reserve_waiver_document(uuid, uuid, uuid)
    to service_role;
grant execute on function public.finalize_waiver_document(uuid, uuid, uuid, text, integer)
    to service_role;
grant execute on function public.fail_waiver_document(uuid, uuid, text)
    to service_role;
grant execute on function public.consume_edge_rate_limit(text, uuid, integer, integer)
    to service_role;
