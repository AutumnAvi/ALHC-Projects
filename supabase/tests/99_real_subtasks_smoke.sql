-- Behavioural checks for Phase: Real subtasks: the data migration (old public.subtasks rows from
-- fixtures/before_20261006080000_real_subtasks.sql kept their id, completion, order, and approval link),
-- subtasks as tasks (root / home / no memberships), depth and cycle limits, access through the root task
-- only, the parent's custom fields, trash cascades, approval subtasks, rules and Req # skipping
-- subtasks, My Tasks / inbox / workload / search, and copies, recurrence, task templates, and imports
-- carrying subtask trees while staying muted. People from earlier suites:
--   5555… viewer@example.com    "Vera Viewer"
--   6666… commenter@example.com "Cora Commenter"
--   7777… editor@example.com    "Eddie Editor"
--   8888… admin@example.com     "Ada Admin"
--   9999… nonmember@example.com "Nora Nonmember"

\set ON_ERROR_STOP 1

create temporary table rs_ids (name text primary key, id uuid) on commit preserve rows;
grant all on rs_ids to authenticated, anon, service_role;

-- Data migration (as the database owner) -----------------------------------------------------------

do $$
declare
  parent uuid := 'f0f0f0f0-0000-4000-8000-0000000000b1';
  done_step uuid := 'f0f0f0f0-0000-4000-8000-0000000000c1';
  open_step uuid := 'f0f0f0f0-0000-4000-8000-0000000000c2';
  approval_step uuid := 'f0f0f0f0-0000-4000-8000-0000000000c3';
  removed_step uuid := 'f0f0f0f0-0000-4000-8000-0000000000c4';
