create or replace function public.list_organization_members(
    p_organization_id uuid
)
returns table (
    user_id uuid,
    email text,
    role text,
    status text,
    created_at timestamptz,
    updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if not public.has_organization_role(
        p_organization_id,
        array['owner', 'admin']
    ) then
        raise exception 'You are not allowed to view organization members.'
            using errcode = '42501';
    end if;

    return query
    select
        membership.user_id,
        auth_user.email::text,
        membership.role,
        membership.status,
        membership.created_at,
        membership.updated_at
    from public.organization_memberships as membership
    join auth.users as auth_user on auth_user.id = membership.user_id
    where membership.organization_id = p_organization_id
    order by
        case membership.role
            when 'owner' then 1
            when 'admin' then 2
            when 'accountant' then 3
            when 'member' then 4
            else 5
        end,
        lower(auth_user.email);
end;
$$;

create or replace function public.upsert_organization_member(
    p_organization_id uuid,
    p_email text,
    p_role text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    actor_id uuid := auth.uid();
    actor_role text;
    normalized_email text := lower(trim(p_email));
    target_user_id uuid;
    existing_role text;
begin
    actor_role := public.organization_role(p_organization_id);

    if actor_id is null or actor_role not in ('owner', 'admin') then
        raise exception 'You are not allowed to manage organization members.'
            using errcode = '42501';
    end if;

    if normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
       or char_length(normalized_email) > 320 then
        raise exception 'Enter a valid registered user email address.'
            using errcode = '22023';
    end if;

    if p_role not in ('admin', 'accountant', 'member', 'subcontractor') then
        raise exception 'Select a supported organization role.'
            using errcode = '22023';
    end if;

    select auth_user.id
    into target_user_id
    from auth.users as auth_user
    where lower(auth_user.email) = normalized_email
    limit 1;

    if target_user_id is null then
        raise exception 'No registered TradeLedger user has that email address.'
            using errcode = 'P0002';
    end if;

    select membership.role
    into existing_role
    from public.organization_memberships as membership
    where membership.organization_id = p_organization_id
      and membership.user_id = target_user_id;

    if existing_role = 'owner' then
        raise exception 'The organization owner role cannot be changed here.'
            using errcode = '55000';
    end if;

    if actor_role = 'admin'
       and (
           p_role in ('admin', 'accountant')
           or existing_role in ('admin', 'accountant')
       ) then
        raise exception 'Only an owner can manage admin or accountant access.'
            using errcode = '42501';
    end if;

    insert into public.organization_memberships (
        organization_id,
        user_id,
        role,
        status
    ) values (
        p_organization_id,
        target_user_id,
        p_role,
        'active'
    )
    on conflict (organization_id, user_id) do update
    set
        role = excluded.role,
        status = 'active';

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
        'organization_membership.upserted',
        'organization_membership',
        target_user_id,
        jsonb_build_object('role', p_role, 'status', 'active')
    );

    return target_user_id;
end;
$$;

create or replace function public.set_organization_member_status(
    p_organization_id uuid,
    p_user_id uuid,
    p_status text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    actor_id uuid := auth.uid();
    actor_role text;
    target_role text;
begin
    actor_role := public.organization_role(p_organization_id);

    if actor_id is null or actor_role not in ('owner', 'admin') then
        raise exception 'You are not allowed to manage organization members.'
            using errcode = '42501';
    end if;

    if p_status not in ('active', 'suspended') then
        raise exception 'Select a supported membership status.'
            using errcode = '22023';
    end if;

    select membership.role
    into target_role
    from public.organization_memberships as membership
    where membership.organization_id = p_organization_id
      and membership.user_id = p_user_id;

    if target_role is null then
        raise exception 'The organization member was not found.'
            using errcode = 'P0002';
    end if;

    if target_role = 'owner' then
        raise exception 'The organization owner cannot be suspended.'
            using errcode = '55000';
    end if;

    if actor_role = 'admin' and target_role in ('admin', 'accountant') then
        raise exception 'Only an owner can change admin or accountant access.'
            using errcode = '42501';
    end if;

    update public.organization_memberships as membership
    set status = p_status
    where membership.organization_id = p_organization_id
      and membership.user_id = p_user_id;

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
        'organization_membership.status_changed',
        'organization_membership',
        p_user_id,
        jsonb_build_object('role', target_role, 'status', p_status)
    );

    return true;
end;
$$;

create or replace function public.seed_demo_organization(
    p_organization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    actor_id uuid := auth.uid();
    project_one_id uuid;
    project_two_id uuid;
    subcontractor_one_id uuid;
    subcontractor_two_id uuid;
    draft_request_id uuid;
    submitted_request_id uuid;
    approved_request_id uuid;
begin
    if actor_id is null
       or not public.has_organization_role(
           p_organization_id,
           array['owner', 'admin']
       ) then
        raise exception 'You are not allowed to seed this organization.'
            using errcode = '42501';
    end if;

    if exists (
        select 1 from public.projects where organization_id = p_organization_id
        union all
        select 1 from public.subcontractors where organization_id = p_organization_id
        union all
        select 1 from public.payment_requests where organization_id = p_organization_id
    ) then
        raise exception 'Demo data can only be added to an empty organization.'
            using errcode = '55000';
    end if;

    insert into public.projects (organization_id, name, code, status)
    values (p_organization_id, 'Cedar Kitchen Remodel', 'CEDAR-01', 'active')
    returning id into project_one_id;

    insert into public.projects (organization_id, name, code, status)
    values (p_organization_id, 'Harbor Office Fit-Out', 'HARBOR-02', 'active')
    returning id into project_two_id;

    insert into public.subcontractors (
        organization_id,
        company_name,
        contact_name,
        email,
        status
    ) values (
        p_organization_id,
        'Fine Finish Carpentry',
        'Hector Ramirez',
        'hector@example.test',
        'active'
    ) returning id into subcontractor_one_id;

    insert into public.subcontractors (
        organization_id,
        company_name,
        contact_name,
        email,
        status
    ) values (
        p_organization_id,
        'Northline Electrical',
        'Maya Chen',
        'maya@example.test',
        'active'
    ) returning id into subcontractor_two_id;

    insert into public.project_subcontractors (
        organization_id,
        project_id,
        subcontractor_id
    ) values
        (p_organization_id, project_one_id, subcontractor_one_id),
        (p_organization_id, project_two_id, subcontractor_two_id);

    draft_request_id := public.create_payment_request(
        p_organization_id,
        project_one_id,
        subcontractor_one_id,
        'Custom millwork deposit',
        185000,
        1000,
        'usd'
    );

    submitted_request_id := public.create_payment_request(
        p_organization_id,
        project_two_id,
        subcontractor_two_id,
        'Electrical rough-in milestone',
        940000,
        500,
        'usd'
    );
    perform public.submit_payment_request(submitted_request_id);

    approved_request_id := public.create_payment_request(
        p_organization_id,
        project_one_id,
        subcontractor_one_id,
        'Kitchen trim milestone',
        105000,
        1000,
        'usd'
    );
    perform public.submit_payment_request(approved_request_id);
    perform public.approve_payment_request(approved_request_id);

    return jsonb_build_object(
        'projects', 2,
        'subcontractors', 2,
        'paymentRequests', 3,
        'draftRequestId', draft_request_id,
        'submittedRequestId', submitted_request_id,
        'approvedRequestId', approved_request_id
    );
end;
$$;

create or replace function public.create_organization_workspace(
    p_name text,
    p_slug text,
    p_seed_demo boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    organization_id uuid;
begin
    organization_id := public.create_organization(p_name, p_slug);

    if p_seed_demo then
        perform public.seed_demo_organization(organization_id);
    end if;

    return organization_id;
end;
$$;

revoke all on function public.list_organization_members(uuid) from public, anon;
revoke all on function public.upsert_organization_member(uuid, text, text)
    from public, anon;
revoke all on function public.set_organization_member_status(uuid, uuid, text)
    from public, anon;
revoke all on function public.seed_demo_organization(uuid) from public, anon;
revoke all on function public.create_organization_workspace(text, text, boolean)
    from public, anon;

grant execute on function public.list_organization_members(uuid) to authenticated;
grant execute on function public.upsert_organization_member(uuid, text, text)
    to authenticated;
grant execute on function public.set_organization_member_status(uuid, uuid, text)
    to authenticated;
grant execute on function public.seed_demo_organization(uuid) to authenticated;
grant execute on function public.create_organization_workspace(text, text, boolean)
    to authenticated;

grant execute on function public.list_organization_members(uuid) to service_role;
grant execute on function public.upsert_organization_member(uuid, text, text)
    to service_role;
grant execute on function public.set_organization_member_status(uuid, uuid, text)
    to service_role;
grant execute on function public.seed_demo_organization(uuid) to service_role;
grant execute on function public.create_organization_workspace(text, text, boolean)
    to service_role;
