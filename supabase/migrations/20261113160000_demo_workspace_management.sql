create table public.demo_workspace_seeds (
    organization_id uuid primary key
        references public.organizations(id) on delete cascade,
    project_ids uuid[] not null,
    subcontractor_ids uuid[] not null,
    payment_request_ids uuid[] not null,
    status text not null default 'active',
    seeded_at timestamptz not null default now(),
    removed_at timestamptz,
    removed_by uuid references auth.users(id) on delete set null,
    constraint demo_workspace_seeds_project_count check (
        cardinality(project_ids) = 2
    ),
    constraint demo_workspace_seeds_subcontractor_count check (
        cardinality(subcontractor_ids) = 2
    ),
    constraint demo_workspace_seeds_request_count check (
        cardinality(payment_request_ids) = 3
    ),
    constraint demo_workspace_seeds_status check (
        status in ('active', 'removed')
    ),
    constraint demo_workspace_seeds_removal_fields check (
        (status = 'active' and removed_at is null and removed_by is null)
        or (status = 'removed' and removed_at is not null)
    )
);

alter table public.demo_workspace_seeds enable row level security;

revoke all on table public.demo_workspace_seeds from public, anon, authenticated;
grant all on table public.demo_workspace_seeds to service_role;

-- Preserve the original seed implementation as an internal primitive. The public
-- wrapper below records the exact row identifiers so cleanup never relies on names.
alter function public.seed_demo_organization(uuid)
    rename to seed_demo_organization_records;

revoke all on function public.seed_demo_organization_records(uuid)
    from public, anon, authenticated;
grant execute on function public.seed_demo_organization_records(uuid)
    to service_role;