begin
  assert (select count(*) from public.tasks where parent_task_id = parent) = 4, 'every old subtask is a child task';
  assert (select title = 'Done step' and completed_at = '2026-09-01T10:00:00Z' and subtask_order = 1024
            and root_task_id = parent and created_at = '2026-08-01T10:00:00Z'
          from public.tasks where id = done_step), 'same id, completion, order, and creation time';
  assert (select completed_at is null and subtask_order = 2048 from public.tasks where id = open_step), 'open stays open';
  assert (select deleted_at = '2026-08-15T10:00:00Z' from public.tasks where id = removed_step), 'soft deletion is kept';
  assert (select array_agg(title order by subtask_order) from public.tasks
          where parent_task_id = parent and deleted_at is null) = array['Done step', 'Approval', 'Open step'],
    'order is kept';
  assert (select home_project_id = 'f0f0f0f0-0000-4000-8000-0000000000a1'
            and workspace_id = '00000000-0000-4000-8000-000000000001'
          from public.tasks where id = open_step), 'home project and workspace follow the parent';
  assert not exists (select 1 from public.task_projects where task_id in (done_step, open_step, approval_step, removed_step)),
    'migrated subtasks get no project memberships';
  assert not exists (select 1 from public.task_stories where task_id in (done_step, open_step, approval_step, removed_step)),
    'the migration writes no activity';
  assert not exists (select 1 from public.inbox_items where task_id in (done_step, open_step, approval_step, removed_step)),
    'the migration notifies nobody';
  assert (select subtask_id from public.approval_requests where id = 'f0f0f0f0-0000-4000-8000-0000000000d1') = approval_step,
    'the approval still points at its subtask';
  assert (select confrelid = 'public.tasks'::regclass from pg_constraint where conname = 'approval_requests_subtask_id_fkey'),
    'approval_requests.subtask_id references tasks';
  assert (select count(*) from public.subtasks) = 4, 'the old table is kept (no DROP)';
  assert obj_description('public.subtasks'::regclass, 'pg_class') like 'Retired by Real subtasks%', 'and marked retired';
  assert not has_table_privilege('authenticated', 'public.subtasks', 'insert')
    and not has_table_privilege('authenticated', 'public.subtasks', 'update'), 'nobody writes the retired table';
  assert (select req_number is null from public.tasks where id = open_step), 'no Req #';

  -- An editor for the approval-subtask check below (suite 60's backfill may already have added one).
  if not exists (select 1 from public.project_members where project_id = 'f0f0f0f0-0000-4000-8000-0000000000a1'
                 and profile_id = '77777777-7777-4777-8777-777777777777' and deleted_at is null) then
    insert into public.project_members (project_id, profile_id, role)
    values ('f0f0f0f0-0000-4000-8000-0000000000a1', '77777777-7777-4777-8777-777777777777', 'editor');
  end if;
end $$;

set role authenticated;

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
begin
  begin
    update public.tasks set completed_at = now() where id = 'f0f0f0f0-0000-4000-8000-0000000000c3';
    raise exception 'a migrated approval subtask still completes by deciding';
  exception when check_violation then null;
  end;
  update public.tasks set completed_at = now() where id = 'f0f0f0f0-0000-4000-8000-0000000000c2';
  assert (select completed_at is not null from public.tasks where id = 'f0f0f0f0-0000-4000-8000-0000000000c2'),
    'an ordinary migrated subtask can be ticked';
end $$;

-- Subtasks are tasks: root, home, depth, cycles ----------------------------------------------------

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid;
  q uuid;
  t uuid;
  t2 uuid;
  s1 uuid;
  s2 uuid;
  s3 uuid;
  s4 uuid;
  x1 uuid;
  x2 uuid;
  x3 uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Subtasks') returning id into p;
  insert into public.projects (workspace_id, name) values (ws, 'Elsewhere') returning id into q;
  insert into rs_ids values ('p', p), ('q', q);
  perform public.add_project_member(p, 'commenter@example.com', 'commenter');
  perform public.add_project_member(p, 'viewer@example.com', 'viewer');

  t := public.create_task(p, null, 'Launch kit');
  s1 := public.create_subtask(t, 'Step one');
  s2 := public.create_subtask(s1, 'Step two');
  s3 := public.create_subtask(s2, 'Step three');
  s4 := public.create_subtask(s3, 'Step four');
  insert into rs_ids values ('t', t), ('s1', s1), ('s2', s2), ('s3', s3), ('s4', s4);

  assert (select bool_and(root_task_id = t and home_project_id = p) from public.tasks where id in (s1, s2, s3, s4)),
    'every level resolves to the root task and its home project';
  assert (select parent_task_id from public.tasks where id = s4) = s3, 'sub-subtasks nest';
  assert not exists (select 1 from public.task_projects where task_id in (s1, s2, s3, s4)), 'subtasks have no memberships';
  assert (select count(*) from public.filter_project_tasks(p, '{"completion": "all"}', 'UTC')) = 1,
    'views list the task, not its subtasks';

  begin
    perform public.create_subtask(s4, 'Step five');
    raise exception 'depth is limited to 4';
  exception when check_violation then null;
  end;
  begin
    insert into public.task_projects (task_id, project_id, sort_order) values (s1, p, 1);
    raise exception 'subtasks never get their own memberships';
  exception when check_violation then null;
  end;
  begin
    update public.tasks set parent_task_id = s3 where id = s1;
    raise exception 'cycles are rejected';
  exception when check_violation then null;
  end;
  begin
    update public.tasks set parent_task_id = s1 where id = s1;
    raise exception 'a task is not its own subtask';
  exception when check_violation then null;
  end;
  begin
    update public.tasks set parent_task_id = null where id = s1;
    raise exception 'a subtask does not become a task';
  exception when check_violation then null;
  end;

  -- Moving a subtree to another task carries the root along; the depth limit counts the subtree.
  t2 := public.create_task(p, null, 'Second task');
  insert into rs_ids values ('t2', t2);
  begin
    update public.tasks set parent_task_id = t where id = t2;
    raise exception 'a task does not become a subtask';
  exception when check_violation then null;
  end;
  x1 := public.create_subtask(t2, 'X1');
  x2 := public.create_subtask(x1, 'X2');
  x3 := public.create_subtask(x2, 'X3');
  begin
    perform public.place_subtask(s3, null, x3);
    raise exception 'a moved subtree must fit the depth limit';
  exception when check_violation then null;
  end;
  perform public.place_subtask(s3, null, x1);
  assert (select parent_task_id = x1 and root_task_id = t2 from public.tasks where id = s3), 'moved under X1';
  assert (select root_task_id from public.tasks where id = s4) = t2, 'its subtasks follow the new root';
  perform public.place_subtask(s3, null, s2);
  assert (select root_task_id from public.tasks where id = s4) = t, 'and back';

  -- Ordering among siblings.
  perform public.create_subtask(t, 'Step zero', s1);
  assert (select array_agg(title order by subtask_order) from public.tasks where parent_task_id = t and deleted_at is null)
    = array['Step zero', 'Step one'], 'inserted before a sibling';
  perform public.place_subtask((select id from public.tasks where parent_task_id = t and title = 'Step zero'), null);
  assert (select array_agg(title order by subtask_order) from public.tasks where parent_task_id = t and deleted_at is null)
    = array['Step one', 'Step zero'], 'moved to the end';

  -- Custom fields: the root task's projects' fields only.
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Points', 'number');
  insert into public.custom_fields (project_id, name, field_type) values (q, 'Other', 'number');
  insert into public.task_field_values (task_id, field_id, value)
  values (s2, (select id from public.custom_fields where project_id = p and name = 'Points'), '5');
  begin
    insert into public.task_field_values (task_id, field_id, value)
    values (s2, (select id from public.custom_fields where project_id = q and name = 'Other'), '1');
    raise exception 'a field of another project is rejected';
  exception when check_violation then null;
  end;
end $$;

-- Access: through the root task's projects only -----------------------------------------------------

select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999999', false) is not null as ok \gset
do $$
declare
  affected integer;
begin
  assert not exists (select 1 from public.tasks where id in (select id from rs_ids where name in ('s1', 's2', 's3', 's4'))),
    'non-members cannot see subtasks';
  assert not public.has_task_role((select id from rs_ids where name = 's4'), 'viewer'), 'nor have a role on them';
  assert not exists (select 1 from public.search_tasks('Step', 50) where id in (select id from rs_ids)), 'nor find them';
  update public.tasks set title = 'hijack' where id = (select id from rs_ids where name = 's1');
  get diagnostics affected = row_count;
  assert affected = 0, 'nor change them';
end $$;

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
declare
  affected integer;
begin
  assert (select count(*) from public.tasks where id in (select id from rs_ids where name in ('s1', 's2', 's3', 's4'))) = 4,
    'viewers of the root read every level';
  assert public.task_role((select id from rs_ids where name = 's4')) = 'viewer', 'with their project role';
  update public.tasks set title = 'nope' where id = (select id from rs_ids where name = 's1');
  get diagnostics affected = row_count;
  assert affected = 0, 'viewers cannot edit subtasks';
  begin
    perform public.create_subtask((select id from rs_ids where name = 't'), 'Nope');
    raise exception 'viewers cannot add subtasks';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Removing the root from a project removes access to its subtasks: multi-home the root into Q, then
-- check a Q-only member sees the subtasks only while the root is in Q.
select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
begin
  perform public.add_project_member((select id from rs_ids where name = 'q'), 'admin@example.com', 'viewer');
  insert into public.task_projects (task_id, project_id, sort_order)
  values ((select id from rs_ids where name = 't'), (select id from rs_ids where name = 'q'), 1024);
end $$;

select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset
do $$
begin
  assert exists (select 1 from public.tasks where id = (select id from rs_ids where name = 's4')),
    'a member of another project of the root task reads its subtasks';
end $$;

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
begin
  update public.task_projects set deleted_at = now()
  where task_id = (select id from rs_ids where name = 't') and project_id = (select id from rs_ids where name = 'q');
end $$;

select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.tasks where id = (select id from rs_ids where name = 's4')),
    'and loses them with the root task''s membership';
