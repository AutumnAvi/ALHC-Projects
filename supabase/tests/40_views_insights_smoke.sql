-- Behavioural checks for Phase: Views & Insights: default views, view/widget validation + RLS +
-- soft delete, filter_project_tasks() semantics (incl. calendar placement by due_on and the
-- no-date tray), and project_metrics() counts for dashboard widgets.
-- Reuses the users from 10_core_smoke.sql:
--   1111… member@example.com  "Member One"   (allowlisted)
--   4444… later@example.com   "Later Person" (allowlisted)
--   2222… outsider@example.com               (not allowlisted)

\set ON_ERROR_STOP 1

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

create temporary table ids (name text primary key, id uuid) on commit preserve rows;
grant all on ids to authenticated, anon, service_role;

-- Fixtures ---------------------------------------------------------------------------------------
--   task      section  assignee  due        completed      Priority  notes
--   Alpha     A        member    today-2    -              High
--   Beta      A        later     today      -              Low       (Code = "X1")
--   Gamma     B        -         today+3    -              -         "find the needle"
--   Delta     B        member    -          now            -
--   Epsilon   -        -         -          -              -
--   Zeta      A        member    -          20 days ago    -
--   Eta       B        -         -          -              -         (home: Other, multi-homed here)
--   Removed   A        member    today      -              -         (soft-deleted task)

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  member uuid := '11111111-1111-4111-8111-111111111111';
  later uuid := '44444444-4444-4444-8444-444444444444';
  today date := (now() at time zone 'UTC')::date;
  p uuid;
  other_p uuid;
  s_a uuid;
  s_b uuid;
  s_other uuid;
  f_priority uuid;
  f_code uuid;
  f_status uuid;
  f_other uuid;
  t uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Views') returning id into p;
  insert into public.projects (workspace_id, name) values (ws, 'Other') returning id into other_p;
  insert into public.sections (project_id, name, sort_order) values (p, 'A', 1) returning id into s_a;
  insert into public.sections (project_id, name, sort_order) values (p, 'B', 2) returning id into s_b;
  insert into public.sections (project_id, name) values (other_p, 'Elsewhere') returning id into s_other;
  insert into public.custom_fields (project_id, name, field_type, options)
  values (p, 'Priority', 'single_select',
    '[{"id": "high", "name": "High", "color": "red"}, {"id": "low", "name": "Low", "color": "zinc"}]')
  returning id into f_priority;
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Code', 'text') returning id into f_code;
  insert into public.custom_fields (project_id, name, field_type, bound_to_sections)
  values (p, 'Status', 'single_select', true) returning id into f_status;
  insert into public.custom_fields (project_id, name, field_type) values (other_p, 'Foreign', 'text') returning id into f_other;
  insert into ids values ('p', p), ('other_p', other_p), ('s_a', s_a), ('s_b', s_b), ('s_other', s_other),
    ('f_priority', f_priority), ('f_code', f_code), ('f_status', f_status), ('f_other', f_other);

  t := public.create_task(p, s_a, 'Alpha');
  update public.tasks set assignee_id = member, due_on = today - 2 where id = t;
  insert into public.task_field_values (task_id, field_id, value) values (t, f_priority, '"high"');
  insert into ids values ('alpha', t);

  t := public.create_task(p, s_a, 'Beta');
  update public.tasks set assignee_id = later, due_on = today where id = t;
  insert into public.task_field_values (task_id, field_id, value) values (t, f_priority, '"low"'), (t, f_code, '"X1"');
  insert into ids values ('beta', t);

  t := public.create_task(p, s_b, 'Gamma');
  update public.tasks set due_on = today + 3, notes = 'find the needle' where id = t;
  insert into ids values ('gamma', t);

  t := public.create_task(p, s_b, 'Delta');
  update public.tasks set assignee_id = member, completed_at = now() where id = t;
  insert into ids values ('delta', t);

  t := public.create_task(p, null, 'Epsilon');
  insert into ids values ('epsilon', t);

  t := public.create_task(p, s_a, 'Zeta');
  update public.tasks set assignee_id = member, completed_at = now() - interval '20 days' where id = t;
  insert into ids values ('zeta', t);

  t := public.create_task(other_p, s_other, 'Eta');
  insert into public.task_projects (task_id, project_id, section_id, sort_order) values (t, p, s_b, 99999);
  insert into ids values ('eta', t);

  t := public.create_task(p, s_a, 'Removed');
  update public.tasks set assignee_id = member, due_on = today, deleted_at = now() where id = t;
