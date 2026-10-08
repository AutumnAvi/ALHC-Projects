-- Behavioural checks for Phase: Goals and Teams directory: a workspace-wide team directory managed by
-- leads and workspace admins (creator becomes lead, last-lead guard, only allowlisted people join),
-- team membership granting no project access, the group invite (Project Admin+ only, ordinary
-- project_members rows, existing members keep their role, unaddable people skipped), goals editable
-- only by their owner, a lead of their team, or a workspace admin, sub-goal cycles rejected, links that
-- need Viewer+ on the project or portfolio, status updates, and progress that never counts a project
-- the viewer can't read (workspace admins included). People from earlier suites:
--   1111… member@example.com    "Member One"      (workspace admin since suite 94)
--   4444… later@example.com     "Later Person"
--   5555… viewer@example.com    "Vera Viewer"
--   6666… commenter@example.com "Cora Commenter"
--   7777… editor@example.com    "Eddie Editor"
--   8888… admin@example.com     "Ada Admin"
--   9999… nonmember@example.com "Nora Nonmember"
-- plus aaaa… gone@example.com "Gary Gone", who leaves the allowlist after joining a team.

\set ON_ERROR_STOP 1

create temporary table gt_ids (name text primary key, id uuid) on commit preserve rows;
grant all on gt_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email) values ('gone@example.com');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'gone@example.com', now(), '{"full_name":"Gary Gone"}');

set role authenticated;

-- Teams: creator is lead, members by email ---------------------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  team uuid;
begin
  insert into public.teams (name, description) values ('  Design  ', 'Brand and creative') returning id into team;
  insert into gt_ids values ('design', team);
  assert (select name from public.teams where id = team) = 'Design', 'names are trimmed';
  assert (select workspace_id from public.teams where id = team) = '00000000-0000-4000-8000-000000000001',
    'the workspace defaults to the app''s';
  assert (select created_by from public.teams where id = team) = '77777777-7777-4777-8777-777777777777', 'creator stamped';
  assert (select role from public.team_members where team_id = team and deleted_at is null) = 'lead',
    'the creator is the first lead';
  assert public.is_team_lead(team) and public.can_manage_team(team), 'and manages the team';

  perform public.add_team_member(team, 'Viewer@Example.com', 'member');
  perform public.add_team_member(team, 'commenter@example.com', 'member');
  perform public.add_team_member(team, 'nonmember@example.com', 'member');
  perform public.add_team_member(team, 'gone@example.com', 'member');
  perform public.add_team_member(team, 'viewer@example.com', 'member');
  assert (select count(*) from public.team_members where team_id = team and deleted_at is null) = 5,
    'four people added; adding again is a no-op';

  begin
    perform public.add_team_member(team, 'outsider@example.com', 'member');
    raise exception 'only allowlisted people can join a team';
  exception when check_violation then null;
  end;
  -- Since Asana feel, batch 2: someone who never signed in gets a pending team invite (null).
  assert public.add_team_member(team, 'pending@example.com', 'member') is null, 'a pending team invite';
  begin
    perform public.add_team_member(team, 'later@example.com', 'owner');
    raise exception 'teams only have leads and members';
  exception when check_violation then null;
  end;
  begin
    insert into public.team_members (team_id, profile_id) values (team, '22222222-2222-4222-8222-222222222222');
    raise exception 'a non-allowlisted profile can''t be inserted directly either';
  exception when check_violation or foreign_key_violation then null;
  end;
end $$;

reset role;
delete from public.allowed_emails where email = 'gone@example.com';
set role authenticated;

-- The directory is readable by everyone allowlisted; only leads and workspace admins manage ---------

select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false) is not null as ok \gset
do $$
declare
  team uuid := (select id from gt_ids where name = 'design');
  n int;