end $$;

-- Collaboration on subtasks: comments, assignment, My Tasks, inbox, workload, search ----------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  s1 uuid := (select id from rs_ids where name = 's1');
  pf uuid;
begin
  update public.tasks set assignee_id = '66666666-6666-4666-8666-666666666666', start_on = '2026-11-02', due_on = '2026-11-04'
  where id = s1;
  assert exists (select 1 from public.task_stories where task_id = s1 and kind = 'assigned'), 'assignment is in the activity';
  assert exists (select 1 from public.project_workload((select id from rs_ids where name = 'p'))
                 where task_id = s1 and assignee_id = '66666666-6666-4666-8666-666666666666'),
    'subtasks count in the project workload';

  insert into public.portfolios (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'Subtask portfolio')
  returning id into pf;
  perform public.add_portfolio_project(pf, (select id from rs_ids where name = 'p'));
  assert exists (select 1 from public.portfolio_workload(pf) where task_id = s1), 'and in the portfolio workload';

  assert exists (select 1 from public.search_tasks('Step one', 50) where id = s1 and home_project_id = (select id from rs_ids where name = 'p')),
    'search finds subtasks, labelled with the root task''s project';
end $$;

select set_config('request.jwt.claim.sub', '66666666-6666-4666-8666-666666666666', false) is not null as ok \gset
do $$
declare
  s1 uuid := (select id from rs_ids where name = 's1');
