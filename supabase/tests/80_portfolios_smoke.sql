-- Behavioural checks for Phase: Portfolios and reporting: portfolio creation and ownership, the
-- portfolio role matrix (viewer < editor < admin < owner), member RPCs and the last-owner invariant,
-- adding/removing/reordering projects (Editor+ on the portfolio AND Viewer+ on the project), reports
-- that only count projects the caller can read (deduped by task), no leaks to non-members or anon,
-- soft delete, and project status. Reuses people from earlier suites:
--   1111… member@example.com    "Member One"     (owner of everything below)
--   4444… later@example.com     "Later Person"
--   5555… viewer@example.com    "Vera Viewer"
--   6666… commenter@example.com "Cora Commenter"
--   7777… editor@example.com    "Eddie Editor"
--   8888… admin@example.com     "Ada Admin"
--   9999… nonmember@example.com "Nora Nonmember"  (never joins anything here)

\set ON_ERROR_STOP 1

create temporary table pf_ids (name text primary key, id uuid) on commit preserve rows;
grant all on pf_ids to authenticated, anon;

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

-- Fixtures: three projects, tasks (one multi-homed, one deleted), and a portfolio -----------------

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  a uuid;
  b uuid;
  c uuid;
  t1 uuid;
  t2 uuid;
  t3 uuid;
  t4 uuid;
  t5 uuid;
  t6 uuid;
  t7 uuid;
  pf uuid;
  spoofed uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Port A') returning id into a;
  insert into public.projects (workspace_id, name) values (ws, 'Port B') returning id into b;
  insert into public.projects (workspace_id, name) values (ws, 'Port C private') returning id into c;
  assert (select status from public.projects where id = a) = 'on_track', 'projects start on track';

  -- A: overdue (also in B), completed today, open + assigned to the editor.
  t1 := public.create_task(a, null, 'Overdue in A and B');
  update public.tasks set due_on = '2000-01-01' where id = t1;
  insert into public.task_projects (task_id, project_id, sort_order) values (t1, b, 1024);
  t2 := public.create_task(a, null, 'Done today in A');
  update public.tasks set completed_at = now() where id = t2;
  t3 := public.create_task(a, null, 'Open in A');
  -- B: open, completed a month ago, deleted.
  t4 := public.create_task(b, null, 'Open in B');
  t5 := public.create_task(b, null, 'Done long ago in B');
  update public.tasks set completed_at = now() - interval '30 days' where id = t5;
  t6 := public.create_task(b, null, 'Deleted in B');
  update public.tasks set deleted_at = now() where id = t6;
  -- C: only the owner is a member.
  t7 := public.create_task(c, null, 'Secret title in C');

  perform public.add_project_member(a, 'viewer@example.com', 'viewer');
  perform public.add_project_member(a, 'editor@example.com', 'editor');
  perform public.add_project_member(b, 'editor@example.com', 'editor');
  update public.tasks set assignee_id = '77777777-7777-4777-8777-777777777777' where id = t3;

  -- Creating a portfolio: creator becomes owner; created_by can't be spoofed.
  insert into public.portfolios (workspace_id, name, notes, created_by)
  values (ws, 'Ops portfolio', 'Quarterly work', '99999999-9999-4999-8999-999999999999')
  returning id, created_by into pf, spoofed;
  assert spoofed = auth.uid(), 'created_by is forced to the caller';
  assert public.portfolio_role(pf) = 'owner', 'the creator owns a new portfolio';
  assert public.has_portfolio_role(pf, 'admin'), 'owner ranks above admin';
  assert not public.has_portfolio_role(pf, 'commenter'), 'portfolios have no commenter role';
  assert (select count(*) from public.portfolio_members where portfolio_id = pf and deleted_at is null) = 1,
    'a new portfolio starts with only its owner';

  begin
    insert into public.portfolios (workspace_id, name) values (ws, '   ');
    raise exception 'blank portfolio names should fail';
  exception when check_violation then null;
  end;
  begin
    insert into public.portfolios (workspace_id, name) values (ws, repeat('x', 101));
    raise exception 'names over 100 characters should fail';
  exception when check_violation then null;
  end;

  insert into pf_ids values ('a', a), ('b', b), ('c', c), ('pf', pf),
    ('t1', t1), ('t2', t2), ('t3', t3), ('t4', t4), ('t5', t5), ('t6', t6), ('t7', t7);
