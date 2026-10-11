-- Behavioural checks for Phase: Asana parity, batch 2: the On hold project status, status update titles
-- (post_project_status_update over set_project_status), the project due date, and comment counts
-- (task_comment_counts, RLS-bound).
-- Fresh people for this suite (no memberships from earlier suites):
--   fcfc…01 ap2-owner@example.com    owner of AP2 P
--   fcfc…02 ap2-editor@example.com   Editor of AP2 P
--   fcfc…03 ap2-viewer@example.com   Viewer of AP2 P
--   fcfc…04 ap2-other@example.com    no memberships

\set ON_ERROR_STOP 1

create temporary table ap2_ids (name text primary key, id uuid) on commit preserve rows;
grant all on ap2_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('ap2-owner@example.com', 'asana parity 2 suite'),
  ('ap2-editor@example.com', 'asana parity 2 suite'),
  ('ap2-viewer@example.com', 'asana parity 2 suite'),
  ('ap2-other@example.com', 'asana parity 2 suite');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('fcfcfcfc-0000-4000-8000-000000000001', 'ap2-owner@example.com', now(), '{"full_name":"Ona Owner"}'),
  ('fcfcfcfc-0000-4000-8000-000000000002', 'ap2-editor@example.com', now(), '{"full_name":"Eda Editor"}'),
  ('fcfcfcfc-0000-4000-8000-000000000003', 'ap2-viewer@example.com', now(), '{"full_name":"Vik Viewer"}'),
  ('fcfcfcfc-0000-4000-8000-000000000004', 'ap2-other@example.com', now(), '{"full_name":"Oz Other"}');

-- The tail ran (the local harness applies the whole file): one status CHECK per table, under the old
-- name, and it allows on_hold.
do $$
begin
  assert not exists (
    select 1 from pg_constraint
    where conname in ('projects_status_check_v2', 'project_status_updates_status_check_v2')
  ), 'the wider CHECKs took the old names';
  assert pg_get_constraintdef((select oid from pg_constraint
                               where conname = 'projects_status_check' and conrelid = 'public.projects'::regclass))
         like '%on_hold%', 'projects_status_check allows on_hold';
  assert pg_get_constraintdef((select oid from pg_constraint
                               where conname = 'project_status_updates_status_check'
                                 and conrelid = 'public.project_status_updates'::regclass))
         like '%on_hold%', 'project_status_updates_status_check allows on_hold';
  assert (select count(*) from pg_constraint
          where conrelid = 'public.projects'::regclass and contype = 'c'
            and pg_get_constraintdef(oid) like '%on_track%') = 1, 'one status CHECK on projects';
  assert (select count(*) from pg_constraint
          where conrelid = 'public.project_status_updates'::regclass and contype = 'c'
            and pg_get_constraintdef(oid) like '%on_track%') = 1, 'one status CHECK on project_status_updates';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'fcfcfcfc-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'AP2 P') returning id into p;
  perform public.add_project_member(p, 'ap2-editor@example.com', 'editor');
  perform public.add_project_member(p, 'ap2-viewer@example.com', 'viewer');
  insert into ap2_ids values ('p', p);
end $$;

-- An Editor sets On hold, then posts titled updates -----------------------------------------------

