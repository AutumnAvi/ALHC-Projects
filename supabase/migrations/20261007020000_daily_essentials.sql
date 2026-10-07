-- ALHC Projects — Phase: Daily essentials.
-- Private My Tasks tasks (no project), Duplicate task, archived projects, task likes, and the auto-shift
-- gap closers (several tasks at once for bulk due dates, and an optional "pull dependents earlier").
-- Generic: nothing knows about a team or request type.
--
-- Security shape (pinned by supabase/tests/zz04_daily_essentials_smoke.sql):
--   * A private task is a top-level task with no home project (tasks.home_project_id null). Only its
--     creator and its current assignee can read or edit it (Editor); a subtask resolves through its root,
--     like every subtask. profile_task_role() answers that, so every has_task_role policy (comments,
--     followers, attachments, stories, inbox items, likes, tags, dependencies), search_tasks (invoker),
--     @mentions, followers, and notify_with's "can the recipient read it" check follow without touching
--     fire_rules, notify_with, notify_message, or add_story. Nobody else — workspace admins included —
--     can read, find, follow, be mentioned in, or be notified about one. Adding it to a project (a
--     task_projects row, Editor of that project) makes it an ordinary task with that home project; a
--     project task can't be made private.
--   * Archived projects (projects.archived_at) are read-only for everyone: a membership in an archived
--     project counts as Viewer (profile_project_role / profile_task_role), so every write policy and every
--     role-checking RPC refuses, rules of archived projects don't fire, and their forms take no responses.
--     Reading is unchanged (members only). set_project_archived (Admin+ by the member's own role) is the
--     one new client SECURITY DEFINER function: it has to read the uncapped role and write a row whose
--     update policy the cap now refuses. Pinned in suite 60; revoked from public and anon.
--   * duplicate_task, the multi-task auto-shift (preview_dependency_shifts / apply_dependency_shifts), and
--     the like guard are SECURITY INVOKER: every row they write goes through RLS and the normal triggers.
--   * Workspace admins get nothing extra anywhere. No new anon grants.
--
-- Existing functions are changed with asserted text patches (alhc_patch_function below): each edit must
-- match the live definition exactly once, and every other line stays as it was. Grants are kept.

-- ---------------------------------------------------------------------------
-- Patch helper (dropped at the end of this migration)
-- ---------------------------------------------------------------------------

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
-- Archived projects: columns, guard, project stories
-- ---------------------------------------------------------------------------

alter table public.projects
  add column archived_at timestamptz,
  add column archived_by uuid references public.profiles (id) on delete set null;

comment on column public.projects.archived_at is
  'When the project was archived (null = active). Archived projects are read-only for every member (a '
  'membership counts as Viewer) and leave the sidebar, Home, and pickers. Written only by set_project_archived.';

-- Clients never write the archive columns directly (set_project_archived is the only path).
create or replace function public.guard_project_archive()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.is_client_role() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.archived_at := null;
    new.archived_by := null;
    return new;
  end if;
  if new.archived_at is distinct from old.archived_at or new.archived_by is distinct from old.archived_by then
    raise exception 'Archive or unarchive a project from its settings'
      using errcode = 'insufficient_privilege', hint = 'Use set_project_archived (Admin+)';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_project_archive() from public, anon;
grant execute on function public.guard_project_archive() to authenticated;

create trigger projects_07_guard_archive
  before insert or update on public.projects
  for each row execute function public.guard_project_archive();

alter table public.project_stories drop constraint project_stories_kind_check;
alter table public.project_stories add constraint project_stories_kind_check
  check (kind in ('created_from_template', 'duplicated', 'archived', 'unarchived'));

-- A membership in an archived project counts as Viewer: read-only, whatever the role.
select public.alhc_patch_function('public.profile_project_role(uuid, uuid)'::regprocedure,
$p$  select m.role
  from public.project_members m
  where m.project_id = target_project$p$,
$p$  -- Archived projects are read-only: every membership there counts as Viewer (Daily essentials).
  select case when exists (
      select 1 from public.projects ap where ap.id = target_project and ap.archived_at is not null
    ) then 'viewer' else m.role end
  from public.project_members m
  where m.project_id = target_project$p$);

-- ---------------------------------------------------------------------------
-- Private tasks
-- ---------------------------------------------------------------------------

alter table public.tasks alter column home_project_id drop not null;
comment on column public.tasks.home_project_id is
  'The task''s primary project (its home membership). Null for a private My Tasks task, readable only by '
  'its creator and its assignee, and for that task''s subtasks; adding a private task to a project makes '
  'that project its home.';

-- A dependency may now join private tasks, which have no project to record the link on.
alter table public.task_dependencies alter column project_id drop not null;

-- Task role: archived projects count as Viewer; a private task's creator and assignee are its Editors.
select public.alhc_patch_function('public.profile_task_role(uuid, uuid)'::regprocedure,
$p$  select m.role
  from public.project_members m
  where m.profile_id = target_profile$p$,
$p$  select r.role from (
  -- Archived projects are read-only: a membership there counts as Viewer (Daily essentials).
  select case when exists (
      select 1 from public.projects ap where ap.id = m.project_id and ap.archived_at is not null
    ) then 'viewer' else m.role end as role
  from public.project_members m
  where m.profile_id = target_profile$p$,
$p$  order by public.project_role_rank(m.role) desc
  limit 1;$p$,
$p$  union all
  -- A private task (no project; a subtask through its root) belongs to its creator and its assignee.
  select 'editor'
  from public.tasks rt
  where rt.id = coalesce(
      (select t.root_task_id from public.tasks t where t.id = target_task),
      target_task
    )
    and rt.home_project_id is null
    and target_profile in (rt.created_by, rt.assignee_id)
  ) r
  order by public.project_role_rank(r.role) desc
  limit 1;$p$);

-- The workspace of a private task (and of its subtasks) is set by guard_private_task / the parent.
select public.alhc_patch_function('public.set_task_workspace()'::regprocedure,
$p$begin
  select p.workspace_id into new.workspace_id$p$,
$p$begin
  -- A private task (no project) and its subtasks keep the workspace they were given.
  if new.home_project_id is null then
    return new;
  end if;
  select p.workspace_id into new.workspace_id$p$);

-- A private task has no home membership to keep.
select public.alhc_patch_function('public.ensure_home_membership()'::regprocedure,
$p$  if new.parent_task_id is not null then
    return new;
  end if;$p$,
$p$  if new.parent_task_id is not null then
    return new;
  end if;
  -- Private tasks have no project at all.
  if new.home_project_id is null then
    return new;
  end if;$p$);

-- Private tasks: the creator is the caller, the workspace is a real one, a project task never becomes
-- private, and becoming a project task needs Editor in that project. Invoker; runs after
-- tasks_05_subtask_parent (which fills a subtask's home and workspace from its parent).
create or replace function public.guard_private_task()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  ws uuid;
begin
  if tg_op = 'INSERT' then
    if new.parent_task_id is not null or new.home_project_id is not null then
      return new;
    end if;
    -- People can't create a private task on someone else's behalf (it would be that person's task).
    if public.is_client_role() then
      new.created_by := auth.uid();
    end if;
    if new.created_by is null then
      raise exception 'A private task needs a creator' using errcode = 'check_violation';
    end if;
    select w.id into ws from public.workspaces w
    where w.deleted_at is null and (new.workspace_id is null or w.id = new.workspace_id)
    order by w.created_at, w.id
    limit 1;
    if ws is null then
      raise exception 'Workspace not found' using errcode = 'check_violation';
    end if;
    new.workspace_id := ws;
    return new;
  end if;

  if new.parent_task_id is null and old.home_project_id is not null and new.home_project_id is null then
    raise exception 'A project task can’t be made private' using errcode = 'check_violation';
  end if;
  if old.parent_task_id is null and new.parent_task_id is null
     and old.home_project_id is null and new.home_project_id is not null then
    -- A private task joining a project becomes that project's task: Editor there, same workspace.
    if public.is_client_role() and not public.has_project_role(new.home_project_id, 'editor') then
      raise exception 'Only editors of that project can add tasks to it' using errcode = 'insufficient_privilege';
    end if;
    if not exists (
      select 1 from public.projects p
      where p.id = new.home_project_id and p.deleted_at is null and p.workspace_id = old.workspace_id
    ) then
      raise exception 'Choose an active project in this workspace' using errcode = 'check_violation';
    end if;
  end if;
  if old.parent_task_id is null and old.home_project_id is null and new.home_project_id is null
     and new.created_by is distinct from old.created_by and public.is_client_role() then
    raise exception 'The creator of a private task can’t be changed' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_private_task() from public, anon;
grant execute on function public.guard_private_task() to authenticated;

create trigger tasks_06_private_task
  before insert or update on public.tasks
  for each row execute function public.guard_private_task();

-- RLS: the creating INSERT … RETURNING and its WITH CHECK can't see the new row through
-- profile_task_role, so private tasks get a column-based branch (same rule: creator or assignee).
drop policy tasks_select_viewer on public.tasks;
create policy tasks_select_viewer on public.tasks
  for select to authenticated
  using (
    case
      when root_task_id is not null then (
        select public.has_task_role(tasks.root_task_id, case when tasks.deleted_at is null then 'viewer' else 'editor' end)
      )
      when home_project_id is null then (
        (select auth.uid()) in (tasks.created_by, tasks.assignee_id) and (select public.is_allowlisted())
      )
      when deleted_at is null then (
        (select public.has_project_role(tasks.home_project_id, 'viewer'))
        or (select public.has_task_role(tasks.id, 'viewer'))
      )
      else (
        (select public.has_project_role(tasks.home_project_id, 'editor'))
        or (select public.has_task_role(tasks.id, 'editor'))
      )
    end
  );

drop policy tasks_insert_editor on public.tasks;
create policy tasks_insert_editor on public.tasks
  for insert to authenticated
  with check (
    case
      when parent_task_id is not null then (select public.has_task_role(tasks.root_task_id, 'editor'))
      when home_project_id is null then (
        tasks.created_by = (select auth.uid()) and (select public.is_allowlisted())
      )
      else (select public.has_project_role(tasks.home_project_id, 'editor'))
    end
  );

-- Adding a private task to a project (a task_projects row: Editor of the project and of the task) makes
-- that project its home, so it becomes an ordinary task of the project. Invoker: the update goes through
-- tasks RLS and guard_private_task.
create or replace function public.adopt_private_task()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.tasks t
    where t.id = new.task_id and t.home_project_id is null and t.parent_task_id is null
  ) then
    update public.tasks t set home_project_id = new.project_id
    where t.id = new.task_id and t.home_project_id is null and t.parent_task_id is null;
    if not found then
      raise exception 'Your role doesn’t allow moving this task into a project' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.adopt_private_task() from public, anon;
grant execute on function public.adopt_private_task() to authenticated;

create trigger task_projects_10_adopt_private
  after insert on public.task_projects
  for each row execute function public.adopt_private_task();

-- Dependency stories carry the other task's title only when everyone who can read the story's task can
-- read the other one. A private task is read by its top-level task's creator and assignee, so check them.
select public.alhc_patch_function('public.task_reach_within(uuid, uuid)'::regprocedure,
$p$  select not exists (select project_id from reach_a except select project_id from reach_b);$p$,
$p$  select not exists (select project_id from reach_a except select project_id from reach_b)
    -- A private task (no project) is read by its top-level task's creator and assignee only.
    and not exists (
      select 1
      from public.tasks rt
      cross join lateral (values (rt.created_by), (rt.assignee_id)) as reader (id)
      where rt.id = coalesce((select t.root_task_id from public.tasks t where t.id = target_task), target_task)
        and rt.home_project_id is null
        and reader.id is not null
        and public.profile_task_role(reader.id, other_task) is null
    );$p$);

-- Quick-add in My Tasks: a private task assigned to the caller.
create or replace function public.create_private_task(task_title text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  created uuid;
begin
  if not public.is_allowlisted() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  if nullif(trim(coalesce(task_title, '')), '') is null then
    raise exception 'Give the task a name' using errcode = 'check_violation';
  end if;
  insert into public.tasks (title, assignee_id)
  values (left(trim(task_title), 1000), auth.uid())
  returning id into created;
  return created;
end;
$$;

revoke all on function public.create_private_task(text) from public, anon;
grant execute on function public.create_private_task(text) to authenticated;

-- Search: private tasks are found by their creator and assignee (RLS), without a project label.
select public.alhc_patch_function('public.search_tasks(text, integer)'::regprocedure,
$p$  cross join lateral (
    select p.id, p.name$p$,
$p$  left join lateral (
    select p.id, p.name$p$,
$p$    limit 1
  ) shown
  where length(trim(query)) > 0$p$,
$p$    limit 1
  ) shown on true
  where length(trim(query)) > 0
    -- A private task (no project; subtasks through their root) shows without a project.
    and (shown.id is not null or t.home_project_id is null)$p$);

-- ---------------------------------------------------------------------------
-- Archived projects: rules don't fire, forms take no responses
-- ---------------------------------------------------------------------------

select public.alhc_patch_function('public.fire_rules(text, uuid, uuid, jsonb)'::regprocedure,
$p$    join public.projects p on p.id = ru.project_id and p.deleted_at is null
    join public.task_projects tp$p$,
$p$    join public.projects p on p.id = ru.project_id and p.deleted_at is null and p.archived_at is null
    join public.task_projects tp$p$);

select public.alhc_patch_function('public.workflow_tick()'::regprocedure,
$p$    if not r.enabled or r.deleted_at is not null
$p$,
$p$    if not r.enabled or r.deleted_at is not null
       or exists (select 1 from public.projects ap where ap.id = r.project_id and ap.archived_at is not null)
$p$,
$p$    join public.projects p on p.id = ru.project_id and p.deleted_at is null
    where ru.enabled$p$,
$p$    join public.projects p on p.id = ru.project_id and p.deleted_at is null and p.archived_at is null
    where ru.enabled$p$);

select public.alhc_patch_function('public.submit_form(uuid, text, jsonb)'::regprocedure,
$p$  if not f.accepting_responses then$p$,
$p$  if not f.accepting_responses
     or exists (select 1 from public.projects ap where ap.id = f.project_id and ap.archived_at is not null) then$p$);

select public.alhc_patch_function('public.get_public_form(uuid)'::regprocedure,
$p$  member boolean;
$p$,
$p$  member boolean;
  archived boolean;
$p$,
$p$  member := public.has_project_role(f.project_id, 'viewer');
$p$,
$p$  member := public.has_project_role(f.project_id, 'viewer');
  archived := exists (select 1 from public.projects ap where ap.id = f.project_id and ap.archived_at is not null);
$p$,
$p$    'accepting_responses', f.accepting_responses,
    'questions', case when f.accepting_responses or member then ($p$,
$p$    'accepting_responses', f.accepting_responses and not archived,
    'questions', case when (f.accepting_responses and not archived) or member then ($p$);

-- Archive / unarchive (Admin+ by the member's own role; the archive cap makes everyone a Viewer).
create or replace function public.set_project_archived(target_project uuid, archive boolean)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  p public.projects;
  own_role text;
begin
  if not public.is_allowlisted() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  if archive is null then
    raise exception 'Choose archive or unarchive' using errcode = 'check_violation';
  end if;
  select * into p from public.projects x where x.id = target_project and x.deleted_at is null for update;
  -- The caller's own membership, not the (capped) effective role.
  select m.role into own_role
  from public.project_members m
  where m.project_id = target_project and m.profile_id = me and m.deleted_at is null;
  if p.id is null or own_role is null then
    raise exception 'Project not found' using errcode = 'no_data_found';
  end if;
  if public.project_role_rank(own_role) < public.project_role_rank('admin') then
    raise exception 'Only project admins and owners can archive or unarchive a project'
      using errcode = 'insufficient_privilege';
  end if;

  if archive and p.archived_at is null then
    update public.projects set archived_at = now(), archived_by = me where id = target_project;
    insert into public.project_stories (project_id, actor_id, kind) values (target_project, me, 'archived');
  elsif not archive and p.archived_at is not null then
    update public.projects set archived_at = null, archived_by = null where id = target_project;
    insert into public.project_stories (project_id, actor_id, kind) values (target_project, me, 'unarchived');
  end if;
  return (select x.archived_at from public.projects x where x.id = target_project);
end;
$$;

revoke all on function public.set_project_archived(uuid, boolean) from public, anon;
grant execute on function public.set_project_archived(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Task likes
-- ---------------------------------------------------------------------------

create table public.task_likes (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id),
  profile_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

comment on table public.task_likes is
  'Likes (a heart) on tasks: read with the task (Viewer+), liked by Commenters+ (own rows only). '
  'Unliking soft-deletes; liking again adds a row.';

create unique index task_likes_one_active on public.task_likes (task_id, profile_id) where deleted_at is null;
create index task_likes_task_idx on public.task_likes (task_id) where deleted_at is null;

alter table public.task_likes enable row level security;
revoke all on public.task_likes from anon, authenticated;
grant select on public.task_likes to authenticated;
grant insert (task_id, profile_id) on public.task_likes to authenticated;
grant update (deleted_at) on public.task_likes to authenticated;

create policy task_likes_select_viewer on public.task_likes
  for select to authenticated
  using ((select public.has_task_role(task_likes.task_id, 'viewer')));

create policy task_likes_insert_own_commenter on public.task_likes
  for insert to authenticated
  with check (
    task_likes.profile_id = (select auth.uid())
    and (select public.has_task_role(task_likes.task_id, 'commenter'))
  );

create policy task_likes_update_own_commenter on public.task_likes
  for update to authenticated
  using (
    task_likes.profile_id = (select auth.uid())
    and (select public.has_task_role(task_likes.task_id, 'commenter'))
  )
  with check (
    task_likes.profile_id = (select auth.uid())
    and (select public.has_task_role(task_likes.task_id, 'commenter'))
  );

-- Likes go on active tasks; an unlike is final for that row (like again = a new row).
create or replace function public.guard_task_like()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from public.tasks t where t.id = new.task_id and t.deleted_at is null) then
      raise exception 'Task not found' using errcode = 'no_data_found';
    end if;
    new.created_at := now();
    new.updated_at := now();
    new.deleted_at := null;
    return new;
  end if;
  if new.task_id is distinct from old.task_id or new.profile_id is distinct from old.profile_id
     or new.created_at is distinct from old.created_at then
    raise exception 'A like can’t be moved' using errcode = 'insufficient_privilege';
  end if;
  if old.deleted_at is not null and new.deleted_at is distinct from old.deleted_at then
    raise exception 'Like the task again instead' using errcode = 'check_violation';
  end if;
  if new.deleted_at is not null and old.deleted_at is null then
    new.deleted_at := now();
  end if;
  return new;
end;
$$;

revoke all on function public.guard_task_like() from public, anon;
grant execute on function public.guard_task_like() to authenticated;

create trigger task_likes_05_guard
  before insert or update on public.task_likes
  for each row execute function public.guard_task_like();

create trigger task_likes_set_updated_at
  before update on public.task_likes
  for each row execute function public.set_updated_at();

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.task_likes;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Duplicate task (invoker: every row goes through RLS and the normal triggers)
-- ---------------------------------------------------------------------------
-- Attachments are copied as links to the original files (task_attachment_links.attachment_id, served by
-- the same RLS-checked /attachments/<id> route), never as new Storage objects.

alter table public.task_attachment_links drop constraint task_attachment_links_source_check;
alter table public.task_attachment_links add constraint task_attachment_links_source_check
  check (source in ('asana', 'duplicate'));
alter table public.task_attachment_links add column attachment_id uuid references public.task_attachments (id);
comment on column public.task_attachment_links.attachment_id is
  'Duplicate task: the original attachment this link points to (opened through /attachments/<id>, which '
  'checks access to the original).';

grant insert (task_id, source, name, url, attachment_id) on public.task_attachment_links to authenticated;
create policy task_attachment_links_insert_editor on public.task_attachment_links
  for insert to authenticated
  with check (
    task_attachment_links.source = 'duplicate'
    and task_attachment_links.deleted_at is null
    and (select public.has_task_role(task_attachment_links.task_id, 'editor'))
    and (
      task_attachment_links.attachment_id is null
      or exists (
        select 1 from public.task_attachments a
        where a.id = task_attachment_links.attachment_id and a.deleted_at is null
      )
    )
  );

-- Options shared by duplicate_task and duplicate_subtask_tree (all default true except a given title).
create or replace function public.duplicate_option(options jsonb, option_key text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce((options ->> option_key)::boolean, true);
$$;

revoke all on function public.duplicate_option(jsonb, text) from public, anon;
grant execute on function public.duplicate_option(jsonb, text) to authenticated;

-- The copy engine's subtask rules (copy_subtask_tree: active non-approval subtasks, in order, nested),
-- applied through RLS with the duplicate options. Returns how many subtasks were copied.
create or replace function public.duplicate_subtask_tree(source_parent uuid, target_parent uuid, options jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  c public.tasks;
  new_id uuid;
  r record;
  copied integer := 0;
begin
  for c in
    select * from public.tasks s
    where s.parent_task_id = source_parent and s.deleted_at is null
      and not exists (select 1 from public.approval_requests a where a.subtask_id = s.id)
    order by s.subtask_order, s.created_at, s.id
  loop
    insert into public.tasks (parent_task_id, title, notes, kind, subtask_order, start_on, due_on, start_at, due_at, time_zone)
    values (
      target_parent, c.title, c.notes, c.kind, c.subtask_order,
      case when public.duplicate_option(options, 'dates') then c.start_on end,
      case when public.duplicate_option(options, 'dates') then c.due_on end,
      case when public.duplicate_option(options, 'dates') then c.start_at end,
      case when public.duplicate_option(options, 'dates') then c.due_at end,
      c.time_zone
    )
    returning id into new_id;
    copied := copied + 1;

    if public.duplicate_option(options, 'assignee') and c.assignee_id is not null
       and public.profile_can_read_task(c.assignee_id, new_id) then
      begin
        update public.tasks set assignee_id = c.assignee_id where id = new_id;
      exception when check_violation or insufficient_privilege then
        null;
      end;
    end if;
    if public.duplicate_option(options, 'tags') then
      insert into public.task_tags (task_id, tag_id, created_by)
      select new_id, tt.tag_id, auth.uid()
      from public.task_tags tt
      join public.tags g on g.id = tt.tag_id and g.deleted_at is null and g.archived_at is null
      where tt.task_id = c.id and tt.deleted_at is null;
    end if;
    if public.duplicate_option(options, 'fields') then
      for r in
        select v.field_id, v.value from public.task_field_values v
        join public.custom_fields f on f.id = v.field_id and f.deleted_at is null and not f.bound_to_sections
        where v.task_id = c.id and v.value is not null and jsonb_typeof(v.value) <> 'null'
      loop
        begin
          insert into public.task_field_values (task_id, field_id, value) values (new_id, r.field_id, r.value);
        exception when check_violation or foreign_key_violation or insufficient_privilege then
          null;
        end;
      end loop;
    end if;
    if public.duplicate_option(options, 'followers') then
      for r in select f.profile_id from public.task_followers f where f.task_id = c.id and f.deleted_at is null loop
        begin
          insert into public.task_followers (task_id, profile_id) values (new_id, r.profile_id)
          on conflict (task_id, profile_id) do nothing;
        exception when insufficient_privilege or check_violation then
          null;
        end;
      end loop;
    end if;

    copied := copied + public.duplicate_subtask_tree(c.id, new_id, options);
  end loop;
  return copied;
end;
$$;

revoke all on function public.duplicate_subtask_tree(uuid, uuid, jsonb) from public, anon;
grant execute on function public.duplicate_subtask_tree(uuid, uuid, jsonb) to authenticated;

-- duplicate_task(target_task, options) → { task_id, subtasks, skipped: { assignee, fields, followers,
-- attachments, dependencies } }. options (all booleans default true): subtasks, assignee, dates, tags,
-- fields, followers, attachments, dependencies; title (text, default "Copy of <title>").
-- Where the copy lands: a subtask's copy sits right after it under the same parent (Editor on the tree);
-- a private task's copy is the caller's private task; a project task's copy goes into each of the task's
-- projects where the caller is Editor (the home project first, else the first of them), right after the
-- original in the same section. No project the caller edits → insufficient_privilege. The copy is open,
-- created by the caller (a normal creation: stories, inbox items, rules), and gets its own Req #.
create or replace function public.duplicate_task(target_task uuid, options jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  opts jsonb := coalesce(options, '{}'::jsonb);
  src public.tasks;
  home uuid;
  copy_title text;
  label text;
  created uuid;
  m record;
  r record;
  next_task uuid;
  next_sibling uuid;
  n_subtasks integer := 0;
  skipped_assignee boolean := false;
  skipped_fields integer := 0;
  skipped_followers integer := 0;
  skipped_attachments integer := 0;
  skipped_dependencies integer := 0;
  k text;
begin
  if jsonb_typeof(opts) <> 'object' then
    raise exception 'Duplicate options must be an object' using errcode = 'check_violation';
  end if;
  for k in select jsonb_object_keys(opts) loop
    if k not in ('subtasks', 'assignee', 'dates', 'tags', 'fields', 'followers', 'attachments', 'dependencies', 'title') then
      raise exception 'Unknown duplicate option: %', k using errcode = 'check_violation';
    end if;
    if k <> 'title' and jsonb_typeof(opts -> k) <> 'boolean' then
      raise exception 'Duplicate option % must be true or false', k using errcode = 'check_violation';
    end if;
  end loop;

  select * into src from public.tasks x where x.id = target_task and x.deleted_at is null;
  if not found then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;

  if src.parent_task_id is not null or src.home_project_id is null then
    if not public.has_task_role(src.id, 'editor') then
      raise exception 'Only editors can duplicate this task' using errcode = 'insufficient_privilege';
    end if;
  else
    select tp.project_id into home
    from public.task_projects tp
    join public.projects p on p.id = tp.project_id and p.deleted_at is null
    where tp.task_id = src.id and tp.deleted_at is null and public.has_project_role(tp.project_id, 'editor')
    order by (tp.project_id = src.home_project_id) desc, tp.created_at, tp.project_id
    limit 1;
    if home is null then
      raise exception 'You need Editor access in one of this task’s projects to duplicate it'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  copy_title := src.title;
  if src.req_number is not null then
    label := '[' || public.format_request_label(src.req_project_id, src.req_number) || '] ';
    if left(copy_title, length(label)) = label then
      copy_title := substr(copy_title, length(label) + 1);
    end if;
  end if;
  copy_title := coalesce(nullif(trim(opts ->> 'title'), ''), 'Copy of ' || copy_title);

  if src.parent_task_id is not null then
    select s.id into next_sibling from public.tasks s
    where s.parent_task_id = src.parent_task_id and s.deleted_at is null and s.id <> src.id
      and (s.subtask_order, s.created_at, s.id) > (src.subtask_order, src.created_at, src.id)
    order by s.subtask_order, s.created_at, s.id
    limit 1;
  end if;

  insert into public.tasks (
    home_project_id, parent_task_id, title, notes, kind, subtask_order,
    start_on, due_on, start_at, due_at, time_zone
  )
  values (
    home, src.parent_task_id, left(copy_title, 1000), src.notes, src.kind,
    case when src.parent_task_id is not null
      then public.subtask_order_before(src.parent_task_id, next_sibling, null) else 0 end,
    case when public.duplicate_option(opts, 'dates') then src.start_on end,
    case when public.duplicate_option(opts, 'dates') then src.due_on end,
    case when public.duplicate_option(opts, 'dates') then src.start_at end,
    case when public.duplicate_option(opts, 'dates') then src.due_at end,
    src.time_zone
  )
  returning id into created;

  -- Projects: right after the original in each project the caller edits (the home membership exists).
  if home is not null then
    for m in
      select tp.project_id, tp.section_id, tp.sort_order
      from public.task_projects tp
      join public.projects p on p.id = tp.project_id and p.deleted_at is null
      where tp.task_id = src.id and tp.deleted_at is null and public.has_project_role(tp.project_id, 'editor')
      order by (tp.project_id = home) desc, tp.created_at
    loop
      if m.project_id <> home then
        insert into public.task_projects (task_id, project_id, section_id, sort_order)
        values (created, m.project_id, m.section_id, m.sort_order + 1);
      end if;
      select n.task_id into next_task
      from public.task_projects n
      join public.tasks nt on nt.id = n.task_id and nt.deleted_at is null
      where n.project_id = m.project_id and n.deleted_at is null
        and n.section_id is not distinct from m.section_id
        and n.task_id not in (src.id, created)
        and n.sort_order > m.sort_order
      order by n.sort_order
      limit 1;
      perform public.place_task(created, m.project_id, m.section_id, next_task);
    end loop;
  end if;

  -- The assignee is kept when they can read the copy (a private copy is shared with them, as before).
  if public.duplicate_option(opts, 'assignee') and src.assignee_id is not null then
    if (src.parent_task_id is null and src.home_project_id is null)
       or public.profile_can_read_task(src.assignee_id, created) then
      begin
        update public.tasks set assignee_id = src.assignee_id where id = created;
      exception when check_violation or insufficient_privilege then
        skipped_assignee := true;
      end;
    else
      skipped_assignee := true;
    end if;
  end if;

  if public.duplicate_option(opts, 'tags') then
    insert into public.task_tags (task_id, tag_id, created_by)
    select created, tt.tag_id, auth.uid()
    from public.task_tags tt
    join public.tags g on g.id = tt.tag_id and g.deleted_at is null and g.archived_at is null
    where tt.task_id = src.id and tt.deleted_at is null;
  end if;

  if public.duplicate_option(opts, 'fields') then
    for r in
      select v.field_id, v.value from public.task_field_values v
      join public.custom_fields f on f.id = v.field_id and f.deleted_at is null and not f.bound_to_sections
      where v.task_id = src.id and v.value is not null and jsonb_typeof(v.value) <> 'null'
    loop
      begin
        insert into public.task_field_values (task_id, field_id, value) values (created, r.field_id, r.value);
      exception when check_violation or foreign_key_violation or insufficient_privilege then
        skipped_fields := skipped_fields + 1;
      end;
    end loop;
  end if;

  if public.duplicate_option(opts, 'followers') then
    for r in select f.profile_id from public.task_followers f where f.task_id = src.id and f.deleted_at is null loop
      begin
        insert into public.task_followers (task_id, profile_id) values (created, r.profile_id)
        on conflict (task_id, profile_id) do nothing;
      exception when insufficient_privilege or check_violation then
        skipped_followers := skipped_followers + 1;
      end;
    end loop;
  end if;

  if public.duplicate_option(opts, 'attachments') then
    for r in
      select a.id, a.file_name as name, null::text as url from public.task_attachments a
      where a.task_id = src.id and a.deleted_at is null
      union all
      select l.attachment_id, l.name, l.url from public.task_attachment_links l
      where l.task_id = src.id and l.deleted_at is null
    loop
      begin
        insert into public.task_attachment_links (task_id, source, name, url, attachment_id)
        values (created, 'duplicate', left(r.name, 255), r.url, r.id);
      exception when check_violation or foreign_key_violation or insufficient_privilege then
        skipped_attachments := skipped_attachments + 1;
      end;
    end loop;
  end if;

  if public.duplicate_option(opts, 'dependencies') then
    for r in
      select d.predecessor_id, d.successor_id, d.kind, d.lag_days from public.task_dependencies d
      where (d.successor_id = src.id or d.predecessor_id = src.id) and d.deleted_at is null
    loop
      begin
        if r.successor_id = src.id then
          perform public.set_task_dependency(r.predecessor_id, created, r.kind, r.lag_days);
        else
          perform public.set_task_dependency(created, r.successor_id, r.kind, r.lag_days);
        end if;
      exception when check_violation or insufficient_privilege or no_data_found then
        skipped_dependencies := skipped_dependencies + 1;
      end;
    end loop;
  end if;

  if public.duplicate_option(opts, 'subtasks') then
    n_subtasks := public.duplicate_subtask_tree(src.id, created, opts);
  end if;

  return jsonb_build_object(
    'task_id', created,
    'subtasks', n_subtasks,
    'skipped', jsonb_build_object(
      'assignee', skipped_assignee,
      'fields', skipped_fields,
      'followers', skipped_followers,
      'attachments', skipped_attachments,
      'dependencies', skipped_dependencies
    )
  );
end;
$$;

revoke all on function public.duplicate_task(uuid, jsonb) from public, anon;
grant execute on function public.duplicate_task(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Auto-shift gap closers: several tasks at once, and "pull dependents earlier" (invoker)
-- ---------------------------------------------------------------------------
-- moves: [{ task_id, start_on?, due_on? }] (1–200; a missing key keeps that date). The plan is the
-- single-task one (preview_dependency_shift, unchanged) over every moved task at once: a dependent is
-- pushed later just enough for every predecessor whose anchor moved later (kind + lag), keeping its
-- length; completed dependents and ones the caller can't edit are listed as skipped and push nothing
-- further; links to tasks the caller can't read are never followed. With pull_earlier, a dependent whose
-- predecessors moved earlier moves earlier by the smallest of those moves ("keep the gap"), but never
-- before what its other (readable) links allow; nothing is pulled without it.

create or replace function public.preview_dependency_shifts(moves jsonb, pull_earlier boolean default false)
returns table (
  task_id uuid, title text, start_on date, due_on date, new_start date, new_due date,
  shift_days integer, status text, reason text
)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  item jsonb;
  src public.tasks;
  t public.tasks;
  pt public.tasks;
  roots uuid[] := '{}';
  ns date;
  nd date;
  node record;
  edge record;
  -- Tasks that move (the given ones and every shifted dependent): id -> old / new start and due.
  moved jsonb := '{}'::jsonb;
  m jsonb;
  cur_start date;
  need date;
  floor_start date;
  pull integer;
  old_anchor date;
  new_anchor date;
  shift integer;
begin
  if jsonb_typeof(moves) is distinct from 'array' or jsonb_array_length(moves) not between 1 and 200 then
    raise exception 'Choose 1 to 200 tasks to move' using errcode = 'check_violation';
  end if;
  for item in select value from jsonb_array_elements(moves) loop
    if jsonb_typeof(item) <> 'object' or coalesce(item ->> 'task_id', '') !~* '^[0-9a-f-]{36}$' then
      raise exception 'Each move needs a task_id' using errcode = 'check_violation';
    end if;
    select * into src from public.tasks x where x.id = (item ->> 'task_id')::uuid and x.deleted_at is null;
    continue when not found or src.id = any (roots);
    ns := case when item ? 'start_on' then (item ->> 'start_on')::date else src.start_on end;
    nd := case when item ? 'due_on' then (item ->> 'due_on')::date else src.due_on end;
    if src.kind = 'milestone' then
      ns := null;
    end if;
    -- A move the task itself would refuse moves nothing.
    continue when ns is not null and nd is not null and ns > nd;
    roots := roots || src.id;
    moved := moved || jsonb_build_object(src.id::text, jsonb_build_object(
      'os', case when src.kind = 'milestone' then src.due_on else coalesce(src.start_on, src.due_on) end,
      'od', coalesce(src.due_on, src.start_on),
      'ns', case when src.kind = 'milestone' then nd else coalesce(ns, nd) end,
      'nd', coalesce(nd, ns)
    ));
  end loop;
  if cardinality(roots) = 0 then
    return;
  end if;

  for node in
    with recursive walk (id, depth) as (
      select d.successor_id, 1 from public.task_dependencies d
      where d.predecessor_id = any (roots) and d.deleted_at is null
      union
      select d.successor_id, w.depth + 1 from public.task_dependencies d
      join walk w on d.predecessor_id = w.id
      where d.deleted_at is null and w.depth < 200
    )
    select w.id, max(w.depth) as depth from walk w where not (w.id = any (roots))
    group by w.id order by max(w.depth), w.id
  loop
    select * into t from public.tasks x where x.id = node.id and x.deleted_at is null;
    continue when not found;
    cur_start := case when t.kind = 'milestone' then t.due_on else coalesce(t.start_on, t.due_on) end;
    continue when cur_start is null;

    need := null;
    pull := null;
    floor_start := null;
    for edge in
      select d.predecessor_id, d.kind, d.lag_days from public.task_dependencies d
      where d.successor_id = node.id and d.deleted_at is null
    loop
      if moved ? edge.predecessor_id::text then
        m := moved -> edge.predecessor_id::text;
        if edge.kind = 'start_to_start' then
          old_anchor := (m ->> 'os')::date;
          new_anchor := (m ->> 'ns')::date;
        else
          old_anchor := (m ->> 'od')::date;
          new_anchor := (m ->> 'nd')::date;
        end if;
      else
        select * into pt from public.tasks x where x.id = edge.predecessor_id and x.deleted_at is null;
        continue when not found;
        new_anchor := case when edge.kind = 'start_to_start'
          then case when pt.kind = 'milestone' then pt.due_on else coalesce(pt.start_on, pt.due_on) end
          else coalesce(pt.due_on, pt.start_on) end;
        old_anchor := new_anchor;
      end if;
      continue when new_anchor is null;
      floor_start := greatest(floor_start, new_anchor + edge.lag_days);
      if old_anchor is null or new_anchor > old_anchor then
        -- Only a predecessor whose anchor moved later pushes.
        need := greatest(need, new_anchor + edge.lag_days);
      elsif new_anchor < old_anchor then
        pull := greatest(pull, new_anchor - old_anchor);
      end if;
    end loop;

    if need is not null and need > cur_start then
      shift := need - cur_start;
    elsif pull_earlier and pull is not null then
      shift := greatest(cur_start + pull, coalesce(floor_start, cur_start + pull)) - cur_start;
      continue when shift >= 0;
    else
      continue;
    end if;

    task_id := t.id;
    title := t.title;
    start_on := t.start_on;
    due_on := t.due_on;
    shift_days := shift;
    if t.completed_at is not null then
      new_start := t.start_on;
      new_due := t.due_on;
      status := 'skipped';
      reason := 'Completed';
    elsif not public.has_task_role(t.id, 'editor') then
      new_start := t.start_on;
      new_due := t.due_on;
      status := 'skipped';
      reason := 'You can’t edit this task';
    else
      new_start := t.start_on + shift;
      new_due := t.due_on + shift;
      status := 'move';
      reason := null;
      moved := moved || jsonb_build_object(t.id::text, jsonb_build_object(
        'os', cur_start, 'od', coalesce(t.due_on, t.start_on),
        'ns', cur_start + shift, 'nd', coalesce(t.due_on, t.start_on) + shift
      ));
    end if;
    return next;
  end loop;
end;
$$;

revoke all on function public.preview_dependency_shifts(jsonb, boolean) from public, anon;
grant execute on function public.preview_dependency_shifts(jsonb, boolean) to authenticated;

-- Applies moves (each given task; ones that can't move are reported in skipped) and the confirmed
-- dependents of the plan computed against the dates before the move. Returns { changes, skipped } in
-- undo_dependency_shift's shape (the given tasks first).
create or replace function public.apply_dependency_shifts(
  moves jsonb,
  confirmed_tasks uuid[] default '{}'::uuid[],
  pull_earlier boolean default false
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  item jsonb;
  src public.tasks;
  ns date;
  nd date;
  plan record;
  after_row public.tasks;
  plan_rows jsonb;
  ready jsonb := '[]'::jsonb;
  done uuid[] := '{}';
  changes jsonb := '[]'::jsonb;
  skipped jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(moves) is distinct from 'array' or jsonb_array_length(moves) not between 1 and 200 then
    raise exception 'Choose 1 to 200 tasks to move' using errcode = 'check_violation';
  end if;
  if coalesce(cardinality(confirmed_tasks), 0) > 500 then
    raise exception 'Too many tasks to shift at once' using errcode = 'check_violation';
  end if;

  -- The given tasks that can move (others are skipped up front, so they push nothing).
  for item in select value from jsonb_array_elements(moves) loop
    if jsonb_typeof(item) <> 'object' or coalesce(item ->> 'task_id', '') !~* '^[0-9a-f-]{36}$' then
      raise exception 'Each move needs a task_id' using errcode = 'check_violation';
    end if;
    src := null;
    select * into src from public.tasks x where x.id = (item ->> 'task_id')::uuid and x.deleted_at is null;
    if src.id is null then
      skipped := skipped || jsonb_build_array(jsonb_build_object('task_id', (item ->> 'task_id')::uuid,
        'title', null, 'reason', 'Not found, or you don’t have access to it'));
      continue;
    end if;
    continue when src.id = any (done);
    done := done || src.id;
    ns := case when item ? 'start_on' then (item ->> 'start_on')::date else src.start_on end;
    nd := case when item ? 'due_on' then (item ->> 'due_on')::date else src.due_on end;
    if not public.has_task_role(src.id, 'editor') then
      skipped := skipped || jsonb_build_array(jsonb_build_object('task_id', src.id, 'title', src.title,
        'reason', 'You can’t edit this task'));
    elsif src.kind <> 'milestone' and ns is not null and nd is not null and ns > nd then
      skipped := skipped || jsonb_build_array(jsonb_build_object('task_id', src.id, 'title', src.title,
        'reason', 'The start date must be on or before the due date'));
    else
      ready := ready || jsonb_build_array(jsonb_build_object('task_id', src.id, 'start_on', ns, 'due_on', nd));
    end if;
  end loop;
  if jsonb_array_length(ready) = 0 then
    return jsonb_build_object('changes', changes, 'skipped', skipped);
  end if;

  -- The plan is computed against the dates before the move.
  select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) into plan_rows
  from public.preview_dependency_shifts(ready, pull_earlier) p;

  for item in select value from jsonb_array_elements(ready) loop
    select * into src from public.tasks x where x.id = (item ->> 'task_id')::uuid;
    after_row := null;
    update public.tasks x
    set start_on = (item ->> 'start_on')::date, due_on = (item ->> 'due_on')::date
    where x.id = src.id
    returning * into after_row;
    if after_row.id is null then
      raise exception 'Your role in this project doesn’t allow that' using errcode = 'insufficient_privilege';
    end if;
    if after_row.start_on is distinct from src.start_on or after_row.due_on is distinct from src.due_on then
      changes := changes || jsonb_build_array(jsonb_build_object(
        'task_id', src.id, 'title', src.title,
        'old_start_on', src.start_on, 'old_due_on', src.due_on,
        'new_start_on', after_row.start_on, 'new_due_on', after_row.due_on));
    end if;
  end loop;

  for plan in
    select * from jsonb_to_recordset(plan_rows) as r(
      task_id uuid, title text, start_on date, due_on date, new_start date, new_due date,
      shift_days integer, status text, reason text)
  loop
    if plan.status <> 'move' then
      skipped := skipped || jsonb_build_array(jsonb_build_object('task_id', plan.task_id, 'title', plan.title, 'reason', plan.reason));
      continue;
    end if;
    if not (plan.task_id = any (coalesce(confirmed_tasks, '{}'))) then
      skipped := skipped || jsonb_build_array(jsonb_build_object('task_id', plan.task_id, 'title', plan.title,
        'reason', 'Not part of the confirmed change'));
      continue;
    end if;
    after_row := null;
    update public.tasks x
    set start_on = plan.new_start, due_on = plan.new_due
    where x.id = plan.task_id
      and x.deleted_at is null
      and x.start_on is not distinct from plan.start_on
      and x.due_on is not distinct from plan.due_on
    returning * into after_row;
    if after_row.id is null then
      skipped := skipped || jsonb_build_array(jsonb_build_object('task_id', plan.task_id, 'title', plan.title,
        'reason', 'It changed since the preview'));
    else
      changes := changes || jsonb_build_array(jsonb_build_object(
        'task_id', plan.task_id, 'title', plan.title,
        'old_start_on', plan.start_on, 'old_due_on', plan.due_on,
        'new_start_on', after_row.start_on, 'new_due_on', after_row.due_on));
    end if;
  end loop;

  return jsonb_build_object('changes', changes, 'skipped', skipped);
end;
$$;

revoke all on function public.apply_dependency_shifts(jsonb, uuid[], boolean) from public, anon;
grant execute on function public.apply_dependency_shifts(jsonb, uuid[], boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Done
-- ---------------------------------------------------------------------------

drop function public.alhc_patch_function(regprocedure, text[]);