begin
  assert exists (select 1 from public.teams where id = team), 'anyone allowlisted sees the team';
  assert (select count(*) from public.team_members where team_id = team and deleted_at is null) = 5, 'and its members';
  update public.teams set name = 'Hijacked' where id = team;
  get diagnostics n = row_count;
  assert n = 0, 'non-members can''t rename a team';
  begin
    perform public.add_team_member(team, 'later@example.com', 'lead');
    raise exception 'non-members can''t add themselves';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.team_members (team_id, profile_id, role)
    values (team, '44444444-4444-4444-8444-444444444444', 'lead');
    raise exception 'nor insert a membership directly';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
declare
  team uuid := (select id from gt_ids where name = 'design');
  solo uuid;
begin
  begin
    perform public.add_team_member(team, 'later@example.com', 'member');
    raise exception 'members can''t add people';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.team_members set role = 'lead'
    where team_id = team and profile_id = '55555555-5555-4555-8555-555555555555' and deleted_at is null;
    raise exception 'members can''t promote themselves';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.update_team_member_role(team, '55555555-5555-4555-8555-555555555555', 'lead');
    raise exception 'nor through the RPC';
  exception when insufficient_privilege then null;
  end;

  -- Last-lead guard on a team of one.
  insert into public.teams (name) values ('Solo') returning id into solo;
  insert into gt_ids values ('solo', solo);
  begin
    perform public.remove_team_member(solo, '55555555-5555-4555-8555-555555555555');
    raise exception 'the last lead can''t leave';
  exception when check_violation then null;
  end;
  begin
    perform public.update_team_member_role(solo, '55555555-5555-4555-8555-555555555555', 'member');
    raise exception 'nor step down';
  exception when check_violation then null;
  end;
  -- A lead may delete their team (soft); afterwards the guard no longer applies.
  update public.teams set deleted_at = now() where id = solo;
  assert (select deleted_at from public.teams where id = solo) is not null, 'leads delete their team';
end $$;

-- A workspace admin who isn't in the team manages it.
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset
do $$
declare
  team uuid := (select id from gt_ids where name = 'design');
  n int;
begin
  assert public.is_workspace_admin(), 'fixture: member is a workspace admin';
  assert not public.is_team_lead(team) and public.can_manage_team(team), 'workspace admins manage every team';
  perform public.update_team_member_role(team, '99999999-9999-4999-8999-999999999999', 'lead');
  perform public.update_team_member_role(team, '99999999-9999-4999-8999-999999999999', 'member');
  update public.teams set description = 'Brand, creative, and print' where id = team;
  get diagnostics n = row_count;
  assert n = 1, 'workspace admins edit the team';
end $$;

-- A team grants no project access; the group invite needs Project Admin+ -------------------------

select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset
do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Team target') returning id into p;
  perform public.create_task(p, null, 'Target task');
  perform public.add_project_member(p, 'commenter@example.com', 'commenter');
  perform public.add_project_member(p, 'editor@example.com', 'editor');
  insert into gt_ids values ('target', p);
end $$;

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from gt_ids where name = 'target');
begin
  assert exists (
    select 1 from public.team_members
    where team_id = (select id from gt_ids where name = 'design')
      and profile_id = '55555555-5555-4555-8555-555555555555' and deleted_at is null
  ), 'fixture: Vera is in the team';
  assert not exists (select 1 from public.projects where id = p), 'team membership grants no project row';
  assert not exists (select 1 from public.tasks t join public.task_projects tp on tp.task_id = t.id where tp.project_id = p),
    'nor its tasks';
  assert public.project_role(p) is null and not public.has_project_role(p, 'viewer'), 'nor a role';
  begin
    perform public.add_team_to_project(p, (select id from gt_ids where name = 'design'), 'viewer');
    raise exception 'a non-member can''t group-invite';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Team members who are only Commenters or Editors of the project can't add the team either.
select set_config('request.jwt.claim.sub', '66666666-6666-4666-8666-666666666666', false) is not null as ok \gset
do $$
begin
  perform public.add_team_to_project((select id from gt_ids where name = 'target'), (select id from gt_ids where name = 'design'), 'viewer');
  raise exception 'a commenter can''t group-invite';
