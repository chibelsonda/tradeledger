-- Remove tables left behind by the previous Laravel application.
-- Supabase migration history is stored in supabase_migrations.schema_migrations,
-- so public.migrations is not used by this application.
drop table if exists public.cache;
drop table if exists public.cache_locks;
drop table if exists public.failed_jobs;
drop table if exists public.job_batches;
drop table if exists public.jobs;
drop table if exists public.migrations;
drop table if exists public.password_reset_tokens;
drop table if exists public.sessions;
drop table if exists public.users;
