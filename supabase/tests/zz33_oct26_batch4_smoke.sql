-- Oct 26 notes, batch 4 (20261026020000_oct26_batch4_a.sql).
--   b4b40026…01 b4-lead@example.com     lead of B4 Team; owner of B4 P
--   b4b40026…02 b4-member@example.com   member of B4 Team (leaves it, asks to come back); Editor of B4 P
--   b4b40026…03 b4-viewer@example.com   Viewer of B4 P; never on B4 Team
--   b4b40026…04 b4-admin@example.com    workspace admin; not on B4 Team, not in B4 P
-- Everyone joins the workspace's default team on first sign-in.

\set ON_ERROR_STOP 1

insert into public.allowed_emails (email, note) values
  ('b4-lead@example.com', 'oct 26 batch 4'),
  ('b4-member@example.com', 'oct 26 batch 4'),
  ('b4-viewer@example.com', 'oct 26 batch 4'),
  ('b4-admin@example.com', 'oct 26 batch 4');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b4b40026-0000-4000-8000-000000000001', 'b4-lead@example.com', now(), '{"full_name":"Lena Lead"}'),
  ('b4b40026-0000-4000-8000-000000000002', 'b4-member@example.com', now(), '{"full_name":"Mona Member"}'),
  ('b4b40026-0000-4000-8000-000000000003', 'b4-viewer@example.com', now(), '{"full_name":"Vic Viewer"}'),
  ('b4b40026-0000-4000-8000-000000000004', 'b4-admin@example.com', now(), '{"full_name":"Abe Admin"}');
select public.seed_workspace_admin('b4-admin@example.com');

create temporary table b4_ids (name text primary key, id uuid);
grant all on b4_ids to authenticated, anon;

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['team_join_requests', 'calendar_events', 'list_collapsed_groups', 'project_view_settings', 'profile_preferences'] loop
    assert (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass), format('RLS on %s', t);
    assert not has_table_privilege('anon', 'public.' || t, 'SELECT'), format('nothing for anon on %s', t);
    assert not has_table_privilege('authenticated', 'public.' || t, 'TRUNCATE'), format('no truncate on %s', t);
  end loop;
  assert not has_table_privilege('authenticated', 'public.team_join_requests', 'INSERT')
    and not has_table_privilege('authenticated', 'public.team_join_requests', 'UPDATE'), 'requests: no client writes';
  assert (select prosecdef from pg_proc where oid = 'public.can_view_team(uuid)'::regprocedure), 'can_view_team is a definer';
  assert not (select prosecdef from pg_proc where oid = 'public.can_read_team(uuid)'::regprocedure), 'can_read_team stays invoker';
  assert not (select prosecdef from pg_proc where oid = 'public.team_access_status(uuid)'::regprocedure), 'status is invoker';
  assert not has_function_privilege('anon', 'public.request_team_join(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.decide_team_join_request(uuid, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.can_view_team(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.set_list_collapsed_groups(uuid, text[])', 'execute')
    and not has_function_privilege('anon', 'public.set_open_personal_view(boolean)', 'execute'), 'nothing for anon';
  assert not has_function_privilege('authenticated', 'public.on_team_member_close_join_request()', 'execute'), 'trigger revoked';
  assert position('team_messages' in pg_get_functiondef('public.inbox_unread_count()'::regprocedure)) = 0,
    'the unread badge no longer counts team-message items (their tab is gone)';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 1. Teams are for their members
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b4b40026-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  team uuid;
  p uuid;
begin
  insert into public.teams (name, description) values ('B4 Team', 'Batch 4') returning id into team;
  insert into b4_ids values ('team', team);
  perform public.add_team_member(team, 'b4-member@example.com', 'member');
  insert into public.projects (workspace_id, name, team_id) values ('00000000-0000-4000-8000-000000000001', 'B4 P', team)
    returning id into p;
  insert into b4_ids values ('p', p);
  perform public.add_project_member(p, 'b4-member@example.com', 'editor');
  perform public.add_project_member(p, 'b4-viewer@example.com', 'viewer');
  insert into public.team_curated_work (team_id, project_id) values (team, p);
  assert public.can_view_team(team) and public.can_read_team(team), 'the lead views the team';
  assert public.team_access_status(team) = 'member', 'a member';
  assert (select count(*) from public.team_members where team_id = team and deleted_at is null) = 2, 'and reads who is in it';
