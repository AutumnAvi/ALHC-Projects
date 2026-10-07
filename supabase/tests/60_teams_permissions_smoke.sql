-- Behavioural checks for the Teams & permissions migration: project membership, the role matrix in
-- RLS and RPCs, invites, the last-owner invariant, no leaks to non-members, public forms, EXECUTE
-- hardening, and the backfill. Reuses the users from 10_core_smoke.sql:
--   1111… member@example.com  "Member One"   (allowlisted)
--   4444… later@example.com   "Later Person" (allowlisted)
--   2222… outsider@example.com               (not allowlisted)
--   3333… unconfirmed@example.com            (allowlisted, email never confirmed)
-- and adds one allowlisted person per role plus a non-member.

\set ON_ERROR_STOP 1

-- Fixtures (as the migration owner) --------------------------------------------------------------

insert into public.allowed_emails (email) values
  ('viewer@example.com'), ('commenter@example.com'), ('editor@example.com'), ('admin@example.com'),
  ('nonmember@example.com'), ('pending@example.com');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('55555555-5555-4555-8555-555555555555', 'viewer@example.com', now(), '{"full_name":"Vera Viewer"}'),
  ('66666666-6666-4666-8666-666666666666', 'commenter@example.com', now(), '{"full_name":"Cora Commenter"}'),
  ('77777777-7777-4777-8777-777777777777', 'editor@example.com', now(), '{"full_name":"Eddie Editor"}'),
  ('88888888-8888-4888-8888-888888888888', 'admin@example.com', now(), '{"full_name":"Ada Admin"}'),
  ('99999999-9999-4999-8999-999999999999', 'nonmember@example.com', now(), '{"full_name":"Nora Nonmember"}');

create temporary table tp_ids (name text primary key, id uuid) on commit preserve rows;
grant all on tp_ids to authenticated, anon;

set role authenticated;

-- Owner sets up a project and invites one person per role ----------------------------------------

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid;
  q uuid;
  s uuid;
  t uuid;
  tq uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Team') returning id into p;
  insert into public.projects (workspace_id, name) values (ws, 'Private') returning id into q;
  assert public.project_role(p) = 'owner', 'the creator owns a new project';
  assert (select count(*) from public.project_members where project_id = p and deleted_at is null) = 1,
    'a new project starts with only its owner';

  insert into public.sections (project_id, name, sort_order) values (p, 'To do', 1024) returning id into s;
  t := public.create_task(p, s, 'Shared task');
  tq := public.create_task(q, null, 'Private task, also in Team');
  insert into public.task_projects (task_id, project_id, sort_order) values (tq, p, 4096);
  insert into tp_ids values ('p', p), ('q', q), ('s', s), ('t', t), ('tq', tq);

  perform public.add_project_member(p, 'viewer@example.com', 'viewer');
  perform public.add_project_member(p, ' Commenter@Example.com ', 'commenter');
  perform public.add_project_member(p, 'editor@example.com', 'viewer');
  perform public.add_project_member(p, 'editor@example.com', 'editor');
  perform public.add_project_member(p, 'admin@example.com', 'admin');
  assert (select count(*) from public.project_members where project_id = p and deleted_at is null) = 5,
    'invites add active members; re-inviting changes the role instead of duplicating';
  assert (select role from public.project_members
          where project_id = p and profile_id = '77777777-7777-4777-8777-777777777777' and deleted_at is null) = 'editor',
    're-invite updated the role';

  begin
    perform public.add_project_member(p, 'stranger@example.com', 'viewer');
    raise exception 'non-allowlisted invite should fail';
  exception when check_violation then null;
  end;
  begin
    perform public.add_project_member(p, 'pending@example.com', 'viewer');
    raise exception 'invite of an allowlisted address with no profile yet should fail';
  exception when check_violation then null;
  end;
  begin
    perform public.add_project_member(p, 'unconfirmed@example.com', 'viewer');
    raise exception 'invite of an unconfirmed account should fail';
  exception when check_violation then null;
  end;
  begin
    perform public.add_project_member(p, 'editor@example.com', 'superuser');
    raise exception 'unknown roles should fail';
  exception when check_violation then null;
  end;

  -- Memberships only change through the RPCs.
  update public.project_members set role = 'viewer' where project_id = p;
  assert not exists (select 1 from public.project_members where project_id = p and role = 'viewer'
                     and profile_id <> '55555555-5555-4555-8555-555555555555'),
    'direct updates of memberships affect nothing (no update policy)';
  begin
    insert into public.project_members (project_id, profile_id, role)
    values (p, '99999999-9999-4999-8999-999999999999', 'owner');
    raise exception 'direct membership inserts should fail';
  exception when insufficient_privilege then null;
  end;

  -- Last owner is protected.
  begin
    perform public.update_project_member_role(p, auth.uid(), 'admin');
    raise exception 'demoting the last owner should fail';
  exception when check_violation then null;
  end;
  begin
    perform public.remove_project_member(p, auth.uid());
    raise exception 'removing the last owner should fail';
  exception when check_violation then null;
  end;