end $$;

-- Owner: projects, members, reports, invariants -------------------------------------------------

do $$
declare
  a uuid := (select id from pf_ids where name = 'a');
  b uuid := (select id from pf_ids where name = 'b');
  c uuid := (select id from pf_ids where name = 'c');
  pf uuid := (select id from pf_ids where name = 'pf');
  first_a uuid;
  r record;
  affected int;
begin
  first_a := public.add_portfolio_project(pf, a);
  perform public.add_portfolio_project(pf, b);
  perform public.add_portfolio_project(pf, c);
  assert public.add_portfolio_project(pf, a) = first_a, 're-adding an active project is idempotent';
  assert (select count(*) from public.portfolio_projects where portfolio_id = pf and deleted_at is null) = 3,
    'three projects in the portfolio';
  assert (select array_agg(project_id order by sort_order) from public.portfolio_projects where portfolio_id = pf)
    = array[a, b, c], 'projects are appended in order';

  -- Overall: tasks {t1, t2, t3, t4, t5, t7}; t1 counted once although it is in A and B; t6 deleted.
  select * into r from public.portfolio_report(pf, 'none', 'UTC');
  assert r.bucket is null and r.task_count = 6 and r.completed_count = 2 and r.incomplete_count = 4,
    format('overall counts dedupe multi-homed tasks: %s', r);
  assert r.overdue_count = 1, 'one overdue task overall';
  assert r.completed_recent_count = 1, 'only the task completed today is recent (last 7 days)';
  assert (select count(*) from public.portfolio_report(pf, 'none', 'UTC')) = 1, 'none returns exactly one row';

  -- Per project: a multi-homed task counts in each of its projects.
  select * into r from public.portfolio_report(pf, 'project', 'UTC') where bucket = a;
  assert r.task_count = 3 and r.completed_count = 1 and r.overdue_count = 1, format('project A counts: %s', r);
  select * into r from public.portfolio_report(pf, 'project', 'UTC') where bucket = b;
  assert r.task_count = 3 and r.completed_count = 1 and r.incomplete_count = 2 and r.overdue_count = 1,
    format('project B counts (t1 shared, t6 excluded): %s', r);
  select * into r from public.portfolio_report(pf, 'project', 'UTC') where bucket = c;
  assert r.task_count = 1 and r.incomplete_count = 1, 'project C counts';

  select * into r from public.portfolio_report(pf, 'assignee', 'UTC')
  where bucket = '77777777-7777-4777-8777-777777777777';
  assert r.task_count = 1 and r.incomplete_count = 1, 'by assignee';
  select * into r from public.portfolio_report(pf, 'assignee', 'UTC') where bucket is null;
  assert r.task_count = 5, 'unassigned bucket, deduped';
  assert not exists (select 1 from public.portfolio_report(pf, 'bogus', 'UTC')), 'unknown grouping returns nothing';

  assert (select task_count from public.list_portfolio_progress() where portfolio_id = pf) = 6, 'sidebar progress total';
  assert (select completed_count from public.list_portfolio_progress() where portfolio_id = pf) = 2,
    'sidebar progress completed';
  assert public.portfolio_hidden_project_count(pf) = 0, 'the owner of every project sees all of them';

  -- Members: invites follow the project_members rules.
  perform public.add_portfolio_member(pf, 'viewer@example.com', 'viewer');
  perform public.add_portfolio_member(pf, ' Editor@Example.com ', 'viewer');
  perform public.add_portfolio_member(pf, 'editor@example.com', 'editor');
  perform public.add_portfolio_member(pf, 'admin@example.com', 'admin');
  assert (select count(*) from public.portfolio_members where portfolio_id = pf and deleted_at is null) = 4,
    're-inviting changes the role instead of duplicating';
  assert (select role from public.portfolio_members
          where portfolio_id = pf and profile_id = '77777777-7777-4777-8777-777777777777' and deleted_at is null)
    = 'editor', 're-invite updated the role';
  begin
    perform public.add_portfolio_member(pf, 'commenter@example.com', 'commenter');
    raise exception 'commenter is not a portfolio role';
  exception when check_violation then null;
  end;
  begin
    perform public.add_portfolio_member(pf, 'stranger@example.com', 'viewer');
    raise exception 'non-allowlisted invite should fail';
  exception when check_violation then null;
  end;
  begin
    perform public.add_portfolio_member(pf, 'pending@example.com', 'viewer');
    raise exception 'invite of an allowlisted address with no profile yet should fail';
  exception when check_violation then null;
  end;
  begin
    perform public.add_portfolio_member(pf, 'unconfirmed@example.com', 'viewer');
    raise exception 'invite of an unconfirmed account should fail';
  exception when check_violation then null;
  end;

  -- Memberships and portfolio projects only change through the RPCs.
  update public.portfolio_members set role = 'viewer' where portfolio_id = pf;
  get diagnostics affected = row_count;
  assert affected = 0, 'direct membership updates affect nothing (no update policy)';
  begin
    insert into public.portfolio_members (portfolio_id, profile_id, role)
    values (pf, '99999999-9999-4999-8999-999999999999', 'owner');
    raise exception 'direct membership inserts should fail';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.portfolio_projects (portfolio_id, project_id) values (pf, a);
    raise exception 'direct portfolio project inserts should fail';
  exception when insufficient_privilege then null;
  end;
  update public.portfolio_projects set deleted_at = now() where portfolio_id = pf;
  get diagnostics affected = row_count;
  assert affected = 0, 'direct portfolio project updates affect nothing';

  -- Last owner is protected.
  begin
    perform public.update_portfolio_member_role(pf, auth.uid(), 'admin');
    raise exception 'demoting the last owner should fail';
  exception when check_violation then null;
  end;
  begin
    perform public.remove_portfolio_member(pf, auth.uid());
    raise exception 'removing the last owner should fail';
  exception when check_violation then null;
  end;

  -- Project status: only through set_project_status.
  begin
    update public.projects set status = 'at_risk' where id = a;
    raise exception 'direct status updates should fail';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.set_project_status(a, 'sideways', null);
    raise exception 'unknown statuses should fail';
  exception when check_violation then null;
  end;
