-- Behavioural checks for Phase: Scheduling depth and polish: dependency kind and lag (bounds, cycles,
-- start-to-start never blocks), dependencies between subtasks and across projects (Editor on both tasks;
-- reading needs both tasks; stories never leak a title), the critical path with lag and kind, auto-shift
-- (preview, skipped tasks, confirmed apply, Undo), converting a task into a subtask and back, tag
-- stories, approval decisions (only the approver, Commenter+), the saved "Show subtasks" view setting,
-- copies keeping kind and lag, workspace admins getting nothing extra, and anon getting nothing.
-- Fresh people for this suite (no memberships from earlier suites):
--   e3e3…01 sched-owner@example.com    owner of Sched P, Sched Q, Sched R, Sched CP1, Sched CP2
--   e3e3…02 sched-editor@example.com   Editor of P, Viewer of Q, not in R
--   e3e3…03 sched-viewer@example.com   Viewer of P
--   e3e3…04 sched-qonly@example.com    Editor of Q only

\set ON_ERROR_STOP 1

create temporary table sc_ids (name text primary key, id uuid) on commit preserve rows;
grant all on sc_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('sched-owner@example.com', 'scheduling suite'),
  ('sched-editor@example.com', 'scheduling suite'),
  ('sched-viewer@example.com', 'scheduling suite'),
  ('sched-qonly@example.com', 'scheduling suite');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e3e3e3e3-0000-4000-8000-000000000001', 'sched-owner@example.com', now(), '{"full_name":"Sam Owner"}'),
  ('e3e3e3e3-0000-4000-8000-000000000002', 'sched-editor@example.com', now(), '{"full_name":"Eddie Editor"}'),
  ('e3e3e3e3-0000-4000-8000-000000000003', 'sched-viewer@example.com', now(), '{"full_name":"Val Viewer"}'),
  ('e3e3e3e3-0000-4000-8000-000000000004', 'sched-qonly@example.com', now(), '{"full_name":"Quinn Qonly"}');

insert into sc_ids values
  ('owner', 'e3e3e3e3-0000-4000-8000-000000000001'),
  ('editor', 'e3e3e3e3-0000-4000-8000-000000000002'),
  ('viewer', 'e3e3e3e3-0000-4000-8000-000000000003'),
  ('qonly', 'e3e3e3e3-0000-4000-8000-000000000004'),
  ('admin', (select profile_id from public.workspace_admins where deleted_at is null order by created_at limit 1));

do $$
begin
  assert (select id from sc_ids where name = 'admin') is not null, 'an earlier suite left a workspace admin';
end $$;

-- Owner: projects, tasks, links ----------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'e3e3e3e3-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid;
  q uuid;
  r uuid;
  doing uuid;
  a uuid;
  b uuid;
  c uuid;
  q1 uuid;
  dep uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Sched P') returning id into p;
  insert into public.projects (workspace_id, name) values (ws, 'Sched Q') returning id into q;
  insert into public.projects (workspace_id, name) values (ws, 'Sched R') returning id into r;
  insert into public.sections (project_id, name, sort_order) values (p, 'Doing', 1024) returning id into doing;
  perform public.add_project_member(p, 'sched-editor@example.com', 'editor');
  perform public.add_project_member(p, 'sched-viewer@example.com', 'commenter');
  perform public.add_project_member(q, 'sched-editor@example.com', 'viewer');
  perform public.add_project_member(q, 'sched-qonly@example.com', 'editor');

  a := public.create_task(p, doing, 'Draft copy');
  b := public.create_task(p, doing, 'Review copy');
  c := public.create_task(p, doing, 'Print copy');
  q1 := public.create_task(q, null, 'Book the printer');
  insert into sc_ids values ('p', p), ('q', q), ('r', r), ('doing', doing), ('a', a), ('b', b), ('c', c), ('q1', q1);

  -- Kind and lag, stored and validated.
  dep := public.set_task_dependency(a, b, 'finish_to_start', 2);
  insert into sc_ids values ('d_ab', dep);
  assert (select kind = 'finish_to_start' and lag_days = 2 from public.task_dependencies where id = dep), 'kind and lag stored';
  assert public.set_task_dependency(a, b, 'finish_to_start', 2) = dep, 'setting the same link again is a no-op';
  begin
    perform public.set_task_dependency(a, c, 'finish_to_start', 366);
    raise exception 'lag is bounded';
  exception when check_violation then null;
  end;
  begin
    perform public.set_task_dependency(a, c, 'finish_to_finish', 0);
    raise exception 'unknown kinds are rejected';
  exception when check_violation then null;
  end;
  begin
    perform public.set_task_dependency(a, a, 'finish_to_start', 0);
    raise exception 'a task can''t depend on itself';
  exception when check_violation then null;
  end;
  perform public.set_task_dependency(b, c, 'start_to_start', -1);
  begin
    perform public.set_task_dependency(c, a, 'start_to_start', 0);
    raise exception 'cycles are rejected whatever the kind';
  exception when check_violation then null;
  end;
  begin
    insert into public.task_dependencies (project_id, predecessor_id, successor_id) values (p, c, a);
    raise exception 'direct inserts are refused';
  exception when insufficient_privilege then null;
  end;

  -- Cross-project: the owner edits both tasks.
  dep := public.set_task_dependency(q1, a, 'finish_to_start', 0);
  insert into sc_ids values ('d_q1a', dep);
  assert (select project_id from public.task_dependencies where id = dep) = p,
    'a link with no shared project is recorded on the successor''s home project';
