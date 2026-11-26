insert into storage.buckets (
    id,
    name,
    public,
    file_size_limit,
    allowed_mime_types
) values (
    'invoice-documents',
    'invoice-documents',
    false,
    10485760,
    array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table public.invoice_documents (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete restrict,
    project_id uuid not null,
    subcontractor_id uuid not null,
    payment_request_id uuid unique references public.payment_requests(id) on delete restrict,
    uploaded_by uuid references auth.users(id) on delete set null,
    reviewed_by uuid references auth.users(id) on delete set null,
    storage_path text not null unique,
    file_name text not null,
    mime_type text not null,
    file_size integer not null,
    sha256 text not null,
    status text not null default 'extracting',
    extraction_provider text,
    extraction_model text,
    provider_response_id text,
    extracted_data jsonb not null default '{}'::jsonb,
    extraction_confidence jsonb not null default '{}'::jsonb,
    extraction_note text,
    invoice_number text,
    vendor_name text,
    invoice_date date,
    due_date date,
    project_reference text,
    description text,
    gross_amount bigint,
    currency varchar(3),
    retainage_basis_points integer,
    cost_code text,
    line_items jsonb not null default '[]'::jsonb,
    reviewed_data jsonb,
    failure_reason text,
    extracted_at timestamptz,
    reviewed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    foreign key (project_id, organization_id)
        references public.projects(id, organization_id) on delete restrict,
    foreign key (subcontractor_id, organization_id)
        references public.subcontractors(id, organization_id) on delete restrict,
    constraint invoice_documents_status check (
        status in ('extracting', 'review_required', 'confirmed', 'failed')
    ),
    constraint invoice_documents_mime_type check (
        mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
    ),
    constraint invoice_documents_file_size check (
        file_size between 1 and 10485760
    ),
    constraint invoice_documents_hash_format check (
        sha256 ~ '^[a-f0-9]{64}$'
    ),
    constraint invoice_documents_file_name_length check (
        char_length(btrim(file_name)) between 1 and 255
    ),
    constraint invoice_documents_extracted_data_object check (
        jsonb_typeof(extracted_data) = 'object'
    ),
    constraint invoice_documents_confidence_object check (
        jsonb_typeof(extraction_confidence) = 'object'
    ),
    constraint invoice_documents_line_items_array check (
        jsonb_typeof(line_items) = 'array'
    ),
    constraint invoice_documents_positive_gross check (
        gross_amount is null or gross_amount > 0
    ),
    constraint invoice_documents_retainage_range check (
        retainage_basis_points is null
        or retainage_basis_points between 0 and 10000
    ),
    constraint invoice_documents_currency_format check (
        currency is null or currency ~ '^[a-z]{3}$'
    ),
    constraint invoice_documents_confirmation_fields check (
        status <> 'confirmed'
        or (
            payment_request_id is not null
            and reviewed_by is not null
            and reviewed_at is not null
            and reviewed_data is not null
            and char_length(btrim(invoice_number)) between 1 and 100
            and char_length(btrim(description)) between 3 and 500
            and gross_amount > 0
            and currency ~ '^[a-z]{3}$'
            and retainage_basis_points between 0 and 10000
        )
    )
);

create unique index invoice_documents_organization_hash_unique
    on public.invoice_documents (organization_id, sha256)
    where status <> 'failed';

create unique index invoice_documents_confirmed_number_unique
    on public.invoice_documents (
        organization_id,
        subcontractor_id,
        lower(btrim(invoice_number))
    )
    where status = 'confirmed' and invoice_number is not null;

create index invoice_documents_organization_created_index
    on public.invoice_documents (organization_id, created_at desc);

create index invoice_documents_review_queue_index
    on public.invoice_documents (organization_id, status, created_at desc);

create trigger invoice_documents_set_updated_at
before update on public.invoice_documents
for each row execute function public.set_updated_at();

alter table public.invoice_documents enable row level security;

create policy "Financial roles can read invoice documents"
    on public.invoice_documents
    for select
    to authenticated
    using (
        public.has_organization_role(
            organization_id,
            array['owner', 'admin', 'accountant']
        )
    );

create policy "Financial roles can read private invoice files"
    on storage.objects
    for select
    to authenticated
    using (
        bucket_id = 'invoice-documents'
        and exists (
            select 1
            from public.organization_memberships as membership
            where membership.organization_id::text = (storage.foldername(name))[1]
              and membership.user_id = auth.uid()
              and membership.status = 'active'
              and membership.role in ('owner', 'admin', 'accountant')
        )
    );

create or replace function public.reserve_invoice_document(
    p_organization_id uuid,
    p_project_id uuid,
    p_subcontractor_id uuid,
    p_user_id uuid,
    p_file_name text,
    p_mime_type text,
    p_file_size integer,
    p_sha256 text
)
returns table (
    document_id uuid,
    storage_path text,
    project_name text,
    project_code text,
    subcontractor_name text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    document_id_value uuid := gen_random_uuid();
    storage_path_value text;
    project_record public.projects%rowtype;
    subcontractor_record public.subcontractors%rowtype;
begin
    if p_user_id is null then
        raise exception 'Authentication is required.' using errcode = '28000';
    end if;

    if not exists (
        select 1
        from public.organization_memberships as membership
        where membership.organization_id = p_organization_id
          and membership.user_id = p_user_id
          and membership.status = 'active'
          and membership.role in ('owner', 'admin', 'accountant')
    ) then
        raise exception 'You are not allowed to upload invoices.'
            using errcode = '42501';
    end if;

    if p_mime_type not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
       or p_file_size not between 1 and 10485760
       or lower(p_sha256) !~ '^[a-f0-9]{64}$'
       or char_length(btrim(p_file_name)) not between 1 and 255 then
        raise exception 'The invoice file is invalid.' using errcode = '22023';
    end if;

    select * into project_record
    from public.projects as project
    where project.id = p_project_id
      and project.organization_id = p_organization_id
      and project.status <> 'archived';

    if not found then
        raise exception 'An active project was not found.' using errcode = 'P0002';
    end if;

    select * into subcontractor_record
    from public.subcontractors as subcontractor
    where subcontractor.id = p_subcontractor_id
      and subcontractor.organization_id = p_organization_id
      and subcontractor.status = 'active';

    if not found then
        raise exception 'An active subcontractor was not found.' using errcode = 'P0002';
    end if;

    update public.invoice_documents
    set
        status = 'failed',
        failure_reason = 'A previous upload did not finish and may be retried.'
    where organization_id = p_organization_id
      and sha256 = lower(p_sha256)
      and status = 'extracting'
      and created_at < now() - interval '15 minutes';

    if exists (
        select 1
        from public.invoice_documents as invoice
        where invoice.organization_id = p_organization_id
          and invoice.sha256 = lower(p_sha256)
          and invoice.status <> 'failed'
    ) then
        raise exception 'This invoice file has already been uploaded.'
            using errcode = '23505';
    end if;

    storage_path_value := p_organization_id::text
        || '/' || document_id_value::text
        || case p_mime_type
            when 'application/pdf' then '.pdf'
            when 'image/png' then '.png'
            when 'image/webp' then '.webp'
            else '.jpg'
        end;

    insert into public.invoice_documents (
        id,
        organization_id,
        project_id,
        subcontractor_id,
        uploaded_by,
        storage_path,
        file_name,
        mime_type,
        file_size,
        sha256
    ) values (
        document_id_value,
        p_organization_id,
        p_project_id,
        p_subcontractor_id,
        p_user_id,
        storage_path_value,
        btrim(p_file_name),
        p_mime_type,
        p_file_size,
        lower(p_sha256)
    );

    insert into public.audit_events (
        organization_id,
        actor_user_id,
        action,
        entity_type,
        entity_id,
        metadata
    ) values (
        p_organization_id,
        p_user_id,
        'invoice.uploaded',
        'invoice_document',
        document_id_value,
        jsonb_build_object(
            'file_name', btrim(p_file_name),
            'file_size', p_file_size,
            'sha256', lower(p_sha256)
        )
    );

    return query select
        document_id_value,
        storage_path_value,
        project_record.name,
        project_record.code,
        subcontractor_record.company_name;
end;
$$;

create or replace function public.complete_invoice_extraction(
    p_document_id uuid,
    p_provider text,
    p_model text,
    p_provider_response_id text,
    p_extracted_data jsonb,
    p_extraction_confidence jsonb,
    p_extraction_note text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
    if jsonb_typeof(coalesce(p_extracted_data, '{}'::jsonb)) <> 'object'
       or jsonb_typeof(coalesce(p_extraction_confidence, '{}'::jsonb)) <> 'object' then
        raise exception 'Extraction data must be JSON objects.' using errcode = '22023';
    end if;

    update public.invoice_documents
    set
        status = 'review_required',
        extraction_provider = left(nullif(btrim(p_provider), ''), 50),
        extraction_model = left(nullif(btrim(p_model), ''), 100),
        provider_response_id = left(nullif(btrim(p_provider_response_id), ''), 255),
        extracted_data = coalesce(p_extracted_data, '{}'::jsonb),
        extraction_confidence = coalesce(p_extraction_confidence, '{}'::jsonb),
        extraction_note = left(nullif(btrim(p_extraction_note), ''), 500),
        extracted_at = now(),
        failure_reason = null
    where id = p_document_id
      and status = 'extracting';

    return found;
end;
$$;

create or replace function public.fail_invoice_document(
    p_document_id uuid,
    p_failure_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
    update public.invoice_documents
    set
        status = 'failed',
        failure_reason = left(
            coalesce(nullif(btrim(p_failure_reason), ''), 'Invoice upload failed.'),
            500
        )
    where id = p_document_id
      and status = 'extracting';

    return found;
end;
$$;

create or replace function public.confirm_invoice_document(
    p_invoice_document_id uuid,
    p_invoice_number text,
    p_vendor_name text,
    p_invoice_date date,
    p_due_date date,
    p_project_reference text,
    p_description text,
    p_gross_amount bigint,
    p_currency text,
    p_retainage_basis_points integer,
    p_cost_code text,
    p_line_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_user_id uuid := auth.uid();
    invoice_record public.invoice_documents%rowtype;
    payment_request_id_value uuid;
    normalized_invoice_number text := btrim(p_invoice_number);
    normalized_description text := btrim(p_description);
    normalized_currency text := lower(btrim(p_currency));
    reviewed_data_value jsonb;
begin
    if current_user_id is null then
        raise exception 'Authentication is required.' using errcode = '28000';
    end if;

    select * into invoice_record
    from public.invoice_documents as invoice
    where invoice.id = p_invoice_document_id
    for update;

    if not found then
        raise exception 'Invoice document was not found.' using errcode = 'P0002';
    end if;

    if not public.has_organization_role(
        invoice_record.organization_id,
        array['owner', 'admin', 'accountant']
    ) then
        raise exception 'You are not allowed to confirm invoices.'
            using errcode = '42501';
    end if;

    if invoice_record.status = 'confirmed' then
        return invoice_record.payment_request_id;
    end if;

    if invoice_record.status <> 'review_required' then
        raise exception 'This invoice is not ready for review.' using errcode = '55000';
    end if;

    if normalized_invoice_number is null
       or char_length(normalized_invoice_number) not between 1 and 100
       or normalized_description is null
       or char_length(normalized_description) not between 3 and 500
       or p_gross_amount is null
       or p_gross_amount <= 0
       or p_retainage_basis_points is null
       or p_retainage_basis_points not between 0 and 10000
       or normalized_currency is null
       or normalized_currency !~ '^[a-z]{3}$'
       or jsonb_typeof(coalesce(p_line_items, '[]'::jsonb)) <> 'array' then
        raise exception 'The reviewed invoice fields are invalid.' using errcode = '22023';
    end if;

    perform pg_advisory_xact_lock(
        hashtextextended(
            invoice_record.organization_id::text
                || ':' || invoice_record.subcontractor_id::text
                || ':' || lower(normalized_invoice_number),
            0
        )
    );

    if exists (
        select 1
        from public.invoice_documents as duplicate
        where duplicate.organization_id = invoice_record.organization_id
          and duplicate.subcontractor_id = invoice_record.subcontractor_id
          and lower(btrim(duplicate.invoice_number)) = lower(normalized_invoice_number)
          and duplicate.status = 'confirmed'
          and duplicate.id <> invoice_record.id
    ) then
        raise exception 'This invoice number is already recorded for the subcontractor.'
            using errcode = '23505';
    end if;

    insert into public.payment_requests (
        organization_id,
        project_id,
        subcontractor_id,
        created_by,
        description,
        gross_amount,
        retainage_basis_points,
        currency
    ) values (
        invoice_record.organization_id,
        invoice_record.project_id,
        invoice_record.subcontractor_id,
        current_user_id,
        normalized_description,
        p_gross_amount,
        p_retainage_basis_points,
        normalized_currency
    ) returning id into payment_request_id_value;

    reviewed_data_value := jsonb_build_object(
        'invoice_number', normalized_invoice_number,
        'vendor_name', nullif(btrim(p_vendor_name), ''),
        'invoice_date', p_invoice_date,
        'due_date', p_due_date,
        'project_reference', nullif(btrim(p_project_reference), ''),
        'description', normalized_description,
        'gross_amount', p_gross_amount,
        'currency', normalized_currency,
        'retainage_basis_points', p_retainage_basis_points,
        'cost_code', nullif(btrim(p_cost_code), ''),
        'line_items', coalesce(p_line_items, '[]'::jsonb)
    );

    update public.invoice_documents
    set
        payment_request_id = payment_request_id_value,
        reviewed_by = current_user_id,
        reviewed_at = now(),
        status = 'confirmed',
        invoice_number = normalized_invoice_number,
        vendor_name = nullif(btrim(p_vendor_name), ''),
        invoice_date = p_invoice_date,
        due_date = p_due_date,
        project_reference = nullif(btrim(p_project_reference), ''),
        description = normalized_description,
        gross_amount = p_gross_amount,
        currency = normalized_currency,
        retainage_basis_points = p_retainage_basis_points,
        cost_code = nullif(btrim(p_cost_code), ''),
        line_items = coalesce(p_line_items, '[]'::jsonb),
        reviewed_data = reviewed_data_value
    where id = invoice_record.id;

    insert into public.audit_events (
        organization_id,
        actor_user_id,
        action,
        entity_type,
        entity_id,
        metadata
    ) values
    (
        invoice_record.organization_id,
        current_user_id,
        'payment_request.created',
        'payment_request',
        payment_request_id_value,
        jsonb_build_object(
            'gross_amount', p_gross_amount,
            'retainage_basis_points', p_retainage_basis_points,
            'currency', normalized_currency,
            'source', 'invoice_intake',
            'invoice_document_id', invoice_record.id
        )
    ),
    (
        invoice_record.organization_id,
        current_user_id,
        'invoice.confirmed',
        'invoice_document',
        invoice_record.id,
        jsonb_build_object(
            'payment_request_id', payment_request_id_value,
            'invoice_number', normalized_invoice_number,
            'human_reviewed', true,
            'extraction_provider', invoice_record.extraction_provider
        )
    );

    return payment_request_id_value;
end;
$$;

create or replace function public.prepare_invoice_download(
    p_invoice_document_id uuid,
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
    select invoice.id, invoice.storage_path, invoice.file_name
    from public.invoice_documents as invoice
    join public.organization_memberships as membership
      on membership.organization_id = invoice.organization_id
     and membership.user_id = p_user_id
     and membership.status = 'active'
     and membership.role in ('owner', 'admin', 'accountant')
    where invoice.id = p_invoice_document_id
      and invoice.status in ('review_required', 'confirmed');

    if not found then
        raise exception 'A downloadable invoice was not found.' using errcode = 'P0002';
    end if;
end;
$$;

revoke all on table public.invoice_documents from anon, authenticated;
grant select on public.invoice_documents to authenticated;
grant all on public.invoice_documents to service_role;

revoke all on function public.reserve_invoice_document(
    uuid, uuid, uuid, uuid, text, text, integer, text
) from public, anon, authenticated;
revoke all on function public.complete_invoice_extraction(
    uuid, text, text, text, jsonb, jsonb, text
) from public, anon, authenticated;
revoke all on function public.fail_invoice_document(uuid, text)
    from public, anon, authenticated;
revoke all on function public.prepare_invoice_download(uuid, uuid)
    from public, anon, authenticated;

grant execute on function public.reserve_invoice_document(
    uuid, uuid, uuid, uuid, text, text, integer, text
) to service_role;
grant execute on function public.complete_invoice_extraction(
    uuid, text, text, text, jsonb, jsonb, text
) to service_role;
grant execute on function public.fail_invoice_document(uuid, text)
    to service_role;
grant execute on function public.prepare_invoice_download(uuid, uuid)
    to service_role;

revoke all on function public.confirm_invoice_document(
    uuid, text, text, date, date, text, text, bigint, text, integer, text, jsonb
) from public, anon;
grant execute on function public.confirm_invoice_document(
    uuid, text, text, date, date, text, text, bigint, text, integer, text, jsonb
) to authenticated;
