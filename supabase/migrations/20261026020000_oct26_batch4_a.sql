-- ALHC Projects — Oct 26 notes, batch 4.
--
-- 1. Teams are for their members. Someone who isn't in a team (or left it) no longer reads its members,
--    curated work, pending invites, messages, or calendar events; the app sends them to "You're not part
--    of this team" with Join (the workspace's default team) or Request to join (every other team).
--      * can_view_team(team) (definer, used inside policies): an active member, or a workspace admin of the
--        team's workspace (they manage teams in the Admin console). Pinned in suite 60.
--      * can_read_team(team) (invoker, same signature) = the team is live and can_view_team. Team messages,
--        their Inbox items, team calendar links, and calendar events all follow it.
--      * team_members' read policy: your own rows, and the rows of teams you can view (altered, renamed
--        team_members_select_reader). team_curated_work and team pending invites are altered the same way.
--      * add_team_to_project (asserted patch): only a team the caller can view can be added to a project
--        (adding it would show who is in it), "Team not found" otherwise.
--      * inbox_unread_count (asserted patch): the badge stops counting team-message items (the team
--        Messages tab is gone and the Inbox no longer lists them; the data is kept).
--      * team_join_requests (the requester and the team's managers read; written only by the definer
--        functions below), team_access_status(team) (invoker): member | can_join | can_request | requested |
--        missing; request_team_join(team) (definer: joins the default team at once, else one open request,
--        10 an hour per person, 3 a week per team); decide_team_join_request(request, decision, role)
--        (definer: the team's leads and workspace admins). Joining any other way closes the request.
--        Inbox items can't point at a team (its target CHECK), so managers see requests on the team's
--        Members tab.
--
-- 4. Calendar events: non-task events (title, a date or a date range, optional start / end times, notes)
--    on a project or a team calendar (calendar_events). Project events: Viewers read, Editors+ add, change,
--    and remove them (has_project_role). Team events: whoever can read the team reads them; its members,
--    leads, and workspace admins add, change, and remove them (the team's "editors": a team has no
--    viewer role).
--
-- 8. List groups a person collapsed stay collapsed (list_collapsed_groups: own rows, Viewer+ of the
--    project; set_list_collapsed_groups, invoker).
--
-- 9. / 10. Project tabs and views.
--      * project_view_settings (one row per project): hidden_tabs (Overview, Dashboard, Messages, Workload,
--        Files can be hidden and re-added; Editors+) and default_view_id (the project's default view; only
--        Owners set it). Viewers read it.
--      * project_views.owner_id: null = a shared tab (as before), set = someone's personal view, which only
--        they read and change (Viewer+ of the project). Editors+ still add, rename, reorder, and remove
--        shared tabs; only the project's Owners change what a shared view shows (its layout or config),
--        everyone else saves their changes as a personal view. project_snapshot (asserted patch) copies
--        shared views only.
--      * profile_preferences (own rows): open_personal_view = open my own saved view of a project first.
--
-- Additive: no tail.

create or replace function public.alhc_patch_function(target regprocedure, variadic edits text[])
returns void
language plpgsql
set search_path = ''
as $$
declare
  def text := pg_get_functiondef(target);
  hits integer;
begin
  if coalesce(array_length(edits, 1), 0) = 0 or array_length(edits, 1) % 2 <> 0 then
    raise exception 'alhc_patch_function(%): pass (old, new) text pairs', target;
  end if;
  for i in 1 .. array_length(edits, 1) / 2 loop
    if coalesce(edits[2 * i - 1], '') = '' then
      raise exception 'alhc_patch_function(%): edit % has no text to replace', target, i;
    end if;
    hits := (length(def) - length(replace(def, edits[2 * i - 1], ''))) / length(edits[2 * i - 1]);
    if hits <> 1 then
      raise exception 'alhc_patch_function(%): edit % matched % times (expected exactly once)', target, i, hits;
    end if;
    def := replace(def, edits[2 * i - 1], edits[2 * i]);
  end loop;
  execute def;
end;
$$;

revoke all on function public.alhc_patch_function(regprocedure, text[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. Teams are for their members
-- ---------------------------------------------------------------------------

-- May the caller see inside a team (its members, work, calendar)? An active member, or a workspace admin
-- of its workspace. Definer: team_members' own read policy calls it, so it must not read through RLS.
create or replace function public.can_view_team(target_team uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and public.is_allowlisted() and (
    exists (
      select 1 from public.team_members m
      where m.team_id = target_team and m.profile_id = auth.uid() and m.deleted_at is null
    )
    or exists (
      select 1 from public.teams t
      where t.id = target_team and public.is_workspace_admin(t.workspace_id)
    )
  );
$$;

revoke all on function public.can_view_team(uuid) from public, anon;
grant execute on function public.can_view_team(uuid) to authenticated;

-- Who reads a team's messages, calendar events, and calendar links: whoever can view the team, while it's
-- live (same signature and grants; the directory itself — names and descriptions — stays workspace-level).
create or replace function public.can_read_team(target_team uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select public.is_allowlisted()
    and exists (select 1 from public.teams t where t.id = target_team and t.deleted_at is null)
    and public.can_view_team(target_team);
$$;

-- Members: your own rows (current and past), and the rows of teams you can view.
alter policy team_members_select_allowlisted on public.team_members
  using (
    (select public.is_allowlisted())
    and (profile_id = (select auth.uid()) or (select public.can_view_team(team_id)))
  );
alter policy team_members_select_allowlisted on public.team_members rename to team_members_select_reader;

-- Curated work: as before (only people who can open the target), and only inside the team.
alter policy team_curated_work_select_viewer on public.team_curated_work
  using (
    (select public.can_view_team(team_id))
    and (
      (project_id is not null and (select public.has_project_role(project_id, 'viewer')))
      or (portfolio_id is not null and (select public.has_portfolio_role(portfolio_id, 'viewer')))
    )
  );

-- Team invites waiting for a first sign-in: the team's readers (projects and portfolios unchanged).
alter policy pending_memberships_select_viewer on public.pending_memberships
  using (
    (project_id is not null and (select public.has_project_role(project_id, 'viewer')))
    or (portfolio_id is not null and (select public.has_portfolio_role(portfolio_id, 'viewer')))
    or (team_id is not null and (select public.can_view_team(team_id)))
  );

-- Adding a team to a project adds its members, so it needs a team the caller can view.
select public.alhc_patch_function('public.add_team_to_project(uuid, uuid, text)'::regprocedure,
  'if not exists (select 1 from public.teams t where t.id = target_team and t.deleted_at is null) then',
  'if not exists (select 1 from public.teams t where t.id = target_team and t.deleted_at is null)
     or not public.can_view_team(target_team) then'
);

-- The Inbox no longer lists team messages (their tab is gone; Oct 26 notes, batch 4), so the unread
-- badge stops counting them too (it counted them for anyone, members or not).
select public.alhc_patch_function('public.inbox_unread_count()'::regprocedure,
  '      or (
        i.task_id is null
        and exists (
          select 1
          from public.team_messages m
          join public.teams tm on tm.id = m.team_id and tm.deleted_at is null
          where m.id = i.team_message_id
        )
      )
',
  ''
);

create table if not exists public.team_join_requests (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id),
  requester_id uuid not null references public.profiles (id),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  granted_role text check (granted_role is null or granted_role in ('lead', 'member')),
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists team_join_requests_open_idx
  on public.team_join_requests (team_id, requester_id) where status = 'pending';
create index if not exists team_join_requests_requester_idx
  on public.team_join_requests (requester_id, created_at desc);
create index if not exists team_join_requests_team_idx
  on public.team_join_requests (team_id, created_at desc);
create index if not exists team_join_requests_decided_by_idx
  on public.team_join_requests (decided_by) where decided_by is not null;

alter table public.team_join_requests enable row level security;
revoke all on public.team_join_requests from anon, authenticated;
select public.alhc_revoke_anon_grants(array['team_join_requests']);
select public.alhc_revoke_client_truncate(array['team_join_requests']);
grant select on public.team_join_requests to authenticated;

comment on table public.team_join_requests is
  'Oct 26 notes (batch 4): someone asking to join a team they aren''t part of. Read by the requester and '
  'the team''s leads and workspace admins; written only by request_team_join / decide_team_join_request '
  'and the team_members trigger.';

create policy team_join_requests_select_own_or_manager on public.team_join_requests
  for select to authenticated
  using (
    (select public.is_allowlisted())
    and (requester_id = (select auth.uid()) or (select public.can_manage_team(team_id)))
  );

create trigger team_join_requests_set_updated_at
  before update on public.team_join_requests
  for each row execute function public.set_updated_at();

-- What the not-part-of-this-team page shows. "missing" only for a team that's gone (or never was);
-- "can_join" for the workspace's default team (everyone is in it unless they left). Invoker: teams are
-- readable by everyone allowlisted, and a person reads their own memberships and requests.
create or replace function public.team_access_status(target_team uuid)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  t public.teams;
begin
  if auth.uid() is null or not public.is_allowlisted() then
    return 'missing';
  end if;
  select * into t from public.teams x where x.id = target_team and x.deleted_at is null;
  if not found then
    return 'missing';
  end if;
  if public.can_view_team(t.id) then
    return 'member';
  end if;
  if exists (select 1 from public.workspaces w where w.id = t.workspace_id and w.default_team_id = t.id) then
    return 'can_join';
  end if;
  if exists (
    select 1 from public.team_join_requests r
    where r.team_id = t.id and r.requester_id = auth.uid() and r.status = 'pending'
  ) then
    return 'requested';
  end if;
  return 'can_request';
end;
$$;

revoke all on function public.team_access_status(uuid) from public, anon;
grant execute on function public.team_access_status(uuid) to authenticated;

-- Joins the default team at once; any other team gets one open request its leads decide on.
create or replace function public.request_team_join(target_team uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  t public.teams;
begin
  if me is null or not public.is_allowlisted() then
    raise exception 'Sign in to join a team' using errcode = 'insufficient_privilege';
  end if;
  perform pg_advisory_xact_lock(hashtext('alhc_team_join:' || me::text));
  select * into t from public.teams x where x.id = target_team and x.deleted_at is null;
  if not found then
    raise exception 'Team not found' using errcode = 'no_data_found';
  end if;
  if exists (
    select 1 from public.team_members m
    where m.team_id = t.id and m.profile_id = me and m.deleted_at is null
  ) then
    return 'member';
  end if;
  if exists (select 1 from public.workspaces w where w.id = t.workspace_id and w.default_team_id = t.id) then
    insert into public.team_members (team_id, profile_id, role, created_by) values (t.id, me, 'member', me);
    return 'member';
  end if;
  if exists (
    select 1 from public.team_join_requests r
    where r.team_id = t.id and r.requester_id = me and r.status = 'pending'
  ) then
    return 'requested';
  end if;
  if (select count(*) from public.team_join_requests r
      where r.requester_id = me and r.created_at > now() - interval '1 hour') >= 10 then
    raise exception 'You''ve asked to join a lot of teams in the last hour. Try again later.'
      using errcode = 'check_violation';
  end if;
  if (select count(*) from public.team_join_requests r
      where r.requester_id = me and r.team_id = t.id and r.created_at > now() - interval '7 days') >= 3 then
    raise exception 'You''ve already asked to join this team several times this week.'
      using errcode = 'check_violation', hint = 'Ask one of its leads directly.';
  end if;
  insert into public.team_join_requests (team_id, requester_id) values (t.id, me);
  return 'requested';
end;
$$;

revoke all on function public.request_team_join(uuid) from public, anon;
grant execute on function public.request_team_join(uuid) to authenticated;

-- Add (as a member or a lead) or decline. The team's leads and workspace admins (can_manage_team).
create or replace function public.decide_team_join_request(
  target_request uuid,
  decision text,
  member_role text default 'member'
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  req public.team_join_requests;
begin
  if decision not in ('approve', 'decline') then
    raise exception 'Add or decline the request' using errcode = 'check_violation';
  end if;
  if coalesce(member_role, 'member') not in ('lead', 'member') then
    raise exception 'Choose lead or member' using errcode = 'check_violation';
  end if;
  select * into req from public.team_join_requests r where r.id = target_request for update;
  if not found or me is null or not public.can_manage_team(req.team_id) then
    raise exception 'Request not found' using errcode = 'no_data_found';
  end if;
  if req.status <> 'pending' then
    return req.status;
  end if;
  if not exists (select 1 from public.teams t where t.id = req.team_id and t.deleted_at is null) then
    raise exception 'Team not found' using errcode = 'no_data_found';
  end if;
  if decision = 'approve' then
    if not exists (
      select 1 from public.team_members m
      where m.team_id = req.team_id and m.profile_id = req.requester_id and m.deleted_at is null
    ) then
      -- guard_team_member checks they're still in the workspace.
      insert into public.team_members (team_id, profile_id, role, created_by)
      values (req.team_id, req.requester_id, coalesce(member_role, 'member'), me);
    end if;
    -- The team_members trigger below may have closed it already.
    update public.team_join_requests r
    set status = 'approved', granted_role = coalesce(r.granted_role, coalesce(member_role, 'member')),
        decided_by = coalesce(r.decided_by, me), decided_at = coalesce(r.decided_at, now())
    where r.id = req.id;
  else
    update public.team_join_requests r
    set status = 'declined', decided_by = me, decided_at = now()
    where r.id = req.id;
  end if;
  return (select r.status from public.team_join_requests r where r.id = req.id);
end;
$$;

revoke all on function public.decide_team_join_request(uuid, text, text) from public, anon;
grant execute on function public.decide_team_join_request(uuid, text, text) to authenticated;

-- Joining a team any other way (a lead adds them, an invite, Join) closes that person's open request.
create or replace function public.on_team_member_close_join_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is not null then
    return new;
  end if;
  update public.team_join_requests r
  set status = 'approved', granted_role = new.role, decided_by = coalesce(new.created_by, auth.uid()), decided_at = now()
  where r.team_id = new.team_id and r.requester_id = new.profile_id and r.status = 'pending';
  return new;
end;
$$;

revoke all on function public.on_team_member_close_join_request() from public, anon, authenticated;

create trigger team_members_after_insert_close_join_request
  after insert on public.team_members
  for each row execute function public.on_team_member_close_join_request();

-- ---------------------------------------------------------------------------
-- 4. Calendar events
-- ---------------------------------------------------------------------------

create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects (id),
  team_id uuid references public.teams (id),
  title text not null,
  notes text,
  start_on date not null,
  end_on date not null,
  start_at timestamptz,
  end_at timestamptz,
  time_zone text not null default 'UTC',
  created_by uuid default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint calendar_events_scope_check check (num_nonnulls(project_id, team_id) = 1),
  constraint calendar_events_title_check check (char_length(btrim(title)) between 1 and 200),
  constraint calendar_events_notes_check check (notes is null or char_length(notes) <= 5000),
  constraint calendar_events_dates_check check (end_on >= start_on and end_on - start_on <= 366),
  constraint calendar_events_times_check check (
    (end_at is null or start_at is not null) and (end_at is null or end_at >= start_at)
  )
);

create index if not exists calendar_events_project_idx
  on public.calendar_events (project_id, start_on) where deleted_at is null and project_id is not null;
create index if not exists calendar_events_team_idx
  on public.calendar_events (team_id, start_on) where deleted_at is null and team_id is not null;
create index if not exists calendar_events_created_by_idx on public.calendar_events (created_by);

alter table public.calendar_events enable row level security;
revoke all on public.calendar_events from anon, authenticated;
select public.alhc_revoke_anon_grants(array['calendar_events']);
select public.alhc_revoke_client_truncate(array['calendar_events']);

comment on table public.calendar_events is
  'Oct 26 notes (batch 4): events that aren''t tasks (an offsite, a launch day) on a project or team '
  'calendar. Project events follow the project (Viewers read, Editors+ write); team events follow the '
  'team (its readers read, its members, leads, and workspace admins write). Removed events keep their '
  'row (deleted_at).';

create trigger calendar_events_set_updated_at
  before update on public.calendar_events
  for each row execute function public.set_updated_at();

-- An event stays on its calendar, keeps its creator, and stays removed once removed; a time sets its
-- day (in the event's time zone), and a missing end is the start day.
create or replace function public.guard_calendar_event()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  tz text;
begin
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.created_by := auth.uid();
      new.created_at := now();
      new.deleted_at := null;
    end if;
  else
    if new.project_id is distinct from old.project_id or new.team_id is distinct from old.team_id
       or new.created_by is distinct from old.created_by or new.created_at <> old.created_at then
      raise exception 'An event stays on its calendar' using errcode = 'check_violation';
    end if;
    if old.deleted_at is not null then
      raise exception 'This event was removed' using errcode = 'check_violation';
    end if;
    if new.deleted_at is not null and public.is_client_role() then
      new.deleted_at := now();
    end if;
  end if;
  tz := public.safe_timezone(new.time_zone);
  new.time_zone := tz;
  new.title := btrim(coalesce(new.title, ''));
  new.notes := nullif(btrim(coalesce(new.notes, '')), '');
  if new.start_at is not null then
    new.start_on := (new.start_at at time zone tz)::date;
  end if;
  if new.end_at is not null then
    new.end_on := (new.end_at at time zone tz)::date;
  end if;
  new.end_on := coalesce(new.end_on, new.start_on);
  return new;
end;
$$;

select public.alhc_revoke_anon_execute(array['guard_calendar_event()']);
grant execute on function public.guard_calendar_event() to authenticated;

create trigger calendar_events_05_guard
  before insert or update on public.calendar_events
  for each row execute function public.guard_calendar_event();

grant select on public.calendar_events to authenticated;
grant insert (project_id, team_id, title, notes, start_on, end_on, start_at, end_at, time_zone)
  on public.calendar_events to authenticated;
grant update (title, notes, start_on, end_on, start_at, end_at, time_zone, deleted_at)
  on public.calendar_events to authenticated;

create policy calendar_events_select_reader on public.calendar_events
  for select to authenticated
  using (
    (project_id is not null and (select public.has_project_role(project_id, 'viewer')))
    or (team_id is not null and (select public.can_read_team(team_id)))
  );
-- Team events: the team's members, leads, and workspace admins (can_post_team_message's rule).
create policy calendar_events_insert_editor on public.calendar_events
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (
      (project_id is not null and (select public.has_project_role(project_id, 'editor')))
      or (team_id is not null and (select public.can_post_team_message(team_id)))
    )
  );
create policy calendar_events_update_editor on public.calendar_events
  for update to authenticated
  using (
    (project_id is not null and (select public.has_project_role(project_id, 'editor')))
    or (team_id is not null and (select public.can_post_team_message(team_id)))
  )
  with check (
    (project_id is not null and (select public.has_project_role(project_id, 'editor')))
    or (team_id is not null and (select public.can_post_team_message(team_id)))
  );

-- ---------------------------------------------------------------------------
-- 8. Collapsed List groups, per person per project
-- ---------------------------------------------------------------------------

create table if not exists public.list_collapsed_groups (
  profile_id uuid not null default auth.uid() references public.profiles (id),
  project_id uuid not null references public.projects (id),
  group_keys text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (profile_id, project_id),
  constraint list_collapsed_groups_keys_check check (cardinality(group_keys) <= 500)
);

create index if not exists list_collapsed_groups_project_idx on public.list_collapsed_groups (project_id);

alter table public.list_collapsed_groups enable row level security;
revoke all on public.list_collapsed_groups from anon, authenticated;
select public.alhc_revoke_anon_grants(array['list_collapsed_groups']);
select public.alhc_revoke_client_truncate(array['list_collapsed_groups']);
grant select on public.list_collapsed_groups to authenticated;
grant insert (project_id, group_keys) on public.list_collapsed_groups to authenticated;
grant update (group_keys) on public.list_collapsed_groups to authenticated;

comment on table public.list_collapsed_groups is
  'Oct 26 notes (batch 4): the List groups (sections, assignees, …) a person collapsed in a project. Own '
  'rows only.';

create trigger list_collapsed_groups_set_updated_at
  before update on public.list_collapsed_groups
  for each row execute function public.set_updated_at();

create policy list_collapsed_groups_select_own on public.list_collapsed_groups
  for select to authenticated using (profile_id = (select auth.uid()));
create policy list_collapsed_groups_insert_own_viewer on public.list_collapsed_groups
  for insert to authenticated
  with check (profile_id = (select auth.uid()) and (select public.has_project_role(project_id, 'viewer')));
create policy list_collapsed_groups_update_own_viewer on public.list_collapsed_groups
  for update to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()) and (select public.has_project_role(project_id, 'viewer')));

-- Saves the caller's collapsed groups for a project (keys like "section-<uuid>", at most 500, ≤ 120
-- characters each). Invoker: RLS decides.
create or replace function public.set_list_collapsed_groups(target_project uuid, keys text[])
returns text[]
language plpgsql
set search_path = ''
as $$
declare
  cleaned text[];
  stored text[];
begin
  if not public.has_project_role(target_project, 'viewer') then
    raise exception 'Project not found' using errcode = 'no_data_found';
  end if;
  select coalesce(array_agg(distinct k order by k), '{}') into cleaned
  from unnest(coalesce(keys, '{}')) k
  where k is not null and char_length(k) between 1 and 120;
  if cardinality(cleaned) > 500 then
    raise exception 'Too many collapsed groups' using errcode = 'check_violation';
  end if;
  insert into public.list_collapsed_groups as g (project_id, group_keys)
  values (target_project, cleaned)
  on conflict (profile_id, project_id) do update set group_keys = excluded.group_keys
  returning g.group_keys into stored;
  return stored;
end;
$$;

select public.alhc_revoke_anon_execute(array['set_list_collapsed_groups(uuid, text[])']);
grant execute on function public.set_list_collapsed_groups(uuid, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. / 10. Project tabs, the default view, personal views
-- ---------------------------------------------------------------------------

alter table public.project_views add column if not exists owner_id uuid references public.profiles (id);
create index if not exists project_views_owner_idx on public.project_views (owner_id, project_id);

comment on column public.project_views.owner_id is
  'Oct 26 notes (batch 4): null = a shared tab of the project; set = that person''s own saved view, which '
  'only they read and change.';

-- Shared tabs as before (Viewers read, Editors+ add / rename / reorder / remove); a personal view only for
-- its owner, who needs only Viewer+ of the project.
alter policy project_views_select_viewer on public.project_views
  using (
    (select public.has_project_role(project_id, 'viewer'))
    and (owner_id is null or owner_id = (select auth.uid()))
  );
alter policy project_views_insert_editor on public.project_views
  with check (
    (owner_id is null and (select public.has_project_role(project_id, 'editor')))
    or (owner_id = (select auth.uid()) and (select public.has_project_role(project_id, 'viewer')))
  );
alter policy project_views_update_editor on public.project_views
  using (
    (owner_id is null and (select public.has_project_role(project_id, 'editor')))
    or (owner_id = (select auth.uid()) and (select public.has_project_role(project_id, 'viewer')))
  )
  with check (
    (owner_id is null and (select public.has_project_role(project_id, 'editor')))
    or (owner_id = (select auth.uid()) and (select public.has_project_role(project_id, 'viewer')))
  );

-- A personal view is the caller's own and stays theirs; a shared view's layout and what it shows (its
-- config) change only by the project's Owners. Editors still add shared tabs (any config: a new tab or a
-- duplicate isn't a change to the one everyone uses), rename, reorder, and remove them. Runs after
-- project_views_validate, so a malformed config still reports what's wrong with it first.
create or replace function public.guard_project_view_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.is_client_role() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.owner_id is not null and new.owner_id is distinct from auth.uid() then
      raise exception 'You can only save views of your own' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if new.owner_id is distinct from old.owner_id then
    raise exception 'A view stays shared or personal' using errcode = 'check_violation';
  end if;
  if old.owner_id is null
     and (new.layout is distinct from old.layout or new.config is distinct from old.config)
     and not public.has_project_role(old.project_id, 'owner') then
    raise exception 'Only the project''s owners can change a shared view'
      using errcode = 'insufficient_privilege',
            hint = 'Save it as your own view instead.';
  end if;
  return new;
end;
$$;

select public.alhc_revoke_anon_execute(array['guard_project_view_owner()']);
grant execute on function public.guard_project_view_owner() to authenticated;

create trigger project_views_zz_guard_owner
  before insert or update on public.project_views
  for each row execute function public.guard_project_view_owner();

-- Templates and Duplicate project copy the shared tabs only, never someone's personal views.
select public.alhc_patch_function('public.project_snapshot(uuid, jsonb)'::regprocedure,
  'from public.project_views v where v.project_id = p.id and v.deleted_at is null',
  'from public.project_views v where v.project_id = p.id and v.deleted_at is null and v.owner_id is null'
);

create table if not exists public.project_view_settings (
  project_id uuid primary key references public.projects (id),
  default_view_id uuid references public.project_views (id),
  hidden_tabs text[] not null default '{}',
  updated_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_view_settings_tabs_check check (
    hidden_tabs <@ array['overview', 'dashboard', 'messages', 'workload', 'files']::text[]
  )
);

create index if not exists project_view_settings_default_view_idx
  on public.project_view_settings (default_view_id) where default_view_id is not null;
create index if not exists project_view_settings_updated_by_idx on public.project_view_settings (updated_by);

alter table public.project_view_settings enable row level security;
revoke all on public.project_view_settings from anon, authenticated;
select public.alhc_revoke_anon_grants(array['project_view_settings']);
select public.alhc_revoke_client_truncate(array['project_view_settings']);
grant select on public.project_view_settings to authenticated;
grant insert (project_id, default_view_id, hidden_tabs) on public.project_view_settings to authenticated;
grant update (default_view_id, hidden_tabs) on public.project_view_settings to authenticated;

comment on table public.project_view_settings is
  'Oct 26 notes (batch 4): a project''s hidden tabs (Editors+) and its default view (Owners). Viewers read it.';

create trigger project_view_settings_set_updated_at
  before update on public.project_view_settings
  for each row execute function public.set_updated_at();

create or replace function public.guard_project_view_settings()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.project_id <> old.project_id then
    raise exception 'These settings stay with their project' using errcode = 'check_violation';
  end if;
  if public.is_client_role() then
    new.updated_by := auth.uid();
  end if;
  select coalesce(array_agg(distinct x order by x), '{}') into new.hidden_tabs
  from unnest(coalesce(new.hidden_tabs, '{}')) x where x is not null;
  if new.default_view_id is not null
     and (tg_op = 'INSERT' or new.default_view_id is distinct from old.default_view_id) then
    if not exists (
      select 1 from public.project_views v
      where v.id = new.default_view_id and v.project_id = new.project_id
        and v.owner_id is null and v.deleted_at is null
    ) then
      raise exception 'Choose one of this project''s shared views' using errcode = 'check_violation';
    end if;
  end if;
  if public.is_client_role()
     and (case when tg_op = 'INSERT' then new.default_view_id is not null
               else new.default_view_id is distinct from old.default_view_id end)
     and not public.has_project_role(new.project_id, 'owner') then
    raise exception 'Only the project''s owners can choose its default view' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

select public.alhc_revoke_anon_execute(array['guard_project_view_settings()']);
grant execute on function public.guard_project_view_settings() to authenticated;

create trigger project_view_settings_05_guard
  before insert or update on public.project_view_settings
  for each row execute function public.guard_project_view_settings();

create policy project_view_settings_select_viewer on public.project_view_settings
  for select to authenticated using ((select public.has_project_role(project_id, 'viewer')));
create policy project_view_settings_insert_editor on public.project_view_settings
  for insert to authenticated with check ((select public.has_project_role(project_id, 'editor')));
create policy project_view_settings_update_editor on public.project_view_settings
  for update to authenticated
  using ((select public.has_project_role(project_id, 'editor')))
  with check ((select public.has_project_role(project_id, 'editor')));

create table if not exists public.profile_preferences (
  profile_id uuid primary key default auth.uid() references public.profiles (id),
  open_personal_view boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profile_preferences enable row level security;
revoke all on public.profile_preferences from anon, authenticated;
select public.alhc_revoke_anon_grants(array['profile_preferences']);
select public.alhc_revoke_client_truncate(array['profile_preferences']);
grant select on public.profile_preferences to authenticated;
grant insert (open_personal_view) on public.profile_preferences to authenticated;
grant update (open_personal_view) on public.profile_preferences to authenticated;

comment on table public.profile_preferences is
  'Oct 26 notes (batch 4): a person''s own app preferences (open_personal_view: open my saved view of a '
  'project first). Own rows only.';

create trigger profile_preferences_set_updated_at
  before update on public.profile_preferences
  for each row execute function public.set_updated_at();

create policy profile_preferences_select_own on public.profile_preferences
  for select to authenticated using (profile_id = (select auth.uid()));
create policy profile_preferences_insert_own on public.profile_preferences
  for insert to authenticated
  with check (profile_id = (select auth.uid()) and (select public.is_allowlisted()));
create policy profile_preferences_update_own on public.profile_preferences
  for update to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

-- Turns "Open my saved view by default" on or off for the caller. Invoker: own row only (RLS).
create or replace function public.set_open_personal_view(enabled boolean)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  stored boolean;
begin
  if auth.uid() is null or not public.is_allowlisted() then
    raise exception 'Sign in to change your settings' using errcode = 'insufficient_privilege';
  end if;
  insert into public.profile_preferences as p (open_personal_view)
  values (coalesce(enabled, false))
  on conflict (profile_id) do update set open_personal_view = excluded.open_personal_view
  returning p.open_personal_view into stored;
  return stored;
end;
$$;

select public.alhc_revoke_anon_execute(array['set_open_personal_view(boolean)']);
grant execute on function public.set_open_personal_view(boolean) to authenticated;

-- Readable last, so the app can tell this release's database is there.
grant select on public.profile_preferences to authenticated;
