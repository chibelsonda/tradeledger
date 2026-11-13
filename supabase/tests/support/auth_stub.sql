-- Minimal Supabase Auth surface for isolated PostgreSQL integration tests.
-- This file is test support only and must never be applied to a Supabase project.

create schema if not exists auth;
create schema if not exists extensions;

create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text
);

do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon nologin;
    end if;

    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin;
    end if;

    if not exists (select 1 from pg_roles where rolname = 'service_role') then
        create role service_role nologin bypassrls;
    end if;
end;
$$;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