exception when insufficient_privilege then null;
end $$;

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
begin
  perform public.add_team_to_project((select id from gt_ids where name = 'target'), (select id from gt_ids where name = 'design'), 'viewer');
  raise exception 'an editor (and team lead) can''t group-invite';
exception when insufficient_privilege then null;
end $$;

-- A workspace admin who isn't in the project can't either.
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset
do $$
begin
  perform public.add_team_to_project((select id from gt_ids where name = 'target'), (select id from gt_ids where name = 'design'), 'viewer');
  raise exception 'a workspace admin outside the project can''t group-invite';
exception when insufficient_privilege then null;
end $$;

select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from gt_ids where name = 'target');
  team uuid := (select id from gt_ids where name = 'design');
  result jsonb;
begin
  begin
    perform public.add_team_to_project(p, team, 'owner');
    raise exception 'a team can''t be added as owners';
  exception when check_violation then null;
  end;

  result := public.add_team_to_project(p, team, 'viewer');
  assert (select array_agg(x ->> 'name' order by x ->> 'name') from jsonb_array_elements(result -> 'added') x)
    = array['Nora Nonmember', 'Vera Viewer'], format('adds the people not yet in the project: %s', result);
  assert (select array_agg(x ->> 'name' order by x ->> 'name') from jsonb_array_elements(result -> 'unchanged') x)
    = array['Cora Commenter', 'Eddie Editor'], 'people already in the project are left alone';
  assert jsonb_array_length(result -> 'skipped') = 1
    and result -> 'skipped' -> 0 ->> 'name' = 'Gary Gone'
    and result -> 'skipped' -> 0 ->> 'reason' like '%in this workspace%', format('someone no longer allowlisted is skipped: %s', result);

  assert (select role from public.project_members
          where project_id = p and profile_id = '55555555-5555-4555-8555-555555555555' and deleted_at is null) = 'viewer',
    'ordinary project_members rows with the chosen role';
  assert (select created_by from public.project_members
          where project_id = p and profile_id = '55555555-5555-4555-8555-555555555555' and deleted_at is null)
    = '88888888-8888-4888-8888-888888888888', 'added by the admin who ran the invite';
  assert (select role from public.project_members
          where project_id = p and profile_id = '66666666-6666-4666-8666-666666666666' and deleted_at is null) = 'commenter',
    'existing members keep their role';
  assert (select role from public.project_members
          where project_id = p and profile_id = '77777777-7777-4777-8777-777777777777' and deleted_at is null) = 'editor',
    'existing members keep their role (no downgrade)';
  assert (select count(*) from public.team_projects where team_id = team and project_id = p and deleted_at is null) = 1,
    'the team is recorded on the project';

  result := public.add_team_to_project(p, team, 'editor');
  assert jsonb_array_length(result -> 'added') = 0, 'running it again adds nobody new';
  assert (select count(*) from public.team_projects where team_id = team and project_id = p and deleted_at is null) = 1,
    'still one record';
  assert (select role from public.team_projects where team_id = team and project_id = p and deleted_at is null) = 'editor',
    'with the latest role';
end $$;

-- Access came from the project rows, not the team: new team members get nothing, and leaving the team
-- keeps the project membership.
select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
begin
  perform public.add_team_member((select id from gt_ids where name = 'design'), 'later@example.com', 'member');
end $$;

select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.projects where id = (select id from gt_ids where name = 'target')),
    'joining a team later grants no access to its projects';
  assert not exists (select 1 from public.team_projects where project_id = (select id from gt_ids where name = 'target')),
    'nor shows them on the team page';
end $$;

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
declare
  team uuid := (select id from gt_ids where name = 'design');