end $$;

create function pg_temp.n(filters jsonb) returns bigint language sql as $$
  select count(*) from public.filter_project_tasks((select id from ids where name = 'p'), filters, 'UTC')
$$;

create function pg_temp.titles(filters jsonb) returns text language sql as $$
  select string_agg(t.title, ',' order by t.title)
  from public.filter_project_tasks((select id from ids where name = 'p'), filters, 'UTC') f
  join public.tasks t on t.id = f.task_id
$$;

-- Default views ----------------------------------------------------------------------------------

do $$
declare
  p uuid := (select id from ids where name = 'p');
begin
  assert (select string_agg(layout || ':' || name, ',' order by sort_order) from public.project_views
          where project_id = p and deleted_at is null) = 'list:List,board:Board,calendar:Calendar,timeline:Timeline',
    'every new project gets List, Board, Calendar, and Timeline views';
  assert (select config from public.project_views where project_id = p and layout = 'list') = '{}'::jsonb,
    'default views use the default config';
end $$;

-- Filter semantics -------------------------------------------------------------------------------

do $$
declare
  today date := (now() at time zone 'UTC')::date;
  s_a text := (select id from ids where name = 's_a')::text;
  s_b text := (select id from ids where name = 's_b')::text;
  member text := '11111111-1111-4111-8111-111111111111';
  f_priority text := (select id from ids where name = 'f_priority')::text;
  f_code text := (select id from ids where name = 'f_code')::text;
  f_status text := (select id from ids where name = 'f_status')::text;
