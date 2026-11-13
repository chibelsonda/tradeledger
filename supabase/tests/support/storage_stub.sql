-- Minimal Supabase Storage surface for isolated PostgreSQL integration tests.
-- This file is test support only and must never be applied to a Supabase project.

create schema if not exists storage;

create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false,
    file_size_limit bigint,
    allowed_mime_types text[]
);

create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text not null references storage.buckets(id),
    name text not null
);

create or replace function storage.foldername(name text)
returns text[]
language sql
immutable
as $$
    select string_to_array(name, '/');
$$;

alter table storage.objects enable row level security;

grant usage on schema storage to authenticated, service_role;
grant select on storage.objects to authenticated;
grant all on storage.objects to service_role;