begin
  assert exists (select 1 from public.projects where id = (select id from gt_ids where name = 'target')),
    'the group invite gave Vera an ordinary membership';
  assert exists (select 1 from public.team_projects where team_id = team), 'so she sees it on the team page';
  perform public.remove_team_member(team, '55555555-5555-4555-8555-555555555555');
  assert not exists (
    select 1 from public.team_members
    where team_id = team and profile_id = '55555555-5555-4555-8555-555555555555' and deleted_at is null
  ), 'members may leave';
  assert exists (select 1 from public.projects where id = (select id from gt_ids where name = 'target')),
    'leaving the team doesn''t touch project access';
end $$;

-- Goals: who edits ----------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  team uuid := (select id from gt_ids where name = 'design');
  g1 uuid;
  g2 uuid;
begin
  insert into public.goals (title, period_start, period_end) values ('  Grow awareness ', '2026-10-01', '2026-12-31')
  returning id into g1;
  assert (select owner_id from public.goals where id = g1) = '77777777-7777-4777-8777-777777777777', 'owner defaults to the creator';
  assert (select title from public.goals where id = g1) = 'Grow awareness', 'titles are trimmed';
  -- A lead creates a team goal owned by a teammate.
  insert into public.goals (title, team_id, owner_id) values ('Refresh brand kit', team, '66666666-6666-4666-8666-666666666666')
  returning id into g2;
  insert into gt_ids values ('g1', g1), ('g2', g2);
  begin
    insert into public.goals (title, period_start, period_end) values ('Backwards', '2026-12-31', '2026-10-01');
    raise exception 'period start must not be after its end';
  exception when check_violation then null;
  end;
  begin
    insert into public.goals (title, owner_id) values ('Owned by an outsider', '22222222-2222-4222-8222-222222222222');
    raise exception 'owners must be in the workspace';
  exception when check_violation or foreign_key_violation then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
declare
  n int;
  g3 uuid;
begin
  assert (select count(*) from public.goals where id in ((select id from gt_ids where name = 'g1'), (select id from gt_ids where name = 'g2'))) = 2,
    'anyone allowlisted reads goals';
  update public.goals set title = 'Mine now' where id = (select id from gt_ids where name = 'g1');
  get diagnostics n = row_count;
  assert n = 0, 'only the owner, a team lead, or a workspace admin edits a goal';
  begin
    insert into public.goals (title, owner_id) values ('For Eddie', '77777777-7777-4777-8777-777777777777');
    raise exception 'you can''t create a goal you couldn''t edit';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.goals (title, team_id) values ('Team goal', (select id from gt_ids where name = 'design'));
    -- Owned by Vera, so she can edit it — that's fine.
  end;
  insert into public.goals (title) values ('Vera''s goal') returning id into g3;
  insert into gt_ids values ('g3', g3);
  begin
    update public.goals set parent_id = (select id from gt_ids where name = 'g1') where id = g3;
    raise exception 'a sub-goal can only be attached to a goal you can edit';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.goal_status_updates (goal_id, status, body)
    values ((select id from gt_ids where name = 'g1'), 'off_track', 'Not mine');
    raise exception 'only editors post status updates';
  exception when insufficient_privilege then null;
  end;
end $$;

-- The owner (not a lead) edits a team goal; a team member who isn't a lead doesn't.
select set_config('request.jwt.claim.sub', '66666666-6666-4666-8666-666666666666', false) is not null as ok \gset
do $$
declare
  n int;
begin
  update public.goals set notes = 'Owner notes' where id = (select id from gt_ids where name = 'g2');
  get diagnostics n = row_count;
  assert n = 1, 'the owner edits';
end $$;

select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999999', false) is not null as ok \gset
do $$
declare
  n int;
begin
  update public.goals set notes = 'Member notes' where id = (select id from gt_ids where name = 'g2');
  get diagnostics n = row_count;
  assert n = 0, 'team members who aren''t leads don''t';
end $$;

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset
do $$
declare
  n int;
begin
  update public.goals set notes = 'Admin notes' where id = (select id from gt_ids where name = 'g2');
  get diagnostics n = row_count;
  assert n = 1, 'workspace admins edit any goal';
  update public.goals set notes = 'Admin notes' where id = (select id from gt_ids where name = 'g3');
  get diagnostics n = row_count;
  assert n = 1, 'including personal ones';