end $$;

-- Viewer: read-only ------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from tp_ids where name = 'p');
  t uuid := (select id from tp_ids where name = 't');
  affected int;
begin
  assert public.project_role(p) = 'viewer', 'viewer role';
  assert (select count(*) from public.projects where id = p) = 1, 'viewer reads the project';
  assert (select count(*) from public.tasks where id = t) = 1, 'viewer reads tasks';
  assert (select count(*) from public.sections where project_id = p) = 1, 'viewer reads sections';
  assert (select count(*) from public.project_views where project_id = p) = 4, 'viewer reads views';
  assert (select count(*) from public.filter_project_tasks(p, '{}')) = 2, 'viewer can filter tasks';
  assert (select count(*) from public.project_members where project_id = p) = 5, 'viewer sees who is on the project';

  update public.tasks set title = 'Viewer rename' where id = t;
  get diagnostics affected = row_count;
  assert affected = 0, 'viewer cannot update tasks';
  update public.task_projects set section_id = null where task_id = t;
  get diagnostics affected = row_count;
  assert affected = 0, 'viewer cannot move tasks';
  update public.project_views set name = 'Mine' where project_id = p;
  get diagnostics affected = row_count;
  assert affected = 0, 'viewer cannot edit views';

  begin
    perform public.create_task(p, null, 'Viewer task');
    raise exception 'viewer task create should fail';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.comments (task_id, body) values (t, 'Viewer comment');
    raise exception 'viewer comment should fail';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.task_followers (task_id, profile_id) values (t, auth.uid());
    raise exception 'viewer follow should fail';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into storage.objects (bucket_id, name) values ('task-attachments', t::text || '/viewer.pdf');
    raise exception 'viewer upload should fail';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.add_project_member(p, 'nonmember@example.com', 'viewer');
    raise exception 'viewer invite should fail';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Editor: edits tasks, can't manage people, rules, forms, or settings ----------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from tp_ids where name = 'p');
  q uuid := (select id from tp_ids where name = 'q');
  t uuid := (select id from tp_ids where name = 't');
  tq uuid := (select id from tp_ids where name = 'tq');
  a uuid;
  affected int;
begin
  update public.tasks set title = 'Shared task (edited)' where id = t;
  get diagnostics affected = row_count;
  assert affected = 1, 'editor updates tasks';
  perform public.create_task(p, null, 'Editor task');
  insert into public.sections (project_id, name) values (p, 'Editor section');
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Notes', 'text');
  insert into public.project_views (project_id, name, layout) values (p, 'Editor view', 'list');
  insert into storage.objects (bucket_id, name) values ('task-attachments', t::text || '/editor.pdf');

  update public.projects set name = 'Renamed by editor' where id = p;
  get diagnostics affected = row_count;
  assert affected = 0, 'editor cannot change project settings';
  begin
    insert into public.rules (project_id, name, trigger_type, actions)
    values (p, 'Editor rule', 'task_created', '[{"type": "add_followers", "people": ["assignee"]}]');
    raise exception 'editor rule insert should fail';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.forms (project_id, title) values (p, 'Editor form');
    raise exception 'editor form insert should fail';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.add_project_member(p, 'nonmember@example.com', 'viewer');
    raise exception 'editor invite should fail';
  exception when insufficient_privilege then null;
  end;

  -- Approvals: editors request; the approver must be able to comment.
  begin
    perform public.request_approval(t, '55555555-5555-4555-8555-555555555555', 'Viewer approver');
    raise exception 'a viewer cannot be the approver';
  exception when check_violation then null;
  end;
  a := public.request_approval(t, '66666666-6666-4666-8666-666666666666', 'Please approve');
  insert into tp_ids values ('approval', a);

  -- Multi-homed task: readable through Team, but the Private project stays invisible.
  assert (select count(*) from public.tasks where id = tq) = 1, 'editor reads a task through any of its projects';
  assert (select count(*) from public.projects where id = q) = 0, 'editor cannot see the other project';
  assert (select count(*) from public.task_projects where task_id = tq) = 1,
    'only memberships in visible projects are returned';
  assert (select count(*) from public.filter_project_tasks(q, '{}')) = 0, 'filtering a non-member project returns nothing';
  assert (select home_project_name from public.search_tasks('also in Team')) = 'Team',
    'search labels a task with a project the caller can see';
  update public.tasks set notes = 'Edited through Team' where id = tq;
  get diagnostics affected = row_count;
  assert affected = 1, 'editor in any of the task''s projects can edit it';
  begin
    insert into public.task_projects (task_id, project_id) values (t, q);
    raise exception 'adding a task to a project where you are not an editor should fail';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Commenter: comments and decides their approval, can't edit tasks -------------------------------