end $$;

-- Story data: titles only when every reader of the story's task can read the other task.
do $$
declare
  a uuid := (select id from sc_ids where name = 'a');
  b uuid := (select id from sc_ids where name = 'b');
  q1 uuid := (select id from sc_ids where name = 'q1');
begin
  assert exists (select 1 from public.task_stories where task_id = b and kind = 'dependency_added'
                 and data ->> 'task_title' = 'Draft copy' and (data ->> 'lag_days')::int = 2
                 and data ->> 'kind' = 'finish_to_start'), 'same-project stories name the other task, with kind and lag';
  assert exists (select 1 from public.task_stories where task_id = q1 and kind = 'dependency_added'
                 and data ->> 'task_id' = a::text and not data ? 'task_title'),
    'a cross-project story on Q''s task doesn''t carry the P task''s title';
  assert exists (select 1 from public.task_stories where task_id = a and kind = 'dependency_added'
                 and data ->> 'task_id' = q1::text and not data ? 'task_title'),
    'nor the other way round';

  -- Changing kind / lag keeps the row and logs it.
  assert public.set_task_dependency(a, b, 'start_to_start', 1) = (select id from sc_ids where name = 'd_ab'),
    'changing kind and lag keeps the link';
  assert (select kind = 'start_to_start' and lag_days = 1 from public.task_dependencies
          where id = (select id from sc_ids where name = 'd_ab')), 'kind and lag changed';
  assert exists (select 1 from public.task_stories where task_id = b and kind = 'dependency_changed'
                 and data ->> 'from_kind' = 'finish_to_start' and (data ->> 'from_lag_days')::int = 2),
    'the change is logged with the old values';
end $$;

-- Blocking: finish-to-start blocks completion, start-to-start never does.
do $$
declare
  a uuid := (select id from sc_ids where name = 'a');
  b uuid := (select id from sc_ids where name = 'b');
  c uuid := (select id from sc_ids where name = 'c');
  q1 uuid := (select id from sc_ids where name = 'q1');
begin
  assert public.open_blocker_count(b) = 0, 'a start-to-start predecessor doesn''t block (a → b is SS now)';
  update public.tasks set completed_at = now() where id = b;
  assert (select completed_at is not null from public.tasks where id = b), 'b completes while a is open';
  update public.tasks set completed_at = null where id = b;
  assert public.open_blocker_count(a) = 1, 'a waits on q1 (finish-to-start, another project)';
  begin
    update public.tasks set completed_at = now() where id = a;
    raise exception 'a cross-project finish-to-start predecessor blocks';
  exception when check_violation then null;
  end;
  assert public.open_blocker_count(c) = 0, 'b → c is start-to-start';
end $$;

-- Subtasks: links between subtasks, access through the root.
do $$
declare
  a uuid := (select id from sc_ids where name = 'a');
  c uuid := (select id from sc_ids where name = 'c');
  s1 uuid;
  s2 uuid;
begin
  s1 := public.create_subtask(a, 'Draft headline');
  s2 := public.create_subtask(c, 'Print proof');
  insert into sc_ids values ('s1', s1), ('s2', s2);
  insert into sc_ids values ('d_s', public.set_task_dependency(s1, s2, 'finish_to_start', 0));
  assert public.open_blocker_count(s2) = 1, 'a subtask can wait on another subtask';
end $$;

-- Editor of P (Viewer of Q) --------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'e3e3e3e3-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  a uuid := (select id from sc_ids where name = 'a');
  c uuid := (select id from sc_ids where name = 'c');
  q1 uuid := (select id from sc_ids where name = 'q1');
begin
  assert exists (select 1 from public.task_dependencies where id = (select id from sc_ids where name = 'd_q1a')),
    'someone who reads both tasks reads the cross-project link';
  begin
    perform public.set_task_dependency(q1, c, 'finish_to_start', 0);
    raise exception 'a cross-project link needs Editor on both tasks';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.remove_task_dependency((select id from sc_ids where name = 'd_q1a'));
    raise exception 'removing a cross-project link needs Editor on both tasks';
  exception when insufficient_privilege then null;
  end;
  assert exists (select 1 from public.task_dependencies where id = (select id from sc_ids where name = 'd_s')),
    'project members read links between subtasks of their tasks';
