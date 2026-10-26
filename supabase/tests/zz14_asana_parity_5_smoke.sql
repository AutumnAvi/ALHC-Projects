-- Behavioural checks for Phase: Asana parity, batch 5: the team Overview's curated work
-- (team_curated_work, can_curate_team), the Admin console's last activity
-- (list_workspace_member_activity), and Inbox bookmarks (inbox_items.bookmarked_at).
-- Fresh people for this suite:
--   fefe…01 ap5-owner@example.com     owner of AP5 P, AP5 Secret P, and AP5 Portfolio; lead of AP5 Team
--   fefe…02 ap5-member@example.com    member of AP5 Team; Editor of AP5 P; Viewer of AP5 Portfolio;
--                                     not in AP5 Secret P
--   fefe…03 ap5-outsider@example.com  Viewer of AP5 P; not on AP5 Team
--   fefe…04 ap5-admin@example.com     workspace admin, no memberships

\set ON_ERROR_STOP 1

create temporary table ap5_ids (name text primary key, id uuid) on commit preserve rows;
grant all on ap5_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('ap5-owner@example.com', 'asana parity 5 suite'),
  ('ap5-member@example.com', 'asana parity 5 suite'),
  ('ap5-outsider@example.com', 'asana parity 5 suite'),
  ('ap5-admin@example.com', 'asana parity 5 suite');
insert into auth.users (id, email, email_confirmed_at, last_sign_in_at, raw_user_meta_data) values
  ('fefefefe-0000-4000-8000-000000000001', 'ap5-owner@example.com', now(), '2026-10-10 09:30+00', '{"full_name":"Olga Owner"}'),
  ('fefefefe-0000-4000-8000-000000000002', 'ap5-member@example.com', now(), '2026-10-11 16:00+00', '{"full_name":"Milo Member"}'),
  ('fefefefe-0000-4000-8000-000000000003', 'ap5-outsider@example.com', now(), null, '{"full_name":"Oscar Outsider"}'),
  ('fefefefe-0000-4000-8000-000000000004', 'ap5-admin@example.com', now(), '2026-10-12 08:00+00', '{"full_name":"Ada Admin"}');
insert into public.workspace_admins (workspace_id, profile_id)
values ('00000000-0000-4000-8000-000000000001', 'fefefefe-0000-4000-8000-000000000004');

-- EXECUTE surface and grants --------------------------------------------------------------------------

