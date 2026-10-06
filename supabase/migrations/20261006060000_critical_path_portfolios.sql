-- ALHC Projects — Critical path and portfolio depth.
--
-- Prefer SECURITY INVOKER: every new function runs as the caller, so RLS and the existing role checks
-- apply. The one new SECURITY DEFINER function is the trigger guard_portfolio_child(), which has to see
-- every nesting link (including ones the caller can't read) to reject cycles; like every definer
-- trigger it is revoked from client roles (and swept again at the end). Two existing definer functions
-- keep their signatures and EXECUTE grants: set_project_status() now also writes a history row, and
-- portfolio_hidden_project_count() also counts projects reached through nested portfolios.
--
--   * Critical path (read-only; nothing is shifted):
--       project_critical_path(target_project) returns one row per active task of the project that the
--       caller can read: (task_id, start_on, due_on, slack_days, critical, skipped).
--       Tasks without a due date are skipped (skipped = true, slack null). For the rest:
--         start      = start_on, else due_on;   duration = due_on − start (days; a one-day task is 0)
--         finish     = the latest due_on among them (the project's last due date)
--         edges      = active finish-to-start task_dependencies of this project between two dated tasks
--         remaining  = the longest sum of successor durations along any chain from the task (0 if none)
--         latest     = finish − remaining   (the latest the task could be due without pushing the finish)
--         slack_days = latest − due_on;  critical = slack_days ≤ 0
--       A successor may start on its predecessor's due day (the Timeline's rule), so a chain whose links
--       all touch ends at the finish with zero slack: that chain is the critical path. Negative slack
--       means a successor already starts before its predecessor is due.
--
--   * Project status history: project_status_updates (project_id, status, note, author_id, created_at)
--     is append-only and written only by set_project_status() (signature unchanged), one row per call.
--     Readable by project Viewers+ (project_status_updates_select_viewer); no client write grants.
--
--   * Nested portfolios: portfolio_children (parent_id, child_id, sort_order, soft delete). Nesting needs
--     Editor+ on the parent and Viewer+ on the child; a link is visible only to people who are Viewers+
--     of both, so a parent's members never see a child they aren't in. Cycles (and nesting a portfolio in
--     itself) are rejected under a per-workspace advisory lock. Rollups (portfolio_report,
--     list_portfolio_progress, portfolio_rollup_projects, portfolio_timeline) walk only links the caller
--     can see and count only projects the caller can read (has_project_role viewer).
--
--   * Portfolio custom fields: portfolio_fields (text | number | single_select | date, options for
--     single-select) and portfolio_field_values (one per field × project, JSON null clears). Field
--     definitions: read Viewer+, write Editor+ of the portfolio. Values: read needs Viewer+ on the
--     portfolio AND on the project; write needs Editor+ on the portfolio AND Viewer+ on the project, and
--     the project must be in the portfolio.
--
--   * Portfolio Timeline: portfolio_timeline(target_portfolio) returns one row per readable project
--     (direct or nested) with the earliest start and latest due date of its open tasks.

-- ---------------------------------------------------------------------------
-- Critical path
-- ---------------------------------------------------------------------------

create or replace function public.project_critical_path(target_project uuid)
returns table (
  task_id uuid,
  start_on date,
  due_on date,
  slack_days integer,
  critical boolean,
  skipped boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with recursive nodes as (
    select distinct t.id, coalesce(t.start_on, t.due_on) as s, t.due_on as d
    from public.task_projects tp
    join public.tasks t on t.id = tp.task_id and t.deleted_at is null
    where tp.project_id = target_project
      and tp.deleted_at is null
      and public.has_project_role(target_project, 'viewer')
  ),
  dated as (
    select n.id, n.s, n.d from nodes n where n.d is not null
  ),
  bounds as (
    select max(dated.d) as finish from dated
  ),
  edges as (
    select distinct dep.predecessor_id as pred, dep.successor_id as succ
    from public.task_dependencies dep
    join dated a on a.id = dep.predecessor_id
    join dated b on b.id = dep.successor_id
    where dep.project_id = target_project and dep.deleted_at is null
  ),
  -- Walks back from every task: a predecessor's remaining work is its successor's remaining work plus
  -- the successor's duration. UNION drops repeats, so this ends on any DAG (dependencies reject cycles);
  -- the day cap is a backstop.
  remaining (id, days) as (
    select dated.id, 0 from dated
    union
    select e.pred, r.days + (b.d - b.s)
    from remaining r
    join edges e on e.succ = r.id
    join dated b on b.id = r.id
    where r.days < 36600
  ),
  longest as (
    select r.id, max(r.days) as days from remaining r group by r.id
  )
  select dated.id,
         dated.s,
         dated.d,
         ((bounds.finish - l.days) - dated.d)::integer,
         ((bounds.finish - l.days) - dated.d) <= 0,
         false
  from dated
  join longest l on l.id = dated.id
  cross join bounds
  union all
  select n.id, n.s, n.d, null::integer, false, true
  from nodes n
  where n.d is null;
$$;

revoke all on function public.project_critical_path(uuid) from public, anon;
grant execute on function public.project_critical_path(uuid) to authenticated;

comment on function public.project_critical_path(uuid) is
  'Read-only critical path and slack (days) over the project''s readable tasks with a due date; see the '
  'header of 20261006060000_critical_path_portfolios.sql.';

-- ---------------------------------------------------------------------------
-- Project status history
-- ---------------------------------------------------------------------------

create table public.project_status_updates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  status text not null check (status in ('on_track', 'at_risk', 'off_track', 'complete')),
  note text check (note is null or length(note) <= 2000),
  author_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default clock_timestamp()
);

create index project_status_updates_project_idx on public.project_status_updates (project_id, created_at desc);
create index project_status_updates_author_idx on public.project_status_updates (author_id);

comment on table public.project_status_updates is
  'Append-only history of project status changes. Written only by set_project_status(); read by project Viewers+.';

alter table public.project_status_updates enable row level security;

create policy project_status_updates_select_viewer on public.project_status_updates
  for select to authenticated
  using ((select public.has_project_role(project_id, 'viewer')));
-- No insert/update policies and no client write grants: set_project_status() is the only writer.

revoke all on public.project_status_updates from anon;
revoke insert, update, delete, truncate, references, trigger on public.project_status_updates from authenticated;

-- The current status of projects that already had one becomes their first history row.
insert into public.project_status_updates (project_id, status, note, author_id, created_at)
select p.id, p.status, p.status_note, p.status_updated_by, p.status_updated_at
from public.projects p
where p.status_updated_at is not null;

-- Same signature and checks as before; each call now also keeps a history row.
create or replace function public.set_project_status(
  target_project uuid,
  new_status text,
  note text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  cleaned text := nullif(trim(coalesce(note, '')), '');
begin
  if not public.has_project_role(target_project, 'editor') then
    raise exception 'Only project editors and above can set the project status'
      using errcode = 'insufficient_privilege';
  end if;
  if new_status is null or new_status not in ('on_track', 'at_risk', 'off_track', 'complete') then
    raise exception 'Status must be on_track, at_risk, off_track, or complete' using errcode = 'check_violation';
  end if;
  if length(cleaned) > 2000 then
    raise exception 'The status note is too long' using errcode = 'check_violation';
  end if;
  update public.projects
  set status = new_status,
      status_note = cleaned,
      status_updated_at = now(),
      status_updated_by = auth.uid()
  where id = target_project and deleted_at is null;
  if not found then
    raise exception 'Project not found' using errcode = 'no_data_found';
  end if;
  insert into public.project_status_updates (project_id, status, note, author_id)
  values (target_project, new_status, cleaned, auth.uid());
end;
$$;

revoke all on function public.set_project_status(uuid, text, text) from public, anon;
grant execute on function public.set_project_status(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Nested portfolios
-- ---------------------------------------------------------------------------

create table public.portfolio_children (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references public.portfolios (id),
  child_id uuid not null references public.portfolios (id),
  sort_order double precision not null default 0,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint portfolio_children_not_self check (parent_id <> child_id)
);

-- One active link per (parent, child). Removing soft-deletes; re-adding creates a new row.
create unique index portfolio_children_active_idx on public.portfolio_children (parent_id, child_id)
  where deleted_at is null;
create index portfolio_children_child_idx on public.portfolio_children (child_id) where deleted_at is null;
create index portfolio_children_created_by_idx on public.portfolio_children (created_by);

create trigger portfolio_children_set_updated_at
  before update on public.portfolio_children
  for each row execute function public.set_updated_at();

comment on table public.portfolio_children is
  'Portfolios inside portfolios. Visible only to Viewers+ of both; never grants access to the child or its projects.';

-- SECURITY DEFINER on purpose: the cycle walk must see every active link, including links the caller
-- can't read (otherwise A ⊃ B ⊃ hidden C ⊃ A would slip through). It reveals nothing but the error.
-- Stamps creator/created_at, keeps links from moving or coming back, checks both portfolios are active
-- and in the same workspace, and rejects cycles under a per-workspace advisory lock.
create or replace function public.guard_portfolio_child()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  parent_workspace uuid;
  child_workspace uuid;
begin
  if tg_op = 'UPDATE' then
    if new.parent_id <> old.parent_id
       or new.child_id <> old.child_id
       or new.created_by is distinct from old.created_by
       or new.created_at <> old.created_at then
      raise exception 'Nested portfolios can''t be moved; remove and add them again'
        using errcode = 'insufficient_privilege';
    end if;
    if old.deleted_at is not null and new.deleted_at is null then
      raise exception 'Add the portfolio again instead of restoring it' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  new.created_at := now();
  new.deleted_at := null;
  if new.parent_id = new.child_id then
    raise exception 'A portfolio can’t contain itself' using errcode = 'check_violation';
  end if;
  select p.workspace_id into parent_workspace from public.portfolios p where p.id = new.parent_id and p.deleted_at is null;
  select p.workspace_id into child_workspace from public.portfolios p where p.id = new.child_id and p.deleted_at is null;
  if parent_workspace is null or child_workspace is null or parent_workspace <> child_workspace then
    raise exception 'Portfolio not found' using errcode = 'check_violation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('alhc.portfolio_tree:' || parent_workspace::text, 0));
  if exists (
    with recursive below (id) as (
      select new.child_id
      union
      select c.child_id
      from public.portfolio_children c
      join below b on c.parent_id = b.id
      where c.deleted_at is null
    )
    select 1 from below where id = new.parent_id
  ) then
    raise exception 'A portfolio can’t contain a portfolio it is already inside' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_portfolio_child() from public, anon, authenticated;

create trigger portfolio_children_05_guard
  before insert or update on public.portfolio_children
  for each row execute function public.guard_portfolio_child();

alter table public.portfolio_children enable row level security;

create policy portfolio_children_select_viewer on public.portfolio_children
  for select to authenticated
  using (
    (select public.has_portfolio_role(parent_id, 'viewer'))
    and (select public.has_portfolio_role(child_id, 'viewer'))
  );
-- Nesting needs Editor+ on the parent and Viewer+ on the child (whatever the parent role).
create policy portfolio_children_insert_editor on public.portfolio_children
  for insert to authenticated
  with check (
    (select public.has_portfolio_role(parent_id, 'editor'))
    and (select public.has_portfolio_role(child_id, 'viewer'))
  );
-- Reorder and remove (soft delete): Editor+ on the parent, on links the caller can see.
create policy portfolio_children_update_editor on public.portfolio_children
  for update to authenticated
  using ((select public.has_portfolio_role(parent_id, 'editor')))
  with check ((select public.has_portfolio_role(parent_id, 'editor')));

revoke all on public.portfolio_children from anon;
revoke update, delete, truncate, references, trigger on public.portfolio_children from authenticated;
grant update (sort_order, deleted_at) on public.portfolio_children to authenticated;

-- Adds a portfolio inside another (idempotent). Appends after the children the caller can see.
create or replace function public.add_portfolio_child(target_portfolio uuid, child_portfolio uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing uuid;
  inserted uuid;
begin
  if not public.has_portfolio_role(target_portfolio, 'editor') then
    raise exception 'Only portfolio editors and above can add portfolios' using errcode = 'insufficient_privilege';
  end if;
  if not public.has_portfolio_role(child_portfolio, 'viewer') then
    raise exception 'You can only add portfolios you are a member of' using errcode = 'insufficient_privilege';
  end if;
  select c.id into existing from public.portfolio_children c
  where c.parent_id = target_portfolio and c.child_id = child_portfolio and c.deleted_at is null;
  if existing is not null then
    return existing;
  end if;
  insert into public.portfolio_children (parent_id, child_id, sort_order)
  values (
    target_portfolio,
    child_portfolio,
    coalesce((
      select max(c.sort_order) from public.portfolio_children c
      where c.parent_id = target_portfolio and c.deleted_at is null
    ), 0) + 1024
  )
  returning id into inserted;
  return inserted;
end;
$$;

revoke all on function public.add_portfolio_child(uuid, uuid) from public, anon;
grant execute on function public.add_portfolio_child(uuid, uuid) to authenticated;

create or replace function public.remove_portfolio_child(target_portfolio uuid, child_portfolio uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not public.has_portfolio_role(target_portfolio, 'editor') then
    raise exception 'Only portfolio editors and above can remove portfolios' using errcode = 'insufficient_privilege';
  end if;
  update public.portfolio_children c
  set deleted_at = now()
  where c.parent_id = target_portfolio and c.child_id = child_portfolio and c.deleted_at is null;
  if not found then
    raise exception 'That portfolio is not in this one' using errcode = 'no_data_found';
  end if;
end;
$$;

revoke all on function public.remove_portfolio_child(uuid, uuid) from public, anon;
grant execute on function public.remove_portfolio_child(uuid, uuid) to authenticated;

-- The portfolio and every nested portfolio the caller can see (Viewer+ of each link's child), with the
-- top-level child it hangs under (group_id; null for the portfolio itself) and its depth. A portfolio
-- reached along two paths appears once per path.
create or replace function public.portfolio_tree(target_portfolio uuid)
returns table (portfolio_id uuid, group_id uuid, depth integer)
language sql
stable
security invoker
set search_path = ''
as $$
  with recursive tree (portfolio_id, group_id, depth, path) as (
    select po.id, null::uuid, 0, array[po.id]
    from public.portfolios po
    where po.id = target_portfolio
      and po.deleted_at is null
      and public.has_portfolio_role(po.id, 'viewer')
    union all
    select c.child_id, coalesce(t.group_id, c.child_id), t.depth + 1, t.path || c.child_id
    from tree t
    join public.portfolio_children c on c.parent_id = t.portfolio_id and c.deleted_at is null
    join public.portfolios po on po.id = c.child_id and po.deleted_at is null
    where public.has_portfolio_role(c.child_id, 'viewer')
      and not c.child_id = any (t.path)
      and t.depth < 20
  )
  select t.portfolio_id, t.group_id, t.depth from tree t;
$$;

revoke all on function public.portfolio_tree(uuid) from public, anon;
grant execute on function public.portfolio_tree(uuid) to authenticated;

-- Every project the caller can read in a portfolio or its visible nested portfolios, once each: the
-- nearest occurrence wins (the portfolio's own projects first, then by the top-level child's order).
--   portfolio_id  the portfolio the project sits in directly
--   group_id      the top-level child it was reached through (null = the portfolio's own project)
create or replace function public.portfolio_rollup_projects(target_portfolio uuid)
returns table (
  project_id uuid,
  name text,
  status text,
  status_note text,
  status_updated_at timestamptz,
  portfolio_id uuid,
  group_id uuid,
  depth integer,
  sort_order double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select distinct on (pp.project_id)
    pp.project_id, pr.name, pr.status, pr.status_note, pr.status_updated_at,
    t.portfolio_id, t.group_id, t.depth, pp.sort_order
  from public.portfolio_tree(target_portfolio) t
  join public.portfolio_projects pp on pp.portfolio_id = t.portfolio_id and pp.deleted_at is null
  join public.projects pr on pr.id = pp.project_id and pr.deleted_at is null
  left join public.portfolio_children gc
    on gc.parent_id = target_portfolio and gc.child_id = t.group_id and gc.deleted_at is null
  where public.has_project_role(pp.project_id, 'viewer')
  order by pp.project_id, t.depth, gc.sort_order nulls first, pp.sort_order;
$$;

revoke all on function public.portfolio_rollup_projects(uuid) from public, anon;
grant execute on function public.portfolio_rollup_projects(uuid) to authenticated;

-- One row per readable project of the rollup with the span of its open tasks: earliest start (start
-- date, else due date) to latest due (due date, else start date). No dated open tasks ⇒ null dates.
create or replace function public.portfolio_timeline(target_portfolio uuid)
returns table (
  project_id uuid,
  name text,
  status text,
  status_note text,
  portfolio_id uuid,
  group_id uuid,
  sort_order double precision,
  start_on date,
  due_on date,
  open_task_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select r.project_id, r.name, r.status, r.status_note, r.portfolio_id, r.group_id, r.sort_order,
         s.start_on, s.due_on, coalesce(s.open_task_count, 0)
  from public.portfolio_rollup_projects(target_portfolio) r
  left join lateral (
    select min(coalesce(t.start_on, t.due_on)) as start_on,
           max(coalesce(t.due_on, t.start_on)) as due_on,
           count(distinct t.id) as open_task_count
    from public.task_projects tp
    join public.tasks t on t.id = tp.task_id and t.deleted_at is null and t.completed_at is null
    where tp.project_id = r.project_id and tp.deleted_at is null
  ) s on true;
$$;

revoke all on function public.portfolio_timeline(uuid) from public, anon;
grant execute on function public.portfolio_timeline(uuid) to authenticated;

-- Same signature and output as before; the project set is now the rollup (the portfolio's projects
-- plus those of visible nested portfolios), still only projects the caller can read.
create or replace function public.portfolio_report(
  target_portfolio uuid,
  group_by text default 'none',
  tz text default 'UTC'
)
returns table (
  bucket uuid,
  task_count bigint,
  completed_count bigint,
  incomplete_count bigint,
  overdue_count bigint,
  completed_recent_count bigint
)
language sql
stable
set search_path = ''
as $$
  with params as (
    select zone, (now() at time zone zone)::date as today
    from (select public.safe_timezone(tz) as zone) z
  ),
  visible_projects as (
    select r.project_id
    from public.portfolio_rollup_projects(target_portfolio) r
    where public.has_portfolio_role(target_portfolio, 'viewer')
      and public.has_project_role(r.project_id, 'viewer')
  ),
  memberships as (
    select tp.project_id, t.id as task_id, t.assignee_id, t.due_on, t.completed_at
    from visible_projects vp
    join public.task_projects tp on tp.project_id = vp.project_id and tp.deleted_at is null
    join public.tasks t on t.id = tp.task_id and t.deleted_at is null
  ),
  counted as (
    -- 'project' keeps one row per (project, task); the other groupings dedupe by task id.
    select case when group_by = 'project' then m.project_id end as project_id,
           m.task_id, m.assignee_id, m.due_on, m.completed_at
    from memberships m
    group by 1, m.task_id, m.assignee_id, m.due_on, m.completed_at
  )
  select
    case group_by when 'project' then r.project_id when 'assignee' then r.assignee_id end as bucket,
    count(*) as task_count,
    count(*) filter (where r.completed_at is not null) as completed_count,
    count(*) filter (where r.completed_at is null) as incomplete_count,
    count(*) filter (where r.completed_at is null and r.due_on < p.today) as overdue_count,
    count(*) filter (
      where r.completed_at is not null and (r.completed_at at time zone p.zone)::date > p.today - 7
    ) as completed_recent_count
  from counted r
  cross join params p
  where group_by in ('none', 'project', 'assignee')
  group by 1
  union all
  -- 'none' always returns one row, even for an empty (or unreadable) portfolio.
  select null, 0, 0, 0, 0, 0
  where group_by = 'none' and not exists (select 1 from counted);
$$;

revoke all on function public.portfolio_report(uuid, text, text) from public, anon;
grant execute on function public.portfolio_report(uuid, text, text) to authenticated;

-- Sidebar progress, now rolled up through visible nested portfolios (each task once per portfolio).
create or replace function public.list_portfolio_progress()
returns table (portfolio_id uuid, task_count bigint, completed_count bigint)
language sql
stable
set search_path = ''
as $$
  with recursive readable as (
    select po.id from public.portfolios po
    where po.deleted_at is null and public.has_portfolio_role(po.id, 'viewer')
  ),
  tree (root, portfolio_id, path) as (
    select r.id, r.id, array[r.id] from readable r
    union all
    select t.root, c.child_id, t.path || c.child_id
    from tree t
    join public.portfolio_children c on c.parent_id = t.portfolio_id and c.deleted_at is null
    join readable r on r.id = c.child_id
    where not c.child_id = any (t.path) and cardinality(t.path) <= 20
  ),
  visible as (
    select distinct t.root as portfolio_id, tk.id as task_id, tk.completed_at
    from tree t
    join public.portfolio_projects pp on pp.portfolio_id = t.portfolio_id and pp.deleted_at is null
    join public.projects pr on pr.id = pp.project_id and pr.deleted_at is null
    join public.task_projects tp on tp.project_id = pp.project_id and tp.deleted_at is null
    join public.tasks tk on tk.id = tp.task_id and tk.deleted_at is null
    where public.has_project_role(pp.project_id, 'viewer')
  )
  select v.portfolio_id, count(*), count(*) filter (where v.completed_at is not null)
  from visible v
  group by v.portfolio_id;
$$;

revoke all on function public.list_portfolio_progress() from public, anon;
grant execute on function public.list_portfolio_progress() to authenticated;

-- Same signature and grants as before (members only; a count, never a name or id). Now also counts
-- projects reached through nested portfolios: a project is hidden when no path to it runs only through
-- portfolios the caller is a member of AND the caller can't read it, i.e. when the rollups leave it out.
create or replace function public.portfolio_hidden_project_count(target_portfolio uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  with recursive tree (portfolio_id, visible, path) as (
    select po.id, true, array[po.id]
    from public.portfolios po
    where po.id = target_portfolio and po.deleted_at is null
      and public.has_portfolio_role(target_portfolio, 'viewer')
    union all
    select c.child_id, t.visible and public.has_portfolio_role(c.child_id, 'viewer'), t.path || c.child_id
    from tree t
    join public.portfolio_children c on c.parent_id = t.portfolio_id and c.deleted_at is null
    join public.portfolios po on po.id = c.child_id and po.deleted_at is null
    where not c.child_id = any (t.path) and cardinality(t.path) <= 20
  ),
  reach as (
    select pp.project_id, (t.visible and public.has_project_role(pp.project_id, 'viewer')) as visible
    from tree t
    join public.portfolio_projects pp on pp.portfolio_id = t.portfolio_id and pp.deleted_at is null
    join public.projects pr on pr.id = pp.project_id and pr.deleted_at is null
  )
  select count(*)::integer
  from (select r.project_id from reach r group by r.project_id having not bool_or(r.visible)) hidden;
$$;

revoke all on function public.portfolio_hidden_project_count(uuid) from public, anon;
grant execute on function public.portfolio_hidden_project_count(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Portfolio custom fields
-- ---------------------------------------------------------------------------

create table public.portfolio_fields (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios (id),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  field_type text not null check (field_type in ('text', 'number', 'single_select', 'date')),
  -- Single-select options: [{ "id": "<stable id>", "name": "Label", "color": "zinc" }]
  options jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array'),
  sort_order double precision not null default 0,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index portfolio_fields_portfolio_idx on public.portfolio_fields (portfolio_id, sort_order)
  where deleted_at is null;
create index portfolio_fields_created_by_idx on public.portfolio_fields (created_by);

create trigger portfolio_fields_set_updated_at
  before update on public.portfolio_fields
  for each row execute function public.set_updated_at();

-- Runs as the caller. Stamps creator/created_at; the portfolio and type never change; deleted fields
-- stay deleted; options are validated (single-select only: unique ids, names, a known colour).
create or replace function public.guard_portfolio_field()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.created_by := auth.uid();
      new.created_at := now();
      new.deleted_at := null;
    end if;
  else
    if new.portfolio_id <> old.portfolio_id
       or new.field_type <> old.field_type
       or new.created_by is distinct from old.created_by
       or new.created_at <> old.created_at then
      raise exception 'A field''s portfolio and type can''t change' using errcode = 'insufficient_privilege';
    end if;
    if old.deleted_at is not null and new.deleted_at is null then
      raise exception 'Create the field again instead of restoring it' using errcode = 'check_violation';
    end if;
  end if;
  new.name := btrim(new.name);
  if new.field_type <> 'single_select' then
    if new.options <> '[]'::jsonb then
      raise exception 'Only single-select fields have options' using errcode = 'check_violation';
    end if;
  elsif jsonb_array_length(new.options) > 100
     or exists (
       select 1 from jsonb_array_elements(new.options) o
       where jsonb_typeof(o) <> 'object'
         or jsonb_typeof(o -> 'id') is distinct from 'string'
         or char_length(o ->> 'id') not between 1 and 64
         or jsonb_typeof(o -> 'name') is distinct from 'string'
         or char_length(btrim(o ->> 'name')) not between 1 and 100
         or coalesce(o ->> 'color', '') not in ('zinc', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink')
     )
     or (select count(distinct o ->> 'id') from jsonb_array_elements(new.options) o) <> jsonb_array_length(new.options) then
    raise exception 'Invalid options for field "%"', new.name using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_portfolio_field() from public, anon;
grant execute on function public.guard_portfolio_field() to authenticated;

create trigger portfolio_fields_05_guard
  before insert or update on public.portfolio_fields
  for each row execute function public.guard_portfolio_field();

alter table public.portfolio_fields enable row level security;

create policy portfolio_fields_select_viewer on public.portfolio_fields
  for select to authenticated
  using ((select public.has_portfolio_role(portfolio_id, 'viewer')));
create policy portfolio_fields_insert_editor on public.portfolio_fields
  for insert to authenticated
  with check ((select public.has_portfolio_role(portfolio_id, 'editor')));
create policy portfolio_fields_update_editor on public.portfolio_fields
  for update to authenticated
  using ((select public.has_portfolio_role(portfolio_id, 'editor')))
  with check ((select public.has_portfolio_role(portfolio_id, 'editor')));

revoke all on public.portfolio_fields from anon;
revoke delete, truncate, references, trigger on public.portfolio_fields from authenticated;

-- One value per (field, project); like task_field_values there is no deleted_at (JSON null clears).
create table public.portfolio_field_values (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios (id),
  field_id uuid not null references public.portfolio_fields (id),
  project_id uuid not null references public.projects (id),
  value jsonb,
  updated_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint portfolio_field_values_one unique (field_id, project_id)
);

create index portfolio_field_values_portfolio_idx on public.portfolio_field_values (portfolio_id, project_id);
create index portfolio_field_values_project_idx on public.portfolio_field_values (project_id);
create index portfolio_field_values_updated_by_idx on public.portfolio_field_values (updated_by);

create trigger portfolio_field_values_set_updated_at
  before update on public.portfolio_field_values
  for each row execute function public.set_updated_at();

-- Runs as the caller. The portfolio comes from the field; field and project never change; the project
-- must be in the field's portfolio; the value must fit the field's type.
create or replace function public.guard_portfolio_field_value()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  field public.portfolio_fields;
begin
  if tg_op = 'UPDATE' and (
    new.field_id <> old.field_id or new.project_id <> old.project_id or new.portfolio_id <> old.portfolio_id
  ) then
    raise exception 'A field value can''t move' using errcode = 'insufficient_privilege';
  end if;
  select * into field from public.portfolio_fields f where f.id = new.field_id and f.deleted_at is null;
  if not found then
    raise exception 'Unknown portfolio field' using errcode = 'foreign_key_violation';
  end if;
  new.portfolio_id := field.portfolio_id;
  if public.is_client_role() then
    new.updated_by := auth.uid();
    if tg_op = 'INSERT' then
      new.created_at := now();
    end if;
  end if;
  if not exists (
    select 1 from public.portfolio_projects pp
    where pp.portfolio_id = field.portfolio_id and pp.project_id = new.project_id and pp.deleted_at is null
  ) then
    raise exception 'That project is not in this portfolio' using errcode = 'check_violation';
  end if;

  if new.value is null or new.value = 'null'::jsonb then
    new.value := null;
    return new;
  end if;
  if not (case field.field_type
    when 'text' then jsonb_typeof(new.value) = 'string' and char_length(new.value #>> '{}') <= 2000
    when 'number' then jsonb_typeof(new.value) = 'number'
    when 'date' then jsonb_typeof(new.value) = 'string' and (new.value #>> '{}') ~ '^\d{4}-\d{2}-\d{2}$'
    when 'single_select' then jsonb_typeof(new.value) = 'string' and exists (
      select 1 from jsonb_array_elements(field.options) o where o ->> 'id' = new.value #>> '{}'
    )
    else false
  end) then
    raise exception 'Invalid value for % field "%"', field.field_type, field.name using errcode = 'check_violation';
  end if;
  if field.field_type = 'date' then
    begin
      perform (new.value #>> '{}')::date;
    exception when others then
      raise exception 'Invalid value for date field "%"', field.name using errcode = 'check_violation';
    end;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_portfolio_field_value() from public, anon;
grant execute on function public.guard_portfolio_field_value() to authenticated;

create trigger portfolio_field_values_05_guard
  before insert or update on public.portfolio_field_values
  for each row execute function public.guard_portfolio_field_value();

alter table public.portfolio_field_values enable row level security;

-- A value shows only to people who can read both the portfolio and the project.
create policy portfolio_field_values_select_viewer on public.portfolio_field_values
  for select to authenticated
  using (
    (select public.has_portfolio_role(portfolio_id, 'viewer'))
    and (select public.has_project_role(project_id, 'viewer'))
  );
create policy portfolio_field_values_insert_editor on public.portfolio_field_values
  for insert to authenticated
  with check (
    (select public.has_portfolio_role(portfolio_id, 'editor'))
    and (select public.has_project_role(project_id, 'viewer'))
  );
create policy portfolio_field_values_update_editor on public.portfolio_field_values
  for update to authenticated
  using (
    (select public.has_portfolio_role(portfolio_id, 'editor'))
    and (select public.has_project_role(project_id, 'viewer'))
  )
  with check (
    (select public.has_portfolio_role(portfolio_id, 'editor'))
    and (select public.has_project_role(project_id, 'viewer'))
  );

revoke all on public.portfolio_field_values from anon;
revoke delete, truncate, references, trigger on public.portfolio_field_values from authenticated;

-- Sets (or clears, with JSON null) one project's value of a portfolio field. Portfolio Editor+, and the
-- caller must be able to read the project; the guard checks the project is in the portfolio.
create or replace function public.set_portfolio_field_value(target_field uuid, target_project uuid, new_value jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  owner_portfolio uuid;
begin
  select f.portfolio_id into owner_portfolio
  from public.portfolio_fields f where f.id = target_field and f.deleted_at is null;
  if owner_portfolio is null then
    raise exception 'Field not found' using errcode = 'no_data_found';
  end if;
  if not public.has_portfolio_role(owner_portfolio, 'editor') then
    raise exception 'Only portfolio editors and above can set field values' using errcode = 'insufficient_privilege';
  end if;
  if not public.has_project_role(target_project, 'viewer') then
    raise exception 'You can only set values on projects you can open' using errcode = 'insufficient_privilege';
  end if;
  insert into public.portfolio_field_values (portfolio_id, field_id, project_id, value)
  values (owner_portfolio, target_field, target_project, new_value)
  on conflict (field_id, project_id) do update set value = excluded.value;
end;
$$;

revoke all on function public.set_portfolio_field_value(uuid, uuid, jsonb) from public, anon;
grant execute on function public.set_portfolio_field_value(uuid, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Hardening: EXECUTE on SECURITY DEFINER trigger functions (same sweep as earlier phases)
-- ---------------------------------------------------------------------------

do $$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and p.prorettype = 'trigger'::regtype
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
  end loop;
end;
$$;
