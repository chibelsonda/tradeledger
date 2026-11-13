create extension if not exists pgcrypto with schema extensions;

create table if not exists public.organizations (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    slug text not null unique,
    created_by uuid not null references auth.users(id) on delete restrict,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint organizations_name_length check (char_length(btrim(name)) between 2 and 120),
    constraint organizations_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

create table if not exists public.organization_memberships (
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    role text not null,
    status text not null default 'active',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (organization_id, user_id),
    constraint organization_memberships_role check (
        role in ('owner', 'admin', 'accountant', 'member', 'subcontractor')
    ),
    constraint organization_memberships_status check (
        status in ('invited', 'active', 'suspended')
    )
);

create table if not exists public.projects (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    name text not null,
    code text not null,
    status text not null default 'active',
    created_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (organization_id, code),
    unique (id, organization_id),
    constraint projects_name_length check (char_length(btrim(name)) between 2 and 160),
    constraint projects_code_format check (code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$'),
    constraint projects_status check (status in ('active', 'on_hold', 'completed', 'archived'))
);

create table if not exists public.subcontractors (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid references auth.users(id) on delete set null,
    company_name text not null,
    contact_name text,
    email text,
    status text not null default 'active',
    created_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (id, organization_id),
    constraint subcontractors_company_name_length check (
        char_length(btrim(company_name)) between 2 and 160
    ),
    constraint subcontractors_status check (status in ('active', 'inactive', 'blocked'))
);

create table if not exists public.project_subcontractors (
    organization_id uuid not null references public.organizations(id) on delete cascade,
    project_id uuid not null,
    subcontractor_id uuid not null,
    assigned_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
    assigned_at timestamptz not null default now(),
    primary key (project_id, subcontractor_id),
    foreign key (project_id, organization_id)
        references public.projects(id, organization_id) on delete cascade,
    foreign key (subcontractor_id, organization_id)
        references public.subcontractors(id, organization_id) on delete cascade
);

create table if not exists public.payment_requests (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    project_id uuid not null,
    subcontractor_id uuid not null,
    created_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
    approved_by uuid references auth.users(id) on delete restrict,
    description text not null,
    gross_amount bigint not null,
    retainage_basis_points integer not null default 0,
    retainage_amount bigint generated always as (
        (gross_amount * retainage_basis_points + 5000) / 10000
    ) stored,
    net_amount bigint generated always as (
        gross_amount - ((gross_amount * retainage_basis_points + 5000) / 10000)
    ) stored,
    currency varchar(3) not null default 'usd',
    status text not null default 'draft',
    submitted_at timestamptz,
    approved_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    foreign key (project_id, organization_id)
        references public.projects(id, organization_id) on delete restrict,
    foreign key (subcontractor_id, organization_id)
        references public.subcontractors(id, organization_id) on delete restrict,
    constraint payment_requests_description_length check (
        char_length(btrim(description)) between 3 and 500
    ),
    constraint payment_requests_positive_gross check (gross_amount > 0),
    constraint payment_requests_retainage_range check (
        retainage_basis_points between 0 and 10000
    ),
    constraint payment_requests_currency_format check (currency ~ '^[a-z]{3}$'),
    constraint payment_requests_status check (
        status in ('draft', 'submitted', 'approved', 'canceled')
    ),
    constraint payment_requests_submission_fields check (
        status = 'draft' or submitted_at is not null
    ),
    constraint payment_requests_approval_fields check (
        status <> 'approved' or (approved_by is not null and approved_at is not null)
    )
);

create table if not exists public.audit_events (
    id bigint generated by default as identity primary key,
    organization_id uuid not null references public.organizations(id) on delete cascade,
    actor_user_id uuid references auth.users(id) on delete set null,
    action text not null,
    entity_type text not null,
    entity_id uuid,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

alter table public.payments
    add column if not exists organization_id uuid references public.organizations(id) on delete restrict,
    add column if not exists payment_request_id uuid references public.payment_requests(id) on delete restrict;

create index if not exists organization_memberships_user_index
    on public.organization_memberships (user_id, status, organization_id);
create index if not exists projects_organization_status_index
    on public.projects (organization_id, status, created_at desc);
create index if not exists subcontractors_organization_status_index
    on public.subcontractors (organization_id, status, company_name);
create index if not exists project_subcontractors_subcontractor_index
    on public.project_subcontractors (subcontractor_id, project_id);
create index if not exists payment_requests_organization_status_index
    on public.payment_requests (organization_id, status, created_at desc);
create index if not exists payment_requests_project_index
    on public.payment_requests (project_id, created_at desc);
create index if not exists audit_events_organization_created_index
    on public.audit_events (organization_id, created_at desc);
create index if not exists payments_organization_created_index
    on public.payments (organization_id, created_at desc);
create unique index if not exists payments_payment_request_unique
    on public.payments (payment_request_id)
    where payment_request_id is not null;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists organizations_set_updated_at on public.organizations;
create trigger organizations_set_updated_at
before update on public.organizations
for each row execute function public.set_updated_at();

drop trigger if exists organization_memberships_set_updated_at on public.organization_memberships;
create trigger organization_memberships_set_updated_at
before update on public.organization_memberships
for each row execute function public.set_updated_at();

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
before update on public.projects
for each row execute function public.set_updated_at();

drop trigger if exists subcontractors_set_updated_at on public.subcontractors;
create trigger subcontractors_set_updated_at
before update on public.subcontractors
for each row execute function public.set_updated_at();

drop trigger if exists payment_requests_set_updated_at on public.payment_requests;
create trigger payment_requests_set_updated_at
before update on public.payment_requests
for each row execute function public.set_updated_at();

create or replace function public.organization_role(p_organization_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
    select membership.role
    from public.organization_memberships as membership
    where membership.organization_id = p_organization_id
      and membership.user_id = auth.uid()
      and membership.status = 'active'
    limit 1;
$$;

create or replace function public.is_organization_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select public.organization_role(p_organization_id) is not null;
$$;

create or replace function public.has_organization_role(
    p_organization_id uuid,
    p_roles text[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select coalesce(public.organization_role(p_organization_id) = any(p_roles), false);
$$;

create or replace function public.create_organization(
    p_name text,
    p_slug text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_user_id uuid := auth.uid();
    organization_id uuid;
    normalized_name text := btrim(p_name);
    normalized_slug text := lower(btrim(p_slug));
begin
    if current_user_id is null then
        raise exception 'Authentication is required.' using errcode = '28000';
    end if;

    if char_length(normalized_name) not between 2 and 120 then
        raise exception 'Organization name must be between 2 and 120 characters.'
            using errcode = '22023';
    end if;

    if normalized_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
        raise exception 'Organization slug must use lowercase letters, numbers, and single hyphens.'
            using errcode = '22023';
    end if;

    insert into public.organizations (name, slug, created_by)
    values (normalized_name, normalized_slug, current_user_id)
    returning id into organization_id;

    insert into public.organization_memberships (
        organization_id,
        user_id,
        role,
        status
    ) values (
        organization_id,
        current_user_id,
        'owner',
        'active'
    );

    insert into public.audit_events (
        organization_id,
        actor_user_id,
        action,
        entity_type,
        entity_id,
        metadata
    ) values (
        organization_id,
        current_user_id,
        'organization.created',
        'organization',
        organization_id,
        jsonb_build_object('name', normalized_name)
    );

    return organization_id;
end;
$$;

create or replace function public.create_payment_request(
    p_organization_id uuid,
    p_project_id uuid,
    p_subcontractor_id uuid,
    p_description text,
    p_gross_amount bigint,
    p_retainage_basis_points integer default 0,
    p_currency text default 'usd'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_user_id uuid := auth.uid();
    request_id uuid;
begin
    if current_user_id is null then
        raise exception 'Authentication is required.' using errcode = '28000';
    end if;

    if not public.has_organization_role(
        p_organization_id,
        array['owner', 'admin', 'accountant']
    ) then
        raise exception 'You are not allowed to create payment requests.'
            using errcode = '42501';
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
        p_organization_id,
        p_project_id,
        p_subcontractor_id,
        current_user_id,
        btrim(p_description),
        p_gross_amount,
        p_retainage_basis_points,
        lower(p_currency)
    ) returning id into request_id;

    insert into public.audit_events (
        organization_id,
        actor_user_id,
        action,
        entity_type,
        entity_id,
        metadata
    ) values (
        p_organization_id,
        current_user_id,
        'payment_request.created',
        'payment_request',
        request_id,
        jsonb_build_object(
            'gross_amount', p_gross_amount,
            'retainage_basis_points', p_retainage_basis_points,
            'currency', lower(p_currency)
        )
    );

    return request_id;
end;
$$;

create or replace function public.submit_payment_request(p_payment_request_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_user_id uuid := auth.uid();
    request_organization_id uuid;
begin
    select payment_request.organization_id
    into request_organization_id
    from public.payment_requests as payment_request
    where payment_request.id = p_payment_request_id;

    if request_organization_id is null
       or not public.has_organization_role(
           request_organization_id,
           array['owner', 'admin', 'accountant']
       ) then
        return false;
    end if;

    update public.payment_requests
    set status = 'submitted', submitted_at = now()
    where id = p_payment_request_id
      and status = 'draft';

    if not found then
        return false;
    end if;

    insert into public.audit_events (
        organization_id,
        actor_user_id,
        action,
        entity_type,
        entity_id
    ) values (
        request_organization_id,
        current_user_id,
        'payment_request.submitted',
        'payment_request',
        p_payment_request_id
    );

    return true;
end;
$$;

create or replace function public.approve_payment_request(p_payment_request_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_user_id uuid := auth.uid();
    request_organization_id uuid;
begin
    select payment_request.organization_id
    into request_organization_id
    from public.payment_requests as payment_request
    where payment_request.id = p_payment_request_id;

    if request_organization_id is null
       or not public.has_organization_role(
           request_organization_id,
           array['owner', 'accountant']
       ) then
        return false;
    end if;

    update public.payment_requests
    set
        status = 'approved',
        approved_by = current_user_id,
        approved_at = now()
    where id = p_payment_request_id
      and status = 'submitted';

    if not found then
        return false;
    end if;

    insert into public.audit_events (
        organization_id,
        actor_user_id,
        action,
        entity_type,
        entity_id
    ) values (
        request_organization_id,
        current_user_id,
        'payment_request.approved',
        'payment_request',
        p_payment_request_id
    );

    return true;
end;
$$;

alter table public.organizations enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.projects enable row level security;
alter table public.subcontractors enable row level security;
alter table public.project_subcontractors enable row level security;
alter table public.payment_requests enable row level security;
alter table public.audit_events enable row level security;

create policy "Members can read their organizations"
    on public.organizations
    for select
    to authenticated
    using (public.is_organization_member(id));

create policy "Owners and admins can update organizations"
    on public.organizations
    for update
    to authenticated
    using (public.has_organization_role(id, array['owner', 'admin']))
    with check (public.has_organization_role(id, array['owner', 'admin']));

create policy "Members can read their own membership"
    on public.organization_memberships
    for select
    to authenticated
    using (
        user_id = auth.uid()
        or public.has_organization_role(
            organization_id,
            array['owner', 'admin', 'accountant']
        )
    );

create policy "Organization members can read projects"
    on public.projects
    for select
    to authenticated
    using (
        public.has_organization_role(
            organization_id,
            array['owner', 'admin', 'accountant', 'member']
        )
        or exists (
            select 1
            from public.project_subcontractors as assignment
            join public.subcontractors as subcontractor
              on subcontractor.id = assignment.subcontractor_id
            where assignment.project_id = projects.id
              and subcontractor.user_id = auth.uid()
        )
    );

create policy "Owners and admins can create projects"
    on public.projects
    for insert
    to authenticated
    with check (
        created_by = auth.uid()
        and public.has_organization_role(organization_id, array['owner', 'admin'])
    );

create policy "Owners and admins can update projects"
    on public.projects
    for update
    to authenticated
    using (public.has_organization_role(organization_id, array['owner', 'admin']))
    with check (public.has_organization_role(organization_id, array['owner', 'admin']));

create policy "Owners and admins can delete projects"
    on public.projects
    for delete
    to authenticated
    using (public.has_organization_role(organization_id, array['owner', 'admin']));

create policy "Organization members can read subcontractors"
    on public.subcontractors
    for select
    to authenticated
    using (
        public.has_organization_role(
            organization_id,
            array['owner', 'admin', 'accountant', 'member']
        )
        or user_id = auth.uid()
    );

create policy "Owners and admins can create subcontractors"
    on public.subcontractors
    for insert
    to authenticated
    with check (
        created_by = auth.uid()
        and public.has_organization_role(organization_id, array['owner', 'admin'])
    );

create policy "Owners and admins can update subcontractors"
    on public.subcontractors
    for update
    to authenticated
    using (public.has_organization_role(organization_id, array['owner', 'admin']))
    with check (public.has_organization_role(organization_id, array['owner', 'admin']));

create policy "Owners and admins can delete subcontractors"
    on public.subcontractors
    for delete
    to authenticated
    using (public.has_organization_role(organization_id, array['owner', 'admin']));

create policy "Organization members can read assignments"
    on public.project_subcontractors
    for select
    to authenticated
    using (
        public.is_organization_member(organization_id)
        or exists (
            select 1
            from public.subcontractors as subcontractor
            where subcontractor.id = project_subcontractors.subcontractor_id
              and subcontractor.user_id = auth.uid()
        )
    );

create policy "Owners and admins can create assignments"
    on public.project_subcontractors
    for insert
    to authenticated
    with check (
        assigned_by = auth.uid()
        and public.has_organization_role(organization_id, array['owner', 'admin'])
    );

create policy "Owners and admins can delete assignments"
    on public.project_subcontractors
    for delete
    to authenticated
    using (public.has_organization_role(organization_id, array['owner', 'admin']));

create policy "Authorized members can read payment requests"
    on public.payment_requests
    for select
    to authenticated
    using (
        public.has_organization_role(
            organization_id,
            array['owner', 'admin', 'accountant', 'member']
        )
        or created_by = auth.uid()
        or exists (
            select 1
            from public.subcontractors as subcontractor
            where subcontractor.id = payment_requests.subcontractor_id
              and subcontractor.user_id = auth.uid()
        )
    );

create policy "Financial roles can read audit events"
    on public.audit_events
    for select
    to authenticated
    using (
        public.has_organization_role(
            organization_id,
            array['owner', 'admin', 'accountant']
        )
    );

drop policy if exists "Users can read their own payments" on public.payments;
create policy "Users can read permitted payments"
    on public.payments
    for select
    to authenticated
    using (
        user_id = auth.uid()
        or (
            organization_id is not null
            and public.has_organization_role(
                organization_id,
                array['owner', 'admin', 'accountant']
            )
        )
    );

revoke all on table public.organizations from anon, authenticated;
revoke all on table public.organization_memberships from anon, authenticated;
revoke all on table public.projects from anon, authenticated;
revoke all on table public.subcontractors from anon, authenticated;
revoke all on table public.project_subcontractors from anon, authenticated;
revoke all on table public.payment_requests from anon, authenticated;
revoke all on table public.audit_events from anon, authenticated;

grant select on public.organizations to authenticated;
grant update (name, slug) on public.organizations to authenticated;
grant select on public.organization_memberships to authenticated;
grant select on public.projects to authenticated;
grant insert (organization_id, name, code, status) on public.projects to authenticated;
grant update (name, code, status) on public.projects to authenticated;
grant delete on public.projects to authenticated;
grant select on public.subcontractors to authenticated;
grant insert (
    organization_id,
    user_id,
    company_name,
    contact_name,
    email,
    status
) on public.subcontractors to authenticated;
grant update (user_id, company_name, contact_name, email, status)
    on public.subcontractors to authenticated;
grant delete on public.subcontractors to authenticated;
grant select, insert, delete on public.project_subcontractors to authenticated;
grant select on public.payment_requests to authenticated;
grant select on public.audit_events to authenticated;

revoke all on function public.organization_role(uuid) from public, anon;
revoke all on function public.is_organization_member(uuid) from public, anon;
revoke all on function public.has_organization_role(uuid, text[]) from public, anon;
revoke all on function public.create_organization(text, text) from public, anon;
revoke all on function public.create_payment_request(
    uuid,
    uuid,
    uuid,
    text,
    bigint,
    integer,
    text
) from public, anon;
revoke all on function public.submit_payment_request(uuid) from public, anon;
revoke all on function public.approve_payment_request(uuid) from public, anon;

grant execute on function public.organization_role(uuid) to authenticated;
grant execute on function public.is_organization_member(uuid) to authenticated;
grant execute on function public.has_organization_role(uuid, text[]) to authenticated;
grant execute on function public.create_organization(text, text) to authenticated;
grant execute on function public.create_payment_request(
    uuid,
    uuid,
    uuid,
    text,
    bigint,
    integer,
    text
) to authenticated;
grant execute on function public.submit_payment_request(uuid) to authenticated;
grant execute on function public.approve_payment_request(uuid) to authenticated;

grant all on table public.organizations to service_role;
grant all on table public.organization_memberships to service_role;
grant all on table public.projects to service_role;
grant all on table public.subcontractors to service_role;
grant all on table public.project_subcontractors to service_role;
grant all on table public.payment_requests to service_role;
grant all on table public.audit_events to service_role;
grant usage, select on sequence public.audit_events_id_seq to service_role;