end $$;

-- Q-only editor: can't see the P side ---------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'e3e3e3e3-0000-4000-8000-000000000004', false) is not null as ok \gset

do $$
declare
  q1 uuid := (select id from sc_ids where name = 'q1');
begin
  assert exists (select 1 from public.tasks where id = q1), 'Q''s editor reads Q''s task';
  assert not exists (select 1 from public.task_dependencies where predecessor_id = q1 or successor_id = q1),
    'but not the link to a task they can''t read';
  assert not exists (select 1 from public.tasks where id = (select id from sc_ids where name = 'a')),
    'nor the other task';
  assert not exists (select 1 from public.task_stories where task_id = q1 and data ? 'task_title'
                     and data ->> 'task_title' = 'Draft copy'), 'nor its title through activity';
  assert not exists (select 1 from public.task_dependencies), 'no links at all from P';
  assert (select count(*) from public.preview_dependency_shift(q1, '2026-12-01', '2026-12-02')) = 0,
    'auto-shift never names a task they can''t read';
  begin
    perform public.set_task_dependency(q1, (select id from sc_ids where name = 'c'), 'finish_to_start', 0);
    raise exception 'an unreadable task can''t be linked';
  exception when no_data_found then null;
  end;
  begin
    perform public.remove_task_dependency((select id from sc_ids where name = 'd_q1a'));
    raise exception 'an unreadable link can''t be removed';
  exception when no_data_found then null;
  end;
end $$;

-- Critical path with lag and kind --------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'e3e3e3e3-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  cp1 uuid;
  cp2 uuid;
  x uuid;
  y uuid;
begin
  -- FS lag 2: x 11-01..11-02, y 11-05..11-06. Latest finish of x = 11-06 - 1 (y) - 2 (lag) = 11-03: slack 1.
  insert into public.projects (workspace_id, name) values (ws, 'Sched CP1') returning id into cp1;
  x := public.create_task(cp1, null, 'CP1 x');
  y := public.create_task(cp1, null, 'CP1 y');
  update public.tasks set start_on = '2026-11-01', due_on = '2026-11-02' where id = x;
  update public.tasks set start_on = '2026-11-05', due_on = '2026-11-06' where id = y;
  perform public.set_task_dependency(x, y, 'finish_to_start', 2);
  assert (select slack_days from public.project_critical_path(cp1) where task_id = x) = 1, 'FS lag counts in slack';
  assert (select slack_days from public.project_critical_path(cp1) where task_id = y) = 0, 'the last task is critical';

  -- SS lag 2: x 11-01..11-02 (1 day), y 11-03..11-05. Latest start of x = 11-03 - 2 = 11-01: slack 0.
  -- (Finish-to-start with the same lag would make it -1.)
  insert into public.projects (workspace_id, name) values (ws, 'Sched CP2') returning id into cp2;
  x := public.create_task(cp2, null, 'CP2 x');
  y := public.create_task(cp2, null, 'CP2 y');
  update public.tasks set start_on = '2026-11-01', due_on = '2026-11-02' where id = x;
  update public.tasks set start_on = '2026-11-03', due_on = '2026-11-05' where id = y;
  perform public.set_task_dependency(x, y, 'start_to_start', 2);
  assert (select slack_days from public.project_critical_path(cp2) where task_id = x) = 0
    and (select critical from public.project_critical_path(cp2) where task_id = x), 'SS lag: x is critical';
  perform public.set_task_dependency(x, y, 'finish_to_start', 2);
  assert (select slack_days from public.project_critical_path(cp2) where task_id = x) = -1, 'FS lag: x is a day behind';
  perform public.set_task_dependency(x, y, 'start_to_start', 2);
  insert into sc_ids values ('cp2', cp2);

  assert (select count(*) from public.project_dependencies(cp2)) = 1, 'project_dependencies lists the link';
  assert (select kind from public.project_dependencies(cp2)) = 'start_to_start', 'with its kind';
  assert (select count(*) from public.project_dependencies((select id from sc_ids where name = 'p'))) = 2,
    'only links with both tasks in the project (a→b, b→c; not q1→a, not the subtask link)';
end $$;

-- Copies keep kind and lag.
do $$
declare
  result jsonb;
  np uuid;
begin
  result := public.duplicate_project((select id from sc_ids where name = 'cp2'), 'Sched CP2 copy', '{}'::jsonb);
  np := (result ->> 'project_id')::uuid;
  assert (select kind = 'start_to_start' and lag_days = 2 from public.task_dependencies
          where project_id = np and deleted_at is null), 'Duplicate project keeps the link''s kind and lag';
end $$;

