-- Behavioural checks for Phase: Timeline: tasks.start_on (constraint, RLS, start_changed stories),
-- the timeline layout (defaults, backfill invariant, validation of the `start` sort/column key),
-- filters still evaluating on due_on, and EXECUTE hardening of SECURITY DEFINER trigger functions.
-- Reuses the users from 10_core_smoke.sql:
--   1111… member@example.com  "Member One"   (allowlisted)
--   2222… outsider@example.com               (not allowlisted)

\set ON_ERROR_STOP 1

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

create temporary table tl_ids (name text primary key, id uuid) on commit preserve rows;
grant all on tl_ids to authenticated, anon, service_role;

-- Fixtures ---------------------------------------------------------------------------------------
--   task       start        due
--   Span       today        today+4
--   DueOnly    -            today+2
--   StartOnly  today+1      -
--   Floating   -            -

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  today date := (now() at time zone 'UTC')::date;
  p uuid;
  s uuid;
  t uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Timeline') returning id into p;
  insert into public.sections (project_id, name, sort_order) values (p, 'Plan', 1) returning id into s;
  insert into tl_ids values ('p', p), ('s', s);

  t := public.create_task(p, s, 'Span');
  update public.tasks set start_on = today, due_on = today + 4 where id = t;
  insert into tl_ids values ('span', t);

  t := public.create_task(p, s, 'DueOnly');
  update public.tasks set due_on = today + 2 where id = t;
  insert into tl_ids values ('due_only', t);

  t := public.create_task(p, s, 'StartOnly');
  update public.tasks set start_on = today + 1 where id = t;
  insert into tl_ids values ('start_only', t);

  t := public.create_task(p, null, 'Floating');
  insert into tl_ids values ('floating', t);
end $$;

-- Start dates ------------------------------------------------------------------------------------

do $$
declare
  today date := (now() at time zone 'UTC')::date;
  span uuid := (select id from tl_ids where name = 'span');
  start_only uuid := (select id from tl_ids where name = 'start_only');
  story jsonb;
  n integer;
begin
  assert (select start_on from public.tasks where id = span) = today, 'members can set start_on';
  assert (select start_on is null from public.tasks where id = (select id from tl_ids where name = 'due_only')),
    'start_on is optional';

  select data into story from public.task_stories
  where task_id = span and kind = 'start_changed' order by created_at desc limit 1;
  assert story ->> 'to' = today::text and story -> 'from' = 'null'::jsonb, 'start_changed story records from/to';
  assert (select actor_id from public.task_stories where task_id = span and kind = 'start_changed' limit 1)
    = '11111111-1111-4111-8111-111111111111', 'start_changed story records the actor';

  begin
    update public.tasks set start_on = today + 5 where id = span;
    raise exception 'start after due must be rejected';
  exception when check_violation then null;
  end;
  begin
    update public.tasks set due_on = today + 0 where id = start_only;
    raise exception 'due before start must be rejected';
  exception when check_violation then null;
  end;

  update public.tasks set start_on = today + 4 where id = span;
  assert (select start_on = due_on from public.tasks where id = span), 'start may equal due (one-day bar)';

  -- Moving a bar shifts both dates in one statement; the check sees the final row.
  update public.tasks set start_on = today + 10, due_on = today + 12 where id = span;
  assert (select (start_on, due_on) = (today + 10, today + 12) from public.tasks where id = span),
    'moving start and due together past the old due date succeeds';
  assert (select count(*) from public.task_stories where task_id = span and kind = 'due_changed') = 2,
    'due changes keep logging due_changed';

  select count(*) into n from public.task_stories where task_id = span and kind = 'start_changed';
  update public.tasks set title = 'Span' where id = span;
  update public.tasks set start_on = null where id = span;
  assert (select count(*) from public.task_stories where task_id = span and kind = 'start_changed') = n + 1,
    'only actual start changes are logged';
  assert exists (select 1 from public.task_stories where task_id = span and kind = 'start_changed'
                 and data -> 'to' = 'null'::jsonb and data ->> 'from' = (today + 10)::text),
    'clearing the start date is logged';
  update public.tasks set start_on = today + 10 where id = span;
end $$;

-- Timeline views ---------------------------------------------------------------------------------

do $$
declare
  p uuid := (select id from tl_ids where name = 'p');
  v uuid;