select set_config('request.jwt.claim.sub', 'fcfcfcfc-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from ap2_ids where name = 'p');
  latest record;
begin
  perform public.set_project_status(p, 'on_hold', 'Waiting on legal');
  assert (select status from public.projects where id = p) = 'on_hold', 'on_hold is a project status';
  select status, note, title into latest from public.project_status_updates
  where project_id = p order by created_at desc limit 1;
  assert latest.status = 'on_hold' and latest.note = 'Waiting on legal', 'the history keeps on_hold';
  assert latest.title is null, 'set_project_status alone stores no title';

  perform public.post_project_status_update(p, 'at_risk', '  Week 41  ', 'Copy is late');
  select status, note, title into latest from public.project_status_updates
  where project_id = p order by created_at desc limit 1;
  assert latest.status = 'at_risk' and latest.note = 'Copy is late' and latest.title = 'Week 41',
    'a titled update stores the trimmed title, the status, and the summary';
  assert (select status = 'at_risk' and status_note = 'Copy is late' from public.projects where id = p),
    'the project carries the new status and the summary as its note';

  -- The title never leaks into a later call in the same transaction.
  perform public.set_project_status(p, 'on_track', null);
  assert (select title from public.project_status_updates where project_id = p order by created_at desc limit 1) is null,
    'the title setting is cleared after the update';

  perform public.post_project_status_update(p, 'complete', '   ', null);
  select status, note, title into latest from public.project_status_updates
  where project_id = p order by created_at desc limit 1;
  assert latest.status = 'complete' and latest.title is null and latest.note is null, 'a blank title is no title';

  assert (select count(*) from public.project_status_updates where project_id = p) = 4, 'one history row per update';

  begin
    perform public.post_project_status_update(p, 'on_track', repeat('x', 201), null);
    raise exception 'a title over 200 characters is refused';
  exception when check_violation then null;
  end;
  begin
    perform public.post_project_status_update(p, 'paused', 'Nope', null);
    raise exception 'unknown statuses are still refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.project_status_updates (project_id, status, title) values (p, 'on_track', 'Forged');
    raise exception 'clients can''t write the history directly';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.project_status_updates set title = 'Rewritten' where project_id = p;
    raise exception 'or rewrite a title';
  exception when insufficient_privilege then null;
  end;

  -- The project due date is Admin+ like the name: an Editor's update changes nothing.
  update public.projects set due_on = date '2026-12-01' where id = p;
  assert (select due_on from public.projects where id = p) is null, 'Editors can''t set the project due date';
end $$;

-- A Viewer reads the history and its titles but can't post ------------------------------------------

select set_config('request.jwt.claim.sub', 'fcfcfcfc-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from ap2_ids where name = 'p');
begin
  assert (select count(*) from public.project_status_updates where project_id = p and title = 'Week 41') = 1,
    'Viewers read status update titles';
  begin
    perform public.post_project_status_update(p, 'off_track', 'Viewer update', 'Nope');
    raise exception 'Viewers can''t post status updates';
  exception when insufficient_privilege then null;
  end;
  assert (select status from public.projects where id = p) = 'complete', 'the refused update changed nothing';
end $$;

-- A non-member reads nothing and posts nothing ------------------------------------------------------

select set_config('request.jwt.claim.sub', 'fcfcfcfc-0000-4000-8000-000000000004', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from ap2_ids where name = 'p');
begin
  assert not exists (select 1 from public.project_status_updates where project_id = p), 'non-members read no history';
  begin
    perform public.post_project_status_update(p, 'on_track', 'Outsider', null);
    raise exception 'non-members can''t post';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Comment counts follow comments RLS --------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'fcfcfcfc-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from ap2_ids where name = 'p');
  t1 uuid;
  t2 uuid;
  gone uuid;
begin
  t1 := public.create_task(p, null, 'Counted');
  t2 := public.create_task(p, null, 'Quiet');
  insert into public.comments (task_id, body) values (t1, 'one'), (t1, 'two') ;
  insert into public.comments (task_id, body) values (t1, 'three') returning id into gone;
  update public.comments set deleted_at = now() where id = gone;
  insert into ap2_ids values ('t1', t1), ('t2', t2);
  assert (select comment_count from public.task_comment_counts(array[t1, t2]) where task_id = t1) = 2,
    'deleted comments aren''t counted';
  assert not exists (select 1 from public.task_comment_counts(array[t1, t2]) where task_id = t2),
    'a task without comments has no row';
  assert not exists (select 1 from public.task_comment_counts(array[]::uuid[])), 'no ids, no rows';
end $$;

select set_config('request.jwt.claim.sub', 'fcfcfcfc-0000-4000-8000-000000000004', false) is not null as ok \gset

do $$
begin
  assert not exists (
    select 1 from public.task_comment_counts(array[(select id from ap2_ids where name = 't1')])
  ), 'non-members count nothing';
end $$;

select set_config('request.jwt.claim.sub', 'fcfcfcfc-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
begin
  assert (select comment_count from public.task_comment_counts(array[(select id from ap2_ids where name = 't1')])) = 2,
    'Viewers see the count of the comments they can read';
end $$;

-- The owner sets and clears the due date --------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'fcfcfcfc-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from ap2_ids where name = 'p');
begin
  update public.projects set due_on = date '2026-12-01' where id = p;
  assert (select due_on from public.projects where id = p) = date '2026-12-01', 'an owner sets the due date';
  perform public.set_project_archived(p, true);
  update public.projects set due_on = date '2027-01-15' where id = p;
  assert (select due_on from public.projects where id = p) = date '2026-12-01', 'an archived project is read-only';
  begin
    perform public.post_project_status_update(p, 'on_track', 'Archived', null);
    raise exception 'archived projects take no status updates';
  exception when insufficient_privilege then null;
  end;
  perform public.set_project_archived(p, false);
  update public.projects set due_on = null where id = p;
  assert (select due_on from public.projects where id = p) is null, 'and clears it';
end $$;

select set_config('request.jwt.claim.sub', 'fcfcfcfc-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from ap2_ids where name = 'p');
begin
  assert exists (select 1 from public.projects where id = p and due_on is null), 'Viewers read the due date';
end $$;

reset role;

do $$
begin
  assert not has_function_privilege('anon', 'public.post_project_status_update(uuid, text, text, text)', 'execute'),
    'anon can''t post status updates';
  assert has_function_privilege('authenticated', 'public.post_project_status_update(uuid, text, text, text)', 'execute'),
    'signed-in people can';
  assert not (select prosecdef from pg_proc where oid = 'public.post_project_status_update(uuid, text, text, text)'::regprocedure),
    'post_project_status_update is invoker';
  assert not (select prosecdef from pg_proc where oid = 'public.task_comment_counts(uuid[])'::regprocedure),
    'task_comment_counts is invoker';
  assert not has_function_privilege('anon', 'public.task_comment_counts(uuid[])', 'execute'), 'anon can''t count comments';
  assert has_function_privilege('authenticated', 'public.task_comment_counts(uuid[])', 'execute'), 'signed-in people can';
  assert (select prosecdef from pg_proc where oid = 'public.set_project_status(uuid, text, text)'::regprocedure),
    'set_project_status is still the definer writer';
  assert has_function_privilege('authenticated', 'public.set_project_status(uuid, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.set_project_status(uuid, text, text)', 'execute'),
    'set_project_status kept its grants';
  assert not has_function_privilege('authenticated', 'public.alhc_patch_function(regprocedure, text[])', 'execute'),
    'the patch helper stays internal';
end $$;

select 'zz12 asana parity 2 smoke: ok' as result;