begin
  assert exists (select 1 from public.inbox_items where task_id = s1 and kind = 'assigned'
                 and recipient_id = '66666666-6666-4666-8666-666666666666'), 'the assignee is notified in the inbox';
  assert exists (select 1 from public.tasks where assignee_id = '66666666-6666-4666-8666-666666666666' and id = s1),
    'the subtask is in the assignee''s My Tasks';
  assert exists (select 1 from public.my_tasks_layout() where task_id = s1), 'and placed in their My Tasks sections';
  insert into public.comments (task_id, body) values (s1, 'On it @Eddie Editor');
end $$;

-- Trash cascade --------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
begin
  assert exists (select 1 from public.inbox_items where task_id = (select id from rs_ids where name = 's1')
                 and kind = 'mention' and recipient_id = '77777777-7777-4777-8777-777777777777'),
    'commenters comment on subtasks, and mentions notify';
end $$;

do $$
declare
  t2 uuid := (select id from rs_ids where name = 't2');
  x1 uuid := (select id from public.tasks where parent_task_id = t2 and title = 'X1');
  x2 uuid := (select id from public.tasks where parent_task_id = x1);
  lone uuid;
begin
  lone := public.create_subtask(t2, 'Deleted on its own');
  update public.tasks set deleted_at = now() - interval '1 minute' where id = lone;
  update public.tasks set deleted_at = now() where id = t2;
  assert (select bool_and(deleted_at = (select deleted_at from public.tasks where id = t2))
          from public.tasks where id in (x1, x2)), 'trashing a task trashes its subtasks';
  begin
    perform public.restore_task(x2);
    raise exception 'a subtask cannot come back while its parent is trashed';
  exception when check_violation then null;
  end;
  perform public.restore_task(t2);
  assert (select bool_and(deleted_at is null) from public.tasks where id in (t2, x1, x2)), 'restoring brings them back';
  assert (select deleted_at is not null from public.tasks where id = lone), 'one trashed earlier stays in the Trash';
end $$;

-- Approval subtasks ----------------------------------------------------------------------------------

do $$
declare
  t uuid := (select id from rs_ids where name = 't');
  a uuid;
  sub uuid;
begin
  a := public.request_approval(t, '66666666-6666-4666-8666-666666666666', 'Check it', true, 'Sign-off');
  sub := (select subtask_id from public.approval_requests where id = a);
  insert into rs_ids values ('approval', a), ('approval_sub', sub);
  assert (select parent_task_id = t and title = 'Sign-off' from public.tasks where id = sub), 'the approval subtask is a child task';
  begin
    update public.tasks set completed_at = now() where id = sub;
    raise exception 'approval subtasks complete by deciding';
  exception when check_violation then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '66666666-6666-4666-8666-666666666666', false) is not null as ok \gset