select set_config('request.jwt.claim.sub', '66666666-6666-4666-8666-666666666666', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from tp_ids where name = 'p');
  t uuid := (select id from tp_ids where name = 't');
  a uuid := (select id from tp_ids where name = 'approval');
  affected int;
begin
  assert exists (select 1 from public.inbox_items where kind = 'approval_requested' and task_id = t),
    'the approver is notified';
  insert into public.comments (task_id, body) values (t, 'Looks good @Eddie Editor, and hi @Nora Nonmember');
  assert (select array_agg(profile_id) from public.comment_mentions) = array['77777777-7777-4777-8777-777777777777'::uuid],
    'only people who can read the task can be mentioned';
  insert into public.task_followers (task_id, profile_id) values (t, auth.uid())
  on conflict (task_id, profile_id) do update set deleted_at = null;
  begin
    insert into public.task_followers (task_id, profile_id) values (t, '99999999-9999-4999-8999-999999999999');
    raise exception 'following on behalf of a non-member should fail';
  exception when insufficient_privilege then null;
  end;

  update public.tasks set title = 'Commenter rename' where id = t;
  get diagnostics affected = row_count;
  assert affected = 0, 'commenter cannot rename tasks';
  begin
    perform public.request_approval(t, auth.uid());
    raise exception 'commenter cannot request approvals';
  exception when insufficient_privilege then null;
  end;

  perform public.decide_approval(a, 'approved', 'Ship it');
  assert (select status from public.approval_requests where id = a) = 'approved', 'commenter approver decides';
end $$;

-- Admin: manages people, rules, forms, settings; can't touch owners or delete the project --------

select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from tp_ids where name = 'p');
  t uuid := (select id from tp_ids where name = 't');
  f uuid;
  affected int;
begin
  perform public.add_project_member(p, 'nonmember@example.com', 'viewer');
  perform public.update_project_member_role(p, '99999999-9999-4999-8999-999999999999', 'editor');
  assert (select role from public.project_members
          where project_id = p and profile_id = '99999999-9999-4999-8999-999999999999' and deleted_at is null) = 'editor',
    'admin changes roles';

  update public.projects set name = 'Team', description = 'Set by admin' where id = p;
  get diagnostics affected = row_count;
  assert affected = 1, 'admin edits project settings';
  insert into public.forms (project_id, title, accepting_responses, questions)
  values (p, 'Team intake', true, '[{"id": "title", "type": "short_text", "label": "What do you need?", "required": true, "maps_to": {"target": "title"}}]')
  returning id into f;
  insert into public.forms (project_id, title, accepting_responses, questions)
  values (p, 'Closed intake', false, '[{"id": "q", "type": "short_text", "label": "Question"}]');
  insert into tp_ids select 'form', f;
  insert into tp_ids select 'closed_form', id from public.forms where title = 'Closed intake';
  insert into public.rules (project_id, name, trigger_type, actions)
  values (p, 'Admin rule', 'task_created', '[{"type": "add_followers", "people": ["assignee"]}]');
  insert into public.request_sequences (project_id) values (p);

  begin
    perform public.add_project_member(p, 'later@example.com', 'owner');
    raise exception 'admin cannot add owners';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.update_project_member_role(p, '11111111-1111-4111-8111-111111111111', 'viewer');
    raise exception 'admin cannot demote an owner';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.remove_project_member(p, '11111111-1111-4111-8111-111111111111');
    raise exception 'admin cannot remove an owner';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.projects set deleted_at = now() where id = p;
    raise exception 'admin cannot delete the project';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.transfer_project_ownership(p, auth.uid());
    raise exception 'admin cannot take ownership';
  exception when insufficient_privilege then null;
  end;

  -- Admin removes the non-member again, and assigns them a task first to check for leaks.
  update public.tasks set assignee_id = '99999999-9999-4999-8999-999999999999' where id = t;
  perform public.remove_project_member(p, '99999999-9999-4999-8999-999999999999');
  assert not exists (select 1 from public.project_members
                     where project_id = p and profile_id = '99999999-9999-4999-8999-999999999999' and deleted_at is null),
    'removal soft-deletes the membership';
  assert exists (select 1 from public.project_members
                 where project_id = p and profile_id = '99999999-9999-4999-8999-999999999999' and deleted_at is not null),
    'removed memberships are kept as history';