end $$;

-- Sub-goals, cycles, status updates --------------------------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset
do $$
declare
  g1 uuid := (select id from gt_ids where name = 'g1');
  g2 uuid := (select id from gt_ids where name = 'g2');
  a uuid;
  b uuid;
  n int;
begin
  -- Eddie leads g2's team, so he can attach it under his own goal.
  update public.goals set parent_id = g1 where id = g2;
  get diagnostics n = row_count;
  assert n = 1, 'a team lead re-parents a team goal under a goal they own';
  insert into public.goals (title, parent_id) values ('Sub A', g1) returning id into a;
  insert into public.goals (title, parent_id) values ('Sub B', a) returning id into b;
  assert (select workspace_id from public.goals where id = b) = '00000000-0000-4000-8000-000000000001', 'workspace follows';

  begin
    update public.goals set parent_id = b where id = g1;
    raise exception 'a goal must not become a sub-goal of its own descendant';
  exception when check_violation then null;
  end;
  begin
    update public.goals set parent_id = a where id = a;
    raise exception 'a goal must not be its own parent';
  exception when check_violation then null;
  end;
  begin
    update public.goals set parent_id = g2 where id = g1;
    raise exception 'two-goal cycles are rejected too';
  exception when check_violation then null;
  end;

  insert into public.goal_status_updates (goal_id, status, body) values (g1, 'at_risk', '  Behind on reach  ');
  assert (select status from public.goals where id = g1) = 'at_risk', 'a status update sets the goal''s status';
  assert (select body from public.goal_status_updates where goal_id = g1) = 'Behind on reach', 'body trimmed';
  assert (select author_id from public.goal_status_updates where goal_id = g1) = '77777777-7777-4777-8777-777777777777',
    'author stamped';
  update public.goal_status_updates set deleted_at = now() where goal_id = g1;
  assert (select deleted_at from public.goal_status_updates where goal_id = g1) is not null, 'authors delete their updates';
  assert (select status from public.goals where id = g1) = 'at_risk', 'the status stays';
  begin
    update public.goal_status_updates set body = 'Rewritten' where goal_id = g1;
    raise exception 'status updates can''t be edited';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Links and progress ----------------------------------------------------------------------------
-- Eddie's project P_vis: 4 tasks, 2 completed (Vera and Ada are Viewers).
-- Ada's project P_secret: 3 tasks, all completed (nobody else).
-- Ada's project P_folio inside Ada's portfolio: 1 open task (nobody else).

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid;
  t uuid;
  i int;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Goal visible') returning id into p;
  for i in 1..4 loop
    t := public.create_task(p, null, 'Visible ' || i);
    if i <= 2 then
      update public.tasks set completed_at = now() where id = t;
    end if;
  end loop;
  perform public.add_project_member(p, 'viewer@example.com', 'viewer');
  perform public.add_project_member(p, 'admin@example.com', 'viewer');
  insert into gt_ids values ('p_vis', p);
end $$;

