-- ALHC Projects — Phase: Asana parity, batch 5 (Inbox, Home, Teams, and the Admin console).
-- Mostly UI (the Inbox's tabs, toolbar, and day-grouped cards; Home's greeting and widgets; the team
-- page's tabs; the Admin console; the Settings modal's tabs). The database gains only what those
-- screens need to be real:
--
--   Team curated work (team_curated_work): the team Overview's "Curated work" list — projects and
--     portfolios the team pins for itself, in order. A row is visible only to people who can read its
--     project (has_project_role viewer) or portfolio (has_portfolio_role viewer), so a curated private
--     project stays invisible to everyone outside it, workspace admins included. Team members, team
--     leads, and workspace admins curate (can_curate_team, invoker); adding needs Viewer+ on the
--     target too, so nobody can pin something they can't open. Removing sets deleted_at (kept, final;
--     adding again makes a new row). A curated item never grants access to anything.
--   Last activity (list_workspace_member_activity, SECURITY DEFINER): the Admin console's Users table
--     shows when each person on the allowlist last signed in (auth.users.last_sign_in_at). Workspace
--     admins only (insufficient_privilege for anyone else); it returns an address and a time, nothing
--     about projects or tasks.
--   Inbox bookmarks (inbox_items.bookmarked_at): the Inbox's Bookmarks tab. Set and cleared by the
--     recipient on their own items, exactly like read_at / archived_at (column grant; the existing
--     own-rows update policy). Added last: the app treats this batch's database features as present
--     only once this column exists.
--
-- One new client SECURITY DEFINER function, list_workspace_member_activity (pinned in suite 60).
-- Everything else new is invoker. Nothing for anon (alhc_revoke_*). fire_rules, notify_with,
-- notify_message, and add_story are untouched (their import and copy checks included). Additive: the
-- release still on main keeps working once this is applied (it never reads the new table, function, or
-- column). No statement here needs a row- or object-removal keyword, so there is no tail section.

-- ---------------------------------------------------------------------------
-- Team curated work
-- ---------------------------------------------------------------------------

create table public.team_curated_work (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id),
  project_id uuid references public.projects (id),
  portfolio_id uuid references public.portfolios (id),
  sort_order double precision not null default 1024,
  created_by uuid default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint team_curated_work_one_target check (num_nonnulls(project_id, portfolio_id) = 1)
);

comment on table public.team_curated_work is
  'Asana parity, batch 5: the team Overview''s Curated work (projects and portfolios a team pins). '
  'Visible only with the target (project / portfolio Viewer+); curated by team members, leads, and '
  'workspace admins (can_curate_team). Removal sets deleted_at. Never grants access.';

create unique index team_curated_work_project_key on public.team_curated_work (team_id, project_id)
  where deleted_at is null and project_id is not null;
create unique index team_curated_work_portfolio_key on public.team_curated_work (team_id, portfolio_id)
  where deleted_at is null and portfolio_id is not null;
create index team_curated_work_team_idx on public.team_curated_work (team_id, sort_order) where deleted_at is null;
create index team_curated_work_project_idx on public.team_curated_work (project_id);
create index team_curated_work_portfolio_idx on public.team_curated_work (portfolio_id);
create index team_curated_work_created_by_idx on public.team_curated_work (created_by);

