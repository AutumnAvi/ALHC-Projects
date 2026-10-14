-- Behavioural checks for Phase: Real features 4 (data and calendar): status templates
-- (project_status_templates: Viewers read, Editors+ manage, validated sections), calendar subscribe links
-- (calendar_feeds: own rows, database-generated tokens stored as a hash, rotate / turn off) and the anon
-- reader calendar_feed() (built with the owner's own access at every fetch, rate-limited, empty once off or
-- once the owner left the workspace), and the streaming CSV export helpers (filter_project_task_ids,
-- report_overdue_tasks_after). Workspace admins never get project data from any of it.
-- Fresh people for this suite:
--   a4a4…01 r4-owner@example.com   Rowan Realfour: owner of R4 P and R4 Hidden, lead of R4 Team
--   a4a4…02 r4-mate@example.com    Tess Teamfour: Editor of R4 P; member of R4 Team (not of R4 Hidden)
--   a4a4…03 r4-viewer@example.com  Vik Viewfour: Viewer of R4 P until removed
--   a4a4…04 r4-admin@example.com   Ana Adminfour: workspace admin, in no project
--   a4a4…05 r4-gone@example.com    Gil Gonefour: Viewer of R4 P, later removed from the workspace

\set ON_ERROR_STOP 1

create temporary table r4_ids (name text primary key, id uuid) on commit preserve rows;
grant all on r4_ids to authenticated, anon, service_role;
create temporary table r4_vals (name text primary key, val text) on commit preserve rows;
grant all on r4_vals to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('r4-owner@example.com', 'real 4 suite'),
  ('r4-mate@example.com', 'real 4 suite'),
  ('r4-viewer@example.com', 'real 4 suite'),
  ('r4-admin@example.com', 'real 4 suite'),
  ('r4-gone@example.com', 'real 4 suite');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a4a4a4a4-0000-4000-8000-000000000001', 'r4-owner@example.com', now(), '{"full_name":"Rowan Realfour"}'),
  ('a4a4a4a4-0000-4000-8000-000000000002', 'r4-mate@example.com', now(), '{"full_name":"Tess Teamfour"}'),
  ('a4a4a4a4-0000-4000-8000-000000000003', 'r4-viewer@example.com', now(), '{"full_name":"Vik Viewfour"}'),
  ('a4a4a4a4-0000-4000-8000-000000000004', 'r4-admin@example.com', now(), '{"full_name":"Ana Adminfour"}'),
  ('a4a4a4a4-0000-4000-8000-000000000005', 'r4-gone@example.com', now(), '{"full_name":"Gil Gonefour"}');
insert into public.workspace_admins (workspace_id, profile_id)
values ('00000000-0000-4000-8000-000000000001', 'a4a4a4a4-0000-4000-8000-000000000004');

-- EXECUTE surface and grants ------------------------------------------------------------------------------