do $$
begin
  perform public.decide_approval((select id from rs_ids where name = 'approval'), 'approved', 'Fine');
end $$;

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  sub uuid := (select id from rs_ids where name = 'approval_sub');
begin
  assert (select completed_at is not null from public.tasks where id = sub), 'approving completes the approval subtask';
  assert not exists (select 1 from public.inbox_items where task_id = sub and kind = 'completed'),
    'one inbox item per event: no completed item on top of approval_decided';
  assert exists (select 1 from public.inbox_items where task_id = (select id from rs_ids where name = 't')
                 and kind = 'approval_decided' and recipient_id = '77777777-7777-4777-8777-777777777777'),
    'the requester hears about the decision';
end $$;

-- Rules and Req # skip subtasks ----------------------------------------------------------------------

do $$
declare
  p uuid := (select id from rs_ids where name = 'p');
  t uuid := (select id from rs_ids where name = 't');
  s uuid;
  top uuid;
begin
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (p, 'Hello', true, 'task_created', '[{"type": "add_comment", "body": "Hello"}]');
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (p, 'Assigned', true, 'assignee_changed', '[{"type": "add_comment", "body": "Assigned"}]');
  insert into public.request_sequences (project_id, enabled, assign_to, add_to_title) values (p, true, 'all_tasks', true);
  s := public.create_subtask(t, 'Quiet subtask');
  update public.tasks set assignee_id = '77777777-7777-4777-8777-777777777777' where id = s;
  insert into rs_ids values ('quiet', s);
  top := public.create_task(p, null, 'Numbered task');
  insert into rs_ids values ('numbered', top);
  assert (select req_number is null and title = 'Quiet subtask' from public.tasks where id = s), 'subtasks get no Req #';
  assert (select req_number is not null from public.tasks where id = top), 'tasks still do';
  begin
    perform public.assign_request_number(s);
    raise exception 'subtasks are not numbered on demand either';
  exception when check_violation then null;
  end;
end $$;

-- task_created rules fire at commit, so check in a later transaction.
do $$
begin
  assert not exists (select 1 from public.rule_runs where task_id = (select id from rs_ids where name = 'quiet')),
    'rules skip subtasks';
  assert not exists (select 1 from public.comments where task_id = (select id from rs_ids where name = 'quiet')), 'no rule comment';
  assert exists (select 1 from public.rule_runs where task_id = (select id from rs_ids where name = 'numbered')),
    'rules still run for tasks';
end $$;

-- Copies, task templates, and recurrence carry subtasks (quietly) ---------------------------------

do $$
declare
  p uuid := (select id from rs_ids where name = 'p');
  t uuid := (select id from rs_ids where name = 't');
  copy jsonb;
  np uuid;
  nt uuid;
  ns1 uuid;
  tt uuid;
  ft uuid;