end $$;

-- Viewer (portfolio viewer; project viewer of A only) --------------------------------------------

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset

do $$
declare
  a uuid := (select id from pf_ids where name = 'a');
  b uuid := (select id from pf_ids where name = 'b');
  pf uuid := (select id from pf_ids where name = 'pf');
  r record;
  affected int;
begin
  assert public.portfolio_role(pf) = 'viewer', 'viewer role';
  assert (select count(*) from public.portfolios where id = pf) = 1, 'viewer reads the portfolio';
  assert (select count(*) from public.portfolio_members where portfolio_id = pf) = 4, 'viewer reads the members';
  assert (select array_agg(project_id) from public.portfolio_projects where portfolio_id = pf) = array[a],
    'the project list only shows projects the viewer can read';
  assert public.portfolio_hidden_project_count(pf) = 2, 'two projects are hidden from the viewer';

  select * into r from public.portfolio_report(pf, 'none', 'UTC');
  assert r.task_count = 3 and r.completed_count = 1 and r.overdue_count = 1,
    format('viewer progress only covers project A: %s', r);
  assert (select array_agg(bucket) from public.portfolio_report(pf, 'project', 'UTC')) = array[a],
    'per-project report only includes readable projects';
  assert (select task_count from public.list_portfolio_progress() where portfolio_id = pf) = 3,
    'sidebar progress only covers readable projects';
  assert not exists (select 1 from public.tasks where title = 'Secret title in C'), 'no task titles leak from C';
  assert not exists (select 1 from public.projects where name = 'Port C private'), 'no project names leak';

  update public.portfolios set name = 'Viewer rename' where id = pf;
  get diagnostics affected = row_count;
  assert affected = 0, 'viewer cannot rename the portfolio';
  begin
    perform public.add_portfolio_project(pf, a);
    raise exception 'viewer cannot add projects';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.remove_portfolio_project(pf, a);
    raise exception 'viewer cannot remove projects';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.move_portfolio_project(pf, a, 1);
    raise exception 'viewer cannot reorder projects';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.add_portfolio_member(pf, 'later@example.com', 'viewer');
    raise exception 'viewer cannot invite';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.set_project_status(a, 'at_risk', 'Viewer opinion');
    raise exception 'project viewers cannot set status';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Editor (portfolio editor; project editor of A and B) -------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  a uuid := (select id from pf_ids where name = 'a');
  b uuid := (select id from pf_ids where name = 'b');
  c uuid := (select id from pf_ids where name = 'c');
  pf uuid := (select id from pf_ids where name = 'pf');
  old_b uuid;
  new_b uuid;
  affected int;