begin
  assert (select string_agg(layout, ',' order by sort_order) from public.project_views
          where project_id = p and deleted_at is null) = 'list,board,calendar,timeline',
    'new projects get a Timeline view after List, Board, and Calendar';
  assert not exists (
    select 1 from public.projects pr
    where pr.deleted_at is null and not exists (
      select 1 from public.project_views v
      where v.project_id = pr.id and v.layout = 'timeline' and v.deleted_at is null
    )
  ), 'every active project can open a Timeline view';

  insert into public.project_views (project_id, name, layout, config, sort_order)
  values (p, 'Roadmap', 'timeline', jsonb_build_object(
    'filters', '{"completion": "all"}'::jsonb,
    'sort', '[{"key": "start", "dir": "asc"}, {"key": "due", "dir": "asc"}]'::jsonb,
    'group_by', 'assignee'
  ), 5120)
  returning id into v;
  insert into tl_ids values ('view', v);
  assert (select layout from public.project_views where id = v) = 'timeline', 'timeline views can be created';

  insert into public.project_views (project_id, name, layout, config, sort_order)
  values (p, 'Dates', 'list', '{"columns": ["start", "due"]}', 6144);
  assert (select config -> 'columns' from public.project_views where project_id = p and name = 'Dates')
    = '["start", "due"]', 'start is a List/Board column key';

  begin
    insert into public.project_views (project_id, name, layout) values (p, 'Gantt', 'gantt');
    raise exception 'unknown layouts must still be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into public.project_views (project_id, name, layout, config)
    values (p, 'Bad', 'timeline', '{"sort": [{"key": "starts", "dir": "asc"}]}');
    raise exception 'unknown sort keys must be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into public.project_views (project_id, name, layout, config)
    values (p, 'Bad', 'timeline', '{"columns": ["start_on"]}');
    raise exception 'unknown column keys must be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into public.project_views (project_id, name, layout, config)
    values (p, 'Bad', 'timeline', '{"zoom": "week"}');
    raise exception 'unknown view settings must be rejected';
  exception when check_violation then null;
  end;

  update public.project_views set deleted_at = now() where id = v;
  assert (select count(*) from public.project_views where project_id = p and layout = 'timeline' and deleted_at is null) = 1,
    'timeline views soft-delete like any other view';
end $$;

-- Filters stay on due_on -------------------------------------------------------------------------

create function pg_temp.tl_titles(filters jsonb) returns text language sql as $$
  select string_agg(t.title, ',' order by t.title)
  from public.filter_project_tasks((select id from tl_ids where name = 'p'), filters, 'UTC') f
  join public.tasks t on t.id = f.task_id
$$;

do $$
declare
  today date := (now() at time zone 'UTC')::date;
  s text := (select id from tl_ids where name = 's')::text;
begin
  assert pg_temp.tl_titles('{}') = 'DueOnly,Floating,Span,StartOnly', 'timeline sees every incomplete task';
  assert pg_temp.tl_titles('{"due": {"kind": "no_date"}}') = 'Floating,StartOnly',
    '"No due date" is about due_on only (start-only tasks still match)';
  assert pg_temp.tl_titles(jsonb_build_object('due', jsonb_build_object('kind', 'range', 'from', today::text, 'to', (today + 3)::text)))
    = 'DueOnly', 'due ranges ignore start_on';
  assert pg_temp.tl_titles(jsonb_build_object('sections', jsonb_build_array(s), 'text', 'only'))
    = 'DueOnly,StartOnly', 'timeline filters combine like any other view';
end $$;

-- Outsider ---------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false) is not null as ok \gset

do $$
begin
  update public.tasks set start_on = '2000-01-01' where id = (select id from tl_ids where name = 'floating');
  assert (select count(*) from public.project_views where layout = 'timeline') = 0, 'outsider cannot read timeline views';
end $$;

reset role;

do $$
begin
  assert (select start_on is null from public.tasks where id = (select id from tl_ids where name = 'floating')),
    'outsider cannot set start dates';
end $$;

-- EXECUTE hardening ------------------------------------------------------------------------------

do $$
declare
  exposed text;
begin
  select string_agg(p.proname, ',' order by p.proname) into exposed
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute');
  assert exposed = 'get_public_form,submit_form',
    format('anon may only execute the public form RPCs among SECURITY DEFINER functions, got %s', exposed);

  assert not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and p.prorettype = 'trigger'::regtype
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
  ), 'no client role can execute a SECURITY DEFINER trigger function';

  assert has_function_privilege('authenticated', 'public.is_allowlisted()', 'execute'), 'is_allowlisted stays callable';
  assert has_function_privilege('authenticated', 'public.create_task(uuid, uuid, text)', 'execute'), 'create_task stays callable';
  assert has_function_privilege('authenticated', 'public.filter_project_tasks(uuid, jsonb, text)', 'execute'),
    'filter_project_tasks stays callable';
end $$;

set role anon;

do $$
begin
  begin
    perform public.is_allowlisted();
    raise exception 'anon must not call is_allowlisted';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.validate_view_config((select id from tl_ids where name = 'p'), '{}');
    raise exception 'anon must not call view validators';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.tasks set start_on = '2000-01-01';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

do $$
begin
  assert not exists (select 1 from public.tasks where start_on = '2000-01-01'), 'anon cannot set start dates';
end $$;

select 'timeline smoke: all assertions passed' as result;