begin
  assert pg_temp.titles('{}') = 'Alpha,Beta,Epsilon,Eta,Gamma',
    'default filter = incomplete tasks, including multi-homed ones, excluding soft-deleted';
  assert pg_temp.n('{"completion": "all"}') = 7, 'completion all';
  assert pg_temp.titles('{"completion": "completed"}') = 'Delta,Zeta', 'completion completed';
  assert pg_temp.titles('{"completion": "completed", "completed_within_days": 7}') = 'Delta',
    'completed in the last N days uses completed_at';

  assert pg_temp.titles(jsonb_build_object('sections', jsonb_build_array(s_a))) = 'Alpha,Beta', 'section filter';
  assert pg_temp.titles('{"sections": [null]}') = 'Epsilon', 'null section = No section';
  assert pg_temp.n(jsonb_build_object('sections', jsonb_build_array(s_b, null))) = 3, 'sections are any-of';

  assert pg_temp.titles(jsonb_build_object('assignees', jsonb_build_array(member))) = 'Alpha', 'assignee filter';
  assert pg_temp.titles(jsonb_build_object('assignees', jsonb_build_array(member), 'completion', 'all')) = 'Alpha,Delta,Zeta',
    'assignee + completion all';
  assert pg_temp.titles('{"assignees": [null]}') = 'Epsilon,Eta,Gamma', 'null assignee = unassigned';
  assert pg_temp.titles('{"assignees": ["me"]}') = 'Alpha', '"me" resolves to the caller';

  assert pg_temp.titles('{"due": {"kind": "overdue"}}') = 'Alpha', 'overdue';
  assert pg_temp.titles('{"due": {"kind": "overdue"}, "completion": "all"}') = 'Alpha', 'overdue never includes completed tasks';
  assert pg_temp.titles('{"due": {"kind": "today"}}') = 'Beta', 'due today';
  assert pg_temp.titles('{"due": {"kind": "upcoming"}}') = 'Gamma', 'upcoming defaults to 7 days after today';
  assert pg_temp.n('{"due": {"kind": "upcoming", "days": 2}}') = 0, 'upcoming window';
  assert pg_temp.titles('{"due": {"kind": "no_date"}}') = 'Epsilon,Eta', 'no due date';

  -- Calendar placement: the visible month/week is a due_on range; the tray is incomplete + no date.
  assert pg_temp.titles(jsonb_build_object('due', jsonb_build_object('kind', 'range', 'from', (today - 2)::text, 'to', today::text)))
    = 'Alpha,Beta', 'calendar range places tasks by due_on (inclusive)';
  assert pg_temp.titles(jsonb_build_object('due', jsonb_build_object('kind', 'range', 'from', (today + 1)::text))) = 'Gamma',
    'open-ended range';
  assert pg_temp.titles(jsonb_build_object('due', jsonb_build_object('kind', 'range', 'from', (today - 2)::text, 'to', today::text),
    'assignees', jsonb_build_array(member))) = 'Alpha', 'calendar respects other view filters';

  assert pg_temp.titles(jsonb_build_object('fields', jsonb_build_array(
    jsonb_build_object('field_id', f_priority, 'op', 'in', 'values', '["high"]'::jsonb)))) = 'Alpha', 'select field in';
  assert pg_temp.n(jsonb_build_object('fields', jsonb_build_array(
    jsonb_build_object('field_id', f_priority, 'op', 'in', 'values', '["high", "low"]'::jsonb)))) = 2, 'select field any-of';
  assert pg_temp.titles(jsonb_build_object('fields', jsonb_build_array(
    jsonb_build_object('field_id', f_priority, 'op', 'empty')))) = 'Epsilon,Eta,Gamma', 'field empty';
  assert pg_temp.n(jsonb_build_object('fields', jsonb_build_array(
    jsonb_build_object('field_id', f_priority, 'op', 'not_empty')))) = 2, 'field not empty';
  assert pg_temp.titles(jsonb_build_object('fields', jsonb_build_array(
    jsonb_build_object('field_id', f_code, 'op', 'equals', 'value', 'x1')))) = 'Beta', 'text equals is case-insensitive';
  assert pg_temp.titles(jsonb_build_object('fields', jsonb_build_array(
    jsonb_build_object('field_id', f_status, 'op', 'in', 'values', jsonb_build_array(s_a))))) = 'Alpha,Beta',
    'section-bound Status filters by the section';
  assert pg_temp.n(jsonb_build_object('fields', jsonb_build_array(
    jsonb_build_object('field_id', f_priority, 'op', 'in', 'values', '["high"]'::jsonb),
    jsonb_build_object('field_id', f_code, 'op', 'empty')))) = 1, 'field conditions are ANDed';

  assert pg_temp.titles('{"text": "NEEDLE"}') = 'Gamma', 'text searches notes';
  assert pg_temp.titles('{"text": "alp"}') = 'Alpha', 'text searches titles';
  assert pg_temp.n('{"text": "%"}') = 0, 'LIKE wildcards are escaped';
  assert pg_temp.n(jsonb_build_object('sections', jsonb_build_array(s_a), 'due', '{"kind": "today"}'::jsonb)) = 1,
    'filters combine with AND';

  assert (select count(*) from public.filter_project_tasks((select id from ids where name = 'p'), '{}', 'Not/AZone')) = 5,
    'an unknown time zone falls back to UTC';
end $$;

-- Dashboard metrics ------------------------------------------------------------------------------

do $$
declare
  p uuid := (select id from ids where name = 'p');
  s_a uuid := (select id from ids where name = 's_a');
  s_b uuid := (select id from ids where name = 's_b');
  member uuid := '11111111-1111-4111-8111-111111111111';
  later uuid := '44444444-4444-4444-8444-444444444444';