-- May the caller curate the team's work? An active member of the active team, or someone who manages
-- it (its leads and workspace admins, can_manage_team). Invoker: teams and team_members are readable by
-- everyone allowlisted, and this never touches project data.
create or replace function public.can_curate_team(target_team uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select public.is_allowlisted() and (
    public.can_manage_team(target_team)
    or exists (
      select 1
      from public.team_members m
      join public.teams t on t.id = m.team_id and t.deleted_at is null
      where m.team_id = target_team
        and m.profile_id = auth.uid()
        and m.deleted_at is null
    )
  );
$$;

select public.alhc_revoke_anon_execute(array['can_curate_team(uuid)']);
grant execute on function public.can_curate_team(uuid) to authenticated;

alter table public.team_curated_work enable row level security;
revoke all on public.team_curated_work from anon, authenticated;
grant select on public.team_curated_work to authenticated;
grant insert (team_id, project_id, portfolio_id, sort_order) on public.team_curated_work to authenticated;
grant update (sort_order, deleted_at) on public.team_curated_work to authenticated;

-- Read with the target: a curated project shows only to its readers, a portfolio only to its members.
create policy team_curated_work_select_viewer on public.team_curated_work
  for select to authenticated
  using (
    (team_curated_work.project_id is not null and (select public.has_project_role(team_curated_work.project_id, 'viewer')))
    or (team_curated_work.portfolio_id is not null and (select public.has_portfolio_role(team_curated_work.portfolio_id, 'viewer')))
  );

-- Pin: someone who curates the team, who can open the target.
create policy team_curated_work_insert_curator on public.team_curated_work
  for insert to authenticated
  with check (
    team_curated_work.created_by = (select auth.uid())
    and (select public.can_curate_team(team_curated_work.team_id))
    and (
      (team_curated_work.project_id is not null and (select public.has_project_role(team_curated_work.project_id, 'viewer')))
      or (team_curated_work.portfolio_id is not null and (select public.has_portfolio_role(team_curated_work.portfolio_id, 'viewer')))
    )
  );

-- Reorder or unpin: someone who curates the team (the select policy still hides rows they can't read).
create policy team_curated_work_update_curator on public.team_curated_work
  for update to authenticated
  using ((select public.can_curate_team(team_curated_work.team_id)))
  with check ((select public.can_curate_team(team_curated_work.team_id)));

-- Invoker guard: the creator and creation time are the caller's on client inserts; the team must be
-- active and the target live; rows never move between teams or targets; an unpinned row stays unpinned.
create or replace function public.guard_team_curated_work()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.created_by := auth.uid();
    end if;
    new.created_at := now();
    new.deleted_at := null;
    if not exists (select 1 from public.teams t where t.id = new.team_id and t.deleted_at is null) then
      raise exception 'Team not found' using errcode = 'no_data_found';
    end if;
    if new.project_id is not null
       and not exists (select 1 from public.projects p where p.id = new.project_id and p.deleted_at is null) then
      raise exception 'Project not found' using errcode = 'no_data_found';
    end if;
    if new.portfolio_id is not null
       and not exists (select 1 from public.portfolios p where p.id = new.portfolio_id and p.deleted_at is null) then
      raise exception 'Portfolio not found' using errcode = 'no_data_found';
    end if;
  else
    if new.team_id is distinct from old.team_id or new.project_id is distinct from old.project_id
       or new.portfolio_id is distinct from old.portfolio_id or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at then
      raise exception 'Curated work can’t be moved to another team or target' using errcode = 'insufficient_privilege';
    end if;
    if old.deleted_at is not null and new.deleted_at is null then
      raise exception 'Add it to the team’s curated work again instead' using errcode = 'check_violation';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

select public.alhc_revoke_anon_execute(array['guard_team_curated_work()']);
grant execute on function public.guard_team_curated_work() to authenticated;

create trigger team_curated_work_05_guard
  before insert or update on public.team_curated_work
  for each row execute function public.guard_team_curated_work();

select public.alhc_revoke_anon_grants(array['team_curated_work']);

-- ---------------------------------------------------------------------------
-- Admin console: last activity
-- ---------------------------------------------------------------------------

-- When each address on the allowlist last signed in, for the Admin console's Users table. Definer
-- (auth.users isn't readable by clients), workspace admins only; an address and a time, never anything
-- about projects or tasks. Removed addresses are included (the Removed tab shows them too).
create or replace function public.list_workspace_member_activity()
returns table (email text, last_sign_in_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_workspace_admin(null) then
    raise exception 'Only workspace admins can see member activity' using errcode = 'insufficient_privilege';
  end if;
  return query
    select a.email::text, max(u.last_sign_in_at)
    from public.allowed_emails a
    join auth.users u on lower(u.email) = a.email
    group by a.email;
end;
$$;

select public.alhc_revoke_anon_execute(array['list_workspace_member_activity()']);
revoke all on function public.list_workspace_member_activity() from public, anon;
grant execute on function public.list_workspace_member_activity() to authenticated;

-- ---------------------------------------------------------------------------
-- Inbox bookmarks (added last; see the header)
-- ---------------------------------------------------------------------------

alter table public.inbox_items add column bookmarked_at timestamptz;

comment on column public.inbox_items.bookmarked_at is
  'Asana parity, batch 5: set by the recipient to keep the notification in the Inbox''s Bookmarks tab '
  '(null = not bookmarked). Independent of read_at and archived_at.';

create index inbox_items_bookmarked_idx on public.inbox_items (recipient_id, bookmarked_at desc)
  where bookmarked_at is not null;

grant update (bookmarked_at) on public.inbox_items to authenticated;