do $$
begin
  assert has_function_privilege('anon', 'public.calendar_feed(text)', 'execute')
    and not has_function_privilege('authenticated', 'public.calendar_feed(text)', 'execute')
    and (select prosecdef from pg_proc where oid = 'public.calendar_feed(text)'::regprocedure),
    'calendar_feed: the public feed route, anon only';
  assert has_function_privilege('authenticated', 'public.create_calendar_feed(text, uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.rotate_calendar_feed(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.create_calendar_feed(text, uuid)', 'execute')
    and not has_function_privilege('anon', 'public.rotate_calendar_feed(uuid)', 'execute')
    and not (select prosecdef from pg_proc where oid = 'public.create_calendar_feed(text, uuid)'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.rotate_calendar_feed(uuid)'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.guard_calendar_feed()'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.guard_project_status_template()'::regprocedure),
    'managing links and the guards are invoker';
  assert has_function_privilege('authenticated', 'public.filter_project_task_ids(uuid, jsonb, text)', 'execute')
    and has_function_privilege('authenticated', 'public.report_overdue_tasks_after(jsonb, text, date, text, uuid, integer)', 'execute')
    and not has_function_privilege('anon', 'public.filter_project_task_ids(uuid, jsonb, text)', 'execute')
    and not has_function_privilege('anon', 'public.report_overdue_tasks_after(jsonb, text, date, text, uuid, integer)', 'execute')
    and not (select prosecdef from pg_proc where oid = 'public.filter_project_task_ids(uuid, jsonb, text)'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.report_overdue_tasks_after(jsonb, text, date, text, uuid, integer)'::regprocedure),
    'the export helpers are invoker, signed-in only';
  assert (select relrowsecurity from pg_class where oid = 'public.project_status_templates'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.calendar_feeds'::regclass), 'RLS is on';
  assert not has_table_privilege('anon', 'public.project_status_templates', 'select')
    and not has_table_privilege('anon', 'public.calendar_feeds', 'select')
    and not has_any_column_privilege('anon', 'public.calendar_feeds', 'select'), 'anon reads nothing';
  assert not has_column_privilege('authenticated', 'public.calendar_feeds', 'token_hash', 'select')
    and not has_column_privilege('authenticated', 'public.calendar_feeds', 'token_hash', 'insert')
    and not has_column_privilege('authenticated', 'public.calendar_feeds', 'token_hash', 'update')
    and not has_column_privilege('authenticated', 'public.calendar_feeds', 'fetch_count', 'update')
    and not has_column_privilege('authenticated', 'public.calendar_feeds', 'profile_id', 'update')
    and not has_column_privilege('authenticated', 'public.calendar_feeds', 'project_id', 'update')
    and not has_table_privilege('authenticated', 'public.calendar_feeds', 'delete')
    and has_column_privilege('authenticated', 'public.calendar_feeds', 'revoked_at', 'update')
    and has_column_privilege('authenticated', 'public.calendar_feeds', 'token_hint', 'select'),
    'the token hash is out of reach; only rotate and turn off are writable';
  assert not has_column_privilege('authenticated', 'public.project_status_templates', 'project_id', 'update')
    and not has_column_privilege('authenticated', 'public.project_status_templates', 'created_by', 'insert')
    and not has_table_privilege('authenticated', 'public.project_status_templates', 'delete'),
    'status templates never move and are removed softly';
  assert public.status_template_summary('[{"heading":"Done","body":"Shipped A"},{"heading":"Next","body":""}]')
    = e'Done\nShipped A\n\nNext', 'a template''s summary: heading, body, blank line between sections';
end $$;

-- Setup ------------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'a4a4a4a4-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  team uuid;
  p uuid;
  hidden uuid;
  t uuid;
  i integer;
begin
  insert into public.teams (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'R4 Team') returning id into team;
  perform public.add_team_member(team, 'r4-mate@example.com', 'member');
  insert into r4_ids values ('team', team);
  insert into public.projects (workspace_id, name, team_id, visibility)
  values ('00000000-0000-4000-8000-000000000001', 'R4 P', team, 'team') returning id into p;
  perform public.add_project_member(p, 'r4-mate@example.com', 'editor');
  perform public.add_project_member(p, 'r4-viewer@example.com', 'viewer');
  perform public.add_project_member(p, 'r4-gone@example.com', 'viewer');
  insert into r4_ids values ('p', p);
  insert into public.projects (workspace_id, name, team_id, visibility)
  values ('00000000-0000-4000-8000-000000000001', 'R4 Hidden', team, 'team') returning id into hidden;
  insert into r4_ids values ('hidden', hidden);

  -- R4 P: four dated tasks, one undated, one completed long ago, one timed.
  for i in 1 .. 4 loop
    select public.create_task(p, null, 'R4 task ' || i) into t;
    update public.tasks set due_on = current_date + i where id = t;
    insert into r4_ids values ('t' || i, t);
  end loop;
  update public.tasks set start_on = current_date + 1, due_on = current_date + 3 where id = (select id from r4_ids where name = 't3');
  update public.tasks set notes = 'R4 secret note' where id = (select id from r4_ids where name = 't1');
  select public.create_task(p, null, 'R4 undated') into t;
  insert into r4_ids values ('undated', t);
  select public.create_task(p, null, 'R4 done long ago') into t;
  update public.tasks set due_on = current_date - 120 where id = t;
  update public.tasks set completed_at = now() where id = t;
  insert into r4_ids values ('old', t);
  select public.create_task(p, null, 'R4 done lately') into t;
  update public.tasks set due_on = current_date - 2 where id = t;
  update public.tasks set completed_at = now() where id = t;
  insert into r4_ids values ('lately', t);
  select public.create_task(p, null, 'R4 timed') into t;
  update public.tasks set due_at = date_trunc('day', now()) + interval '2 days 15 hours', time_zone = 'UTC' where id = t;
  insert into r4_ids values ('timed', t);
  -- Assignments: Vik gets t1, Gil gets t2.
  update public.tasks set assignee_id = 'a4a4a4a4-0000-4000-8000-000000000003' where id = (select id from r4_ids where name = 't1');
  update public.tasks set assignee_id = 'a4a4a4a4-0000-4000-8000-000000000005' where id = (select id from r4_ids where name = 't2');

  -- R4 Hidden: a team project Tess isn't a member of.
  select public.create_task(hidden, null, 'R4 hidden task') into t;
  update public.tasks set due_on = current_date + 1 where id = t;
  insert into r4_ids values ('h1', t);
end $$;

-- Tess: a private task of her own with a due date.
select set_config('request.jwt.claim.sub', 'a4a4a4a4-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid;
begin
  select public.create_private_task('R4 private errand') into t;
  update public.tasks set due_on = current_date + 5 where id = t;
  insert into r4_ids values ('private', t);
end $$;
-- The completed task of 120 days ago: completed back then.
reset role;
update public.tasks set completed_at = now() - interval '120 days' where id = (select id from r4_ids where name = 'old');

-- Status templates ---------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'a4a4a4a4-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  tpl public.project_status_templates;
begin
  insert into public.project_status_templates (project_id, name, status, title, sections)
  values (
    (select id from r4_ids where name = 'p'), '  Weekly  ', 'at_risk', '  ',
    '[{"heading":" What we accomplished ","body":"- "},{"heading":"What''s blocked"},{"heading":"Next steps","body":null}]'
  )
  returning * into tpl;
  assert tpl.created_by = 'a4a4a4a4-0000-4000-8000-000000000002' and tpl.name = 'Weekly' and tpl.title is null
    and tpl.sections = '[{"heading":"What we accomplished","body":"- "},{"heading":"What''s blocked","body":""},{"heading":"Next steps","body":""}]'::jsonb,
    'an Editor saves a template: trimmed, sections cleaned, the creator is the caller';
  insert into r4_ids values ('tpl', tpl.id);

  begin
    insert into public.project_status_templates (project_id, name, sections)
    values ((select id from r4_ids where name = 'p'), 'Too many', (select jsonb_agg(jsonb_build_object('heading', 'H' || i)) from generate_series(1, 9) i));
    assert false, 'at most 8 sections';
  exception when check_violation then null;
  end;
  begin
    insert into public.project_status_templates (project_id, name, sections)
    values ((select id from r4_ids where name = 'p'), 'Odd keys', '[{"heading":"A","colour":"red"}]');
    assert false, 'only heading and body';
  exception when check_violation then null;
  end;
  begin
    insert into public.project_status_templates (project_id, name, sections)
    values ((select id from r4_ids where name = 'p'), 'No heading', '[{"heading":"  ","body":"x"}]');
    assert false, 'a heading is required';
  exception when check_violation then null;
  end;
  begin
    insert into public.project_status_templates (project_id, name, sections)
    values ((select id from r4_ids where name = 'p'), 'Too long', (
      select jsonb_agg(jsonb_build_object('heading', 'Heading ' || i, 'body', repeat('x', 900))) from generate_series(1, 3) i));
    assert false, 'the summary must fit 2,000 characters';
  exception when check_violation then null;
  end;
  begin
    insert into public.project_status_templates (project_id, name, status)
    values ((select id from r4_ids where name = 'p'), 'Bad status', 'great');
    assert false, 'a known status';
  exception when check_violation then null;
  end;
  begin
    insert into public.project_status_templates (project_id, name, created_by)
    values ((select id from r4_ids where name = 'p'), 'Forged', 'a4a4a4a4-0000-4000-8000-000000000001');
    assert false, 'the creator can''t be chosen';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Vik (Viewer) reads it but can't add or change one.
select set_config('request.jwt.claim.sub', 'a4a4a4a4-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  n integer;
begin
  assert (select count(*) from public.project_status_templates) = 1, 'a Viewer reads the project''s templates';
  begin
    insert into public.project_status_templates (project_id, name) values ((select id from r4_ids where name = 'p'), 'Mine');
    assert false, 'Viewers can''t add a template';
  exception when insufficient_privilege then null;
  end;
  update public.project_status_templates set name = 'Hijacked' where id = (select id from r4_ids where name = 'tpl');
  get diagnostics n = row_count;
  assert n = 0, 'Viewers can''t change one';
end $$;

-- Ana (workspace admin, not in the project) sees none and can't add one.
select set_config('request.jwt.claim.sub', 'a4a4a4a4-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  assert (select count(*) from public.project_status_templates
          where project_id = (select id from r4_ids where name = 'p')) = 0, 'a workspace admin outside the project reads nothing';
  begin
    insert into public.project_status_templates (project_id, name) values ((select id from r4_ids where name = 'p'), 'Admin''s');
    assert false, 'and adds nothing';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Rowan (owner) edits and removes it; a removed template stays removed.
select set_config('request.jwt.claim.sub', 'a4a4a4a4-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  tpl public.project_status_templates;
begin
  update public.project_status_templates set name = 'Weekly update', status = 'on_track', title = 'Weekly update'
  where id = (select id from r4_ids where name = 'tpl') returning * into tpl;
  assert tpl.name = 'Weekly update' and tpl.status = 'on_track' and tpl.title = 'Weekly update', 'an owner edits it';
  update public.project_status_templates set deleted_at = '2000-01-01' where id = tpl.id returning * into tpl;
  assert tpl.deleted_at > now() - interval '1 minute', 'removing stamps now';
  begin
    update public.project_status_templates set deleted_at = null where id = tpl.id;
    assert false, 'a removed template stays removed';
  exception when check_violation then null;
  end;
end $$;
reset role;

-- Calendar links: create, rotate, own rows only -------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'a4a4a4a4-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  r jsonb;
  again jsonb;
  f record;
begin
  r := public.create_calendar_feed('my_tasks');
  assert r ->> 'token' ~ '^alhc_cal_[0-9a-f]{64}$' and (r ->> 'id')::uuid is not null, 'a token, shown once';
  select id, scope, token_hint, profile_id into f from public.calendar_feeds where id = (r ->> 'id')::uuid;
  assert f.scope = 'my_tasks' and f.token_hint = '…' || right(r ->> 'token', 4)
    and f.profile_id = 'a4a4a4a4-0000-4000-8000-000000000003', 'the row keeps only a hint';
  assert coalesce(current_setting('alhc.calendar_feed_token', true), '') = '', 'the plain token isn''t left in a setting';
  begin
    perform token_hash from public.calendar_feeds;
    assert false, 'the hash isn''t readable';
  exception when insufficient_privilege then null;
  end;
  insert into r4_vals values ('vik_old', r ->> 'token');
  -- Asking again replaces the link: same row, new token.
  again := public.create_calendar_feed('my_tasks');
  assert again ->> 'id' = r ->> 'id' and again ->> 'token' <> r ->> 'token', 'one live link per feed: asking again rotates it';
  insert into r4_vals values ('vik_mine', again ->> 'token');
  insert into r4_ids values ('vik_mine', (again ->> 'id')::uuid);
  r := public.create_calendar_feed('project', (select id from r4_ids where name = 'p'));
  insert into r4_vals values ('vik_project', r ->> 'token');
  insert into r4_ids values ('vik_project', (r ->> 'id')::uuid);
  begin
    perform public.create_calendar_feed('project', (select id from r4_ids where name = 'hidden'));
    assert false, 'no link to a project you can''t open';
  exception when no_data_found then null;
  end;
  begin
    perform public.create_calendar_feed('my_tasks', (select id from r4_ids where name = 'p'));
    assert false, 'My tasks has no target';
  exception when check_violation then null;
  end;
  begin
    perform public.create_calendar_feed('everything');
    assert false, 'known scopes only';
  exception when check_violation then null;
  end;
  begin
    insert into public.calendar_feeds (scope, profile_id) values ('my_tasks', 'a4a4a4a4-0000-4000-8000-000000000001');
    assert false, 'nobody makes a link for someone else';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'a4a4a4a4-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  r jsonb;
  n integer;
begin
  r := public.create_calendar_feed('my_tasks');
  insert into r4_vals values ('tess_mine', r ->> 'token');
  r := public.create_calendar_feed('team', (select id from r4_ids where name = 'team'));
  insert into r4_vals values ('tess_team', r ->> 'token');
  insert into r4_ids values ('tess_team', (r ->> 'id')::uuid);
  assert (select count(*) from public.calendar_feeds) = 2, 'Tess sees her own two links';
  update public.calendar_feeds set revoked_at = now() where id = (select id from r4_ids where name = 'vik_mine');
  get diagnostics n = row_count;
  assert n = 0, 'and can''t turn off someone else''s';
  begin
    perform public.rotate_calendar_feed((select id from r4_ids where name = 'vik_mine'));
    assert false, 'or rotate it';
  exception when no_data_found then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'a4a4a4a4-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
declare
  r jsonb;
begin
  assert (select count(*) from public.calendar_feeds) = 0, 'a workspace admin reads nobody''s links';
  begin
    perform public.create_calendar_feed('project', (select id from r4_ids where name = 'p'));
    assert false, 'a workspace admin gets no feed of a project they aren''t in';
  exception when no_data_found then null;
  end;
  r := public.create_calendar_feed('team', (select id from r4_ids where name = 'team'));
  insert into r4_vals values ('ana_team', r ->> 'token');
end $$;

select set_config('request.jwt.claim.sub', 'a4a4a4a4-0000-4000-8000-000000000005', false) is not null as ok \gset
do $$
declare
  r jsonb;
begin
  r := public.create_calendar_feed('my_tasks');
  insert into r4_vals values ('gil_mine', r ->> 'token');
end $$;
reset role;

-- Reading feeds as anon -----------------------------------------------------------------------------------

set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
declare
  r jsonb;
  titles text[];
  e jsonb;
begin
  r := public.calendar_feed((select val from r4_vals where name = 'vik_old'));
  assert r ->> 'status' = 'unknown' and not (r ->> 'ok')::boolean and not r ? 'events', 'a replaced token stops at once';
  assert public.calendar_feed('alhc_cal_' || repeat('0', 64)) ->> 'status' = 'unknown', 'a token nobody has';
  assert public.calendar_feed('not a token') ->> 'status' = 'unknown', 'a malformed token';
  assert public.calendar_feed(null) ->> 'status' = 'unknown', 'no token';

  r := public.calendar_feed((select val from r4_vals where name = 'vik_mine'));
  assert r ->> 'status' = 'ok' and r ->> 'name' = 'My tasks — Vik Viewfour', format('Vik''s My tasks: %s', r);
  assert jsonb_array_length(r -> 'events') = 1 and r -> 'events' -> 0 ->> 'title' = 'R4 task 1'
    and r -> 'events' -> 0 ->> 'project' = 'R4 P'
    and r -> 'events' -> 0 ->> 'path' = '/projects/' || (select id from r4_ids where name = 'p') || '?task=' || (select id from r4_ids where name = 't1'),
    'his one dated, assigned task, labeled with its project and linked';
  e := r -> 'events' -> 0;
  assert (select array_agg(k order by k) from jsonb_object_keys(e) k)
    = array['completed', 'due_at', 'due_on', 'id', 'kind', 'path', 'project', 'start_at', 'start_on', 'title', 'updated_at'],
    format('an event carries only its title, dates, state, project, and link: %s', e);
  assert position('R4 secret note' in r::text) = 0, 'never the notes';
  assert coalesce(current_setting('request.jwt.claim.sub', true), '') = '', 'the caller''s identity is restored';

  r := public.calendar_feed((select val from r4_vals where name = 'vik_project'));
  select array_agg(x ->> 'title' order by x ->> 'title') into titles from jsonb_array_elements(r -> 'events') x;
  assert r ->> 'name' = 'R4 P'
    and titles = array['R4 done lately', 'R4 task 1', 'R4 task 2', 'R4 task 3', 'R4 task 4', 'R4 timed'],
    format('the project feed: dated tasks, completed ones of the last 90 days, not the undated one: %s', titles);
  select x into e from jsonb_array_elements(r -> 'events') x where x ->> 'title' = 'R4 task 3';
  assert e ->> 'start_on' = (current_date + 1)::text and e ->> 'due_on' = (current_date + 3)::text, 'start and due dates';
  select x into e from jsonb_array_elements(r -> 'events') x where x ->> 'title' = 'R4 timed';
  assert e ->> 'due_at' is not null and (e ->> 'due_at')::timestamptz = date_trunc('day', now()) + interval '2 days 15 hours', 'times when set';
  select x into e from jsonb_array_elements(r -> 'events') x where x ->> 'title' = 'R4 done lately';
  assert (e ->> 'completed')::boolean, 'the completed state';

  r := public.calendar_feed((select val from r4_vals where name = 'tess_team'));
  select array_agg(x ->> 'title' order by x ->> 'title') into titles from jsonb_array_elements(r -> 'events') x;
  assert r ->> 'name' = 'R4 Team' and 'R4 task 1' = any (titles) and not 'R4 hidden task' = any (titles)
    and not 'R4 private errand' = any (titles),
    format('the team feed: the team''s projects Tess is a member of, never R4 Hidden or private tasks: %s', titles);

  r := public.calendar_feed((select val from r4_vals where name = 'tess_mine'));
  select array_agg(x ->> 'title' order by x ->> 'title') into titles from jsonb_array_elements(r -> 'events') x;
  assert titles = array['R4 private errand'], format('Tess''s My tasks: her private task, linked to My tasks: %s', titles);
  assert r -> 'events' -> 0 ->> 'path' like '/my-tasks?task=%' and r -> 'events' -> 0 ->> 'project' is null, 'no project for a private task';

  r := public.calendar_feed((select val from r4_vals where name = 'ana_team'));
  assert r ->> 'status' = 'ok' and jsonb_array_length(r -> 'events') = 0,
    'a workspace admin''s team feed has nothing of projects they aren''t in';

  r := public.calendar_feed((select val from r4_vals where name = 'gil_mine'));
  assert jsonb_array_length(r -> 'events') = 1 and r -> 'events' -> 0 ->> 'title' = 'R4 task 2', 'Gil''s task';
end $$;
reset role;

-- Lost access, removal from the workspace, turning a link off, rotating ---------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'a4a4a4a4-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  perform public.remove_project_member((select id from r4_ids where name = 'p'), 'a4a4a4a4-0000-4000-8000-000000000003');
end $$;
select set_config('request.jwt.claim.sub', 'a4a4a4a4-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  perform public.remove_workspace_member('r4-gone@example.com');
end $$;
reset role;

set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
declare
  r jsonb;
begin
  r := public.calendar_feed((select val from r4_vals where name = 'vik_mine'));
  assert r ->> 'status' = 'ok' and jsonb_array_length(r -> 'events') = 0,
    'lost access: Vik''s task in R4 P is gone from his My tasks feed (still assigned, but he can''t open it)';
  r := public.calendar_feed((select val from r4_vals where name = 'vik_project'));
  assert r ->> 'status' = 'ok' and r ->> 'name' = 'ALHC Projects' and jsonb_array_length(r -> 'events') = 0,
    'and his R4 P feed is empty, without the project''s name';
  r := public.calendar_feed((select val from r4_vals where name = 'gil_mine'));
  assert r ->> 'status' = 'off' and jsonb_array_length(r -> 'events') = 0,
    'removed from the workspace: an empty calendar';
end $$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', 'a4a4a4a4-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  r jsonb;
begin
  r := public.rotate_calendar_feed((select id from r4_ids where name = 'tess_team'));
  assert r ->> 'token' ~ '^alhc_cal_[0-9a-f]{64}$' and r ->> 'token' <> (select val from r4_vals where name = 'tess_team'),
    'rotating hands back a new token';
  update r4_vals set val = r ->> 'token' where name = 'tess_team';
  update public.calendar_feeds set revoked_at = '2000-01-01' where scope = 'my_tasks';
  assert (select revoked_at > now() - interval '1 minute' from public.calendar_feeds where scope = 'my_tasks'), 'turning off stamps now';
  begin
    update public.calendar_feeds set revoked_at = null where scope = 'my_tasks';
    assert false, 'a link turned off stays off';
  exception when check_violation then null;
  end;
  begin
    update public.calendar_feeds set token_rotated_at = now() where scope = 'my_tasks';
    assert false, 'and can''t be rotated back on';
  exception when check_violation then null;
  end;
  -- A new My tasks link is a new row (the old one stays off).
  r := public.create_calendar_feed('my_tasks');
  assert (select count(*) from public.calendar_feeds where scope = 'my_tasks') = 2, 'a fresh link after turning one off';
end $$;
reset role;

set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
declare
  r jsonb;
  i integer;
begin
  r := public.calendar_feed((select val from r4_vals where name = 'tess_mine'));
  assert r ->> 'status' = 'off' and jsonb_array_length(r -> 'events') = 0, 'a link turned off: an empty calendar';
  -- The rotated team link works; 60 fetches an hour, then 429 (the earlier fetch counted before rotating
  -- was reset by it).
  for i in 1 .. 60 loop
    r := public.calendar_feed((select val from r4_vals where name = 'tess_team'));
    assert r ->> 'status' = 'ok', format('fetch %s is fine', i);
  end loop;
  r := public.calendar_feed((select val from r4_vals where name = 'tess_team'));
  assert r ->> 'status' = 'rate_limited' and not r ? 'events', 'the 61st fetch in an hour is refused';
end $$;
reset role;

do $$
begin
  assert (select fetch_count = 60 and last_fetched_at > now() - interval '1 minute' from public.calendar_feeds
          where id = (select id from r4_ids where name = 'tess_team')), 'fetches are counted';
  update public.calendar_feeds set fetch_window_started_at = now() - interval '61 minutes'
  where id = (select id from r4_ids where name = 'tess_team');
end $$;
set role anon;
do $$
begin
  assert public.calendar_feed((select val from r4_vals where name = 'tess_team')) ->> 'status' = 'ok', 'a new hour, a new window';
end $$;
reset role;

-- Streaming export helpers -------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'a4a4a4a4-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from r4_ids where name = 'p');
  ids uuid[];
  t uuid;
  i integer;
  page record;
  after_due date;
  after_title text;
  after_task uuid;
  paged uuid[] := '{}';
  whole uuid[];
  pages integer := 0;
begin
  ids := public.filter_project_task_ids(p, '{"completion":"all"}', 'UTC');
  assert cardinality(ids) = (select count(*) from public.filter_project_tasks(p, '{"completion":"all"}', 'UTC'))
    and cardinality(ids) = 8, format('the filter''s ids in one array: %s', cardinality(ids));
  ids := public.filter_project_task_ids(p, '{}', 'UTC');
  assert cardinality(ids) = 6, 'the default filter: incomplete tasks';

  -- Seven overdue tasks (two share a due date and a title), paged two at a time.
  for i in 1 .. 7 loop
    select public.create_task(p, null, case when i in (3, 4) then 'R4 same' else 'R4 overdue ' || i end) into t;
    update public.tasks set due_on = current_date - (case when i in (3, 4) then 5 else i + 1 end) where id = t;
  end loop;
  select array_agg(o.task_id order by o.due_on, o.title, o.task_id) into whole
  from public.report_overdue_tasks(jsonb_build_object('projects', jsonb_build_array(p)), 'UTC', 10000) o;
  loop
    pages := pages + 1;
    i := 0;
    for page in
      select x.* from jsonb_to_recordset(public.report_overdue_tasks_after(
        jsonb_build_object('projects', jsonb_build_array(p)), 'UTC', after_due, after_title, after_task, 2
      )) as x(task_id uuid, title text, due_on date, days_overdue integer)
    loop
      i := i + 1;
      paged := paged || page.task_id;
      after_due := page.due_on;
      after_title := page.title;
      after_task := page.task_id;
      assert page.days_overdue > 0, 'days overdue';
    end loop;
    exit when i < 2 or pages > 20;
  end loop;
  assert cardinality(whole) = 7 and paged = whole, format('pages of two give the whole overdue list in order: %s vs %s', paged, whole);
end $$;

select set_config('request.jwt.claim.sub', 'a4a4a4a4-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  assert cardinality(public.filter_project_task_ids((select id from r4_ids where name = 'p'), '{"completion":"all"}', 'UTC')) = 0,
    'a workspace admin outside the project exports no ids';
  assert public.report_overdue_tasks_after(
    jsonb_build_object('projects', jsonb_build_array((select id from r4_ids where name = 'p'))), 'UTC', null, null, null, 1000) = '[]'::jsonb,
    'nor overdue rows';
end $$;
reset role;
