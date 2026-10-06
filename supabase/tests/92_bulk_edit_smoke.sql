-- Behavioural checks for Phase: Bulk edit and shortcuts: bulk_update_tasks (partial apply with
-- per-task skip reasons, role denial, blocked dependencies, per-task stories / inbox items / rules,
-- the 200-task limit) and the ordering helpers (place_task, place_section, reindex).
-- Reuses people from earlier suites:
--   1111… member@example.com   "Member One"   (owner of the projects below)
--   5555… viewer@example.com   "Vera Viewer"
--   7777… editor@example.com   "Eddie Editor"
--   9999… nonmember@example.com

\set ON_ERROR_STOP 1

create temporary table be_ids (name text primary key, id uuid) on commit preserve rows;
grant all on be_ids to authenticated, anon, service_role;

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

-- Fixtures ---------------------------------------------------------------------------------------

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid;
  q uuid;
  other uuid;
  s1 uuid;
  s2 uuid;
  f uuid;
  status_field uuid;
  t uuid;
  name text;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Bulk') returning id into p;
  insert into public.projects (workspace_id, name) values (ws, 'Bulk second') returning id into q;
  insert into public.projects (workspace_id, name) values (ws, 'Bulk other') returning id into other;
  insert into public.sections (project_id, name, sort_order) values (p, 'Inbox', 1024) returning id into s1;
  insert into public.sections (project_id, name, sort_order) values (p, 'Doing', 2048) returning id into s2;
  insert into public.custom_fields (project_id, name, field_type, options)
  values (p, 'Priority', 'single_select', '[{"id": "hi", "name": "High", "color": "red"}, {"id": "lo", "name": "Low", "color": "zinc"}]')
  returning id into f;
  insert into public.custom_fields (project_id, name, field_type, bound_to_sections)
  values (p, 'Status', 'single_select', true) returning id into status_field;
  perform public.add_project_member(p, 'viewer@example.com', 'viewer');
  perform public.add_project_member(p, 'editor@example.com', 'editor');
  insert into be_ids values ('p', p), ('q', q), ('other', other), ('s1', s1), ('s2', s2), ('f', f),
    ('status_field', status_field);
  insert into public.sections (project_id, name, sort_order) values (q, 'Elsewhere', 1024) returning id into t;
  insert into be_ids values ('s_elsewhere', t);
  -- Reorder fixtures: three tasks alone in their own section.
  insert into public.sections (project_id, name, sort_order) values (p, 'Ordering', 4096) returning id into t;
  insert into be_ids values ('s_order', t);
  foreach name in array array['1', '2', '3'] loop
    insert into be_ids values ('o' || name, public.create_task(p, t, 'Order ' || name));
  end loop;

  foreach name in array array['a', 'b', 'c', 'd', 'e'] loop
    t := public.create_task(p, s1, 'Bulk ' || name);
    insert into be_ids values (name, t);
  end loop;
  -- A task outside the project (and outside the field's project).
  t := public.create_task(other, null, 'Bulk outsider');
  insert into be_ids values ('outsider', t);
  -- A blocker that is not part of any request below.
  t := public.create_task(p, null, 'Bulk blocker');
  insert into be_ids values ('blocker', t);
end $$;

-- Changes below run in later transactions than the fixtures, so they aren't part of "created".

-- Complete: partial apply, dependency blocking, in-request blockers, stories --------------------

do $$
declare
  a uuid := (select id from be_ids where name = 'a');
  b uuid := (select id from be_ids where name = 'b');
  c uuid := (select id from be_ids where name = 'c');
  blocker uuid := (select id from be_ids where name = 'blocker');
  result jsonb;
begin
  perform public.add_task_dependency(blocker, b);  -- b waits on a task outside the request
  perform public.add_task_dependency(c, a);        -- a waits on c, which is in the request (after a)

  result := public.bulk_update_tasks(array[a, b, c, a], '{"action": "complete"}');
  assert jsonb_array_length(result -> 'updated') = 2, format('a and c complete: %s', result);
  assert (result -> 'updated') @> to_jsonb(array[a, c]), format('updated lists a and c: %s', result);
  assert jsonb_array_length(result -> 'skipped') = 1, format('only b is skipped: %s', result);
  assert result -> 'skipped' -> 0 ->> 'task_id' = b::text, 'b is the skipped task';
  assert result -> 'skipped' -> 0 ->> 'title' = 'Bulk b', 'the skipped task is named';
  assert result -> 'skipped' -> 0 ->> 'reason' = 'This task is blocked by 1 incomplete task',
    format('the reason says why: %s', result -> 'skipped' -> 0 ->> 'reason');
  assert (select completed_at is not null from public.tasks where id = a), 'a was completed after its blocker';
  assert (select completed_at is null from public.tasks where id = b), 'b stays open';
  assert (select count(*) from public.task_stories where task_id in (a, c) and kind = 'completed') = 2,
    'one completed story per task';

  -- Already complete = unchanged (no second story).
  result := public.bulk_update_tasks(array[a], '{"action": "complete"}');
  assert result -> 'unchanged' = to_jsonb(array[a]), format('already complete is unchanged: %s', result);
  assert (select count(*) from public.task_stories where task_id = a and kind = 'completed') = 1,
    'no extra story for an unchanged task';

  result := public.bulk_update_tasks(array[a, c], '{"action": "reopen"}');
  assert jsonb_array_length(result -> 'updated') = 2, format('reopen both: %s', result);
  assert (select count(*) from public.task_stories where task_id in (a, c) and kind = 'reopened') = 2,
    'one reopened story per task';
end $$;

-- Assign: per-task inbox items, unreadable assignee skipped ---------------------------------------

do $$
declare
  a uuid := (select id from be_ids where name = 'a');
  b uuid := (select id from be_ids where name = 'b');
  outsider uuid := (select id from be_ids where name = 'outsider');
  result jsonb;
begin
  result := public.bulk_update_tasks(array[a, b, outsider],
    '{"action": "assign", "assignee_id": "77777777-7777-4777-8777-777777777777"}');
  assert jsonb_array_length(result -> 'updated') = 2, format('a and b assigned: %s', result);
  assert result -> 'skipped' -> 0 ->> 'task_id' = outsider::text, 'the outsider is skipped';
  assert result -> 'skipped' -> 0 ->> 'reason' = 'Eddie Editor isn’t a member of this task’s projects',
    format('assignee access reason: %s', result -> 'skipped' -> 0 ->> 'reason');
  assert (select assignee_id from public.tasks where id = outsider) is null, 'outsider stays unassigned';
  assert (select count(*) from public.task_stories where task_id in (a, b) and kind = 'assigned') = 2,
    'one assigned story per task';

  result := public.bulk_update_tasks(array[a], '{"action": "assign", "assignee_id": null}');
  assert result -> 'updated' = to_jsonb(array[a]), 'unassign';
  assert (select assignee_id from public.tasks where id = a) is null, 'a is unassigned';
end $$;

reset role;
do $$
begin
  assert (select count(*) from public.inbox_items
          where recipient_id = '77777777-7777-4777-8777-777777777777' and kind = 'assigned'
            and task_id in (select id from be_ids where name in ('a', 'b'))) = 2,
    'the new assignee gets one inbox item per task';
end $$;
set role authenticated;

-- Due dates: a task whose start is after the new due date is skipped ------------------------------

do $$
declare
  a uuid := (select id from be_ids where name = 'a');
  b uuid := (select id from be_ids where name = 'b');
  result jsonb;
begin
  update public.tasks set start_on = '2026-12-01' where id = b;
  result := public.bulk_update_tasks(array[a, b], '{"action": "set_due", "due_on": "2026-11-15"}');
  assert result -> 'updated' = to_jsonb(array[a]), format('a gets the date: %s', result);
  assert result -> 'skipped' -> 0 ->> 'reason' = 'Its start date is after that due date',
    format('start-after-due reason: %s', result);
  assert (select due_on from public.tasks where id = a) = '2026-11-15', 'a is due Nov 15';
  assert (select due_on from public.tasks where id = b) is null, 'b keeps no due date';

  result := public.bulk_update_tasks(array[a], '{"action": "set_due", "due_on": null}');
  assert (select due_on from public.tasks where id = a) is null, 'clearing the due date';
end $$;

-- Move to section: rules fire per task; tasks outside the project are skipped ---------------------

do $$
declare
  p uuid := (select id from be_ids where name = 'p');
  s2 uuid := (select id from be_ids where name = 's2');
  a uuid := (select id from be_ids where name = 'a');
  b uuid := (select id from be_ids where name = 'b');
  d uuid := (select id from be_ids where name = 'd');
  outsider uuid := (select id from be_ids where name = 'outsider');
  r uuid;
  result jsonb;
begin
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions)
  values (p, 'Moved to Doing', true, 'section_changed', jsonb_build_object('section_id', s2),
    '[{"type": "add_comment", "body": "Started"}]')
  returning id into r;

  result := public.bulk_update_tasks(array[a, b, d, outsider],
    jsonb_build_object('action', 'move_section', 'project_id', p, 'section_id', s2));
  assert jsonb_array_length(result -> 'updated') = 3, format('three tasks move: %s', result);
  assert result -> 'skipped' -> 0 ->> 'reason' = 'It isn’t in this project', format('outsider reason: %s', result);
  assert (select count(*) from public.task_projects where project_id = p and section_id = s2 and task_id in (a, b, d)) = 3,
    'all three are in Doing';
  assert (select count(distinct sort_order) from public.task_projects where project_id = p and section_id = s2) = 3,
    'appended with distinct positions';
  assert (select count(*) from public.rule_runs where rule_id = r and status = 'succeeded') = 3,
    'the section rule ran once per task';
  assert (select count(*) from public.comments where rule_id = r and task_id in (a, b, d)) = 3,
    'the rule commented on each task';
  assert (select count(*) from public.task_stories where task_id in (a, b, d) and kind = 'section_changed') = 3,
    'one section_changed story per task';

  update public.rules set enabled = false where id = r;

  -- Moving again to the same section changes nothing.
  result := public.bulk_update_tasks(array[a],
    jsonb_build_object('action', 'move_section', 'project_id', p, 'section_id', s2));
  assert result -> 'unchanged' = to_jsonb(array[a]), 'same section = unchanged';

  begin
    perform public.bulk_update_tasks(array[a], jsonb_build_object('action', 'move_section', 'project_id', p,
      'section_id', (select id from be_ids where name = 's_elsewhere')));
    raise exception 'a section from another project should be rejected';
  exception when invalid_parameter_value then null;
  end;