begin
  update public.request_sequences set enabled = false where project_id = p;
  copy := public.duplicate_project(p, 'Subtasks copy', '{"members": true}');
  np := (copy ->> 'project_id')::uuid;
  insert into rs_ids values ('copy', np);
  nt := (select x.id from public.tasks x join public.task_projects tp on tp.task_id = x.id and tp.project_id = np
         where x.title = 'Launch kit');
  ns1 := (select id from public.tasks where parent_task_id = nt and title = 'Step one');
  assert ns1 is not null, 'the copy has the subtasks';
  assert (select assignee_id = '66666666-6666-4666-8666-666666666666' and due_on = '2026-11-04' and start_on = '2026-11-02'
          from public.tasks where id = ns1), 'with assignee and dates';
  assert (select title from public.tasks where parent_task_id =
           (select id from public.tasks where parent_task_id = (select id from public.tasks where parent_task_id = ns1)))
         = 'Step four', 'nested levels are copied';
  assert (select value from public.task_field_values v join public.custom_fields f on f.id = v.field_id
          where v.task_id = (select id from public.tasks where parent_task_id = ns1) and f.project_id = np) = '5',
    'subtask field values are copied with the field';
  assert not exists (select 1 from public.tasks where parent_task_id = nt and title = 'Sign-off'),
    'approval subtasks are not copied';
  assert (copy ->> 'subtasks')::integer >= 5, format('the copy counts subtasks: %s', copy);
  assert not exists (select 1 from public.task_stories s join public.tasks x on x.id = s.task_id
                     where x.root_task_id = nt), 'copies write no subtask activity';
  assert not exists (select 1 from public.inbox_items i join public.tasks x on x.id = i.task_id
                     where x.root_task_id = nt), 'and notify nobody';

  tt := public.save_task_as_template(t, p, 'Kit template');
  assert (select subtasks from public.task_templates where id = tt) ? 'Step one', 'task templates keep subtask titles';
  ft := public.create_task_from_template(tt, null, 'From template');
  assert exists (select 1 from public.tasks where parent_task_id = ft and title = 'Step one' and completed_at is null),
    'and create them as subtasks';
end $$;

do $$
begin
  assert not exists (select 1 from public.rule_runs r join public.tasks x on x.id = r.task_id
                     where x.root_task_id = (select x2.id from public.tasks x2
                       join public.task_projects tp on tp.task_id = x2.id and tp.project_id = (select id from rs_ids where name = 'copy')
                       where x2.title = 'Launch kit')), 'copies fire no rules for subtasks';
end $$;

do $$
declare
  p uuid := (select id from rs_ids where name = 'p');
  r uuid;
  s uuid;
  nxt uuid;
begin
  r := public.create_task(p, null, 'Weekly review');
  update public.tasks set due_on = '2026-11-06', recurrence = '{"freq": "weekly", "timezone": "UTC"}' where id = r;
  s := public.create_subtask(r, 'Gather notes');
  update public.tasks set due_on = '2026-11-05', assignee_id = '77777777-7777-4777-8777-777777777777',
    completed_at = now() where id = s;
  perform public.create_subtask(s, 'Nested note');
  update public.tasks set completed_at = now() where id = r;
  nxt := (select recurrence_next_id from public.tasks where id = r);
  assert nxt is not null, 'the next occurrence spawns';
  assert (select due_on = '2026-11-12' and completed_at is null and assignee_id = '77777777-7777-4777-8777-777777777777'
          from public.tasks where parent_task_id = nxt and title = 'Gather notes'),
    'its subtasks are copied open with dates shifted';
  assert exists (select 1 from public.tasks where root_task_id = nxt and title = 'Nested note'), 'nested ones too';
end $$;