create or replace function public.register_demo_workspace_seed(
    p_organization_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    seeded_project_ids uuid[];
    seeded_subcontractor_ids uuid[];
    seeded_request_ids uuid[];
begin
    select array_agg(project.id order by project.code)
    into seeded_project_ids
    from public.projects as project
    where project.organization_id = p_organization_id
      and project.code in ('CEDAR-01', 'HARBOR-02');

    select array_agg(subcontractor.id order by subcontractor.company_name)
    into seeded_subcontractor_ids
    from public.subcontractors as subcontractor
    where subcontractor.organization_id = p_organization_id
      and subcontractor.email in (
          'hector@example.test',
          'maya@example.test'
      );

    select array_agg(request.id order by request.description)
    into seeded_request_ids
    from public.payment_requests as request
    where request.organization_id = p_organization_id
      and request.description in (
          'Custom millwork deposit',
          'Electrical rough-in milestone',
          'Kitchen trim milestone'
      );

    if cardinality(seeded_project_ids) <> 2
       or cardinality(seeded_subcontractor_ids) <> 2
       or cardinality(seeded_request_ids) <> 3 then
        raise exception 'The demonstration workspace could not be registered safely.'
            using errcode = '55000';
    end if;

    insert into public.demo_workspace_seeds (
        organization_id,
        project_ids,
        subcontractor_ids,
        payment_request_ids
    ) values (
        p_organization_id,
        seeded_project_ids,
        seeded_subcontractor_ids,
        seeded_request_ids
    );
end;
$$;

revoke all on function public.register_demo_workspace_seed(uuid)
    from public, anon, authenticated;
grant execute on function public.register_demo_workspace_seed(uuid)
    to service_role;

create or replace function public.seed_demo_organization(
    p_organization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    result jsonb;
begin
    if exists (
        select 1
        from public.demo_workspace_seeds as seed
        where seed.organization_id = p_organization_id
    ) then
        raise exception 'Demonstration data has already been configured for this organization.'
            using errcode = '55000';
    end if;

    result := public.seed_demo_organization_records(p_organization_id);
    perform public.register_demo_workspace_seed(p_organization_id);

    return result;
end;
$$;

revoke all on function public.seed_demo_organization(uuid) from public, anon;
grant execute on function public.seed_demo_organization(uuid) to authenticated;
grant execute on function public.seed_demo_organization(uuid) to service_role;

-- Register legacy onboarding datasets only when the complete workspace exactly
-- matches the canonical sample. This intentionally avoids tagging partial or
-- user-created records that happen to share a name.
insert into public.demo_workspace_seeds (
    organization_id,
    project_ids,
    subcontractor_ids,
    payment_request_ids
)
select
    organization.id,
    array(
        select project.id
        from public.projects as project
        where project.organization_id = organization.id
        order by project.code
    ),
    array(
        select subcontractor.id
        from public.subcontractors as subcontractor
        where subcontractor.organization_id = organization.id
        order by subcontractor.company_name
    ),
    array(
        select request.id
        from public.payment_requests as request
        where request.organization_id = organization.id
        order by request.description
    )
from public.organizations as organization
where (
    select count(*)
    from public.projects as project
    where project.organization_id = organization.id
) = 2
and (
    select count(*)
    from public.subcontractors as subcontractor
    where subcontractor.organization_id = organization.id
) = 2
and (
    select count(*)
    from public.payment_requests as request
    where request.organization_id = organization.id
) = 3
and exists (
    select 1
    from public.projects as project
    where project.organization_id = organization.id
      and project.name = 'Cedar Kitchen Remodel'
      and project.code = 'CEDAR-01'
)
and exists (
    select 1
    from public.projects as project
    where project.organization_id = organization.id
      and project.name = 'Harbor Office Fit-Out'
      and project.code = 'HARBOR-02'
)
and exists (
    select 1
    from public.subcontractors as subcontractor
    where subcontractor.organization_id = organization.id
      and subcontractor.company_name = 'Fine Finish Carpentry'
      and subcontractor.contact_name = 'Hector Ramirez'
      and subcontractor.email = 'hector@example.test'
)
and exists (
    select 1
    from public.subcontractors as subcontractor
    where subcontractor.organization_id = organization.id
      and subcontractor.company_name = 'Northline Electrical'
      and subcontractor.contact_name = 'Maya Chen'
      and subcontractor.email = 'maya@example.test'
)
and exists (
    select 1
    from public.payment_requests as request
    join public.projects as project on project.id = request.project_id
    join public.subcontractors as subcontractor
      on subcontractor.id = request.subcontractor_id
    where request.organization_id = organization.id
      and request.description = 'Custom millwork deposit'
      and request.gross_amount = 185000
      and request.retainage_basis_points = 1000
      and request.status = 'draft'
      and project.code = 'CEDAR-01'
      and subcontractor.email = 'hector@example.test'
)
and exists (
    select 1
    from public.payment_requests as request
    join public.projects as project on project.id = request.project_id
    join public.subcontractors as subcontractor
      on subcontractor.id = request.subcontractor_id
    where request.organization_id = organization.id
      and request.description = 'Electrical rough-in milestone'
      and request.gross_amount = 940000
      and request.retainage_basis_points = 500
      and request.status = 'submitted'
      and project.code = 'HARBOR-02'
      and subcontractor.email = 'maya@example.test'
)
and exists (
    select 1
    from public.payment_requests as request
    join public.projects as project on project.id = request.project_id
    join public.subcontractors as subcontractor
      on subcontractor.id = request.subcontractor_id
    where request.organization_id = organization.id
      and request.description = 'Kitchen trim milestone'
      and request.gross_amount = 105000
      and request.retainage_basis_points = 1000
      and request.status = 'approved'
      and project.code = 'CEDAR-01'
      and subcontractor.email = 'hector@example.test'
)
on conflict (organization_id) do nothing;

create or replace function public.demo_workspace_removal_blocker(
    p_organization_id uuid
)
returns text
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
    seed_record public.demo_workspace_seeds%rowtype;
begin
    select *
    into seed_record
    from public.demo_workspace_seeds as seed
    where seed.organization_id = p_organization_id
      and seed.status = 'active';

    if not found then
        return 'No active demonstration dataset is registered for this workspace.';
    end if;

    if (
        select count(*)
        from public.projects as project
        where project.organization_id = p_organization_id
          and project.id = any(seed_record.project_ids)
    ) <> cardinality(seed_record.project_ids)
       or (
        select count(*)
        from public.subcontractors as subcontractor
        where subcontractor.organization_id = p_organization_id
          and subcontractor.id = any(seed_record.subcontractor_ids)
    ) <> cardinality(seed_record.subcontractor_ids)
       or (
        select count(*)
        from public.payment_requests as request
        where request.organization_id = p_organization_id
          and request.id = any(seed_record.payment_request_ids)
    ) <> cardinality(seed_record.payment_request_ids) then
        return 'Some demonstration records have already been changed or removed.';
    end if;

    if exists (
        select 1
        from public.payment_requests as request
        where request.id = any(seed_record.payment_request_ids)
          and (
              request.checkout_started_at is not null
              or request.status in (
                  'checkout_created',
                  'processing',
                  'paid',
                  'failed',
                  'partially_refunded',
                  'refunded'
              )
          )
    ) then
        return 'Demonstration data cannot be removed after a checkout has started.';
    end if;

    if exists (
        select 1
        from public.payments as payment
        where payment.payment_request_id = any(seed_record.payment_request_ids)
    ) or exists (
        select 1
        from public.payment_refunds as refund
        where refund.payment_request_id = any(seed_record.payment_request_ids)
    ) or exists (
        select 1
        from public.waiver_documents as waiver
        where waiver.payment_request_id = any(seed_record.payment_request_ids)
    ) then
        return 'Demonstration data has payment or document history and must be retained.';
    end if;

    if exists (
        select 1
        from public.notification_deliveries as delivery
        where delivery.payment_request_id = any(seed_record.payment_request_ids)
          and delivery.status in ('processing', 'sent')
    ) then
        return 'Demonstration data has an in-progress or delivered notification.';
    end if;

    if exists (
        select 1
        from public.payment_requests as request
        where request.organization_id = p_organization_id
          and request.id <> all(seed_record.payment_request_ids)
          and (
              request.project_id = any(seed_record.project_ids)
              or request.subcontractor_id = any(seed_record.subcontractor_ids)
          )
    ) then
        return 'A non-demonstration payment request uses a demonstration record.';
    end if;

    if exists (
        select 1
        from public.project_subcontractors as assignment
        where assignment.organization_id = p_organization_id
          and (
              assignment.project_id = any(seed_record.project_ids)
              or assignment.subcontractor_id = any(seed_record.subcontractor_ids)
          )
          and not (
              assignment.project_id = any(seed_record.project_ids)
              and assignment.subcontractor_id = any(seed_record.subcontractor_ids)
          )
    ) then
        return 'A non-demonstration directory record is linked to demonstration data.';
    end if;

    return null;
end;
$$;

revoke all on function public.demo_workspace_removal_blocker(uuid)
    from public, anon, authenticated;
grant execute on function public.demo_workspace_removal_blocker(uuid)
    to service_role;

create or replace function public.get_demo_workspace_status(
    p_organization_id uuid
)
returns table (
    status text,
    can_remove boolean,
    reason text
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
    blocker text;
begin
    if auth.uid() is null
       or not public.has_organization_role(
           p_organization_id,
           array['owner']
       ) then
        raise exception 'Only the organization owner can inspect demonstration data.'
            using errcode = '42501';
    end if;

    if not exists (
        select 1
        from public.demo_workspace_seeds as seed
        where seed.organization_id = p_organization_id
          and seed.status = 'active'
    ) then
        return;
    end if;

    blocker := public.demo_workspace_removal_blocker(p_organization_id);

    return query
    select 'active'::text, blocker is null, blocker;
end;
$$;

create or replace function public.remove_demo_workspace_data(
    p_organization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    actor_id uuid := auth.uid();
    seed_record public.demo_workspace_seeds%rowtype;
    blocker text;
    deleted_projects integer;
    deleted_subcontractors integer;
    deleted_requests integer;
begin
    if actor_id is null
       or not public.has_organization_role(
           p_organization_id,
           array['owner']
       ) then
        raise exception 'Only the organization owner can remove demonstration data.'
            using errcode = '42501';
    end if;

    select *
    into seed_record
    from public.demo_workspace_seeds as seed
    where seed.organization_id = p_organization_id
      and seed.status = 'active'
    for update;

    if not found then
        raise exception 'No active demonstration dataset is registered for this workspace.'
            using errcode = '55000';
    end if;

    blocker := public.demo_workspace_removal_blocker(p_organization_id);

    if blocker is not null then
        raise exception '%', blocker using errcode = '55000';
    end if;

    delete from public.notification_deliveries as delivery
    where delivery.payment_request_id = any(seed_record.payment_request_ids);

    delete from public.payment_requests as request
    where request.id = any(seed_record.payment_request_ids);
    get diagnostics deleted_requests = row_count;

    delete from public.project_subcontractors as assignment
    where assignment.organization_id = p_organization_id
      and (
          assignment.project_id = any(seed_record.project_ids)
          or assignment.subcontractor_id = any(seed_record.subcontractor_ids)
      );

    delete from public.subcontractors as subcontractor
    where subcontractor.id = any(seed_record.subcontractor_ids);
    get diagnostics deleted_subcontractors = row_count;

    delete from public.projects as project
    where project.id = any(seed_record.project_ids);
    get diagnostics deleted_projects = row_count;

    update public.demo_workspace_seeds
    set
        status = 'removed',
        removed_at = now(),
        removed_by = actor_id
    where organization_id = p_organization_id;

    insert into public.audit_events (
        organization_id,
        actor_user_id,
        action,
        entity_type,
        entity_id,
        metadata
    ) values (
        p_organization_id,
        actor_id,
        'organization.demo_data_removed',
        'organization',
        p_organization_id,
        jsonb_build_object(
            'projects', deleted_projects,
            'subcontractors', deleted_subcontractors,
            'paymentRequests', deleted_requests
        )
    );

    return jsonb_build_object(
        'projects', deleted_projects,
        'subcontractors', deleted_subcontractors,
        'paymentRequests', deleted_requests
    );
end;
$$;

revoke all on function public.get_demo_workspace_status(uuid)
    from public, anon;
revoke all on function public.remove_demo_workspace_data(uuid)
    from public, anon;
grant execute on function public.get_demo_workspace_status(uuid)
    to authenticated, service_role;
grant execute on function public.remove_demo_workspace_data(uuid)
    to authenticated, service_role;