end $$;

-- Removed / non-member: nothing leaks ------------------------------------------------------------

select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999999', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from tp_ids where name = 'p');
  t uuid := (select id from tp_ids where name = 't');
  ws uuid := '00000000-0000-4000-8000-000000000001';
  mine uuid;
  affected int;
begin
  assert public.is_allowlisted(), 'still allowlisted (outer gate unchanged)';
  assert public.project_role(p) is null, 'a removed membership grants nothing';
  assert (select count(*) from public.projects) = 0, 'non-member sees no projects';
  assert (select count(*) from public.tasks where assignee_id = auth.uid()) = 0,
    'My Tasks does not leak tasks from projects you are not in';
  assert (select count(*) from public.search_tasks('task')) = 0, 'search does not leak';
  assert (select count(*) from public.inbox_items) = 0, 'inbox hides items for tasks you can no longer read';
  assert (select count(*) from public.project_members) = 0, 'non-member cannot list members';
  assert (select count(*) from public.comments) = 0 and (select count(*) from public.task_stories) = 0,
    'non-member cannot read activity';
  assert (select count(*) from public.filter_project_tasks(p, '{}')) = 0, 'filter RPC respects membership';
  assert jsonb_array_length(public.get_public_form((select id from tp_ids where name = 'closed_form')) -> 'questions') = 0,
    'closed forms are previewable by project members only';
  update public.tasks set title = 'Hijack' where id = t;
  get diagnostics affected = row_count;
  assert affected = 0, 'non-member cannot update tasks';
  begin
    perform public.create_task(p, null, 'Sneaky');
    raise exception 'non-member task create should fail';
  exception when insufficient_privilege then null;
  end;

  -- Any allowlisted person can still start their own project and owns it.
  insert into public.projects (workspace_id, name) values (ws, 'Nora''s project') returning id into mine;
  assert public.project_role(mine) = 'owner', 'creating a project makes you its owner';
  assert (select count(*) from public.projects) = 1, 'and only that project is listed';
end $$;

-- Viewer can preview a closed form; outsider and anon get nothing private -----------------------

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset

do $$
begin
  assert jsonb_array_length(public.get_public_form((select id from tp_ids where name = 'closed_form')) -> 'questions') = 1,
    'project members preview closed forms';
end $$;

select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false) is not null as ok \gset

do $$
begin
  assert (select count(*) from public.project_members) = 0, 'outsider cannot read memberships';
  begin
    perform public.add_project_member((select id from tp_ids where name = 'p'), 'outsider@example.com', 'owner');
    raise exception 'outsider invite should fail';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset

do $$
declare
  result jsonb;
begin
  assert (select count(*) from public.project_members) = 0, 'anon cannot read memberships';
  assert public.get_public_form((select id from tp_ids where name = 'form')) ->> 'title' = 'Team intake',
    'public forms still load for anon';
  result := public.submit_form((select id from tp_ids where name = 'form'), 'guest@example.org', '{"title": "Need a flyer"}');
  assert result ->> 'task_id' is not null, 'public forms still accept anonymous submissions';
  insert into tp_ids values ('form_task', (result ->> 'task_id')::uuid);
  begin
    perform public.add_project_member((select id from tp_ids where name = 'p'), 'viewer@example.com', 'viewer');
    raise exception 'anon must not call membership RPCs';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.has_project_role((select id from tp_ids where name = 'p'), 'viewer');
    raise exception 'anon must not call role helpers';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
