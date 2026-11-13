-- Preserve the waiver RPC timestamptz contract for legacy timestamp payment rows.
create or replace function public.reserve_waiver_document(
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
        payment_record.paid_at::timestamptz,
        generation_required_value,
        document_record.generation_token;
end;
$$;

comment on function public.reserve_waiver_document(uuid, uuid, uuid) is
    'Reserves idempotent waiver generation with legacy payment timestamp compatibility.';