end $$;

-- Add to another project, set a field, delete ----------------------------------------------------

do $$
declare
  p uuid := (select id from be_ids where name = 'p');
  q uuid := (select id from be_ids where name = 'q');
  f uuid := (select id from be_ids where name = 'f');
  status_field uuid := (select id from be_ids where name = 'status_field');
  a uuid := (select id from be_ids where name = 'a');
  b uuid := (select id from be_ids where name = 'b');
  e uuid := (select id from be_ids where name = 'e');
  outsider uuid := (select id from be_ids where name = 'outsider');
  result jsonb;
begin
  result := public.bulk_update_tasks(array[a, b], jsonb_build_object('action', 'add_to_project', 'project_id', q));
  assert jsonb_array_length(result -> 'updated') = 2, format('multi-homed into q: %s', result);
  assert (select count(*) from public.task_projects where project_id = q and task_id in (a, b) and deleted_at is null) = 2,
    'both are now in q';
  assert (select count(*) from public.task_stories where task_id in (a, b) and kind = 'project_added') = 2,
    'one project_added story per task';
  result := public.bulk_update_tasks(array[a], jsonb_build_object('action', 'add_to_project', 'project_id', q));
  assert result -> 'unchanged' = to_jsonb(array[a]), 'already in the project = unchanged';

  result := public.bulk_update_tasks(array[a, b, outsider],
    jsonb_build_object('action', 'set_field', 'field_id', f, 'value', 'hi'));
  assert jsonb_array_length(result -> 'updated') = 2, format('field set on a and b: %s', result);
  assert result -> 'skipped' -> 0 ->> 'reason' = 'It isn’t in the field’s project', format('outsider: %s', result);
  assert (select value from public.task_field_values where task_id = a and field_id = f) = '"hi"', 'a is High';
  assert (select count(*) from public.task_stories where task_id in (a, b) and kind = 'field_changed') = 2,
    'one field_changed story per task';

  result := public.bulk_update_tasks(array[a, e], jsonb_build_object('action', 'set_field', 'field_id', f, 'value', null));
  assert result -> 'updated' = to_jsonb(array[a]), format('clearing a: %s', result);
  assert result -> 'unchanged' = to_jsonb(array[e]), 'e had no value';
  assert (select value from public.task_field_values where task_id = a and field_id = f) is null, 'cleared (stored as SQL null)';

  begin
    perform public.bulk_update_tasks(array[a], jsonb_build_object('action', 'set_field', 'field_id', status_field, 'value', 'x'));
    raise exception 'the section-bound Status field is changed by moving, not set_field';
  exception when invalid_parameter_value then null;
  end;

  result := public.bulk_update_tasks(array[e], '{"action": "delete"}');
  assert result -> 'updated' = to_jsonb(array[e]), 'e moves to the Trash';
  assert (select deleted_at is not null from public.tasks where id = e), 'e is soft-deleted';
  result := public.bulk_update_tasks(array[e], '{"action": "complete"}');
  assert result -> 'skipped' -> 0 ->> 'reason' = 'It’s in the Trash', format('trashed tasks are skipped: %s', result);

  -- Limits and bad input.
  begin
    perform public.bulk_update_tasks(
      (select array_agg(gen_random_uuid()) from generate_series(1, 201)), '{"action": "complete"}');
    raise exception 'more than 200 tasks should be rejected';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.bulk_update_tasks(array[a], '{"action": "explode"}');
    raise exception 'unknown actions should be rejected';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.bulk_update_tasks('{}', '{"action": "complete"}');
    raise exception 'an empty selection should be rejected';
  exception when invalid_parameter_value then null;
  end;