select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset
do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  secret uuid;
  folio_project uuid;
  pf uuid;
  t uuid;
  i int;
  g uuid;
  manual uuid;
  mid uuid;
  leaf uuid;
  dropped uuid;
  parent uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Goal secret') returning id into secret;
  for i in 1..3 loop
    t := public.create_task(secret, null, 'Secret ' || i);
    update public.tasks set completed_at = now() where id = t;
  end loop;
  insert into public.projects (workspace_id, name) values (ws, 'Goal folio project') returning id into folio_project;
  perform public.create_task(folio_project, null, 'Folio task');
  insert into public.portfolios (workspace_id, name) values (ws, 'Ada folio') returning id into pf;
  perform public.add_portfolio_project(pf, folio_project);

  insert into public.goals (title, progress_mode) values ('Ship campaigns', 'projects') returning id into g;
  insert into public.goal_links (goal_id, project_id) values (g, (select id from gt_ids where name = 'p_vis'));
  insert into public.goal_links (goal_id, project_id) values (g, secret);
  insert into public.goal_links (goal_id, portfolio_id) values (g, pf);
  begin
    insert into public.goal_links (goal_id, project_id) values (g, secret);
    raise exception 'a project is linked once';
  exception when unique_violation then null;
  end;
  begin
    insert into public.goal_links (goal_id, project_id, portfolio_id) values (g, secret, pf);
    raise exception 'a link points at one thing';
  exception when check_violation then null;
  end;

  insert into public.goals (title, progress_mode) values ('All of it', 'sub_goals') returning id into parent;
  update public.goals set parent_id = parent where id = g;
  insert into public.goals (title, parent_id, manual_progress) values ('Manual', parent, 30) returning id into manual;
  insert into public.goals (title, parent_id, progress_mode) values ('Middle', parent, 'sub_goals') returning id into mid;
  insert into public.goals (title, parent_id, manual_progress) values ('Leaf', mid, 80) returning id into leaf;
  insert into public.goals (title, parent_id, manual_progress, status) values ('Dropped', parent, 100, 'dropped')
  returning id into dropped;
  begin
    insert into public.goals (title, manual_progress) values ('Too much', 101);
    raise exception 'manual progress is 0-100';
  exception when check_violation then null;
  end;

  insert into gt_ids values ('secret', secret), ('folio', pf), ('gp', g), ('parent', parent), ('mid', mid), ('dropped', dropped);
end $$;

-- Ada can read everything: 8 tasks, 5 completed → 62%. Parent = floor(avg(62, 30, 80)) = 57 (the
-- dropped sub-goal is left out; Middle = its only sub-goal, 80).
do $$
declare
  r record;
begin
  select * into r from public.goal_progress() where goal_id = (select id from gt_ids where name = 'gp');
  assert r.task_count = 8 and r.completed_count = 5 and r.progress = 62 and r.hidden_project_count = 0,
    format('owner counts every linked project: %s', r);
  assert (select progress from public.goal_progress() where goal_id = (select id from gt_ids where name = 'mid')) = 80,
    'a sub-goal average of one';
  select * into r from public.goal_progress() where goal_id = (select id from gt_ids where name = 'parent');
  assert r.progress = 57 and r.sub_goal_count = 4, format('average of the sub-goals, dropped left out: %s', r);
  assert (select count(*) from public.goal_links where goal_id = (select id from gt_ids where name = 'gp') and deleted_at is null) = 3,
    'Ada sees all three links';
end $$;

-- Vera only reads P_vis: 4 tasks, 2 done → 50%; 2 hidden projects; parent = floor(avg(50, 30, 80)) = 53.
select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset
do $$
declare
  r record;
  g uuid := (select id from gt_ids where name = 'gp');
begin
  select * into r from public.goal_progress() where goal_id = g;
  assert r.task_count = 4 and r.completed_count = 2 and r.progress = 50 and r.hidden_project_count = 2,
    format('progress never counts unreadable projects: %s', r);
  assert public.goal_hidden_project_count(g) = 2, 'only a count';
  assert (select count(*) from public.goal_links where goal_id = g) = 1, 'links to unreadable projects are hidden';
  assert (select project_id from public.goal_links where goal_id = g) = (select id from gt_ids where name = 'p_vis'),
    'the readable one is shown';
  assert (select progress from public.goal_progress() where goal_id = (select id from gt_ids where name = 'parent')) = 53,
    'parents average what each viewer can see';

  begin
    insert into public.goal_links (goal_id, project_id)
    values ((select id from gt_ids where name = 'g3'), (select id from gt_ids where name = 'secret'));
    raise exception 'linking a project needs Viewer+ on it';
  exception when insufficient_privilege or no_data_found then null;
  end;
  begin
    insert into public.goal_links (goal_id, portfolio_id)
    values ((select id from gt_ids where name = 'g3'), (select id from gt_ids where name = 'folio'));
    raise exception 'linking a portfolio needs Viewer+ on it';
  exception when insufficient_privilege or no_data_found then null;
  end;
  insert into public.goal_links (goal_id, project_id)
  values ((select id from gt_ids where name = 'g3'), (select id from gt_ids where name = 'p_vis'));
  begin
    insert into public.goal_links (goal_id, project_id) values (g, (select id from gt_ids where name = 'p_vis'));
    raise exception 'linking to someone else''s goal needs edit rights on it';
  exception when insufficient_privilege or unique_violation then null;
  end;
  update public.goal_links set deleted_at = now() where goal_id = g;
  assert (select count(*) from public.goal_links where goal_id = g and deleted_at is null) = 1, 'nor unlink';