begin
  update public.portfolios set name = 'Ops', notes = 'Edited notes' where id = pf;
  get diagnostics affected = row_count;
  assert affected = 1, 'editor renames and edits notes';
  update public.portfolios set created_by = auth.uid(), workspace_id = ws where id = pf;
  assert (select created_by from public.portfolios where id = pf) = '11111111-1111-4111-8111-111111111111',
    'created_by is immutable';

  begin
    update public.portfolios set deleted_at = now() where id = pf;
    raise exception 'editor cannot delete the portfolio';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.add_portfolio_project(pf, c);
    raise exception 'adding a project you are not a member of should fail';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.add_portfolio_member(pf, 'later@example.com', 'viewer');
    raise exception 'editor cannot invite';
  exception when insufficient_privilege then null;
  end;

  -- Remove and re-add: a new row, history kept.
  old_b := (select id from public.portfolio_projects where portfolio_id = pf and project_id = b and deleted_at is null);
  perform public.remove_portfolio_project(pf, b);
  assert not exists (select 1 from public.portfolio_projects where portfolio_id = pf and project_id = b and deleted_at is null),
    'removed project is no longer active';
  begin
    perform public.remove_portfolio_project(pf, b);
    raise exception 'removing twice should fail';
  exception when no_data_found then null;
  end;
  new_b := public.add_portfolio_project(pf, b);
  assert new_b <> old_b, 're-adding creates a new row';
  assert (select count(*) from public.portfolio_projects where portfolio_id = pf and project_id = b) = 2,
    'the removed row stays as history';

  -- Reorder: B (now last) moves to the front.
  perform public.move_portfolio_project(pf, b, 1);
  assert (select project_id from public.portfolio_projects
          where portfolio_id = pf and deleted_at is null order by sort_order limit 1) = b, 'reordered';
  begin
    perform public.move_portfolio_project(pf, b, 'NaN');
    raise exception 'NaN positions should fail';
  exception when check_violation then null;
  end;

  -- The editor can't read C, so C is hidden and left out of the numbers.
  assert public.portfolio_hidden_project_count(pf) = 1, 'C is hidden from the editor';
  assert (select task_count from public.portfolio_report(pf, 'none', 'UTC')) = 5, 'editor progress covers A and B';

  -- Project status (editor of A).
  perform public.set_project_status(a, 'at_risk', '  Waiting on assets  ');
  assert (select status from public.projects where id = a) = 'at_risk', 'status set';
  assert (select status_note from public.projects where id = a) = 'Waiting on assets', 'note trimmed';
  assert (select status_updated_by from public.projects where id = a) = auth.uid(), 'status author stamped';
  assert (select status_updated_at from public.projects where id = a) is not null, 'status time stamped';
  perform public.set_project_status(a, 'off_track', '');
  assert (select status_note from public.projects where id = a) is null, 'blank note clears it';
  begin
    perform public.set_project_status(c, 'complete', null);
    raise exception 'setting the status of a project you are not in should fail';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Admin (portfolio admin; member of no project) --------------------------------------------------

