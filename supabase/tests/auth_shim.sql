-- Minimal stand-in for the pieces of a Supabase database the migrations depend on.
-- Used only by supabase/tests/run.sh against a throwaway local Postgres; never run on Supabase.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create schema extensions;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

create function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema storage;
grant usage on schema storage to anon, authenticated, service_role;

create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid default auth.uid(),
  created_at timestamptz default now()
);

alter table storage.objects enable row level security;
grant all on storage.objects to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;

-- pg_cron stand-in: just enough for migrations that schedule a job by name (cron.schedule upserts by
-- job name, like pg_cron) and for suites that check the job exists. Nothing ever runs it.
-- pg_extension has no pg_cron row, so migrations that check for the extension still skip.
create schema cron;
create table cron.job (
  jobid bigserial primary key,
  schedule text not null,
  command text not null,
  jobname text unique
);
create function cron.schedule(job_name text, schedule text, command text) returns bigint
language sql
as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid
$$;