end $$;

-- A workspace admin who is in none of the projects: no tasks, three hidden, no links shown — but they
-- may still edit the goal itself.
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset
do $$
declare
  r record;
  g uuid := (select id from gt_ids where name = 'gp');
  n int;
begin
  select * into r from public.goal_progress() where goal_id = g;
  assert r.task_count = 0 and r.progress is null and r.hidden_project_count = 3,
    format('workspace admins don''t bypass project access: %s', r);
  assert not exists (select 1 from public.goal_links where goal_id = g), 'no links shown';
  assert not exists (select 1 from public.projects where id = (select id from gt_ids where name = 'secret')), 'no project row';
  assert (select progress from public.goal_progress() where goal_id = (select id from gt_ids where name = 'parent')) = 55,
    'a sub-goal with nothing to measure is left out of the average: floor(avg(30, 80))';
  update public.goals set title = 'Ship every campaign' where id = g;
  get diagnostics n = row_count;
  assert n = 1, 'workspace admins still edit the goal';
  begin
    insert into public.goal_links (goal_id, project_id) values (g, (select id from gt_ids where name = 'secret'));
    raise exception 'workspace admins can''t link projects they can''t read';
  exception when insufficient_privilege or no_data_found then null;
  end;
end $$;

-- Deleting a sub-goal drops it from its parent; deleting the parent leaves the children readable.
select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset
do $$
declare
  r record;
begin
  update public.goals set deleted_at = now() where id = (select id from gt_ids where name = 'dropped');
  select * into r from public.goal_progress() where goal_id = (select id from gt_ids where name = 'parent');
  assert r.sub_goal_count = 3, 'deleted sub-goals are not counted';
  update public.goals set deleted_at = now() where id = (select id from gt_ids where name = 'parent');
  assert not exists (select 1 from public.goal_progress() where goal_id = (select id from gt_ids where name = 'parent')),
    'deleted goals have no progress row';
  assert exists (select 1 from public.goal_progress() where goal_id = (select id from gt_ids where name = 'mid')),
    'their sub-goals still do';
end $$;

-- EXECUTE surface ------------------------------------------------------------------------------

reset role;
do $$
begin
  assert not has_function_privilege('anon', 'public.goal_hidden_project_count(uuid)', 'execute'), 'not for anon';
  assert not has_function_privilege('anon', 'public.goal_progress(uuid)', 'execute'), 'not for anon';
  assert not has_function_privilege('anon', 'public.add_team_to_project(uuid, uuid, text)', 'execute'), 'not for anon';
  assert has_function_privilege('authenticated', 'public.goal_hidden_project_count(uuid)', 'execute'), 'members count';
  assert not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.proname in ('is_team_lead', 'can_manage_team', 'add_team_member', 'update_team_member_role',
        'remove_team_member', 'add_team_to_project', 'goal_editable', 'can_edit_goal', 'goal_progress',
        'goal_task_counts', 'guard_team', 'guard_team_member', 'guard_team_project', 'guard_goal', 'guard_goal_link',
        'guard_goal_status_update', 'apply_goal_status_update', 'add_team_creator_lead', 'oldest_workspace_id',
        'profile_in_workspace')
  ), 'everything else in this phase is SECURITY INVOKER';
end $$;

select 'goals and teams smoke: all assertions passed' as result;