end $$;

-- Role denial ------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from be_ids where name = 'p');
  s1 uuid := (select id from be_ids where name = 's1');
  c uuid := (select id from be_ids where name = 'c');
  d uuid := (select id from be_ids where name = 'd');
  result jsonb;
begin
  result := public.bulk_update_tasks(array[c, d], '{"action": "complete"}');
  assert jsonb_array_length(result -> 'updated') = 0, format('a viewer changes nothing: %s', result);
  assert jsonb_array_length(result -> 'skipped') = 2, 'both are skipped';
  assert result -> 'skipped' -> 0 ->> 'reason' = 'Your role doesn’t allow editing this task',
    format('viewer reason: %s', result -> 'skipped' -> 0 ->> 'reason');
  assert result -> 'skipped' -> 0 ->> 'title' = 'Bulk c', 'viewers still see the names of tasks they can read';

  begin
    perform public.bulk_update_tasks(array[c], jsonb_build_object('action', 'move_section', 'project_id', p, 'section_id', s1));
    raise exception 'a viewer cannot move tasks';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.place_task(c, p, s1, null);
    raise exception 'a viewer cannot reorder tasks';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.place_section(s1, null);
    raise exception 'a viewer cannot reorder sections';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.reindex_task_order(p, s1);
    raise exception 'a viewer cannot reindex';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999999', false) is not null as ok \gset