set role authenticated;

-- Owner: transfer ownership, last-owner invariant after transfer, project delete -----------------

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from tp_ids where name = 'p');
begin
  assert (select title from public.tasks where id = (select id from tp_ids where name = 'form_task')) = '[Req #1] Need a flyer',
    'the form submission landed in the project';

  perform public.transfer_project_ownership(p, '88888888-8888-4888-8888-888888888888');
  assert public.project_role(p) = 'admin', 'the previous owner steps down to admin';
  begin
    update public.projects set deleted_at = now() where id = p;
    raise exception 'a former owner cannot delete the project';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from tp_ids where name = 'p');
begin
  assert public.project_role(p) = 'owner', 'ownership transferred';
  begin
    perform public.remove_project_member(p, auth.uid());
    raise exception 'the only owner cannot leave';
  exception when check_violation then null;
  end;
  perform public.update_project_member_role(p, '11111111-1111-4111-8111-111111111111', 'owner');
  perform public.remove_project_member(p, auth.uid());
  assert public.project_role(p) is null, 'an owner can leave once another owner exists';
end $$;

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  doomed uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Doomed') returning id into doomed;
  update public.projects set deleted_at = now() where id = doomed;
  assert (select deleted_at is not null from public.projects where id = doomed), 'the owner can soft-delete a project';
end $$;

reset role;

-- Inbox fan-out skips people who can't read the task ---------------------------------------------

do $$
declare
  t uuid := (select id from tp_ids where name = 't');
begin
  assert not exists (
    select 1 from public.inbox_items
    where recipient_id = '99999999-9999-4999-8999-999999999999' and task_id = t and kind = 'mention'
  ), 'a non-member who was @mentioned gets no inbox item';
  assert not exists (
    select 1 from public.task_followers
    where profile_id = '99999999-9999-4999-8999-999999999999' and task_id = (select id from tp_ids where name = 'tq')
  ), 'non-members are never auto-followed';
end $$;

-- EXECUTE hardening (stretch): the exact SECURITY DEFINER surface per client role ---------------

do $$
declare
  exposed text;
