insert into storage.buckets (
    id,
    name,
    public,
    file_size_limit,
    allowed_mime_types
) values (
    'waiver-documents',
    'waiver-documents',
    false,
    2097152,
    array['application/pdf']
)
on conflict (id) do update
set
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table public.waiver_documents (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete restrict,
    payment_request_id uuid not null unique references public.payment_requests(id) on delete restrict,
    payment_id bigint not null references public.payments(id) on delete restrict,
    storage_path text not null unique,
    file_name text not null,
    mime_type text not null default 'application/pdf',
    status text not null default 'generating',
    generated_by uuid references auth.users(id) on delete set null,
    generated_at timestamptz,
    voided_at timestamptz,
    void_reason text,
    sha256 text,
    file_size integer,
    failure_reason text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint waiver_documents_status check (
        status in ('generating', 'ready', 'failed', 'voided')
    ),
    constraint waiver_documents_pdf_mime check (mime_type = 'application/pdf'),
    constraint waiver_documents_hash_format check (
        sha256 is null or sha256 ~ '^[a-f0-9]{64}$'
    ),
    constraint waiver_documents_file_size check (
        file_size is null or file_size between 1 and 2097152
    ),
    constraint waiver_documents_ready_fields check (
        status <> 'ready'
        or (
            generated_at is not null
            and sha256 is not null
            and file_size is not null
        )
    ),
    constraint waiver_documents_void_fields check (
        status <> 'voided' or voided_at is not null
    )
);

create index waiver_documents_organization_created_index
    on public.waiver_documents (organization_id, created_at desc);

create trigger waiver_documents_set_updated_at
before update on public.waiver_documents
for each row execute function public.set_updated_at();

alter table public.waiver_documents enable row level security;

create policy "Financial roles can read waiver documents"
    on public.waiver_documents
    for select
    to authenticated
    using (
        public.has_organization_role(
            organization_id,
            array['owner', 'admin', 'accountant']
        )
    );

create policy "Financial roles can read private waiver files"
    on storage.objects
    for select
    to authenticated
    using (
        bucket_id = 'waiver-documents'
        and exists (
            select 1
            from public.organization_memberships as membership
            where membership.organization_id::text = (storage.foldername(name))[1]
              and membership.user_id = auth.uid()
              and membership.status = 'active'
              and membership.role in ('owner', 'admin', 'accountant')
        )
    );

create or replace function public.reserve_waiver_document(
    p_payment_request_id uuid,
    p_user_id uuid
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
    paid_at timestamptz
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
begin
    if p_user_id is null then
        raise exception 'Authentication is required.' using errcode = '28000';
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
            || '/' || document_id_value::text || '.pdf';

        insert into public.waiver_documents (
            id,
            organization_id,
            payment_request_id,
            payment_id,
            storage_path,
            file_name,
            generated_by
        ) values (
            document_id_value,
            request_record.organization_id,
            p_payment_request_id,
            payment_record.id,
            document_storage_path,
            document_file_name,
            p_user_id
        ) returning * into document_record;

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
    elsif document_record.status = 'failed' then
        update public.waiver_documents
        set
            status = 'generating',
            generated_by = p_user_id,
            failure_reason = null
        where id = document_record.id
        returning * into document_record;
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
        payment_record.paid_at;
end;
$$;

create or replace function public.finalize_waiver_document(
    p_document_id uuid,
    p_user_id uuid,
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
        return true;
    end if;

    if document_record.status <> 'generating' then
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

create or replace function public.fail_waiver_document(
    p_document_id uuid,
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
      and status = 'generating';

    return found;
end;
$$;

create or replace function public.prepare_waiver_download(
    p_payment_request_id uuid,
    p_user_id uuid
)
returns table (
    document_id uuid,
    storage_path text,
    file_name text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
    return query
    select waiver.id, waiver.storage_path, waiver.file_name
    from public.waiver_documents as waiver
    join public.organization_memberships as membership
      on membership.organization_id = waiver.organization_id
     and membership.user_id = p_user_id
     and membership.status = 'active'
     and membership.role in ('owner', 'admin', 'accountant')
    where waiver.payment_request_id = p_payment_request_id
      and waiver.status = 'ready';

    if not found then
        raise exception 'A downloadable waiver was not found.' using errcode = 'P0002';
    end if;
end;
$$;

create or replace function public.void_waiver_after_refund()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    voided_document_id uuid;
begin
    if new.refunded_amount > old.refunded_amount and new.refunded_amount > 0 then
        update public.waiver_documents
        set
            status = 'voided',
            voided_at = now(),
            void_reason = 'Payment was partially or fully refunded.'
        where payment_request_id = new.id
          and status in ('generating', 'ready')
        returning id into voided_document_id;

        if voided_document_id is not null then
            insert into public.audit_events (
                organization_id,
                actor_user_id,
                action,
                entity_type,
                entity_id,
                metadata
            ) values (
                new.organization_id,
                null,
                'waiver.voided',
                'waiver_document',
                voided_document_id,
                jsonb_build_object(
                    'payment_request_id', new.id,
                    'refunded_amount', new.refunded_amount
                )
            );
        end if;
    end if;

    return new;
end;
$$;

create trigger payment_requests_void_waiver_after_refund
after update of refunded_amount on public.payment_requests
for each row execute function public.void_waiver_after_refund();

revoke all on table public.waiver_documents from anon, authenticated;
grant select on public.waiver_documents to authenticated;
grant all on public.waiver_documents to service_role;

revoke all on function public.reserve_waiver_document(uuid, uuid)
    from public, anon, authenticated;
revoke all on function public.finalize_waiver_document(uuid, uuid, text, integer)
    from public, anon, authenticated;
revoke all on function public.fail_waiver_document(uuid, text)
    from public, anon, authenticated;
revoke all on function public.prepare_waiver_download(uuid, uuid)
    from public, anon, authenticated;

grant execute on function public.reserve_waiver_document(uuid, uuid)
    to service_role;
grant execute on function public.finalize_waiver_document(uuid, uuid, text, integer)
    to service_role;
grant execute on function public.fail_waiver_document(uuid, text)
    to service_role;
grant execute on function public.prepare_waiver_download(uuid, uuid)
    to service_role;