do $$
declare
  c uuid := (select id from be_ids where name = 'c');
  result jsonb;
begin
  result := public.bulk_update_tasks(array[c], '{"action": "delete"}');
  assert result -> 'skipped' -> 0 ->> 'reason' = 'Not found, or you don’t have access to it',
    format('non-member reason: %s', result);
  assert result -> 'skipped' -> 0 -> 'title' = 'null'::jsonb, 'a non-member never learns the title';
end $$;

-- The editor can bulk edit; the change is attributed to them.
select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset

do $$
declare
  c uuid := (select id from be_ids where name = 'c');
  d uuid := (select id from be_ids where name = 'd');
  result jsonb;
begin
  result := public.bulk_update_tasks(array[c, d], '{"action": "complete"}');
  assert jsonb_array_length(result -> 'updated') = 2, format('editor completes both: %s', result);
  assert (select count(*) from public.task_stories
          where task_id in (c, d) and kind = 'completed' and actor_id = '77777777-7777-4777-8777-777777777777') = 2,
    'stories name the editor';
end $$;

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

-- Reorder ----------------------------------------------------------------------------------------

do $$
declare
  p uuid := (select id from be_ids where name = 'p');
  s1 uuid := (select id from be_ids where name = 's1');
  s2 uuid := (select id from be_ids where name = 's2');
  t1 uuid;
  t2 uuid;
  t3 uuid;
  placed double precision;
  ordered uuid[];