-- Auto-shift -----------------------------------------------------------------------------------------
-- t1 (11-01..11-02) ─FS 0→ t2 (11-03..11-04) ─FS 0→ t3 (11-05..11-06)
--                          t2 ─SS 1→ t4 (11-04)            t2 ─FS 0→ q2 (Q, 11-05; the editor only views Q)
-- t1 ─FS 0→ t5 (completed, 11-03)                          t2 ─FS 0→ r1 (R; the editor can't read R)

do $$
declare
  p uuid := (select id from sc_ids where name = 'p');
  q uuid := (select id from sc_ids where name = 'q');
  r uuid := (select id from sc_ids where name = 'r');
  t1 uuid; t2 uuid; t3 uuid; t4 uuid; t5 uuid; q2 uuid; r1 uuid;
begin
  t1 := public.create_task(p, null, 'Shift 1');
  t2 := public.create_task(p, null, 'Shift 2');
  t3 := public.create_task(p, null, 'Shift 3');
  t4 := public.create_task(p, null, 'Shift 4');
  t5 := public.create_task(p, null, 'Shift 5');
  q2 := public.create_task(q, null, 'Shift Q');
  r1 := public.create_task(r, null, 'Shift R');
  update public.tasks set start_on = '2026-11-01', due_on = '2026-11-02' where id = t1;
  update public.tasks set start_on = '2026-11-03', due_on = '2026-11-04' where id = t2;
  update public.tasks set start_on = '2026-11-05', due_on = '2026-11-06' where id = t3;
  update public.tasks set due_on = '2026-11-04' where id = t4;
  update public.tasks set due_on = '2026-11-03', completed_at = now() where id = t5;
  update public.tasks set due_on = '2026-11-04' where id = q2;
  update public.tasks set due_on = '2026-11-04' where id = r1;
  perform public.set_task_dependency(t1, t2, 'finish_to_start', 0);
  perform public.set_task_dependency(t2, t3, 'finish_to_start', 0);
  perform public.set_task_dependency(t2, t4, 'start_to_start', 1);
  perform public.set_task_dependency(t1, t5, 'finish_to_start', 0);
  perform public.set_task_dependency(t2, q2, 'finish_to_start', 0);
  perform public.set_task_dependency(t2, r1, 'finish_to_start', 0);
  insert into sc_ids values ('t1', t1), ('t2', t2), ('t3', t3), ('t4', t4), ('t5', t5), ('q2', q2), ('r1', r1);
end $$;

select set_config('request.jwt.claim.sub', 'e3e3e3e3-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  t1 uuid := (select id from sc_ids where name = 't1');
  t2 uuid := (select id from sc_ids where name = 't2');
  t3 uuid := (select id from sc_ids where name = 't3');
  t4 uuid := (select id from sc_ids where name = 't4');
  t5 uuid := (select id from sc_ids where name = 't5');
  q2 uuid := (select id from sc_ids where name = 'q2');
  r1 uuid := (select id from sc_ids where name = 'r1');
  result jsonb;
  undo jsonb;
begin
  -- Moving earlier never pulls dependents in.
  assert (select count(*) from public.preview_dependency_shift(t1, '2026-10-30', '2026-10-31')) = 0,
    'moving earlier moves nothing';

  -- Moving t1 two days later: t2 +1 (needs to start on t1''s new due date), t4 +1 (SS lag 1 from t2''s new
  -- start), t3 not at all (t2''s new due date is still its start), t5 skipped (completed), q2 skipped (the
  -- editor only views Q), r1 not listed (unreadable).
  assert (select count(*) from public.preview_dependency_shift(t1, '2026-11-03', '2026-11-04')) = 4, 'four tasks listed';
  assert (select new_start = '2026-11-04' and new_due = '2026-11-05' and shift_days = 1 and status = 'move'
          from public.preview_dependency_shift(t1, '2026-11-03', '2026-11-04') where task_id = t2), 't2 moves a day';
  assert (select new_due = '2026-11-05' and status = 'move'
          from public.preview_dependency_shift(t1, '2026-11-03', '2026-11-04') where task_id = t4), 't4 follows by start + lag';
  assert (select status = 'skipped' and reason = 'Completed'
          from public.preview_dependency_shift(t1, '2026-11-03', '2026-11-04') where task_id = t5), 'completed tasks are skipped';
  assert (select status = 'skipped' and reason like 'You can%t edit this task'
          from public.preview_dependency_shift(t1, '2026-11-03', '2026-11-04') where task_id = q2), 'read-only tasks are skipped';
  assert not exists (select 1 from public.preview_dependency_shift(t1, '2026-11-03', '2026-11-04') where task_id in (t3, r1)),
    'unaffected and unreadable tasks are not listed';
  assert (select due_on from public.tasks where id = t2) = '2026-11-04', 'a preview changes nothing';

  -- Nothing shifts without the confirm: apply with only t2 confirmed.
  result := public.apply_dependency_shift(t1, '2026-11-03', '2026-11-04', array[t2]);
  assert jsonb_array_length(result -> 'changes') = 2, 'the task and the confirmed dependent changed';
  assert (select start_on = '2026-11-03' and due_on = '2026-11-04' from public.tasks where id = t1), 't1 moved';
  assert (select start_on = '2026-11-04' and due_on = '2026-11-05' from public.tasks where id = t2), 't2 shifted';
  assert (select due_on from public.tasks where id = t4) = '2026-11-04', 't4 wasn''t confirmed, so it stayed';
  assert exists (select 1 from jsonb_array_elements(result -> 'skipped') s where s ->> 'task_id' = t4::text),
    'and is reported';
  assert (select due_on from public.tasks where id = q2) = '2026-11-04', 'read-only tasks never move';

  -- Undo restores the previous dates.
  undo := public.undo_dependency_shift(result -> 'changes');
  assert jsonb_array_length(undo -> 'restored') = 2, 'both restored';
  assert (select start_on = '2026-11-01' and due_on = '2026-11-02' from public.tasks where id = t1), 't1 back';
  assert (select start_on = '2026-11-03' and due_on = '2026-11-04' from public.tasks where id = t2), 't2 back';

  -- Apply everything, edit one task, then Undo leaves the edited one alone.
  result := public.apply_dependency_shift(t1, '2026-11-03', '2026-11-04', array[t2, t4]);
  assert (select due_on from public.tasks where id = t4) = '2026-11-05', 't4 shifted when confirmed';
  assert exists (select 1 from public.task_stories where task_id = t4 and kind = 'due_changed'), 'shifts write the usual stories';
  update public.tasks set due_on = '2026-11-09' where id = t4;
  undo := public.undo_dependency_shift(result -> 'changes');
  assert jsonb_array_length(undo -> 'restored') = 2 and jsonb_array_length(undo -> 'skipped') = 1, 'one skipped';
  assert (select due_on from public.tasks where id = t4) = '2026-11-09', 'a task changed since keeps its new date';
  assert (select due_on from public.tasks where id = t2) = '2026-11-04', 'the rest went back';
  assert (select due_on from public.tasks where id = r1) is null, 'the editor can''t read R''s task';
end $$;

-- Undo can't touch what you can't edit: Q's editor replays the change list.
select set_config('request.jwt.claim.sub', 'e3e3e3e3-0000-4000-8000-000000000004', false) is not null as ok \gset

do $$
declare
  undo jsonb;
begin
  undo := public.undo_dependency_shift(jsonb_build_array(jsonb_build_object(
    'task_id', (select id from sc_ids where name = 't2'),
    'old_start_on', '2026-01-01', 'old_due_on', '2026-01-02',
    'new_start_on', '2026-11-03', 'new_due_on', '2026-11-04')));
  assert jsonb_array_length(undo -> 'restored') = 0, 'nothing restored';
  assert (undo -> 'skipped' -> 0 ->> 'title') is null, 'and the unreadable task''s title isn''t revealed';
end $$;

-- Viewers can't shift, convert, or link ---------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'e3e3e3e3-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$ begin
  perform public.update_project_member_role(
    (select id from sc_ids where name = 'p'), 'e3e3e3e3-0000-4000-8000-000000000003', 'viewer');
end $$;

select set_config('request.jwt.claim.sub', 'e3e3e3e3-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
declare
  t1 uuid := (select id from sc_ids where name = 't1');
  n int;
begin
  assert exists (select 1 from public.task_dependencies where predecessor_id = t1), 'viewers read the links';
  begin
    perform public.apply_dependency_shift(t1, '2026-11-03', '2026-11-04', array[(select id from sc_ids where name = 't2')]);
    raise exception 'viewers can''t shift';
  exception when insufficient_privilege then null;
  end;
  assert (select due_on from public.tasks where id = t1) = '2026-11-02', 'nothing moved';
  begin
    perform public.convert_to_subtask(t1, (select id from sc_ids where name = 'a'));
    raise exception 'viewers can''t convert';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.convert_to_task((select id from sc_ids where name = 's1'));
    raise exception 'viewers can''t convert a subtask either';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.set_task_dependency(t1, (select id from sc_ids where name = 't3'), 'finish_to_start', 0);
    raise exception 'viewers can''t link';
  exception when insufficient_privilege then null;
  end;
  update public.task_dependencies set lag_days = 5 where predecessor_id = t1;
  get diagnostics n = row_count;
  assert n = 0, 'no direct updates';
end $$;

-- Approvals: only the approver decides, and only as Commenter+ ---------------------------------------

select set_config('request.jwt.claim.sub', 'e3e3e3e3-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$ begin
  perform public.update_project_member_role(
    (select id from sc_ids where name = 'p'), 'e3e3e3e3-0000-4000-8000-000000000003', 'commenter');
end $$;

do $$
declare
  ap uuid;
  ap2 uuid;
begin
  ap := public.request_approval((select id from sc_ids where name = 'c'), 'e3e3e3e3-0000-4000-8000-000000000003',
    'Please check', false, null);
  ap2 := public.request_approval((select id from sc_ids where name = 'b'), 'e3e3e3e3-0000-4000-8000-000000000003',
    'And this', false, null);
  insert into sc_ids values ('ap', ap), ('ap2', ap2);
end $$;

select set_config('request.jwt.claim.sub', 'e3e3e3e3-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
begin
  assert exists (select 1 from public.inbox_items where kind = 'approval_requested'
                 and data ->> 'approval_id' = (select id from sc_ids where name = 'ap')::text),
    'the approver''s inbox item carries the approval id (the Inbox''s decide buttons use it)';
  perform public.decide_approval((select id from sc_ids where name = 'ap'), 'approved', 'Looks good');
  assert (select status from public.approval_requests where id = (select id from sc_ids where name = 'ap')) = 'approved',
    'the approver decides from the Inbox';
end $$;

select set_config('request.jwt.claim.sub', 'e3e3e3e3-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
begin
  begin
    perform public.decide_approval((select id from sc_ids where name = 'ap2'), 'approved', null);
    raise exception 'only the approver decides';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'e3e3e3e3-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$ begin
  perform public.update_project_member_role(
    (select id from sc_ids where name = 'p'), 'e3e3e3e3-0000-4000-8000-000000000003', 'viewer');
end $$;
select set_config('request.jwt.claim.sub', 'e3e3e3e3-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
begin
  begin
    perform public.decide_approval((select id from sc_ids where name = 'ap2'), 'approved', null);
    raise exception 'an approver who is now a Viewer can''t decide';
  exception when insufficient_privilege then null;
  end;
  assert (select status from public.approval_requests where id = (select id from sc_ids where name = 'ap2')) = 'pending',
    'still pending';
end $$;

-- Converting a task into a subtask and back ----------------------------------------------------------

select set_config('request.jwt.claim.sub', 'e3e3e3e3-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from sc_ids where name = 'p');
  doing uuid := (select id from sc_ids where name = 'doing');
  k uuid;
  w uuid;
  n uuid;
  tag uuid;
  field uuid;
  cur uuid;
begin
  k := public.create_task(p, doing, 'Convert me');
  w := public.create_task(p, doing, 'Also in Q');
  n := public.create_task(p, doing, 'Deep tree');
  cur := n;
  for i in 1..4 loop
    cur := public.create_subtask(cur, format('Level %s', i));
  end loop;
  insert into public.tags (name, color) values ('Zz Sched', 'green') returning id into tag;
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Effort', 'number') returning id into field;
  insert into sc_ids values ('k', k), ('w', w), ('n', n), ('tag', tag), ('field', field);
  insert into public.task_projects (task_id, project_id, sort_order) values (w, (select id from sc_ids where name = 'q'), 1024);
end $$;

-- In a later transaction (so the details aren't part of the task's creation).
do $$
declare
  k uuid := (select id from sc_ids where name = 'k');
  a uuid := (select id from sc_ids where name = 'a');
  c uuid := (select id from sc_ids where name = 'c');
begin
  insert into public.task_tags (task_id, tag_id) values (k, (select id from sc_ids where name = 'tag'));
  assert exists (select 1 from public.task_stories where task_id = k and kind = 'tag_added'
                 and data ->> 'tag_name' = 'Zz Sched'), 'adding a tag is logged';
  insert into public.task_field_values (task_id, field_id, value) values (k, (select id from sc_ids where name = 'field'), '5');
  insert into public.comments (task_id, body) values (k, 'Keep me');
  perform public.set_task_dependency(k, c, 'finish_to_start', 0);
  begin
    update public.tasks set parent_task_id = a where id = k;
    raise exception 'a plain update still can''t make a task a subtask';
  exception when check_violation then null;
  end;
  perform public.convert_to_subtask(k, a);
end $$;

do $$
declare
  k uuid := (select id from sc_ids where name = 'k');
  a uuid := (select id from sc_ids where name = 'a');
  p uuid := (select id from sc_ids where name = 'p');
begin
  assert (select parent_task_id = a and root_task_id = a and home_project_id = p from public.tasks where id = k),
    'converted under a';
  assert not exists (select 1 from public.task_projects where task_id = k and deleted_at is null), 'it left its projects';
  assert exists (select 1 from public.task_tags where task_id = k and deleted_at is null), 'tags stay';
  assert exists (select 1 from public.task_field_values where task_id = k and value = '5'), 'field values stay';
  assert exists (select 1 from public.comments where task_id = k and deleted_at is null), 'comments stay';
  assert exists (select 1 from public.task_dependencies where predecessor_id = k and deleted_at is null), 'dependencies stay';
  assert exists (select 1 from public.task_stories where task_id = k and kind = 'converted_to_subtask'
                 and data ->> 'parent_title' = 'Draft copy'), 'the conversion is logged';
  assert (select count(*) from public.filter_project_tasks(p, '{"completion": "all"}', 'UTC') f where f.task_id = k) = 0,
    'it no longer shows as a project row';

  begin
    perform public.convert_to_subtask(a, k);
    raise exception 'cycles are rejected';
  exception when check_violation then null;
  end;
  begin
    perform public.convert_to_subtask((select id from sc_ids where name = 'n'), a);
    raise exception 'the depth limit counts the converted tree';
  exception when check_violation then null;
  end;
  begin
    update public.tasks set parent_task_id = null where id = k;
    raise exception 'a plain update still can''t make a subtask a task';
  exception when check_violation then null;
  end;

  perform public.convert_to_task(k, p, (select id from sc_ids where name = 'doing'));
end $$;

do $$
declare
  k uuid := (select id from sc_ids where name = 'k');
  p uuid := (select id from sc_ids where name = 'p');
begin
  assert (select parent_task_id is null and root_task_id is null and home_project_id = p from public.tasks where id = k),
    'a task again';
  assert (select section_id from public.task_projects where task_id = k and project_id = p and deleted_at is null)
    = (select id from sc_ids where name = 'doing'), 'in the chosen section';
  assert exists (select 1 from public.task_tags where task_id = k and deleted_at is null)
    and exists (select 1 from public.task_field_values where task_id = k and value = '5')
    and exists (select 1 from public.comments where task_id = k and deleted_at is null)
    and exists (select 1 from public.task_dependencies where predecessor_id = k and deleted_at is null),
    'tags, fields, comments, and dependencies came along';
  assert exists (select 1 from public.task_stories where task_id = k and kind = 'converted_to_task'
                 and data ->> 'project_name' = 'Sched P'), 'logged';
  update public.task_tags set deleted_at = now() where task_id = k and deleted_at is null;
  assert exists (select 1 from public.task_stories where task_id = k and kind = 'tag_removed'), 'removing a tag is logged';
end $$;

-- Tags set while creating a task aren't logged as changes.
do $$
declare
  t uuid;
begin
  t := public.create_task((select id from sc_ids where name = 'p'), null, 'Born tagged');
  insert into public.task_tags (task_id, tag_id) values (t, (select id from sc_ids where name = 'tag'));
  assert not exists (select 1 from public.task_stories where task_id = t and kind = 'tag_added'), 'no story at creation';
end $$;

-- The editor: Editor on both, and every project the task is in.
select set_config('request.jwt.claim.sub', 'e3e3e3e3-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  a uuid := (select id from sc_ids where name = 'a');
  w uuid := (select id from sc_ids where name = 'w');
  s1 uuid := (select id from sc_ids where name = 's1');
begin
  begin
    perform public.convert_to_subtask(a, (select id from sc_ids where name = 'q1'));
    raise exception 'the new parent needs Editor too';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.convert_to_subtask(w, a);
    raise exception 'a task in a project you can''t edit can''t become a subtask';
  exception when insufficient_privilege then null;
  end;
  assert (select parent_task_id is null from public.tasks where id = w)
    and exists (select 1 from public.task_projects where task_id = w and deleted_at is null), 'nothing changed';
  begin
    perform public.convert_to_task(s1, (select id from sc_ids where name = 'q'), null);
    raise exception 'a subtask only becomes a task of a project you edit';
  exception when insufficient_privilege then null;
  end;
  perform public.convert_to_task(s1);
  assert (select parent_task_id is null and home_project_id = (select id from sc_ids where name = 'p') from public.tasks where id = s1),
    'by default it lands in its old root''s home project';
  assert exists (select 1 from public.task_dependencies where predecessor_id = s1 and deleted_at is null),
    'its dependency came along';
end $$;

-- Views: Show subtasks is a saved setting -----------------------------------------------------------

do $$
declare
  p uuid := (select id from sc_ids where name = 'p');
  v uuid;
begin
  insert into public.project_views (project_id, name, layout, config)
  values (p, 'With subtasks', 'list', '{"show_subtasks": true}') returning id into v;
  assert (select config ->> 'show_subtasks' from public.project_views where id = v) = 'true', 'saved';
  begin
    update public.project_views set config = '{"show_subtasks": "yes"}' where id = v;
    raise exception 'show_subtasks is a boolean';
  exception when check_violation then null;
  end;
  begin
    update public.project_views set config = '{"show_everything": true}' where id = v;
    raise exception 'unknown keys are still rejected';
  exception when check_violation then null;
  end;
end $$;

-- Workspace admin: nothing extra ---------------------------------------------------------------------

select set_config('request.jwt.claim.sub', (select id::text from sc_ids where name = 'admin'), false) is not null as ok \gset

do $$
declare
  t1 uuid := (select id from sc_ids where name = 't1');
  undo jsonb;
begin
  assert not exists (select 1 from public.task_dependencies d
                     where d.predecessor_id in (select id from sc_ids) or d.successor_id in (select id from sc_ids)),
    'a workspace admin reads no links of private projects';
  assert (select count(*) from public.project_dependencies((select id from sc_ids where name = 'p'))) = 0, 'nor through the RPC';
  begin
    perform public.set_task_dependency(t1, (select id from sc_ids where name = 't3'), 'finish_to_start', 0);
    raise exception 'a workspace admin can''t link private tasks';
  exception when no_data_found then null;
  end;
  begin
    perform public.preview_dependency_shift(t1, '2026-11-03', '2026-11-04');
    raise exception 'or preview a shift';
  exception when no_data_found then null;
  end;
  begin
    perform public.apply_dependency_shift(t1, '2026-11-03', '2026-11-04', '{}');
    raise exception 'or shift';
  exception when no_data_found then null;
  end;
  begin
    perform public.convert_to_subtask(t1, (select id from sc_ids where name = 'a'));
    raise exception 'or convert';
  exception when no_data_found then null;
  end;
  undo := public.undo_dependency_shift(jsonb_build_array(jsonb_build_object(
    'task_id', t1, 'old_start_on', null, 'old_due_on', null,
    'new_start_on', '2026-11-01', 'new_due_on', '2026-11-02')));
  assert jsonb_array_length(undo -> 'restored') = 0, 'or undo on private tasks';
  assert (select due_on from public.tasks where id = t1) is null, 'the admin sees nothing (and changed nothing)';
end $$;

reset role;

do $$
begin
  assert (select due_on from public.tasks where id = (select id from sc_ids where name = 't1')) = '2026-11-02',
    'the admin''s undo changed nothing';
  assert (select due_on from public.tasks where id = (select id from sc_ids where name = 'r1')) = '2026-11-04',
    'tasks the shifting editor couldn''t read were never touched';
end $$;

-- anon gets nothing ----------------------------------------------------------------------------------

set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset

do $$
begin
  begin
    perform 1 from public.task_dependencies;
    raise exception 'anon reads no dependencies';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.set_task_dependency(gen_random_uuid(), gen_random_uuid(), 'finish_to_start', 0);
    raise exception 'anon can''t link';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.preview_dependency_shift(gen_random_uuid(), null, null);
    raise exception 'anon can''t preview';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.convert_to_task(gen_random_uuid());
    raise exception 'anon can''t convert';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- EXECUTE surface --------------------------------------------------------------------------------------

do $$
declare
  fn text;
begin
  assert (select prosecdef from pg_proc where oid = 'public.set_task_dependency(uuid, uuid, text, integer)'::regprocedure),
    'set_task_dependency is the one new client definer RPC (pinned in suite 60)';
  assert has_function_privilege('authenticated', 'public.set_task_dependency(uuid, uuid, text, integer)', 'execute')
    and not has_function_privilege('anon', 'public.set_task_dependency(uuid, uuid, text, integer)', 'execute'),
    'authenticated only';
  foreach fn in array array[
    'public.preview_dependency_shift(uuid, date, date)', 'public.apply_dependency_shift(uuid, date, date, uuid[])',
    'public.undo_dependency_shift(jsonb)', 'public.convert_to_subtask(uuid, uuid)',
    'public.convert_to_task(uuid, uuid, uuid)', 'public.project_dependencies(uuid)'
  ] loop
    assert not (select prosecdef from pg_proc where oid = fn::regprocedure), format('%s is invoker', fn);
    assert has_function_privilege('authenticated', fn, 'execute') and not has_function_privilege('anon', fn, 'execute'),
      format('%s is for signed-in people only', fn);
  end loop;
  foreach fn in array array[
    'public.on_task_tag_story()', 'public.on_task_converted()', 'public.task_reach_within(uuid, uuid)',
    'public.dependency_story_data(uuid, uuid, text, jsonb)'
  ] loop
    assert not has_function_privilege('authenticated', fn, 'execute') and not has_function_privilege('anon', fn, 'execute'),
      format('%s is internal', fn);
  end loop;
  assert not exists (select 1 from pg_proc where proname = 'alhc_patch_function'), 'the patch helper is gone';
  assert not has_table_privilege('anon', 'public.task_dependencies', 'select'), 'no anon table grant';
  assert not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'task_dependencies'
                     and cmd <> 'SELECT'), 'dependencies are only written through the RPCs';
end $$;

select 'scheduling depth and polish smoke: all assertions passed' as result;