begin
  select string_agg(p.proname, ',' order by p.proname) into exposed
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute');
  assert exposed = 'get_public_form,submit_form', format('anon SECURITY DEFINER surface changed: %s', exposed);

  select string_agg(p.proname, ',' order by p.proname) into exposed
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute');
  -- Task depth added add_task_dependency, open_blocker_count, remove_task_dependency, restore_task.
  -- Portfolios and reporting added add_portfolio_member, add_portfolio_project, has_portfolio_role,
  -- move_portfolio_project, portfolio_hidden_project_count, portfolio_role, remove_portfolio_member,
  -- remove_portfolio_project, set_project_status, transfer_portfolio_ownership, update_portfolio_member_role.
  -- Integrations added get_project_integrations and set_project_integration (Admin+ settings, redacted).
  -- Asana importer added start_import_run, import_batch, finish_import_run (Admin+ on the target project).
  -- Templates added can_manage_project_template, create_project_from_template, delete_project_template,
  -- duplicate_project, save_project_as_template, update_project_template.
  -- Workspace admin and comments added add_workspace_admin, is_workspace_admin, remove_workspace_admin.
  -- My Tasks sections and workload added none: every new function is SECURITY INVOKER.
  -- Goals and Teams directory added goal_hidden_project_count (a count only; everything else is invoker).
  -- Critical path and portfolio depth added none (its definer trigger guard_portfolio_child is revoked).
  -- Task types and nested rollups added none (its definer trigger sync_task_approval is revoked).
  -- Real subtasks added none.
  -- Reporting and export added workspace_hidden_project_count (a count only; everything else is invoker).
  -- Tags and collaboration extras added none (its definer functions are triggers / helpers, revoked).
  -- Scheduling depth and polish added set_task_dependency (Editor on both tasks; definer so its cycle
  -- check sees every link); auto-shift, conversions, and project_dependencies are invoker.
  -- Daily essentials added set_project_archived (Admin+ by the member's own role, since an archived
  -- project caps every membership at Viewer); private tasks, duplicate_task, likes, and the multi-task
  -- auto-shift are invoker.
  -- Integration depth added cancel_integration_delivery, list_integration_deliveries, and
  -- retry_integration_delivery (Admin+ of the delivery's project; the outbox has no client path, and the
  -- log returns hints only — never a URL, secret, or signature).
  assert exposed = 'add_portfolio_member,add_portfolio_project,add_project_member,add_task_dependency,add_workspace_admin,'
    'assign_request_number,can_manage_project_template,cancel_approval,cancel_integration_delivery,create_project_from_template,custom_field_project,'
    'decide_approval,delete_project_template,duplicate_project,finish_import_run,format_request_label,'
    'get_project_integrations,get_public_form,goal_hidden_project_count,has_portfolio_role,has_project_role,has_task_role,import_batch,is_allowlisted,is_workspace_admin,list_integration_deliveries,move_portfolio_project,'
    'open_blocker_count,portfolio_hidden_project_count,portfolio_role,profile_can_read_task,project_role,'
    'remove_portfolio_member,remove_portfolio_project,remove_project_member,remove_task_dependency,remove_workspace_admin,'
    'request_approval,restore_task,resubmit_approval,retry_integration_delivery,rule_project,save_project_as_template,set_project_archived,set_project_integration,set_project_status,set_task_dependency,start_import_run,submit_form,'
    'task_request_label,task_role,transfer_portfolio_ownership,transfer_project_ownership,'
    'update_portfolio_member_role,update_project_member_role,update_project_template,workspace_hidden_project_count',
    format('authenticated SECURITY DEFINER surface changed: %s', exposed);

  assert not has_function_privilege('authenticated', 'public.workflow_tick()', 'execute'), 'tick is service-role only';
  assert not has_function_privilege('authenticated', 'public.claim_email_outbox(integer, uuid)', 'execute'),
    'outbox claim is service-role only';
  assert not has_function_privilege('authenticated', 'public.backfill_project_members()', 'execute'),
    'backfill is not an RPC';
  assert has_function_privilege('service_role', 'public.workflow_tick()', 'execute'), 'service role keeps the tick';
end $$;

-- Backfill ---------------------------------------------------------------------------------------
-- Simulates projects that existed before this migration (no memberships), then runs the backfill.

alter table public.projects disable trigger projects_add_owner;
insert into public.projects (id, workspace_id, name, created_by) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-4000-8000-000000000001', 'Legacy with creator',
   '44444444-4444-4444-8444-444444444444'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '00000000-0000-4000-8000-000000000001', 'Legacy without creator', null);
alter table public.projects enable trigger projects_add_owner;

do $$
declare
  legacy_a uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  legacy_b uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  oldest uuid := (
    select x.id from public.profiles x where public.profile_is_allowlisted(x.id) order by x.created_at, x.id limit 1
  );
  allowlisted int := (select count(*) from public.profiles x where public.profile_is_allowlisted(x.id));
begin
  perform public.backfill_project_members();
  assert (select profile_id from public.project_members where project_id = legacy_a and role = 'owner' and deleted_at is null)
    = '44444444-4444-4444-8444-444444444444', 'backfill makes the creator the owner';
  assert (select profile_id from public.project_members where project_id = legacy_b and role = 'owner' and deleted_at is null)
    = oldest, 'without a creator the oldest allowlisted profile owns it';
  assert (select count(*) from public.project_members where project_id = legacy_a and deleted_at is null) = allowlisted,
    'every allowlisted profile is a member after the backfill';
  assert (select count(*) from public.project_members where project_id = legacy_a and role = 'editor' and deleted_at is null)
    = allowlisted - 1, 'everyone except the owner joins as editor';
  assert not exists (select 1 from public.project_members where profile_id = '33333333-3333-4333-8333-333333333333'),
    'unconfirmed accounts are not backfilled';
  assert public.backfill_project_members() = 0, 'the backfill is idempotent';
  assert not exists (
    select 1 from public.projects pr
    where not exists (select 1 from public.project_members m where m.project_id = pr.id and m.role = 'owner' and m.deleted_at is null)
  ), 'every project has an active owner';
end $$;

select 'teams & permissions smoke: all assertions passed' as result;