begin
  t1 := (select id from be_ids where name = 'o1');
  t2 := (select id from be_ids where name = 'o2');
  t3 := (select id from be_ids where name = 'o3');
  s1 := (select id from be_ids where name = 's_order');
  update public.task_projects set sort_order = 1024 where task_id = t1 and project_id = p;
  update public.task_projects set sort_order = 2048 where task_id = t2 and project_id = p;
  update public.task_projects set sort_order = 3072 where task_id = t3 and project_id = p;

  -- Move 3 to the top: before 1.
  placed := public.place_task(t3, p, s1, t1);
  assert placed = 0, format('before the first = first - 1024: %s', placed);
  select array_agg(task_id order by sort_order) into ordered
  from public.task_projects where project_id = p and section_id = s1 and deleted_at is null;
  assert ordered = array[t3, t1, t2], 'order is 3, 1, 2';

  -- Move 3 between 1 and 2 (midpoint).
  placed := public.place_task(t3, p, s1, t2);
  assert placed = 1536, format('midpoint of 1024 and 2048: %s', placed);

  -- To the end.
  placed := public.place_task(t1, p, s1, null);
  select array_agg(task_id order by sort_order) into ordered
  from public.task_projects where project_id = p and section_id = s1 and deleted_at is null;
  assert ordered = array[t3, t2, t1], format('order is 3, 2, 1: %s', ordered);

  -- Across sections: before nothing in Doing = end of Doing, and a section_changed story.
  placed := public.place_task(t2, p, s2, null);
  assert (select section_id from public.task_projects where task_id = t2 and project_id = p) = s2, 't2 moved to Doing';
  assert placed > (select max(sort_order) from public.task_projects
                   where project_id = p and section_id = s2 and task_id <> t2), 'at the end of Doing';
  assert exists (select 1 from public.task_stories where task_id = t2 and kind = 'section_changed'), 'logged';
  placed := public.place_task(t2, p, s1, t1);  -- back, before t1

  -- Tiny gap: neighbours closer than min_order_gap() force a reindex of the section first.
  update public.task_projects set sort_order = 5 where task_id = t3 and project_id = p;
  update public.task_projects set sort_order = 5.0000000001 where task_id = t2 and project_id = p;
  update public.task_projects set sort_order = 9 where task_id = t1 and project_id = p;
  placed := public.place_task(t1, p, s1, t2);
  select array_agg(task_id order by sort_order) into ordered
  from public.task_projects where project_id = p and section_id = s1 and deleted_at is null;
  assert ordered = array[t3, t1, t2], format('t1 lands between t3 and t2 after a reindex: %s', ordered);
  assert (select sort_order from public.task_projects where task_id = t3 and project_id = p) = 1024,
    'the section was renumbered from 1024';
  assert placed = 1536, format('then the midpoint of the reindexed neighbours: %s', placed);

  -- Ties are reindexed too.
  update public.task_projects set sort_order = 7 where project_id = p and section_id = s1;
  placed := public.place_task(t2, p, s1, t1);
  assert (select count(distinct sort_order) from public.task_projects where project_id = p and section_id = s1) = 3,
    'ties are broken';
  assert (select sort_order from public.task_projects where task_id = t2 and project_id = p)
       < (select sort_order from public.task_projects where task_id = t1 and project_id = p), 't2 sits before t1';

  -- Reindex is idempotent.
  perform public.reindex_task_order(p, s1);
  assert public.reindex_task_order(p, s1) = 0, 'a second reindex changes nothing';

  -- Bad input.
  begin
    perform public.place_task(t1, p, s1, t1);
    raise exception 'placing a task before itself should fail';
  exception when check_violation then null;
  end;
  begin
    perform public.place_task(t1, p, s2, t3);
    raise exception 'the before-task must be in the target section';
  exception when check_violation then null;
  end;
  begin
    perform public.place_task((select id from be_ids where name = 'outsider'), p, s1, null);
    raise exception 'a task outside the project cannot be placed in it';
  exception when check_violation then null;
  end;