begin
  assert (select sum(task_count) from public.project_metrics(p, '{}', 'none', 'UTC')) = 5, 'incomplete count';
  assert (select sum(task_count) from public.project_metrics(p, '{"due": {"kind": "overdue"}}', 'none', 'UTC')) = 1, 'overdue count';
  assert (select sum(task_count) from public.project_metrics(p, '{"completion": "completed", "completed_within_days": 7}', 'none', 'UTC')) = 1,
    'completed in the last 7 days';
  assert (select coalesce(sum(task_count), 0) from public.project_metrics(p, '{"text": "nothing matches"}', 'none', 'UTC')) = 0,
    'no matches = no rows';

  assert (select task_count from public.project_metrics(p, '{}', 'section', 'UTC') where bucket = s_a) = 2, 'section A';
  assert (select task_count from public.project_metrics(p, '{}', 'section', 'UTC') where bucket = s_b) = 2, 'section B (incl. multi-homed)';
  assert (select task_count from public.project_metrics(p, '{}', 'section', 'UTC') where bucket is null) = 1, 'No section bucket';

  assert (select task_count from public.project_metrics(p, '{}', 'assignee', 'UTC') where bucket = member) = 1, 'member bucket';
  assert (select task_count from public.project_metrics(p, '{}', 'assignee', 'UTC') where bucket = later) = 1, 'later bucket';
  assert (select task_count from public.project_metrics(p, '{}', 'assignee', 'UTC') where bucket is null) = 3, 'Unassigned bucket';
  assert (select task_count from public.project_metrics(p, '{"completion": "all"}', 'assignee', 'UTC') where bucket = member) = 3,
    'assignee chart honours the widget filter';
end $$;

-- View + widget CRUD and validation --------------------------------------------------------------

do $$
declare
  p uuid := (select id from ids where name = 'p');
  v uuid;
  w uuid;
  n integer;