select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset

do $$
declare
  a uuid := (select id from pf_ids where name = 'a');
  pf uuid := (select id from pf_ids where name = 'pf');
  r record;
begin
  assert public.portfolio_role(pf) = 'admin', 'admin role';
  assert (select count(*) from public.portfolio_projects where portfolio_id = pf) = 0,
    'portfolio membership alone shows no projects';
  assert public.portfolio_hidden_project_count(pf) = 3, 'all three projects are hidden from the admin';
  select * into r from public.portfolio_report(pf, 'none', 'UTC');
  assert r.task_count = 0 and r.completed_count = 0, 'admin progress counts nothing it cannot read';
  assert not exists (select 1 from public.portfolio_report(pf, 'project', 'UTC')), 'no per-project rows';
  assert not exists (select 1 from public.portfolio_report(pf, 'assignee', 'UTC')), 'no per-assignee rows';
  assert not exists (select 1 from public.tasks where title like 'Overdue in A%'), 'no task titles leak';

  begin
    perform public.add_portfolio_project(pf, a);
    raise exception 'even an admin needs Viewer+ on the project to add it';
  exception when insufficient_privilege then null;
  end;

  -- Admins manage people up to admin.
  perform public.add_portfolio_member(pf, 'later@example.com', 'editor');
  perform public.update_portfolio_member_role(pf, '44444444-4444-4444-8444-444444444444', 'admin');
  begin
    perform public.add_portfolio_member(pf, 'commenter@example.com', 'owner');
    raise exception 'admins cannot add owners';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.update_portfolio_member_role(pf, '11111111-1111-4111-8111-111111111111', 'viewer');
    raise exception 'admins cannot demote owners';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.remove_portfolio_member(pf, '11111111-1111-4111-8111-111111111111');
    raise exception 'admins cannot remove owners';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.transfer_portfolio_ownership(pf, '44444444-4444-4444-8444-444444444444');
    raise exception 'admins cannot transfer ownership';
  exception when insufficient_privilege then null;
  end;
  perform public.remove_portfolio_member(pf, '44444444-4444-4444-8444-444444444444');
  assert not exists (
    select 1 from public.portfolio_members
    where portfolio_id = pf and profile_id = '44444444-4444-4444-8444-444444444444' and deleted_at is null
  ), 'admin removed a member (soft delete)';
  assert exists (
    select 1 from public.portfolio_members
    where portfolio_id = pf and profile_id = '44444444-4444-4444-8444-444444444444' and deleted_at is not null
  ), 'removed membership is kept as history';
end $$;

-- Non-member: nothing through the API ------------------------------------------------------------

select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999999', false) is not null as ok \gset

do $$
declare
  a uuid := (select id from pf_ids where name = 'a');
  pf uuid := (select id from pf_ids where name = 'pf');
  affected int;
begin
  assert public.portfolio_role(pf) is null, 'no role';
  assert (select count(*) from public.portfolios where id = pf) = 0, 'non-member cannot see the portfolio';
  assert (select count(*) from public.portfolio_members where portfolio_id = pf) = 0, 'or its members';
  assert (select count(*) from public.portfolio_projects where portfolio_id = pf) = 0, 'or its projects';
  assert (select task_count from public.portfolio_report(pf, 'none', 'UTC')) = 0, 'or its numbers';
  assert not exists (select 1 from public.portfolio_report(pf, 'project', 'UTC')), 'or its project rows';
  assert public.portfolio_hidden_project_count(pf) = 0, 'or even how many projects it hides';
  assert not exists (select 1 from public.list_portfolio_progress()), 'no sidebar progress';

  update public.portfolios set name = 'Hijacked' where id = pf;
  get diagnostics affected = row_count;
  assert affected = 0, 'non-member cannot rename';
  begin
    perform public.add_portfolio_member(pf, 'nonmember@example.com', 'owner');
    raise exception 'non-member cannot invite themselves';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.remove_portfolio_member(pf, '55555555-5555-4555-8555-555555555555');
    raise exception 'non-member cannot remove people';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.add_portfolio_project(pf, a);
    raise exception 'non-member cannot add projects';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Leaving, ownership transfer, and soft delete ---------------------------------------------------

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset

do $$
declare
  pf uuid := (select id from pf_ids where name = 'pf');
begin
  perform public.remove_portfolio_member(pf, auth.uid());
  assert public.portfolio_role(pf) is null, 'viewer left';
  assert (select count(*) from public.portfolios where id = pf) = 0, 'after leaving, the portfolio is hidden';
end $$;

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  b uuid := (select id from pf_ids where name = 'b');
  pf uuid := (select id from pf_ids where name = 'pf');
  scratch uuid;
begin
  begin
    perform public.transfer_portfolio_ownership(pf, auth.uid());
    raise exception 'transferring to yourself should fail';
  exception when check_violation then null;
  end;
  perform public.transfer_portfolio_ownership(pf, '88888888-8888-4888-8888-888888888888');
  assert public.portfolio_role(pf) = 'admin', 'previous owner steps down to admin';
  begin
    update public.portfolios set deleted_at = now() where id = pf;
    raise exception 'an admin cannot delete the portfolio';
  exception when insufficient_privilege then null;
  end;

  -- A soft-deleted project drops out of the numbers (B: t4, t5 only; t1 stays through A).
  update public.projects set deleted_at = now() where id = b;
  assert (select task_count from public.portfolio_report(pf, 'none', 'UTC')) = 4,
    'soft-deleted projects are excluded from reports';
  update public.projects set deleted_at = null where id = b;

  -- Owner soft-deletes a portfolio; it disappears from active lists but stays restorable.
  insert into public.portfolios (workspace_id, name) values (ws, 'Scratch') returning id into scratch;
  perform public.add_portfolio_project(scratch, b);
  update public.portfolios set deleted_at = now() where id = scratch;
  assert (select count(*) from public.portfolios where id = scratch and deleted_at is null) = 0, 'soft-deleted';
  assert not exists (select 1 from public.list_portfolio_progress() where portfolio_id = scratch),
    'deleted portfolios have no progress row';
  assert (select task_count from public.portfolio_report(scratch, 'none', 'UTC')) = 0,
    'deleted portfolios report nothing';
  begin
    perform public.add_portfolio_project(scratch, b);
    raise exception 'adding to a deleted portfolio should fail';
  exception when check_violation then null;
  end;
  update public.portfolios set deleted_at = null where id = scratch;
  assert (select count(*) from public.portfolios where id = scratch and deleted_at is null) = 1, 'owner restores it';
end $$;

-- Anonymous callers ------------------------------------------------------------------------------

reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset

do $$
begin
  assert (select count(*) from public.portfolios) = 0, 'anon reads no portfolios';
  assert (select count(*) from public.portfolio_members) = 0, 'anon reads no portfolio members';
  assert (select count(*) from public.portfolio_projects) = 0, 'anon reads no portfolio projects';
end $$;

reset role;

do $$
begin
  assert not has_function_privilege('anon', 'public.has_portfolio_role(uuid, text)', 'execute'), 'anon: no role helper';
  assert not has_function_privilege('anon', 'public.add_portfolio_member(uuid, text, text)', 'execute'), 'anon: no invite';
  assert not has_function_privilege('anon', 'public.portfolio_report(uuid, text, text)', 'execute'), 'anon: no report';
  assert not has_function_privilege('anon', 'public.set_project_status(uuid, text, text)', 'execute'), 'anon: no status';
  assert not has_function_privilege('authenticated', 'public.profile_portfolio_role(uuid, uuid)', 'execute'),
    'internal helper is not an RPC';
  assert not has_function_privilege('authenticated', 'public.add_portfolio_owner()', 'execute'),
    'trigger functions are not RPCs';
  assert not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename in ('portfolios', 'portfolio_members', 'portfolio_projects')
      and (cmd = 'DELETE' or 'anon' = any (roles) or 'public' = any (roles))
  ), 'no DELETE or anon policies on portfolio tables';
end $$;

select 'portfolios smoke: all assertions passed' as result;