end $$;

do $$
declare
  p uuid := (select id from be_ids where name = 'p');
  s1 uuid := (select id from be_ids where name = 's1');
  s2 uuid := (select id from be_ids where name = 's2');
  s3 uuid := (select id from be_ids where name = 's_order');
  ordered uuid[];
begin
  -- Sections are Inbox (1024), Doing (2048), Ordering (4096). Move Ordering to the front.
  perform public.place_section(s3, s1);
  select array_agg(id order by sort_order) into ordered
  from public.sections where project_id = p and deleted_at is null;
  assert ordered = array[s3, s1, s2], format('Ordering, Inbox, Doing: %s', ordered);
  perform public.place_section(s3, null);
  select array_agg(id order by sort_order) into ordered
  from public.sections where project_id = p and deleted_at is null;
  assert ordered = array[s1, s2, s3], 'back to the end';
  update public.sections set sort_order = 1 where project_id = p;
  perform public.place_section(s3, s2);
  select array_agg(id order by sort_order) into ordered
  from public.sections where project_id = p and deleted_at is null;
  assert array_position(ordered, s3) = array_position(ordered, s2) - 1,
    format('tied sections are reindexed, then placed right before Doing: %s', ordered);
  assert (select count(distinct sort_order) from public.sections where project_id = p and deleted_at is null) = 3,
    'no ties remain';
end $$;

reset role;

do $$
begin
  assert not has_function_privilege('anon', 'public.bulk_update_tasks(uuid[], jsonb)', 'execute'), 'anon cannot bulk edit';
  assert not has_function_privilege('anon', 'public.place_task(uuid, uuid, uuid, uuid)', 'execute'), 'anon cannot reorder';
  assert has_function_privilege('authenticated', 'public.bulk_update_tasks(uuid[], jsonb)', 'execute'), 'members can';
  assert not (select prosecdef from pg_proc where proname = 'bulk_update_tasks'), 'bulk edit runs as the caller';
  assert not (select prosecdef from pg_proc where proname = 'place_task'), 'place_task runs as the caller';
end $$;

select 'bulk edit smoke: all assertions passed' as result;