do $$
begin
  assert has_function_privilege('authenticated', 'public.list_workspace_member_activity()', 'execute'),
    'signed-in people may call it (it refuses non-admins itself)';
  assert not has_function_privilege('anon', 'public.list_workspace_member_activity()', 'execute'), 'anon can''t';
  assert (select prosecdef from pg_proc where oid = 'public.list_workspace_member_activity()'::regprocedure),
    'activity is definer (pinned in suite 60)';
  assert has_function_privilege('authenticated', 'public.can_curate_team(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.can_curate_team(uuid)', 'execute'), 'can_curate_team is for members';
  assert not (select prosecdef from pg_proc where oid = 'public.can_curate_team(uuid)'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.guard_team_curated_work()'::regprocedure),
    'the curation helper and guard are invoker';
  assert not has_function_privilege('anon', 'public.guard_team_curated_work()', 'execute'), 'anon gets no guard';
  assert not has_table_privilege('anon', 'public.team_curated_work', 'select')
    and not has_table_privilege('anon', 'public.team_curated_work', 'insert')
    and not has_table_privilege('anon', 'public.team_curated_work', 'update'), 'anon has nothing on curated work';
  assert not has_table_privilege('authenticated', 'public.team_curated_work', 'delete')
    and not has_column_privilege('authenticated', 'public.team_curated_work', 'team_id', 'update')
    and not has_column_privilege('authenticated', 'public.team_curated_work', 'created_by', 'insert')
    and has_column_privilege('authenticated', 'public.team_curated_work', 'deleted_at', 'update'),
    'curated work: insert targets, update order and removal only';
  assert has_column_privilege('authenticated', 'public.inbox_items', 'bookmarked_at', 'update')
    and not has_column_privilege('authenticated', 'public.inbox_items', 'kind', 'update')
    and not has_column_privilege('anon', 'public.inbox_items', 'bookmarked_at', 'update'),
    'recipients bookmark through a column grant';
  assert (select relrowsecurity from pg_class where oid = 'public.team_curated_work'::regclass), 'RLS is on';
end $$;

-- Setup ------------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'fefefefe-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  team uuid;
  p uuid;
  pf uuid;
  t uuid;
begin
  insert into public.teams (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'AP5 Team') returning id into team;
  perform public.add_team_member(team, 'ap5-member@example.com', 'member');
  insert into ap5_ids values ('team', team);
  insert into public.teams (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'AP5 Other team') returning id into team;
  insert into ap5_ids values ('other_team', team);

  insert into public.projects (workspace_id, name, team_id) values ('00000000-0000-4000-8000-000000000001', 'AP5 P', (select id from ap5_ids where name = 'team')) returning id into p;
  perform public.add_project_member(p, 'ap5-member@example.com', 'editor');
  perform public.add_project_member(p, 'ap5-outsider@example.com', 'viewer');
  insert into ap5_ids values ('p', p);
  insert into public.projects (workspace_id, name, team_id) values ('00000000-0000-4000-8000-000000000001', 'AP5 Secret P', (select id from ap5_ids where name = 'team')) returning id into p;
  insert into ap5_ids values ('secret_p', p);

  insert into public.portfolios (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'AP5 Portfolio') returning id into pf;
  perform public.add_portfolio_member(pf, 'ap5-member@example.com', 'viewer');
  insert into ap5_ids values ('portfolio', pf);

  select public.create_task((select id from ap5_ids where name = 'p'), null, 'AP5 task') into t;
  insert into ap5_ids values ('task', t);
end $$;

-- Curated work: the lead pins a project, a private project, and a portfolio -----------------------------

do $$
declare
  team uuid := (select id from ap5_ids where name = 'team');
  w uuid;
begin
  assert public.can_curate_team(team), 'a lead curates';
  insert into public.team_curated_work (team_id, project_id, sort_order)
  values (team, (select id from ap5_ids where name = 'p'), 1024) returning id into w;
  insert into ap5_ids values ('cw_p', w);
  insert into public.team_curated_work (team_id, project_id, sort_order)
  values (team, (select id from ap5_ids where name = 'secret_p'), 2048) returning id into w;
  insert into ap5_ids values ('cw_secret', w);
  insert into public.team_curated_work (team_id, portfolio_id, sort_order)
  values (team, (select id from ap5_ids where name = 'portfolio'), 3072) returning id into w;
  insert into ap5_ids values ('cw_portfolio', w);
  assert (select created_by from public.team_curated_work where id = w) = 'fefefefe-0000-4000-8000-000000000001',
    'the creator is the caller';

  begin
    insert into public.team_curated_work (team_id, project_id) values (team, (select id from ap5_ids where name = 'p'));
    raise exception 'a project is pinned once per team';
  exception when unique_violation then null;
  end;
  begin
    insert into public.team_curated_work (team_id, project_id, portfolio_id)
    values (team, (select id from ap5_ids where name = 'p'), (select id from ap5_ids where name = 'portfolio'));
    raise exception 'one target per row';
  exception when check_violation then null;
  end;
end $$;

-- Rows never move to another team (the guard; team_id isn't even updatable by clients).
reset role;
do $$
begin
  begin
    update public.team_curated_work set team_id = (select id from ap5_ids where name = 'other_team')
    where id = (select id from ap5_ids where name = 'cw_p');
    raise exception 'curated work can''t move teams';
  exception when insufficient_privilege then null;
  end;
end $$;
set role authenticated;

-- A team member: curates, sees only what they can open, can't pin what they can't open --------------

select set_config('request.jwt.claim.sub', 'fefefefe-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  team uuid := (select id from ap5_ids where name = 'team');
  mine uuid;
  n integer;
begin
  assert public.can_curate_team(team), 'a team member curates';
  assert exists (select 1 from public.team_curated_work where id = (select id from ap5_ids where name = 'cw_p')),
    'a member of the project sees it';
  assert exists (select 1 from public.team_curated_work where id = (select id from ap5_ids where name = 'cw_portfolio')),
    'a portfolio member sees the portfolio';
  assert not exists (select 1 from public.team_curated_work where id = (select id from ap5_ids where name = 'cw_secret')),
    'a private project the member isn''t in stays invisible, even curated by their team';
  assert (select count(*) from public.team_curated_work where team_id = team) = 2, 'two visible items';

  -- A project they can't read doesn't exist for them (the guard says so before RLS would refuse it).
  begin
    insert into public.team_curated_work (team_id, project_id) values (team, (select id from ap5_ids where name = 'secret_p'));
    raise exception 'nobody pins a project they can''t open';
  exception when no_data_found then null;
  end;

  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'AP5 Mine') returning id into mine;
  insert into ap5_ids values ('mine', mine);
  insert into public.team_curated_work (team_id, project_id, sort_order) values (team, mine, 4096);

  update public.team_curated_work set sort_order = 512 where id = (select id from ap5_ids where name = 'cw_portfolio');
  get diagnostics n = row_count;
  assert n = 1, 'members reorder';

  update public.team_curated_work set deleted_at = now() where id = (select id from ap5_ids where name = 'cw_p');
  get diagnostics n = row_count;
  assert n = 1, 'members unpin';
  begin
    update public.team_curated_work set deleted_at = null where id = (select id from ap5_ids where name = 'cw_p');
    raise exception 'an unpinned row stays unpinned';
  exception when check_violation then null;
  end;
  insert into public.team_curated_work (team_id, project_id) values (team, (select id from ap5_ids where name = 'p'));
  assert (select count(*) from public.team_curated_work
          where team_id = team and project_id = (select id from ap5_ids where name = 'p') and deleted_at is null) = 1,
    'pinning again makes a new row';

  begin
    update public.team_curated_work set created_by = auth.uid() where id = (select id from ap5_ids where name = 'cw_portfolio');
    raise exception 'the creator column isn''t writable';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Someone outside the team: sees what they can open, curates nothing ------------------------------------

select set_config('request.jwt.claim.sub', 'fefefefe-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
declare
  team uuid := (select id from ap5_ids where name = 'team');
  n integer;
  theirs uuid;
  their_portfolio uuid;
begin
  assert not public.can_curate_team(team), 'outsiders don''t curate';
  -- Since Oct 26 notes, batch 4 curated work shows inside the team only, even for a project they can read.
  assert not exists (select 1 from public.team_curated_work
                 where team_id = team and project_id = (select id from ap5_ids where name = 'p') and deleted_at is null),
    'someone outside the team doesn''t see its curated work, even a project they can read';
  assert not exists (select 1 from public.team_curated_work where portfolio_id is not null and team_id = team),
    'a portfolio they aren''t in stays invisible';
  assert not exists (select 1 from public.team_curated_work where project_id = (select id from ap5_ids where name = 'mine')),
    'someone else''s private project stays invisible';
  -- A project of their own (not pinned yet, so only the insert policy can refuse it) and one they can
  -- read: outsiders pin neither, and the guard lets both through to RLS.
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'AP5 Outsider P')
  returning id into theirs;
  begin
    insert into public.team_curated_work (team_id, project_id) values (team, theirs);
    raise exception 'outsiders can''t pin their own project';
  exception when insufficient_privilege then null;
  end;
  insert into public.portfolios (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'AP5 Outsider portfolio')
  returning id into their_portfolio;
  begin
    insert into public.team_curated_work (team_id, portfolio_id) values (team, their_portfolio);
    raise exception 'outsiders can''t pin their own portfolio';
  exception when insufficient_privilege then null;
  end;
  update public.team_curated_work set deleted_at = now()
  where team_id = team and project_id = (select id from ap5_ids where name = 'p') and deleted_at is null;
  get diagnostics n = row_count;
  assert n = 0, 'outsiders can''t unpin';
  update public.team_curated_work set sort_order = 1 where team_id = team;
  get diagnostics n = row_count;
  assert n = 0, 'outsiders can''t reorder or unpin';
end $$;

-- A workspace admin manages the team but sees no project they can't open, and can't pin one ----------------

select set_config('request.jwt.claim.sub', 'fefefefe-0000-4000-8000-000000000004', false) is not null as ok \gset

do $$
declare
  team uuid := (select id from ap5_ids where name = 'team');
begin
  assert public.is_workspace_admin(), 'the admin is a workspace admin';
  assert public.can_curate_team(team), 'workspace admins curate (they manage every team)';
  assert not exists (select 1 from public.team_curated_work where team_id = team),
    'workspace admins see no curated project or portfolio they can''t open';
  begin
    insert into public.team_curated_work (team_id, project_id) values (team, (select id from ap5_ids where name = 'secret_p'));
    raise exception 'workspace admins can''t pin a private project';
  exception when no_data_found then null;
  end;
end $$;

-- A removed team takes no new pins --------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'fefefefe-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  team uuid := (select id from ap5_ids where name = 'other_team');
begin
  update public.teams set deleted_at = now() where id = team;
  begin
    insert into public.team_curated_work (team_id, project_id) values (team, (select id from ap5_ids where name = 'p'));
    raise exception 'a removed team takes no pins';
  exception when no_data_found or insufficient_privilege then null;
  end;
end $$;

-- Admin console: last activity -------------------------------------------------------------------------

do $$
begin
  begin
    perform public.list_workspace_member_activity();
    raise exception 'members can''t list activity';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'fefefefe-0000-4000-8000-000000000004', false) is not null as ok \gset

do $$
begin
  assert (select last_sign_in_at from public.list_workspace_member_activity() where email = 'ap5-member@example.com')
    = '2026-10-11 16:00+00'::timestamptz, 'admins see when someone last signed in';
  assert exists (select 1 from public.list_workspace_member_activity()
                 where email = 'ap5-outsider@example.com' and last_sign_in_at is null), 'never signed in = null';
  assert (select count(*) from public.list_workspace_member_activity() where email like 'ap5-%') = 4,
    'one row per allowlisted address';
end $$;

-- Inbox bookmarks ----------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'fefefefe-0000-4000-8000-000000000001', false) is not null as ok \gset