end $$;

-- The member reads it, then leaves.
select set_config('request.jwt.claim.sub', 'b4b40026-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  team uuid := (select id from b4_ids where name = 'team');
begin
  assert (select count(*) from public.team_members where team_id = team and deleted_at is null) = 2, 'members read members';
  assert exists (select 1 from public.team_curated_work where team_id = team), 'and its curated work';
  perform public.remove_team_member(team, auth.uid());
  assert not public.can_view_team(team) and not public.can_read_team(team), 'an ex-member can''t view the team';
  assert public.team_access_status(team) = 'can_request', 'but can ask to come back';
  assert (select count(*) from public.team_members where team_id = team) = 1
    and exists (select 1 from public.team_members where team_id = team and profile_id = auth.uid() and deleted_at is not null),
    'they see only their own (past) row, nobody else''s';
  assert not exists (select 1 from public.team_curated_work where team_id = team), 'nor the curated work';
  assert exists (select 1 from public.teams where id = team), 'the directory entry (name) stays visible';
  -- Their project access is untouched (teams never granted it).
  assert exists (select 1 from public.projects where id = (select id from b4_ids where name = 'p')), 'project kept';
  begin
    perform public.add_team_to_project((select id from b4_ids where name = 'p'), team, 'viewer');
    raise exception 'they can''t add a team they can''t view to a project';
  exception when no_data_found or insufficient_privilege then null;
  end;
  begin
    insert into public.calendar_events (team_id, title, start_on) values (team, 'Sneaky', '2026-11-02');
    raise exception 'ex-members add no team events';
  exception when insufficient_privilege then null;
  end;

  assert public.request_team_join(team) = 'requested', 'asked';
  assert public.request_team_join(team) = 'requested', 'asking again keeps the one request';
  assert public.team_access_status(team) = 'requested', 'shows as requested';
  assert (select count(*) from public.team_join_requests where team_id = team) = 1, 'the requester reads their request';
  begin
    perform public.decide_team_join_request((select id from public.team_join_requests where team_id = team), 'approve', 'member');
    raise exception 'a requester can''t approve themselves';
  exception when no_data_found then null;
  end;
  begin
    perform public.request_team_join(gen_random_uuid());
    raise exception 'an unknown team can''t be asked about';
  exception when no_data_found then null;
  end;
  assert public.team_access_status(gen_random_uuid()) = 'missing', 'unknown = Not found';
end $$;

-- Someone who was never on the team: nothing inside it.
select set_config('request.jwt.claim.sub', 'b4b40026-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  team uuid := (select id from b4_ids where name = 'team');
begin
  assert not exists (select 1 from public.team_members where team_id = team), 'no members';
  assert not exists (select 1 from public.team_join_requests), 'nor anyone else''s requests';
  assert public.team_access_status(team) = 'can_request', 'can ask';
end $$;

-- A workspace admin views every team (they manage teams) and could decide requests.
select set_config('request.jwt.claim.sub', 'b4b40026-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
declare
  team uuid := (select id from b4_ids where name = 'team');
begin
  assert public.can_view_team(team) and public.team_access_status(team) = 'member', 'admins view teams';
  assert (select count(*) from public.team_members where team_id = team and deleted_at is null) = 1, 'and their members';
  assert (select count(*) from public.team_join_requests where team_id = team and status = 'pending') = 1, 'and requests';
  assert not exists (select 1 from public.team_curated_work where team_id = team),
    'but still no curated project they can''t open';
end $$;

-- The lead approves.
select set_config('request.jwt.claim.sub', 'b4b40026-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  team uuid := (select id from b4_ids where name = 'team');
  req uuid := (select id from public.team_join_requests where team_id = team and status = 'pending');
begin
  assert req is not null, 'the lead reads the request';
  begin
    perform public.decide_team_join_request(req, 'maybe', 'member');
    raise exception 'approve or decline';
  exception when check_violation then null;
  end;
  assert public.decide_team_join_request(req, 'approve', 'member') = 'approved', 'approved';
  assert exists (select 1 from public.team_members where team_id = team
                   and profile_id = 'b4b40026-0000-4000-8000-000000000002' and deleted_at is null and role = 'member'),
    'they are back on the team';
  assert public.decide_team_join_request(req, 'decline', 'member') = 'approved', 'a decided request stays decided';
end $$;

select set_config('request.jwt.claim.sub', 'b4b40026-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  team uuid := (select id from b4_ids where name = 'team');
begin
  assert public.team_access_status(team) = 'member' and public.can_read_team(team), 'they can open the team again';
end $$;

-- The viewer asks; the lead adds them another way, which closes the request; then a decline.
select set_config('request.jwt.claim.sub', 'b4b40026-0000-4000-8000-000000000003', false) is not null as ok \gset
select public.request_team_join((select id from b4_ids where name = 'team')) = 'requested' as ok \gset
select set_config('request.jwt.claim.sub', 'b4b40026-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  team uuid := (select id from b4_ids where name = 'team');
begin
  perform public.add_team_member(team, 'b4-viewer@example.com', 'member');
  assert (select status from public.team_join_requests
          where team_id = team and requester_id = 'b4b40026-0000-4000-8000-000000000003') = 'approved',
    'joining another way closes the open request';
  perform public.remove_team_member(team, 'b4b40026-0000-4000-8000-000000000003');
end $$;
select set_config('request.jwt.claim.sub', 'b4b40026-0000-4000-8000-000000000003', false) is not null as ok \gset
select public.request_team_join((select id from b4_ids where name = 'team')) = 'requested' as ok \gset
select set_config('request.jwt.claim.sub', 'b4b40026-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  team uuid := (select id from b4_ids where name = 'team');
  req uuid := (select id from public.team_join_requests where team_id = team and status = 'pending');
begin
  assert public.decide_team_join_request(req, 'decline') = 'declined', 'declined';
  assert not exists (select 1 from public.team_members where team_id = team
                       and profile_id = 'b4b40026-0000-4000-8000-000000000003' and deleted_at is null), 'not added';
end $$;

-- The default team: anyone who left it joins again at once.
select set_config('request.jwt.claim.sub', 'b4b40026-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  dt uuid := (select default_team_id from public.workspaces where id = '00000000-0000-4000-8000-000000000001');
begin
  assert dt is not null, 'the workspace has a default team';
  if exists (select 1 from public.team_members where team_id = dt and profile_id = auth.uid() and deleted_at is null) then
    perform public.remove_team_member(dt, auth.uid());
  end if;
  assert public.team_access_status(dt) = 'can_join', 'the default team can be joined directly';
  assert public.request_team_join(dt) = 'member', 'joined';
  assert public.can_view_team(dt), 'and views it';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 4. Calendar events
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b4b40026-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b4_ids where name = 'p');
  team uuid := (select id from b4_ids where name = 'team');
  e uuid;
  te uuid;
begin
  insert into public.calendar_events (project_id, title, start_on, end_on, notes)
  values (p, '  Launch week  ', '2026-11-09', '2026-11-13', '  Booth at the fair ')
  returning id into e;
  insert into b4_ids values ('event', e);
  assert (select title = 'Launch week' and notes = 'Booth at the fair' and created_by = auth.uid()
          from public.calendar_events where id = e), 'an Editor adds a project event (trimmed, theirs)';
  -- A time sets its day in the event's time zone.
  insert into public.calendar_events (project_id, title, start_on, start_at, end_at, time_zone)
  values (p, 'Kickoff call', '2026-01-01', '2026-11-03 23:30+00', '2026-11-04 00:30+00', 'America/New_York')
  returning id into te;
  assert (select start_on = '2026-11-03' and end_on = '2026-11-03' from public.calendar_events where id = te),
    'times decide the days (7:30 pm in New York)';
  begin
    insert into public.calendar_events (project_id, title, start_on, end_on) values (p, 'Backwards', '2026-11-10', '2026-11-09');
    raise exception 'an event ends on or after it starts';
  exception when check_violation then null;
  end;
  begin
    insert into public.calendar_events (project_id, team_id, title, start_on) values (p, team, 'Both', '2026-11-10');
    raise exception 'one calendar per event';
  exception when check_violation then null;
  end;
  begin
    insert into public.calendar_events (project_id, title, start_on) values (p, '   ', '2026-11-10');
    raise exception 'events need a title';
  exception when check_violation then null;
  end;
  update public.calendar_events set title = 'Launch week (moved)', start_on = '2026-11-16', end_on = '2026-11-20' where id = e;
  assert (select start_on from public.calendar_events where id = e) = '2026-11-16', 'Editors change events';
  begin
    update public.calendar_events set team_id = team where id = e;
    raise exception 'events stay on their calendar';
  exception when insufficient_privilege or check_violation then null;
  end;
  -- Team events: members add them.
  insert into public.calendar_events (team_id, title, start_on) values (team, 'Team offsite', '2026-11-20') returning id into e;
  insert into b4_ids values ('team_event', e);
end $$;

select set_config('request.jwt.claim.sub', 'b4b40026-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b4_ids where name = 'p');
  n int;
begin
  assert exists (select 1 from public.calendar_events where id = (select id from b4_ids where name = 'event')),
    'a Viewer reads project events';
  assert not exists (select 1 from public.calendar_events where id = (select id from b4_ids where name = 'team_event')),
    'someone off the team doesn''t read team events';
  begin
    insert into public.calendar_events (project_id, title, start_on) values (p, 'Viewer event', '2026-11-10');
    raise exception 'Viewers add no events';
  exception when insufficient_privilege then null;
  end;
  update public.calendar_events set title = 'Renamed by a viewer' where id = (select id from b4_ids where name = 'event');
  get diagnostics n = row_count;
  assert n = 0, 'Viewers change no events';
end $$;

select set_config('request.jwt.claim.sub', 'b4b40026-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.calendar_events where id = (select id from b4_ids where name = 'event')),
    'a workspace admin outside the project reads none of its events';
  assert exists (select 1 from public.calendar_events where id = (select id from b4_ids where name = 'team_event')),
    'but reads team events (they view every team)';
end $$;

select set_config('request.jwt.claim.sub', 'b4b40026-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  e uuid := (select id from b4_ids where name = 'event');
begin
  update public.calendar_events set deleted_at = '2000-01-01' where id = e;
  assert (select deleted_at > now() - interval '1 minute' from public.calendar_events where id = e), 'removal is stamped now';
  begin
    update public.calendar_events set deleted_at = null where id = e;
    raise exception 'a removed event stays removed';
  exception when check_violation then null;
  end;
end $$;

reset role;
set role anon;
do $$
begin
  begin
    perform 1 from public.calendar_events limit 1;
    raise exception 'anon reads no events';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set role authenticated;

-- ---------------------------------------------------------------------------------------------
-- 8. Collapsed List groups
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b4b40026-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b4_ids where name = 'p');
begin
  assert public.set_list_collapsed_groups(p, array['section-b', 'section-a', 'section-a', '']) = array['section-a', 'section-b'],
    'a Viewer saves their collapsed groups (deduped, sorted, empty keys dropped)';
  assert public.set_list_collapsed_groups(p, array['section-none']) = array['section-none'], 'replaced';
  assert (select group_keys from public.list_collapsed_groups where project_id = p) = array['section-none'], 'read back';
  begin
    perform public.set_list_collapsed_groups(gen_random_uuid(), array['x']);
    raise exception 'a project you can''t read';
  exception when no_data_found then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'b4b40026-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.list_collapsed_groups where profile_id <> auth.uid()), 'own rows only';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 9. / 10. Tabs, the default view, personal views
-- ---------------------------------------------------------------------------------------------

-- The Editor: hides tabs, adds and renames shared tabs, but can't change what a shared view shows.
select set_config('request.jwt.claim.sub', 'b4b40026-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b4_ids where name = 'p');
  shared uuid := (select id from public.project_views where project_id = p and layout = 'list' and owner_id is null limit 1);
  added uuid;
  mine uuid;
begin
  insert into b4_ids values ('shared_view', shared);
  insert into public.project_view_settings (project_id, hidden_tabs) values (p, array['files', 'dashboard', 'files']);
  assert (select hidden_tabs from public.project_view_settings where project_id = p) = array['dashboard', 'files'],
    'Editors hide tabs (deduped)';
  begin
    update public.project_view_settings set hidden_tabs = array['calendar'] where project_id = p;
    raise exception 'only the fixed tabs can be hidden';
  exception when check_violation then null;
  end;
  begin
    update public.project_view_settings set default_view_id = shared where project_id = p;
    raise exception 'only owners choose the default view';
  exception when insufficient_privilege then null;
  end;

  update public.project_views set name = 'Everything' where id = shared;
  assert (select name from public.project_views where id = shared) = 'Everything', 'Editors rename shared tabs';
  begin
    update public.project_views set config = '{"group_by": "none"}' where id = shared;
    raise exception 'only owners change a shared view';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.project_views set layout = 'board' where id = shared;
    raise exception 'nor its layout';
  exception when insufficient_privilege then null;
  end;
  insert into public.project_views (project_id, name, layout, config) values (p, 'New board', 'board', '{"group_by": "none"}')
    returning id into added;
  assert added is not null, 'Editors add shared tabs';

  -- A personal view: theirs only.
  insert into public.project_views (project_id, name, layout, config, owner_id)
  values (p, 'My list', 'list', '{"group_by": "assignee"}', auth.uid()) returning id into mine;
  insert into b4_ids values ('editor_view', mine);
  update public.project_views set config = '{"group_by": "none"}' where id = mine;
  assert (select config ->> 'group_by' from public.project_views where id = mine) = 'none', 'they change their own view';
  begin
    update public.project_views set owner_id = null where id = mine;
    raise exception 'a personal view stays personal';
  exception when check_violation then null;
  end;
  begin
    insert into public.project_views (project_id, name, layout, owner_id)
    values (p, 'For Lena', 'list', 'b4b40026-0000-4000-8000-000000000001');
    raise exception 'nobody saves a view for someone else';
  exception when insufficient_privilege then null;
  end;
end $$;

-- The Viewer: saves a personal view, sees no one else's, hides no tabs.
select set_config('request.jwt.claim.sub', 'b4b40026-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b4_ids where name = 'p');
  mine uuid;
  n int;
begin
  insert into public.project_views (project_id, name, layout, config, owner_id)
  values (p, 'Viewer list', 'list', '{}', auth.uid()) returning id into mine;
  assert mine is not null, 'Viewers save personal views';
  assert not exists (select 1 from public.project_views where id = (select id from b4_ids where name = 'editor_view')),
    'nobody reads someone else''s personal view';
  assert exists (select 1 from public.project_view_settings where project_id = p), 'Viewers read the tab settings';
  update public.project_view_settings set hidden_tabs = '{}' where project_id = p;
  get diagnostics n = row_count;
  assert n = 0, 'Viewers can''t show or hide tabs';
  begin
    insert into public.project_views (project_id, name, layout) values (p, 'Shared by a viewer', 'list');
    raise exception 'Viewers add no shared tabs';
  exception when insufficient_privilege then null;
  end;
  assert public.set_open_personal_view(true), 'they turn on Open my saved view';
  assert (select open_personal_view from public.profile_preferences where profile_id = auth.uid()), 'stored';
  assert not public.set_open_personal_view(false), 'and off';
end $$;

-- The Owner: changes the shared view and picks the default; a template copies no personal views.
select set_config('request.jwt.claim.sub', 'b4b40026-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b4_ids where name = 'p');
  shared uuid := (select id from b4_ids where name = 'shared_view');
  copy jsonb;
  shared_count int;
begin
  update public.project_views set config = '{"group_by": "none"}' where id = shared;
  assert (select config ->> 'group_by' from public.project_views where id = shared) = 'none', 'Owners change shared views';
  update public.project_view_settings set default_view_id = shared where project_id = p;
  assert (select default_view_id from public.project_view_settings where project_id = p) = shared, 'Owners pick the default';
  begin
    update public.project_view_settings set default_view_id = (select id from b4_ids where name = 'editor_view') where project_id = p;
    raise exception 'a personal view can''t be the default';
  exception when check_violation then null;
  end;
  assert not exists (select 1 from public.profile_preferences where profile_id <> auth.uid()), 'preferences: own rows only';

  select count(*) into shared_count from public.project_views where project_id = p and owner_id is null and deleted_at is null;
  copy := public.duplicate_project(p, 'B4 P copy', '{}'::jsonb);
  assert (copy ->> 'views')::int = shared_count,
    format('Duplicate project copies the %s shared views, no personal ones: %s', shared_count, copy);
  assert not exists (select 1 from public.project_views where project_id = (copy ->> 'project_id')::uuid and owner_id is not null),
    'the copy has no personal views';
end $$;

reset role;
do $$ begin raise notice 'oct 26 batch 4 smoke: all assertions passed'; end $$;
