create table if not exists public.subcontractor_payout_accounts (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    subcontractor_id uuid not null,
    stripe_account_id text unique,
    dashboard_type text not null default 'full',
    onboarding_status text not null default 'pending',
    livemode boolean not null default false,
    details_submitted boolean not null default false,
    charges_enabled boolean not null default false,
    payouts_enabled boolean not null default false,
    requirements_currently_due text[] not null default '{}',
    requirements_eventually_due text[] not null default '{}',
    requirements_past_due text[] not null default '{}',
    disabled_reason text,
    last_synced_at timestamptz,
    created_by uuid not null references auth.users(id) on delete restrict,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint subcontractor_payout_accounts_org_subcontractor_unique
        unique (organization_id, subcontractor_id),
    foreign key (subcontractor_id, organization_id)
        references public.subcontractors(id, organization_id) on delete cascade,
    constraint subcontractor_payout_accounts_stripe_id check (
        stripe_account_id is null
        or stripe_account_id ~ '^acct_[A-Za-z0-9]{8,200}$'
    ),
    constraint subcontractor_payout_accounts_dashboard check (
        dashboard_type in ('express', 'full', 'none')
    ),
    constraint subcontractor_payout_accounts_status check (
        onboarding_status in ('pending', 'restricted', 'ready')
    )
);

create index if not exists subcontractor_payout_accounts_org_status_index
    on public.subcontractor_payout_accounts (
        organization_id,
        onboarding_status,
        subcontractor_id
    );

alter table public.subcontractor_payout_accounts enable row level security;

drop policy if exists "Organization members can read payout readiness"
    on public.subcontractor_payout_accounts;
create policy "Organization members can read payout readiness"
    on public.subcontractor_payout_accounts
    for select
    to authenticated
    using (public.is_organization_member(organization_id));

revoke all on table public.subcontractor_payout_accounts
    from public, anon, authenticated;

grant select (
    id,
    organization_id,
    subcontractor_id,
    dashboard_type,
    onboarding_status,
    livemode,
    details_submitted,
    charges_enabled,
    payouts_enabled,
    requirements_currently_due,
    requirements_eventually_due,
    requirements_past_due,
    disabled_reason,
    last_synced_at,
    created_at,
    updated_at
) on public.subcontractor_payout_accounts to authenticated;

grant all on table public.subcontractor_payout_accounts to service_role;