begin
  insert into public.project_views (project_id, name, layout, config, sort_order)
  values (p, 'By assignee', 'board', jsonb_build_object(
    'filters', jsonb_build_object('sections', jsonb_build_array((select id from ids where name = 's_a')), 'completion', 'all'),
    'sort', '[{"key": "due", "dir": "asc"}]'::jsonb,
    'group_by', 'assignee',
    'columns', jsonb_build_array('due', 'field:' || (select id from ids where name = 'f_priority'))
  ), 4096)
  returning id into v;
  insert into ids values ('view', v);
  assert (select created_by from public.project_views where id = v) = '11111111-1111-4111-8111-111111111111',
    'created_by defaults to the caller';

  update public.project_views
  set name = 'Mine', config = '{"filters": {"assignees": ["me"]}, "group_by": "none"}'
  where id = v;
  assert (select config -> 'filters' -> 'assignees' from public.project_views where id = v) = '["me"]', 'config updates persist';

  update public.project_views
  set config = jsonb_build_object('group_by', 'field:' || (select id from ids where name = 'f_priority'))
  where id = v;

  begin
    insert into public.project_views (project_id, name, layout) values (p, 'Gantt', 'gantt');
    raise exception 'unknown layouts must be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into public.project_views (project_id, name, layout, config)
    values (p, 'Bad', 'list', jsonb_build_object('filters', jsonb_build_object('sections', jsonb_build_array((select id from ids where name = 's_other')))));
    raise exception 'sections from another project must be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into public.project_views (project_id, name, layout, config)
    values (p, 'Bad', 'list', jsonb_build_object('columns', jsonb_build_array('field:' || (select id from ids where name = 'f_other'))));
    raise exception 'columns from another project must be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into public.project_views (project_id, name, layout, config)
    values (p, 'Bad', 'list', jsonb_build_object('group_by', 'field:' || (select id from ids where name = 'f_code')));
    raise exception 'grouping by a text field must be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into public.project_views (project_id, name, layout, config) values (p, 'Bad', 'list', '{"filters": {"colour": "red"}}');
    raise exception 'unknown filters must be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into public.project_views (project_id, name, layout, config) values (p, 'Bad', 'list', '{"filters": {"completed_within_days": 7}}');
    raise exception 'completed_within_days requires completion = completed';
  exception when check_violation then null;
  end;
  begin
    insert into public.project_views (project_id, name, layout, config)
    values (p, 'Bad', 'list', '{"filters": {"due": {"kind": "range", "from": "2026-02-30"}}}');
    raise exception 'invalid dates must be rejected';
  exception when check_violation then null;
  end;
  begin
    update public.project_views set project_id = (select id from ids where name = 'other_p') where id = v;
    raise exception 'views must not move between projects';
  exception when check_violation then null;
  end;

  delete from public.project_views where id = v;
  get diagnostics n = row_count;
  assert n = 0, 'views cannot be hard-deleted';
  update public.project_views set deleted_at = now() where id = v;
  assert (select count(*) from public.project_views where project_id = p and deleted_at is null) = 4,
    'soft-deleted views drop out of the active list';

  insert into public.dashboard_widgets (project_id, kind, title, filters, sort_order)
  values (p, 'count', 'Overdue', '{"due": {"kind": "overdue"}}', 1024)
  returning id into w;
  insert into ids values ('widget', w);
  update public.dashboard_widgets set title = 'Late', filters = '{"due": {"kind": "today"}}' where id = w;
  assert (select sum(task_count) from public.project_metrics(p,
    (select filters from public.dashboard_widgets where id = w), 'none', 'UTC')) = 1, 'widget filters drive metrics';
  begin
    insert into public.dashboard_widgets (project_id, kind, title) values (p, 'pie', 'Pie');
    raise exception 'unknown widget kinds must be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into public.dashboard_widgets (project_id, kind, title, filters)
    values (p, 'count', 'Bad', jsonb_build_object('fields', jsonb_build_array(jsonb_build_object(
      'field_id', (select id from ids where name = 'f_other'), 'op', 'empty'))));
    raise exception 'widget filters must stay inside the project';
  exception when check_violation then null;
  end;
  delete from public.dashboard_widgets where id = w;
  get diagnostics n = row_count;
  assert n = 0, 'widgets cannot be hard-deleted';
  update public.dashboard_widgets set deleted_at = now() where id = w;
  assert (select deleted_at from public.dashboard_widgets where id = w) is not null, 'widgets soft-delete';
end $$;

-- Outsider + anon --------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from ids where name = 'p');
begin
  assert (select count(*) from public.project_views) = 0, 'outsider cannot read views';
  assert (select count(*) from public.dashboard_widgets) = 0, 'outsider cannot read widgets';
  assert (select count(*) from public.filter_project_tasks(p, '{"completion": "all"}', 'UTC')) = 0,
    'filtering runs under the caller''s RLS';
  assert (select count(*) from public.project_metrics(p, '{"completion": "all"}', 'none', 'UTC')) = 0,
    'metrics run under the caller''s RLS';
  begin
    insert into public.project_views (project_id, name, layout) values (p, 'Sneaky', 'list');
    raise exception 'outsider view insert should have failed';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.dashboard_widgets (project_id, kind, title) values (p, 'count', 'Sneaky');
    raise exception 'outsider widget insert should have failed';
  exception when insufficient_privilege then null;
  end;
  update public.project_views set name = 'Hijacked' where project_id = p;
end $$;

reset role;

do $$
begin
  assert not exists (select 1 from public.project_views where name = 'Hijacked'), 'outsider cannot rename views';
end $$;

set role anon;

do $$
begin
  begin
    perform public.filter_project_tasks((select id from ids where name = 'p'), '{}', 'UTC');
    raise exception 'anon must not filter tasks';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.project_metrics((select id from ids where name = 'p'), '{}', 'none', 'UTC');
    raise exception 'anon must not read metrics';
  exception when insufficient_privilege then null;
  end;
  assert (select count(*) from public.project_views) = 0, 'anon cannot read views';
end $$;

reset role;
select 'views & insights smoke: all assertions passed' as result;