update public.tasks set assignee_id = 'fefefefe-0000-4000-8000-000000000002'
where id = (select id from ap5_ids where name = 'task');

reset role;
insert into ap5_ids
select 'item', id from public.inbox_items
where recipient_id = 'fefefefe-0000-4000-8000-000000000002' and task_id = (select id from ap5_ids where name = 'task')
  and kind = 'assigned';
set role authenticated;

do $$
declare
  n integer;
begin
  assert (select id from ap5_ids where name = 'item') is not null, 'assigning made an inbox item';
  -- Someone else can't bookmark it (RLS: own items only).
  update public.inbox_items set bookmarked_at = now() where id = (select id from ap5_ids where name = 'item');
  get diagnostics n = row_count;
  assert n = 0, 'nobody bookmarks another person''s notification';
end $$;

select set_config('request.jwt.claim.sub', 'fefefefe-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  n integer;
begin
  assert (select bookmarked_at from public.inbox_items where id = (select id from ap5_ids where name = 'item')) is null,
    'not bookmarked yet';
  update public.inbox_items set bookmarked_at = now() where id = (select id from ap5_ids where name = 'item');
  get diagnostics n = row_count;
  assert n = 1, 'the recipient bookmarks';
  assert (select bookmarked_at is not null and read_at is null and archived_at is null
          from public.inbox_items where id = (select id from ap5_ids where name = 'item')), 'a bookmark changes nothing else';
  update public.inbox_items set archived_at = now() where id = (select id from ap5_ids where name = 'item');
  assert (select bookmarked_at is not null from public.inbox_items where id = (select id from ap5_ids where name = 'item')),
    'archiving keeps the bookmark';
  update public.inbox_items set bookmarked_at = null where id = (select id from ap5_ids where name = 'item');
  assert (select bookmarked_at is null from public.inbox_items where id = (select id from ap5_ids where name = 'item')),
    'the recipient removes the bookmark';
  begin
    update public.inbox_items set kind = 'comment' where id = (select id from ap5_ids where name = 'item');
    raise exception 'other inbox columns stay read-only';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Losing the project hides the item, bookmark or not (unchanged select policy).
select set_config('request.jwt.claim.sub', 'fefefefe-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  perform public.remove_project_member((select id from ap5_ids where name = 'p'), 'fefefefe-0000-4000-8000-000000000002');
end $$;
select set_config('request.jwt.claim.sub', 'fefefefe-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  n integer;
begin
  assert not exists (select 1 from public.inbox_items where id = (select id from ap5_ids where name = 'item')),
    'an item about a task you can no longer read is hidden';
  update public.inbox_items set bookmarked_at = now() where id = (select id from ap5_ids where name = 'item');
  get diagnostics n = row_count;
  assert n = 0, 'and can''t be bookmarked';
end $$;

reset role;

select 'zz14 asana parity 5 smoke: ok' as result;