-- Imports: nested subtasks up to the depth limit, muted ---------------------------------------------

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  q uuid;
  run uuid;
  result jsonb;
  it uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Imported subtasks') returning id into q;
  insert into rs_ids values ('iq', q);
  perform public.add_project_member(q, 'commenter@example.com', 'commenter');
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (q, 'Hello', true, 'task_created', '[{"type": "add_comment", "body": "Hello"}]');
  run := public.start_import_run(q, 'asana', array['nested.json']);
  result := public.import_batch(run, $json$
  {
    "project": {"gid": "nest-proj", "name": "Nested"},
    "tasks": [
      {"gid": "n1", "title": "Brochure",
       "subtasks": [
         {"gid": "n1-1", "title": "Copy", "assignee_email": "commenter@example.com", "due_on": "2026-11-20",
          "notes": "Draft first", "completed_at": "2026-10-01T10:00:00Z",
          "subtasks": [
            {"gid": "n1-1-1", "title": "Level 2",
             "subtasks": [
               {"gid": "n1-1-1-1", "title": "Level 3",
                "subtasks": [
                  {"gid": "n1-1-1-1-1", "title": "Level 4",
                   "subtasks": [{"gid": "n1-1-1-1-1-1", "title": "Level 5 (flattened)"}]}]}]}]},
         {"gid": "n1-2", "title": "Photos", "assignee_email": "stranger@example.com", "assignee_name": "Stan"}
       ]}
    ]
  }
  $json$::jsonb);
  perform public.finish_import_run(run, 'completed');
  assert (result ->> 'subtasks')::integer = 6, format('every subtask is imported: %s', result);
  it := (select id from public.tasks where home_project_id = q and parent_task_id is null and title = 'Brochure');
  assert (select assignee_id = '66666666-6666-4666-8666-666666666666' and due_on = '2026-11-20' and notes = 'Draft first'
            and completed_at = '2026-10-01T10:00:00Z' and source = 'import'
          from public.tasks where parent_task_id = it and title = 'Copy'), 'subtask details are kept';
  assert (select notes like '%Assignee in Asana: Stan <stranger@example.com>%' and assignee_id is null
          from public.tasks where parent_task_id = it and title = 'Photos'), 'unmatched assignees are noted';
  assert (select x.parent_task_id = y.parent_task_id
          from public.tasks x, public.tasks y
          where x.root_task_id = it and x.title = 'Level 5 (flattened)' and y.root_task_id = it and y.title = 'Level 4'),
    'levels past the limit are flattened into the deepest one';
  assert not exists (select 1 from public.inbox_items i join public.tasks x on x.id = i.task_id where x.root_task_id = it),
    'imports notify nobody about subtasks';
  assert not exists (select 1 from public.task_stories s join public.tasks x on x.id = s.task_id
                     where x.root_task_id = it and (s.kind <> 'created' or not s.data ? 'import')),
    'imported subtasks only get the tagged created story';

  -- Idempotent: running the same batch again adds nothing.
  run := public.start_import_run(q, 'asana', array['nested.json']);
  result := public.import_batch(run, $json$
  {"tasks": [{"gid": "n1", "title": "Brochure", "subtasks": [{"gid": "n1-1", "title": "Copy",
     "subtasks": [{"gid": "n1-1-new", "title": "Late addition"}]}]}]}
  $json$::jsonb);
  perform public.finish_import_run(run, 'completed');
  assert (result ->> 'subtasks')::integer = 1, format('only the new nested subtask is added: %s', result);
  assert exists (select 1 from public.tasks x join public.tasks y on y.id = x.parent_task_id
                 where x.title = 'Late addition' and y.title = 'Copy' and x.root_task_id = it), 'under its imported parent';
end $$;

do $$
begin
  assert not exists (select 1 from public.rule_runs r join public.tasks x on x.id = r.task_id
                     where x.home_project_id = (select id from rs_ids where name = 'iq')), 'imports fire no rules';
end $$;

reset role;

-- EXECUTE surface: nothing new for anon; no new SECURITY DEFINER function --------------------------

do $$
begin
  assert not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.proname in ('create_subtask', 'place_subtask', 'guard_task_parent', 'cascade_task_to_subtasks',
        'guard_task_project_subtask', 'subtask_height', 'subtask_max_depth', 'reindex_subtask_order',
        'subtask_order_before', 'snapshot_subtasks', 'snapshot_task_fields', 'instantiate_subtasks',
        'instantiate_task_fields', 'copy_subtask_tree', 'import_subtasks')
  ), 'every new function is SECURITY INVOKER';
  assert not has_function_privilege('anon', 'public.create_subtask(uuid, text, uuid)', 'execute'), 'anon cannot add subtasks';
  assert not has_function_privilege('authenticated', 'public.copy_subtask_tree(uuid, uuid, integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.import_subtasks(uuid, text, uuid, uuid, jsonb, integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.instantiate_subtasks(uuid, jsonb, date, jsonb, uuid, uuid, integer)', 'execute'),
    'internal copy helpers are revoked from clients';
end $$;

select 'real subtasks smoke: all assertions passed' as result;