create or replace function public.prepare_subcontractor_payout_onboarding(
    p_subcontractor_id uuid,
    p_user_id uuid
)
returns table (
    payout_account_id uuid,
    organization_id uuid,
    subcontractor_id uuid,
    company_name text,
    contact_email text,
    stripe_account_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    subcontractor_record public.subcontractors%rowtype;
    payout_record public.subcontractor_payout_accounts%rowtype;
    inserted_count integer;
begin
    if p_user_id is null then
        raise exception 'Authentication is required.' using errcode = '28000';
    end if;

    select *
    into subcontractor_record
    from public.subcontractors as subcontractor
    where subcontractor.id = p_subcontractor_id
    for update;

    if not found then
        raise exception 'Subcontractor was not found.' using errcode = 'P0002';
    end if;

    if subcontractor_record.status <> 'active' then
        raise exception 'Only an active subcontractor can configure payouts.'
            using errcode = '55000';
    end if;

    if not exists (
        select 1
        from public.organization_memberships as membership
        where membership.organization_id = subcontractor_record.organization_id
          and membership.user_id = p_user_id
          and membership.status = 'active'
          and membership.role in ('owner', 'admin')
    ) then
        raise exception 'You are not allowed to configure subcontractor payouts.'
            using errcode = '42501';
    end if;

    insert into public.subcontractor_payout_accounts (
        organization_id,
        subcontractor_id,
        created_by
    ) values (
        subcontractor_record.organization_id,
        subcontractor_record.id,
        p_user_id
    )
    on conflict on constraint subcontractor_payout_accounts_org_subcontractor_unique
        do nothing;

    get diagnostics inserted_count = row_count;

    select *
    into payout_record
    from public.subcontractor_payout_accounts as payout_account
    where payout_account.organization_id = subcontractor_record.organization_id
      and payout_account.subcontractor_id = subcontractor_record.id
    for update;

    if inserted_count = 1 then
        insert into public.audit_events (
            organization_id,
            actor_user_id,
            action,
            entity_type,
            entity_id,
            metadata
        ) values (
            subcontractor_record.organization_id,
            p_user_id,
            'subcontractor.payout_onboarding_started',
            'subcontractor',
            subcontractor_record.id,
            jsonb_build_object('payout_account_id', payout_record.id)
        );
    end if;

    return query
    select
        payout_record.id,
        subcontractor_record.organization_id,
        subcontractor_record.id,
        subcontractor_record.company_name,
        subcontractor_record.email,
        payout_record.stripe_account_id;
end;
$$;

create or replace function public.attach_subcontractor_stripe_account(
    p_payout_account_id uuid,
    p_user_id uuid,
    p_stripe_account_id text,
    p_dashboard_type text default 'full'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    payout_record public.subcontractor_payout_accounts%rowtype;
begin
    if p_user_id is null then
        raise exception 'Authentication is required.' using errcode = '28000';
    end if;

    if p_stripe_account_id !~ '^acct_[A-Za-z0-9]{8,200}$' then
        raise exception 'A valid Stripe account ID is required.' using errcode = '22023';
    end if;

    if p_dashboard_type not in ('express', 'full', 'none') then
        raise exception 'A valid Stripe dashboard type is required.' using errcode = '22023';
    end if;

    select *
    into payout_record
    from public.subcontractor_payout_accounts as payout_account
    where payout_account.id = p_payout_account_id
    for update;

    if not found then
        raise exception 'Payout account was not found.' using errcode = 'P0002';
    end if;

    if not exists (
        select 1
        from public.organization_memberships as membership
        where membership.organization_id = payout_record.organization_id
          and membership.user_id = p_user_id
          and membership.status = 'active'
          and membership.role in ('owner', 'admin')
    ) then
        raise exception 'You are not allowed to configure subcontractor payouts.'
            using errcode = '42501';
    end if;

    if payout_record.stripe_account_id is not null
       and payout_record.stripe_account_id <> p_stripe_account_id then
        raise exception 'This subcontractor already has a different Stripe account.'
            using errcode = '55000';
    end if;

    update public.subcontractor_payout_accounts
    set
        stripe_account_id = p_stripe_account_id,
        dashboard_type = p_dashboard_type,
        updated_at = now()
    where id = payout_record.id;

    if payout_record.stripe_account_id is null then
        insert into public.audit_events (
            organization_id,
            actor_user_id,
            action,
            entity_type,
            entity_id,
            metadata
        ) values (
            payout_record.organization_id,
            p_user_id,
            'subcontractor.stripe_account_created',
            'subcontractor',
            payout_record.subcontractor_id,
            jsonb_build_object(
                'payout_account_id', payout_record.id,
                'dashboard_type', p_dashboard_type
            )
        );
    end if;

    return true;
end;
$$;

create or replace function public.sync_subcontractor_stripe_account(
    p_stripe_account_id text,
    p_event_id text,
    p_event_type text,
    p_livemode boolean,
    p_details_submitted boolean,
    p_charges_enabled boolean,
    p_payouts_enabled boolean,
    p_requirements_currently_due text[],
    p_requirements_eventually_due text[],
    p_requirements_past_due text[],
    p_disabled_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    payout_record public.subcontractor_payout_accounts%rowtype;
    inserted_count integer;
    next_status text;
begin
    if p_event_id is not null then
        insert into public.stripe_webhook_events (
            event_id,
            type,
            processed_at,
            created_at,
            updated_at
        ) values (
            p_event_id,
            coalesce(p_event_type, 'account.updated'),
            now(),
            now(),
            now()
        ) on conflict (event_id) do nothing;

        get diagnostics inserted_count = row_count;

        if inserted_count = 0 then
            return false;
        end if;
    end if;

    select *
    into payout_record
    from public.subcontractor_payout_accounts as payout_account
    where payout_account.stripe_account_id = p_stripe_account_id
    for update;

    if not found then
        raise exception 'Payout account for Stripe account % was not found.',
            p_stripe_account_id using errcode = 'P0002';
    end if;

    next_status := case
        when p_payouts_enabled then 'ready'
        when coalesce(cardinality(p_requirements_past_due), 0) > 0
          or p_disabled_reason is not null then 'restricted'
        else 'pending'
    end;

    update public.subcontractor_payout_accounts
    set
        onboarding_status = next_status,
        livemode = p_livemode,
        details_submitted = p_details_submitted,
        charges_enabled = p_charges_enabled,
        payouts_enabled = p_payouts_enabled,
        requirements_currently_due = coalesce(p_requirements_currently_due, '{}'),
        requirements_eventually_due = coalesce(p_requirements_eventually_due, '{}'),
        requirements_past_due = coalesce(p_requirements_past_due, '{}'),
        disabled_reason = nullif(left(p_disabled_reason, 240), ''),
        last_synced_at = now(),
        updated_at = now()
    where id = payout_record.id;

    if payout_record.onboarding_status <> next_status
       or payout_record.payouts_enabled <> p_payouts_enabled then
        insert into public.audit_events (
            organization_id,
            actor_user_id,
            action,
            entity_type,
            entity_id,
            metadata
        ) values (
            payout_record.organization_id,
            null,
            'subcontractor.payout_status_changed',
            'subcontractor',
            payout_record.subcontractor_id,
            jsonb_build_object(
                'previous_status', payout_record.onboarding_status,
                'status', next_status,
                'payouts_enabled', p_payouts_enabled,
                'stripe_event_type', p_event_type
            )
        );
    end if;

    return true;
end;
$$;

revoke all on function public.prepare_subcontractor_payout_onboarding(uuid, uuid)
    from public, anon, authenticated;
revoke all on function public.attach_subcontractor_stripe_account(uuid, uuid, text, text)
    from public, anon, authenticated;
revoke all on function public.sync_subcontractor_stripe_account(
    text,
    text,
    text,
    boolean,
    boolean,
    boolean,
    boolean,
    text[],
    text[],
    text[],
    text
) from public, anon, authenticated;

grant execute on function public.prepare_subcontractor_payout_onboarding(uuid, uuid)
    to service_role;
grant execute on function public.attach_subcontractor_stripe_account(uuid, uuid, text, text)
    to service_role;
grant execute on function public.sync_subcontractor_stripe_account(
    text,
    text,
    text,
    boolean,
    boolean,
    boolean,
    boolean,
    text[],
    text[],
    text[],
    text
) to service_role;
