-- Behavioural checks for Phase: Asana parity, batch 1: starred projects per person (own rows only,
-- Viewer+ of the project to star, unstar = soft delete, star again restores, anon gets nothing).
-- Fresh people for this suite (no memberships from earlier suites):
--   fbfb…01 ap-owner@example.com    owner of AP P
--   fbfb…02 ap-viewer@example.com   Viewer of AP P
--   fbfb…03 ap-other@example.com    no memberships

\set ON_ERROR_STOP 1

create temporary table ap_ids (name text primary key, id uuid) on commit preserve rows;
grant all on ap_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('ap-owner@example.com', 'asana parity suite'),
  ('ap-viewer@example.com', 'asana parity suite'),
  ('ap-other@example.com', 'asana parity suite');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('fbfbfbfb-0000-4000-8000-000000000001', 'ap-owner@example.com', now(), '{"full_name":"Ann Owner"}'),
  ('fbfbfbfb-0000-4000-8000-000000000002', 'ap-viewer@example.com', now(), '{"full_name":"Vic Viewer"}'),
  ('fbfbfbfb-0000-4000-8000-000000000003', 'ap-other@example.com', now(), '{"full_name":"Oli Other"}');
insert into ap_ids values
  ('owner', 'fbfbfbfb-0000-4000-8000-000000000001'),
  ('viewer', 'fbfbfbfb-0000-4000-8000-000000000002'),
  ('other', 'fbfbfbfb-0000-4000-8000-000000000003');

set role authenticated;
select set_config('request.jwt.claim.sub', 'fbfbfbfb-0000-4000-8000-000000000001', false) is not null as ok \gset

-- The owner stars, unstars, and stars again ---------------------------------------------------------

do $$
declare
  p uuid;
  first_starred timestamptz;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'AP P') returning id into p;
  perform public.add_project_member(p, 'ap-viewer@example.com', 'viewer');
  insert into ap_ids values ('p', p);

  assert public.set_project_starred(p, true), 'starring returns true';
  assert (select count(*) from public.project_stars where project_id = p and deleted_at is null) = 1, 'one active star';
  assert (select profile_id from public.project_stars where project_id = p) = (select id from ap_ids where name = 'owner'),
    'the star is the caller''s';
  first_starred := (select starred_at from public.project_stars where project_id = p);

  assert public.set_project_starred(p, true), 'starring twice is a no-op';
  assert (select count(*) from public.project_stars where project_id = p) = 1, 'still one row per person and project';

  assert not public.set_project_starred(p, false), 'unstarring returns false';
  assert (select deleted_at is not null from public.project_stars where project_id = p), 'unstar is a soft delete';
  assert not public.set_project_starred(p, false), 'unstarring again is a no-op';

  perform pg_sleep(0.01);
  assert public.set_project_starred(p, true), 'starring again';
  assert (select deleted_at is null and starred_at > first_starred from public.project_stars where project_id = p),
    'starring again restores the row with a new starred_at';
  assert (select count(*) from public.project_stars where project_id = p) = 1, 'the same row is reused';

  -- Clients can't write someone else's star or move one.
  begin
    insert into public.project_stars (profile_id, project_id) values ((select id from ap_ids where name = 'viewer'), p);
    raise exception 'profile_id is not insertable by clients';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.project_stars set starred_at = now() - interval '1 day' where project_id = p;
    raise exception 'starred_at is not updatable by clients';
  exception when insufficient_privilege then null;
  end;
end $$;

-- A Viewer stars for themselves and never sees the owner's star.
select set_config('request.jwt.claim.sub', 'fbfbfbfb-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from ap_ids where name = 'p');
begin
  assert not exists (select 1 from public.project_stars), 'other people''s stars are invisible';
  -- A direct insert through RLS works too (Viewer+).
  insert into public.project_stars (project_id) values (p);
  assert (select count(*) from public.project_stars) = 1, 'a Viewer stars a project they can read';
  update public.project_stars set deleted_at = now() where profile_id = (select id from ap_ids where name = 'owner');
  assert (select deleted_at is null from public.project_stars where project_id = p), 'their update only reaches their own row';
end $$;

-- A non-member can't star the project and reads nothing.
select set_config('request.jwt.claim.sub', 'fbfbfbfb-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from ap_ids where name = 'p');
begin
  begin
    perform public.set_project_starred(p, true);
    raise exception 'a non-member can''t star the project';
  exception when no_data_found then null;
  end;
  begin
    insert into public.project_stars (project_id) values (p);
    raise exception 'RLS refuses a direct insert too';
  exception when insufficient_privilege then null;
  end;
  assert not public.set_project_starred(p, false), 'unstarring without a star is a harmless no-op';
  assert not exists (select 1 from public.project_stars), 'and reads nothing';
end $$;

reset role;

-- Losing access: the star row stays, but re-starring is refused; unstarring still works.
do $$
declare
  p uuid := (select id from ap_ids where name = 'p');
begin
  assert (select deleted_at is null from public.project_stars
          where profile_id = 'fbfbfbfb-0000-4000-8000-000000000001' and project_id = p),
    'the Viewer''s update didn''t touch the owner''s star';
  update public.project_members set deleted_at = now()
  where project_id = p and profile_id = 'fbfbfbfb-0000-4000-8000-000000000002';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'fbfbfbfb-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from ap_ids where name = 'p');
begin
  assert not public.set_project_starred(p, false), 'a removed member can still clear their star';
  begin
    perform public.set_project_starred(p, true);
    raise exception 'a removed member can''t star it again';
  exception when no_data_found then null;
  end;
  begin
    update public.project_stars set deleted_at = null where project_id = p;
    raise exception 'nor restore the star directly';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

do $$
begin
  assert not has_table_privilege('anon', 'public.project_stars', 'select, insert, update'), 'anon gets nothing';
  assert not has_function_privilege('anon', 'public.set_project_starred(uuid, boolean)', 'execute'), 'anon can''t execute the RPC';
  assert not (select prosecdef from pg_proc where oid = 'public.set_project_starred(uuid, boolean)'::regprocedure),
    'set_project_starred is invoker';
  assert not (select prosecdef from pg_proc where oid = 'public.guard_project_star()'::regprocedure),
    'the guard is invoker';
  assert (select relrowsecurity from pg_class where oid = 'public.project_stars'::regclass), 'RLS is on';
end $$;

select 'zz11 asana parity 1 smoke: ok' as result;
