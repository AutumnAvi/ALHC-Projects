-- ALHC Projects — Phase: Tags and collaboration extras.
-- Native workspace tags on tasks, project Messages (threads with replies, @mentions, and reactions on
-- the comment machinery), and the database side of attachment previews / CSV notices (none: those live
-- in the app). Generic: nothing knows about a team or request type.
--
-- Security shape (pinned by supabase/tests/zz02_tags_collaboration_smoke.sql):
--   * Tag names and colours are workspace-level (allowlisted read, like profiles). Anyone allowlisted
--     can create a tag; rename / recolour / archive belong to its creator or a workspace admin. That is
--     tag METADATA only: no project-scoped policy reads tags to grant anything.
--   * task_tags (the links) follow the task: read = Viewer+, write = Editor+ (has_task_role; a subtask
--     resolves through its root task, like every other task-scoped table).
--   * project_messages: read = Viewer+ of the project, post / reply / react = Commenter+, edit and
--     delete your own. @mentions only ever reach people who can read the project.
--   * Workspace admins get no task or message access from any of this.
--   * No new client-callable SECURITY DEFINER function: the definer functions below are triggers and
--     internal helpers, all revoked from public, anon, and authenticated (suite 60's list is unchanged).
--     notify_message() is the message twin of notify_with(): same import and copy mutes (both checks
--     kept as they are in notify_with), same "never notify the actor", same read check (the project).
--     fire_rules, notify_with, and add_story are untouched.
--
-- Views filter schema (src/lib/views.ts mirrors it): filters.tags = [tag uuid | null] (any-of; null =
-- no tags), group_by "tag" (a task with several tags shows under each; "No tag" last). Report filter:
-- tags = [tag uuid] (any-of, on the row's own tags). Bulk edit: add_tag / remove_tag {tag_id}.
--
-- Importer: Asana tags become native tags (import_task_tags, matched by name in the workspace, created
-- when missing). Projects imported before this phase kept tags in a multi-select "Tags" field; the
-- field mapped in import_external_ids (kind = 'field', external_id = 'asana:tags') is the marker, and
-- migrate_imported_tag_fields() copies its values into tags + task_tags ONCE per field (recorded in
-- tag_field_migrations, so running it again changes nothing). The field itself is kept (no DROP).
-- Project templates, Duplicate project, task templates, and recurrence carry tags.

-- ---------------------------------------------------------------------------
-- Tags (workspace-level)
-- ---------------------------------------------------------------------------

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  name text not null check (char_length(btrim(name)) between 1 and 50),
  color text not null default 'zinc'
    check (color in ('zinc', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink')),
  archived_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index tags_workspace_name_idx on public.tags (workspace_id, lower(btrim(name)))
  where deleted_at is null;

comment on table public.tags is
  'Tags and collaboration extras: workspace tags. Names are readable by everyone allowlisted; the creator '
  'or a workspace admin renames, recolours, and archives (archived tags stay on tasks but can''t be added). '
  'Tag metadata never grants task access.';

create trigger tags_set_updated_at
  before update on public.tags
  for each row execute function public.set_updated_at();

-- Runs as the caller. Creator / workspace / creation time are fixed; names are trimmed; a deleted tag
-- stays deleted.
create or replace function public.guard_tag()
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
      new.archived_at := null;
    end if;
    if new.workspace_id is null then
      select w.id into new.workspace_id
      from public.workspaces w where w.deleted_at is null order by w.created_at, w.id limit 1;
    end if;
    if not exists (select 1 from public.workspaces w where w.id = new.workspace_id and w.deleted_at is null) then
      raise exception 'Workspace not found' using errcode = 'no_data_found';
    end if;
  else
    if new.workspace_id <> old.workspace_id
       or new.created_by is distinct from old.created_by
       or new.created_at <> old.created_at then
      raise exception 'Only a tag''s name, colour, and archived state can change' using errcode = 'insufficient_privilege';
    end if;
    if old.deleted_at is not null then
      raise exception 'This tag was deleted' using errcode = 'check_violation';
    end if;
  end if;
  new.name := btrim(new.name);
  return new;
end;
$$;

revoke all on function public.guard_tag() from public, anon;
grant execute on function public.guard_tag() to authenticated;

create trigger tags_05_guard
  before insert or update on public.tags
  for each row execute function public.guard_tag();

-- Who manages a tag's metadata: its creator or a workspace admin (invoker; mirrored by the app).
create or replace function public.can_manage_tag(target_tag uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.tags t
    where t.id = target_tag
      and t.deleted_at is null
      and public.is_allowlisted()
      and (t.created_by = auth.uid() or public.is_workspace_admin(t.workspace_id))
  );
$$;

revoke all on function public.can_manage_tag(uuid) from public, anon;
grant execute on function public.can_manage_tag(uuid) to authenticated;

alter table public.tags enable row level security;

create policy tags_select_allowlisted on public.tags
  for select to authenticated
  using ((select public.is_allowlisted()));
create policy tags_insert_allowlisted on public.tags
  for insert to authenticated
  with check ((select public.is_allowlisted()) and created_by = (select auth.uid()));
create policy tags_update_manager on public.tags
  for update to authenticated
  using (
    (select public.is_allowlisted())
    and (created_by = (select auth.uid()) or (select public.is_workspace_admin(tags.workspace_id)))
  )
  with check ((select public.is_allowlisted()));

revoke all on public.tags from anon;
revoke delete, truncate, references, trigger on public.tags from authenticated;
revoke update on public.tags from authenticated;
grant update (name, color, archived_at, deleted_at) on public.tags to authenticated;

-- ---------------------------------------------------------------------------
-- task_tags (links; follow the task)
-- ---------------------------------------------------------------------------

create table public.task_tags (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id),
  tag_id uuid not null references public.tags (id),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index task_tags_active_idx on public.task_tags (task_id, tag_id) where deleted_at is null;
create index task_tags_tag_idx on public.task_tags (tag_id) where deleted_at is null;

comment on table public.task_tags is
  'Tags and collaboration extras: a tag on a task. Read with the task (Viewer+), added / removed by its '
  'Editors+ (has_task_role; subtasks resolve through their root). Removal is a soft delete; re-adding '
  'creates a new row.';

create trigger task_tags_set_updated_at
  before update on public.task_tags
  for each row execute function public.set_updated_at();

-- Runs as the caller. A link needs an existing tag in the task's workspace (people can't add archived
-- tags; copies and imports skip them on their own), never moves, and stays removed once removed.
create or replace function public.guard_task_tag()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  tag_workspace uuid;
  tag_archived timestamptz;
  task_workspace uuid;
begin
  if tg_op = 'INSERT' then
    select t.workspace_id, t.archived_at into tag_workspace, tag_archived
    from public.tags t where t.id = new.tag_id and t.deleted_at is null;
    if tag_workspace is null then
      raise exception 'Tag not found' using errcode = 'no_data_found';
    end if;
    select t.workspace_id into task_workspace
    from public.tasks t where t.id = new.task_id and t.deleted_at is null;
    if task_workspace is null then
      raise exception 'Task not found' using errcode = 'no_data_found';
    end if;
    if task_workspace <> tag_workspace then
      raise exception 'That tag belongs to another workspace' using errcode = 'check_violation';
    end if;
    if public.is_client_role() then
      if tag_archived is not null then
        raise exception 'Archived tags can’t be added to tasks' using errcode = 'check_violation';
      end if;
      new.created_by := auth.uid();
      new.created_at := now();
      new.deleted_at := null;
    end if;
    return new;
  end if;
  if new.task_id <> old.task_id or new.tag_id <> old.tag_id
     or new.created_by is distinct from old.created_by or new.created_at <> old.created_at then
    raise exception 'Tags can only be removed from a task' using errcode = 'insufficient_privilege';
  end if;
  if old.deleted_at is not null then
    raise exception 'This tag was already removed' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_task_tag() from public, anon;
grant execute on function public.guard_task_tag() to authenticated;

create trigger task_tags_05_guard
  before insert or update on public.task_tags
  for each row execute function public.guard_task_tag();

alter table public.task_tags enable row level security;

create policy task_tags_select_viewer on public.task_tags
  for select to authenticated
  using ((select public.has_task_role(task_tags.task_id, 'viewer')));
create policy task_tags_insert_editor on public.task_tags
  for insert to authenticated
  with check (created_by = (select auth.uid()) and (select public.has_task_role(task_tags.task_id, 'editor')));
create policy task_tags_update_editor on public.task_tags
  for update to authenticated
  using ((select public.has_task_role(task_tags.task_id, 'editor')))
  with check ((select public.has_task_role(task_tags.task_id, 'editor')));

revoke all on public.task_tags from anon;
revoke delete, truncate, references, trigger on public.task_tags from authenticated;
revoke update on public.task_tags from authenticated;
grant update (deleted_at) on public.task_tags to authenticated;

-- ---------------------------------------------------------------------------
-- Tag helpers for the copy engine, recurrence, and the importer (internal; revoked from clients)
-- ---------------------------------------------------------------------------

-- Active, unarchived tags of a task as a JSON array of ids (snapshots).
create or replace function public.task_tag_ids(target_task uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(tt.tag_id order by lower(g.name), g.id), '[]'::jsonb)
  from public.task_tags tt
  join public.tags g on g.id = tt.tag_id and g.deleted_at is null and g.archived_at is null
  where tt.task_id = target_task and tt.deleted_at is null;
$$;

-- Adds the listed tags (ids) to a task: only active, unarchived tags of the task's workspace; anything
-- else is skipped. Returns how many links were added.
create or replace function public.apply_task_tags(target_task uuid, tag_ids jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  added integer;
begin
  insert into public.task_tags (task_id, tag_id, created_by)
  select target_task, g.id, t.created_by
  from public.tasks t
  join public.tags g on g.workspace_id = t.workspace_id and g.deleted_at is null and g.archived_at is null
  where t.id = target_task
    and jsonb_typeof(tag_ids) = 'array'
    and tag_ids @> jsonb_build_array(g.id)
  on conflict (task_id, tag_id) where deleted_at is null do nothing;
  get diagnostics added = row_count;
  return added;
end;
$$;

-- Copies a task's active, unarchived tags onto another task (recurrence and subtask trees).
create or replace function public.copy_task_tags(source_task uuid, target_task uuid)
returns integer
language sql
set search_path = ''
as $$
  select public.apply_task_tags(target_task, public.task_tag_ids(source_task));
$$;

-- Find-or-create a workspace tag by name (case-insensitive, trimmed). An archived tag with that name
-- is reused as it is. Internal: used by the importer and the one-time field migration.
create or replace function public.ensure_tag(target_workspace uuid, tag_name text, tag_color text, creator uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  clean text := left(btrim(coalesce(tag_name, '')), 50);
  found_id uuid;
begin
  if clean = '' then
    return null;
  end if;
  select g.id into found_id
  from public.tags g
  where g.workspace_id = target_workspace and g.deleted_at is null and lower(btrim(g.name)) = lower(clean);
  if found_id is null then
    insert into public.tags (workspace_id, name, color, created_by)
    values (
      target_workspace, clean,
      case when tag_color in ('zinc', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink')
        then tag_color else 'zinc' end,
      creator
    )
    on conflict (workspace_id, lower(btrim(name))) where deleted_at is null do nothing
    returning id into found_id;
    if found_id is null then
      select g.id into found_id
      from public.tags g
      where g.workspace_id = target_workspace and g.deleted_at is null and lower(btrim(g.name)) = lower(clean);
    end if;
  end if;
  return found_id;
end;
$$;

-- Importer: tags of a newly imported task, by name. Archived matches are linked too (the task carried
-- the tag in Asana). Returns the number of links added.
create or replace function public.import_task_tags(target_project uuid, target_task uuid, names jsonb, creator uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  ws uuid;
  tag_name text;
  found_id uuid;
  added integer := 0;
  n integer;
begin
  if jsonb_typeof(names) <> 'array' then
    return 0;
  end if;
  select p.workspace_id into ws from public.projects p where p.id = target_project;
  for tag_name in select distinct btrim(v) from jsonb_array_elements_text(names) v where btrim(v) <> '' limit 100 loop
    found_id := public.ensure_tag(ws, tag_name, null, creator);
    continue when found_id is null;
    insert into public.task_tags (task_id, tag_id, created_by)
    values (target_task, found_id, creator)
    on conflict (task_id, tag_id) where deleted_at is null do nothing;
    get diagnostics n = row_count;
    added := added + n;
  end loop;
  return added;
end;
$$;

revoke all on function public.task_tag_ids(uuid) from public, anon, authenticated;
revoke all on function public.apply_task_tags(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.copy_task_tags(uuid, uuid) from public, anon, authenticated;
revoke all on function public.ensure_tag(uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.import_task_tags(uuid, uuid, jsonb, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- One-time migration of imported "Tags" fields into native tags
-- ---------------------------------------------------------------------------
-- The marker: import_external_ids rows with kind = 'field' and external_id = 'asana:tags' (the key the
-- importer used for its Tags multi-select). Each mapped field is migrated once: every stored value
-- (option ids) becomes links to workspace tags named after the options (colour kept; created when
-- missing, attributed to the import run's importer). tag_field_migrations records the field, so running
-- the function again does nothing for it — a tag someone removed afterwards is never re-added. The field
-- and its values are kept as they are (no DROP); new imports no longer write to it.

create table public.tag_field_migrations (
  field_id uuid primary key references public.custom_fields (id),
  tags_created integer not null default 0,
  links_created integer not null default 0,
  migrated_at timestamptz not null default now()
);

comment on table public.tag_field_migrations is
  'Tags and collaboration extras: imported Asana "Tags" fields already copied into native tags (once each). '
  'No client access.';

alter table public.tag_field_migrations enable row level security;
revoke all on public.tag_field_migrations from public, anon, authenticated;

create or replace function public.migrate_imported_tag_fields()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  m record;
  v record;
  ws uuid;
  creator uuid;
  tag_count_before integer;
  found_id uuid;
  opt jsonb;
  n integer;
  links integer;
  total integer := 0;
begin
  for m in
    select distinct on (x.local_id) x.local_id as field_id, x.project_id, x.run_id
    from public.import_external_ids x
    join public.custom_fields f on f.id = x.local_id
    where x.kind = 'field' and x.external_id = 'asana:tags'
      and not exists (select 1 from public.tag_field_migrations d where d.field_id = x.local_id)
    order by x.local_id, x.created_at
  loop
    select p.workspace_id into ws from public.projects p where p.id = m.project_id;
    select r.created_by into creator from public.import_runs r where r.id = m.run_id;
    select count(*) into tag_count_before from public.tags g where g.workspace_id = ws;
    links := 0;
    for v in
      select tv.task_id, tv.value, f.options
      from public.task_field_values tv
      join public.custom_fields f on f.id = tv.field_id
      join public.tasks t on t.id = tv.task_id and t.deleted_at is null
      where tv.field_id = m.field_id and jsonb_typeof(tv.value) = 'array'
    loop
      for opt in
        select o from jsonb_array_elements(v.options) o
        where v.value @> jsonb_build_array(o ->> 'id')
      loop
        found_id := public.ensure_tag(ws, opt ->> 'name', opt ->> 'color', creator);
        continue when found_id is null;
        insert into public.task_tags (task_id, tag_id, created_by)
        values (v.task_id, found_id, creator)
        on conflict (task_id, tag_id) where deleted_at is null do nothing;
        get diagnostics n = row_count;
        links := links + n;
      end loop;
    end loop;
    insert into public.tag_field_migrations (field_id, tags_created, links_created)
    values (m.field_id, (select count(*) from public.tags g where g.workspace_id = ws) - tag_count_before, links);
    total := total + links;
  end loop;
  return total;
end;
$$;

revoke all on function public.migrate_imported_tag_fields() from public, anon, authenticated;

comment on function public.migrate_imported_tag_fields() is
  'Tags and collaboration extras: copies each imported Asana Tags field (import_external_ids kind field, '
  'external_id asana:tags) into tags + task_tags once (tag_field_migrations). Returns links added. '
  'Run by the migration; safe to run again (does nothing for migrated fields).';

select public.migrate_imported_tag_fields();

-- ---------------------------------------------------------------------------
-- Task templates carry tags
-- ---------------------------------------------------------------------------

alter table public.task_templates add column tags jsonb not null default '[]'::jsonb;

comment on column public.task_templates.tags is
  'Tags and collaboration extras: tag ids added to tasks created from the template (archived or deleted '
  'tags are skipped then).';

-- ---------------------------------------------------------------------------
-- Project Messages (threads + replies on the comment machinery)
-- ---------------------------------------------------------------------------
-- A thread is a row with thread_id null and a title; a reply points at its thread (one level, no
-- title). Viewers read; Commenters+ post and reply; authors edit the body (and a thread's title) and
-- soft-delete their own (edited_at marks edits, like comments). Deleting a thread hides its replies.

create table public.project_messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  thread_id uuid references public.project_messages (id),
  title text,
  body text not null check (char_length(btrim(body)) between 1 and 20000),
  author_id uuid not null default auth.uid() references public.profiles (id),
  edited_at timestamptz,
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint project_messages_title_check check (
    (thread_id is null and title is not null and char_length(btrim(title)) between 1 and 200)
    or (thread_id is not null and title is null)
  ),
  constraint project_messages_not_own_thread check (thread_id is distinct from id)
);

create index project_messages_threads_idx on public.project_messages (project_id, last_activity_at desc)
  where thread_id is null and deleted_at is null;
create index project_messages_replies_idx on public.project_messages (thread_id, created_at)
  where thread_id is not null;

comment on table public.project_messages is
  'Tags and collaboration extras: project Messages. thread_id null = a thread (with a title), else a reply. '
  'Read = project Viewer+, post / reply = Commenter+, edit / soft-delete your own.';

create trigger project_messages_set_updated_at
  before update on public.project_messages
  for each row execute function public.set_updated_at();

-- Runs as the caller. Inserts: author = caller, a reply joins an active thread of the same project
-- (its project is copied from the thread). Updates by people: only the body (and a thread's title) or
-- a soft delete; a deleted message can't be edited or restored. Any body / title change stamps edited_at.
create or replace function public.guard_project_message()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  thread public.project_messages;
begin
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.author_id := auth.uid();
      new.created_at := now();
      new.last_activity_at := now();
      new.edited_at := null;
      new.deleted_at := null;
    end if;
    if new.thread_id is not null then
      select * into thread from public.project_messages m where m.id = new.thread_id;
      if not found or thread.deleted_at is not null then
        raise exception 'Message not found' using errcode = 'no_data_found';
      end if;
      if thread.thread_id is not null then
        raise exception 'Reply to the thread, not to a reply' using errcode = 'check_violation';
      end if;
      new.project_id := thread.project_id;
      new.title := null;
    else
      new.title := btrim(new.title);
    end if;
    new.body := btrim(new.body);
    return new;
  end if;

  if public.is_client_role() then
    if old.deleted_at is not null then
      raise exception 'This message was deleted' using errcode = 'check_violation';
    end if;
    if new.id <> old.id
       or new.project_id <> old.project_id
       or new.thread_id is distinct from old.thread_id
       or new.author_id <> old.author_id
       or new.created_at <> old.created_at
       or new.last_activity_at <> old.last_activity_at
       or new.edited_at is distinct from old.edited_at then
      raise exception 'Only the text of a message can be edited' using errcode = 'insufficient_privilege';
    end if;
  end if;
  if new.thread_id is null then
    new.title := btrim(new.title);
  end if;
  new.body := btrim(new.body);
  if new.body is distinct from old.body or new.title is distinct from old.title then
    new.edited_at := now();
  end if;
  return new;
end;
$$;

revoke all on function public.guard_project_message() from public, anon;
grant execute on function public.guard_project_message() to authenticated;

create trigger project_messages_05_guard
  before insert or update on public.project_messages
  for each row execute function public.guard_project_message();

alter table public.project_messages enable row level security;

create policy project_messages_select_viewer on public.project_messages
  for select to authenticated
  using ((select public.has_project_role(project_messages.project_id, 'viewer')));
create policy project_messages_insert_own_commenter on public.project_messages
  for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and (select public.has_project_role(project_messages.project_id, 'commenter'))
  );
create policy project_messages_update_own_commenter on public.project_messages
  for update to authenticated
  using (
    author_id = (select auth.uid())
    and (select public.has_project_role(project_messages.project_id, 'commenter'))
  )
  with check (
    author_id = (select auth.uid())
    and (select public.has_project_role(project_messages.project_id, 'commenter'))
  );

revoke all on public.project_messages from anon;
revoke delete, truncate, references, trigger on public.project_messages from authenticated;
revoke update on public.project_messages from authenticated;
grant update (title, body, deleted_at) on public.project_messages to authenticated;

-- Mentions (derived from a message; written only by the definer triggers below) ---------------------

create table public.project_message_mentions (
  message_id uuid not null references public.project_messages (id),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (message_id, profile_id)
);

comment on table public.project_message_mentions is
  'Tags and collaboration extras: people @mentioned in a project message (only people who can read the '
  'project). Written by triggers only.';

alter table public.project_message_mentions enable row level security;

create policy project_message_mentions_select_viewer on public.project_message_mentions
  for select to authenticated
  using (exists (
    select 1 from public.project_messages m
    where m.id = project_message_mentions.message_id
      and (select public.has_project_role(m.project_id, 'viewer'))
  ));

revoke all on public.project_message_mentions from anon;
revoke insert, update, delete, truncate, references, trigger on public.project_message_mentions from authenticated;

-- Reactions (the comment reaction set) --------------------------------------------------------------

create table public.project_message_reactions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.project_messages (id),
  project_id uuid not null references public.projects (id),
  profile_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  emoji text not null check (emoji in ('thumbs_up', 'heart', 'tada', 'laugh', 'eyes', 'check')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index project_message_reactions_active_idx
  on public.project_message_reactions (message_id, profile_id, emoji) where deleted_at is null;

comment on table public.project_message_reactions is
  'Tags and collaboration extras: reactions on project messages (same fixed set as comment_reactions). '
  'Read = project Viewer+, react = Commenter+ (own rows; removal is a soft delete).';

create trigger project_message_reactions_set_updated_at
  before update on public.project_message_reactions
  for each row execute function public.set_updated_at();

-- Runs as the caller: the project comes from the (active) message; people can only remove a reaction.
create or replace function public.guard_project_message_reaction()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    select m.project_id into new.project_id
    from public.project_messages m
    where m.id = new.message_id and m.deleted_at is null;
    if new.project_id is null then
      raise exception 'Message not found' using errcode = 'no_data_found';
    end if;
    if public.is_client_role() then
      new.created_at := now();
      new.deleted_at := null;
    end if;
    return new;
  end if;
  if public.is_client_role() then
    if new.message_id <> old.message_id
       or new.project_id <> old.project_id
       or new.profile_id <> old.profile_id
       or new.emoji <> old.emoji
       or new.created_at <> old.created_at
       or old.deleted_at is not null
       or new.deleted_at is null then
      raise exception 'Reactions can only be removed' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_project_message_reaction() from public, anon;
grant execute on function public.guard_project_message_reaction() to authenticated;

create trigger project_message_reactions_05_guard
  before insert or update on public.project_message_reactions
  for each row execute function public.guard_project_message_reaction();

alter table public.project_message_reactions enable row level security;

create policy project_message_reactions_select_viewer on public.project_message_reactions
  for select to authenticated
  using ((select public.has_project_role(project_message_reactions.project_id, 'viewer')));
create policy project_message_reactions_insert_own_commenter on public.project_message_reactions
  for insert to authenticated
  with check (
    profile_id = (select auth.uid())
    and (select public.has_project_role(project_message_reactions.project_id, 'commenter'))
    and exists (
      select 1 from public.project_messages m
      where m.id = project_message_reactions.message_id
        and m.project_id = project_message_reactions.project_id
        and m.deleted_at is null
    )
  );
create policy project_message_reactions_update_own_commenter on public.project_message_reactions
  for update to authenticated
  using (
    profile_id = (select auth.uid())
    and (select public.has_project_role(project_message_reactions.project_id, 'commenter'))
  )
  with check (
    profile_id = (select auth.uid())
    and (select public.has_project_role(project_message_reactions.project_id, 'commenter'))
  );

revoke all on public.project_message_reactions from anon;
revoke delete, truncate, references, trigger on public.project_message_reactions from authenticated;
revoke update on public.project_message_reactions from authenticated;
grant update (deleted_at) on public.project_message_reactions to authenticated;

-- ---------------------------------------------------------------------------
-- Inbox: items about a message (task_id null, message_id set)
-- ---------------------------------------------------------------------------

alter table public.inbox_items alter column task_id drop not null;
alter table public.inbox_items add column message_id uuid references public.project_messages (id);
alter table public.inbox_items add constraint inbox_items_target_check
  check (task_id is not null or message_id is not null);
alter table public.inbox_items drop constraint inbox_items_kind_check;
alter table public.inbox_items add constraint inbox_items_kind_check check (kind in (
  'assigned', 'comment', 'mention', 'completed', 'approval_requested', 'approval_decided', 'rule', 'message'
));
create index inbox_items_message_idx on public.inbox_items (message_id) where message_id is not null;

comment on column public.inbox_items.message_id is
  'Tags and collaboration extras: the project message an item is about (task_id is null then). Readable '
  'by the recipient only while they can read the message''s project.';

-- Same rule as before for task items; message items need Viewer+ on the message's project.
drop policy inbox_items_select_own_viewer on public.inbox_items;
drop policy inbox_items_update_own_viewer on public.inbox_items;

create policy inbox_items_select_own_viewer on public.inbox_items
  for select to authenticated
  using (
    recipient_id = (select auth.uid())
    and (
      (task_id is not null and (select public.has_task_role(inbox_items.task_id, 'viewer')))
      or (task_id is null and exists (
        select 1 from public.project_messages m
        where m.id = inbox_items.message_id and (select public.has_project_role(m.project_id, 'viewer'))
      ))
    )
  );
create policy inbox_items_update_own_viewer on public.inbox_items
  for update to authenticated
  using (
    recipient_id = (select auth.uid())
    and (
      (task_id is not null and (select public.has_task_role(inbox_items.task_id, 'viewer')))
      or (task_id is null and exists (
        select 1 from public.project_messages m
        where m.id = inbox_items.message_id and (select public.has_project_role(m.project_id, 'viewer'))
      ))
    )
  )
  with check (
    recipient_id = (select auth.uid())
    and (
      (task_id is not null and (select public.has_task_role(inbox_items.task_id, 'viewer')))
      or (task_id is null and exists (
        select 1 from public.project_messages m
        where m.id = inbox_items.message_id and (select public.has_project_role(m.project_id, 'viewer'))
      ))
    )
  );

-- The message twin of notify_with(): the same import and copy mutes, never the actor, and only people
-- who can read the project (allowlisted, with an active membership). Internal (definer, revoked).
create or replace function public.notify_message(recipient uuid, target_message uuid, item_kind text, item_data jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := public.current_actor_id();
  msg public.project_messages;
begin
  if public.import_context_id() is not null then
    return;
  end if;
  if public.copy_context_id() is not null then
    return;
  end if;
  if recipient is null or recipient is not distinct from actor then
    return;
  end if;
  select * into msg from public.project_messages m where m.id = target_message;
  if not found then
    return;
  end if;
  if not exists (select 1 from public.profiles p where p.id = recipient)
     or not public.profile_is_allowlisted(recipient)
     or public.profile_project_role(recipient, msg.project_id) is null then
    return;
  end if;
  insert into public.inbox_items (recipient_id, actor_id, task_id, message_id, kind, data)
  values (
    recipient, actor, null, target_message, item_kind,
    coalesce(item_data, '{}'::jsonb) || jsonb_build_object(
      'project_id', msg.project_id,
      'thread_id', coalesce(msg.thread_id, msg.id)
    )
  );
end;
$$;

revoke all on function public.notify_message(uuid, uuid, text, jsonb) from public, anon, authenticated;

-- @mentions in a message: the comment matcher (`@Full Name` or `@emaillocalpart`, word-bounded,
-- case-insensitive) over allowlisted people with an active membership in the project; never the author.
create or replace function public.message_mention_ids(target_project uuid, author uuid, body text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.profiles p
  where p.id is distinct from author
    and public.profile_project_role(p.id, target_project) is not null
    and public.profile_is_allowlisted(p.id)
    and (
      (nullif(trim(p.full_name), '') is not null
        and body ~* ('@' || public.regex_escape(trim(p.full_name)) || '([^[:alnum:]_]|$)'))
      or body ~* ('@' || public.regex_escape(split_part(p.email, '@', 1)) || '([^[:alnum:]_]|$)')
    );
$$;

revoke all on function public.message_mention_ids(uuid, uuid, text) from public, anon, authenticated;

-- After a message is posted: record mentions and notify them ("mention"); a reply also bumps the
-- thread and tells the thread's other participants (its author and earlier repliers) with "message".
create or replace function public.on_project_message_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  thread uuid := coalesce(new.thread_id, new.id);
begin
  insert into public.project_message_mentions (message_id, profile_id)
  select new.id, m.id
  from public.message_mention_ids(new.project_id, new.author_id, new.body) as m (id)
  on conflict do nothing;

  for r in select mm.profile_id from public.project_message_mentions mm where mm.message_id = new.id loop
    perform public.notify_message(r.profile_id, new.id, 'mention', '{}'::jsonb);
  end loop;

  if new.thread_id is not null then
    update public.project_messages set last_activity_at = now() where id = new.thread_id;
    for r in
      select distinct m.author_id as profile_id
      from public.project_messages m
      where (m.id = thread or m.thread_id = thread)
        and m.deleted_at is null
        and m.id <> new.id
        and m.author_id is distinct from new.author_id
        and not exists (
          select 1 from public.project_message_mentions mm
          where mm.message_id = new.id and mm.profile_id = m.author_id
        )
    loop
      perform public.notify_message(r.profile_id, new.id, 'message', '{}'::jsonb);
    end loop;
  end if;
  return new;
end;
$$;

revoke all on function public.on_project_message_insert() from public, anon, authenticated;

create trigger project_messages_after_insert
  after insert on public.project_messages
  for each row execute function public.on_project_message_insert();

-- After an edit: only newly mentioned people are notified (the comment rule). After a soft delete:
-- the message's inbox items (a thread's: its replies' too) are marked read.
create or replace function public.on_project_message_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update public.inbox_items i
    set read_at = coalesce(i.read_at, now())
    where i.message_id in (
      select m.id from public.project_messages m where m.id = new.id or m.thread_id = new.id
    );
    return new;
  end if;
  if new.deleted_at is null and new.body is distinct from old.body then
    for r in
      insert into public.project_message_mentions (message_id, profile_id)
      select new.id, m.id
      from public.message_mention_ids(new.project_id, new.author_id, new.body) as m (id)
      on conflict do nothing
      returning profile_id
    loop
      perform public.notify_message(r.profile_id, new.id, 'mention', '{}'::jsonb);
    end loop;
  end if;
  return new;
end;
$$;

revoke all on function public.on_project_message_update() from public, anon, authenticated;

create trigger project_messages_after_update
  after update of body, deleted_at on public.project_messages
  for each row execute function public.on_project_message_update();

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.project_messages, public.project_message_reactions;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Copy engine and recurrence carry tags (same functions, one added line each)
-- project_snapshot: each task carries "tags" (ids of its active, unarchived tags)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.project_snapshot(source_project uuid, opts jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  p public.projects;
  want_tasks boolean := coalesce((opts ->> 'tasks')::boolean, true);
  want_assignees boolean := coalesce((opts ->> 'assignees')::boolean, false);
  want_dates boolean := coalesce((opts ->> 'dates')::boolean, true);
  keep_completion boolean := coalesce((opts ->> 'keep_completion')::boolean, false);
  want_rules boolean := coalesce((opts ->> 'rules')::boolean, true);
  want_forms boolean := coalesce((opts ->> 'forms')::boolean, true);
  want_views boolean := coalesce((opts ->> 'views')::boolean, true);
  want_members boolean := coalesce((opts ->> 'members')::boolean, false);
  anchor date := nullif(opts ->> 'anchor_on', '')::date;
  task_count integer;
begin
  select * into p from public.projects where id = source_project and deleted_at is null;
  if not found then
    raise exception 'Project not found' using errcode = 'no_data_found';
  end if;

  if to_regclass('pg_temp.snapshot_tasks') is null then
    create temporary table snapshot_tasks (
      id uuid primary key, title text, notes text, section_id uuid, section_order double precision,
      sort_order double precision, completed_at timestamptz, assignee_id uuid, due_on date, start_on date,
      kind text
    ) on commit drop;
  else
    truncate pg_temp.snapshot_tasks;
  end if;

  if want_tasks then
    insert into pg_temp.snapshot_tasks
    select t.id,
      case
        when t.req_number is not null and left(t.title, length('[' || public.format_request_label(t.req_project_id, t.req_number) || '] '))
             = '[' || public.format_request_label(t.req_project_id, t.req_number) || '] '
             and length(t.title) > length('[' || public.format_request_label(t.req_project_id, t.req_number) || '] ')
          then substr(t.title, length('[' || public.format_request_label(t.req_project_id, t.req_number) || '] ') + 1)
        else t.title
      end,
      t.notes, s.id, s.sort_order, tp.sort_order, t.completed_at, t.assignee_id, t.due_on, t.start_on, t.kind
    from public.tasks t
    join public.task_projects tp on tp.task_id = t.id and tp.project_id = p.id and tp.deleted_at is null
    left join public.sections s on s.id = tp.section_id and s.deleted_at is null
    where t.deleted_at is null;
  end if;

  select count(*) into task_count from pg_temp.snapshot_tasks;
  if task_count > 2000 then
    raise exception 'Projects with more than 2,000 tasks can’t be copied yet (this one has %)', task_count
      using errcode = 'check_violation';
  end if;

  if anchor is null and want_dates then
    select min(least(st.start_on, st.due_on)) into anchor from pg_temp.snapshot_tasks st;
  end if;
  anchor := coalesce(anchor, current_date);

  return jsonb_build_object(
    'version', 1,
    'project', jsonb_build_object('description', p.description, 'approval_completes_task', p.approval_completes_task),
    'anchor_on', anchor,
    'request_sequence', (
      select jsonb_build_object('enabled', rs.enabled, 'prefix', rs.prefix, 'pad_width', rs.pad_width,
        'add_to_title', rs.add_to_title, 'assign_to', rs.assign_to)
      from public.request_sequences rs where rs.project_id = p.id and rs.deleted_at is null
    ),
    'sections', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.sort_order, s.created_at)
      from public.sections s where s.project_id = p.id and s.deleted_at is null
    ), '[]'::jsonb),
    'fields', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', f.id, 'name', f.name, 'field_type', f.field_type, 'options', f.options,
        'bound_to_sections', f.bound_to_sections, 'show_in_views', f.show_in_views
      ) order by f.sort_order, f.created_at)
      from public.custom_fields f where f.project_id = p.id and f.deleted_at is null
    ), '[]'::jsonb),
    'forms', case when want_forms then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', fm.id, 'title', fm.title, 'description', fm.description, 'questions', fm.questions,
        'destination_section_id', fm.destination_section_id, 'send_confirmation', fm.send_confirmation,
        'confirmation_message', fm.confirmation_message
      ) order by fm.created_at)
      from public.forms fm where fm.project_id = p.id and fm.deleted_at is null
    ), '[]'::jsonb) else '[]'::jsonb end,
    'rules', case when want_rules then coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', r.name, 'trigger_type', r.trigger_type, 'trigger_config', r.trigger_config,
        'conditions', r.conditions,
        -- Saved integration URLs / secrets stay with the source project.
        'actions', coalesce((
          select jsonb_agg(case when jsonb_typeof(a.value) = 'object'
            then a.value - 'webhook_ref' - 'webhook_hint' - 'url_ref' - 'url_hint' - 'secret_ref' - 'secret_set'
            else a.value end order by a.ordinality)
          from jsonb_array_elements(r.actions) with ordinality a
        ), '[]'::jsonb),
        'preset_key', r.preset_key
      ) order by r.sort_order, r.created_at)
      from public.rules r where r.project_id = p.id and r.deleted_at is null
    ), '[]'::jsonb) else '[]'::jsonb end,
    'views', case when want_views then coalesce((
      select jsonb_agg(jsonb_build_object('name', v.name, 'layout', v.layout, 'config', v.config)
        order by v.sort_order, v.created_at)
      from public.project_views v where v.project_id = p.id and v.deleted_at is null
    ), '[]'::jsonb) else '[]'::jsonb end,
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', st.id,
        'title', st.title,
        'notes', st.notes,
        'kind', st.kind,
        'tags', public.task_tag_ids(st.id),
        'section_id', st.section_id,
        'sort_order', st.sort_order,
        'completed', keep_completion and st.completed_at is not null,
        'completed_at', case when keep_completion then st.completed_at end,
        'assignee_id', case when want_assignees then st.assignee_id end,
        'due_offset', case when want_dates and st.due_on is not null then st.due_on - anchor end,
        'start_offset', case when want_dates and st.start_on is not null then st.start_on - anchor end,
        'fields', coalesce((
          select jsonb_agg(case
            when f.field_type = 'date' then jsonb_build_object('field_id', f.id, 'offset', (v.value #>> '{}')::date - anchor)
            else jsonb_build_object('field_id', f.id, 'value', v.value) end)
          from public.task_field_values v
          join public.custom_fields f on f.id = v.field_id and f.project_id = p.id and f.deleted_at is null
            and not f.bound_to_sections
          where v.task_id = st.id and v.value is not null and v.value <> 'null'::jsonb
            and (f.field_type <> 'people' or want_assignees)
            and (f.field_type <> 'date' or (want_dates and jsonb_typeof(v.value) = 'string'
              and v.value #>> '{}' ~ '^\d{4}-\d{2}-\d{2}$'))
        ), '[]'::jsonb),
        'subtasks', public.snapshot_subtasks(st.id, p.id, anchor, want_assignees, want_dates, keep_completion)
      ) order by st.section_order nulls first, st.sort_order, st.id)
      from pg_temp.snapshot_tasks st
    ), '[]'::jsonb),
    'dependencies', coalesce((
      select jsonb_agg(jsonb_build_object('predecessor', d.predecessor_id, 'successor', d.successor_id))
      from public.task_dependencies d
      where d.deleted_at is null
        and d.predecessor_id in (select st.id from pg_temp.snapshot_tasks st)
        and d.successor_id in (select st.id from pg_temp.snapshot_tasks st)
    ), '[]'::jsonb),
    'members', case when want_members then coalesce((
      select jsonb_agg(jsonb_build_object('profile_id', m.profile_id, 'role', m.role) order by m.created_at)
      from public.project_members m where m.project_id = p.id and m.deleted_at is null
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- snapshot_subtasks: each subtask carries "tags" too
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.snapshot_subtasks(parent uuid, source_project uuid, anchor date, want_assignees boolean, want_dates boolean, keep_completion boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'title', c.title,
      'notes', c.notes,
      'kind', c.kind,
      'tags', public.task_tag_ids(c.id),
      'completed', keep_completion and c.completed_at is not null,
      'completed_at', case when keep_completion then c.completed_at end,
      'assignee_id', case when want_assignees then c.assignee_id end,
      'due_offset', case when want_dates and c.due_on is not null then c.due_on - anchor end,
      'start_offset', case when want_dates and c.start_on is not null then c.start_on - anchor end,
      'fields', public.snapshot_task_fields(c.id, source_project, anchor, want_assignees, want_dates),
      'subtasks', public.snapshot_subtasks(c.id, source_project, anchor, want_assignees, want_dates, keep_completion)
    ) order by c.subtask_order, c.created_at, c.id)
    from public.tasks c
    where c.parent_task_id = parent and c.deleted_at is null
      and not exists (select 1 from public.approval_requests a where a.subtask_id = c.id)
  ), '[]'::jsonb);
end;
$function$;

-- ---------------------------------------------------------------------------
-- instantiate_project_snapshot: copied tasks get the tags that still exist (apply_task_tags)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.instantiate_project_snapshot(snapshot jsonb, project_name text, start_on date, target_workspace uuid, story_kind text, story_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me uuid := public.current_profile_id();
  new_project uuid;
  id_map jsonb := '{}'::jsonb;    -- sections, fields, forms
  task_map jsonb := '{}'::jsonb;
  item jsonb;
  child jsonb;
  found_id uuid;
  new_task uuid;
  v_section uuid;
  v_field_type text;
  v_value jsonb;
  assignee uuid;
  base_date date := coalesce(start_on, current_date);
  i integer;
  kept_views uuid[] := '{}';
  n_sections integer := 0;
  n_fields integer := 0;
  n_tasks integer := 0;
  n_rules integer := 0;
  n_rules_skipped integer := 0;
  n_forms integer := 0;
  n_forms_skipped integer := 0;
  n_views integer := 0;
  n_views_skipped integer := 0;
  n_values_skipped integer := 0;
  n_members integer := 0;
  n_subtasks integer := 0;
  sub_result jsonb;
begin
  if me is null or not public.is_allowlisted() then
    raise exception 'Sign in to create projects' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(snapshot) <> 'object' or (snapshot ->> 'version') is distinct from '1' then
    raise exception 'This template can’t be used (unknown format)' using errcode = 'check_violation';
  end if;
  if nullif(trim(coalesce(project_name, '')), '') is null then
    raise exception 'Project name can’t be empty' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.workspaces w where w.id = target_workspace and w.deleted_at is null) then
    raise exception 'Workspace not found' using errcode = 'no_data_found';
  end if;

  -- Left set until the transaction ends so the deferred task_created rule trigger sees it too.
  perform set_config('alhc.copy_id', gen_random_uuid()::text, true);

  insert into public.projects (workspace_id, name, description, approval_completes_task, created_by, sort_order)
  values (
    target_workspace,
    left(trim(project_name), 200),
    nullif(snapshot #>> '{project,description}', ''),
    coalesce((snapshot #>> '{project,approval_completes_task}')::boolean, false),
    me,
    coalesce((select max(pj.sort_order) from public.projects pj
              where pj.workspace_id = target_workspace and pj.deleted_at is null), 0) + 1024
  )
  returning id into new_project;
  -- projects_add_owner made the caller the owner.

  -- Members (Duplicate project only): owners of the source join as admins; the caller stays owner.
  for item in select * from jsonb_array_elements(case when jsonb_typeof(snapshot -> 'members') = 'array' then snapshot -> 'members' else '[]' end) loop
    found_id := (item ->> 'profile_id')::uuid;
    continue when found_id is null or found_id = me or not public.profile_is_allowlisted(found_id)
      or public.project_role_rank(item ->> 'role') = 0;
    insert into public.project_members (project_id, profile_id, role, created_by)
    values (new_project, found_id, case when item ->> 'role' = 'owner' then 'admin' else item ->> 'role' end, me);
    n_members := n_members + 1;
  end loop;

  -- Req # settings (numbering restarts at 1).
  if jsonb_typeof(snapshot -> 'request_sequence') = 'object' then
    insert into public.request_sequences (project_id, enabled, prefix, pad_width, add_to_title, assign_to)
    values (
      new_project,
      coalesce((snapshot #>> '{request_sequence,enabled}')::boolean, true),
      left(coalesce(snapshot #>> '{request_sequence,prefix}', 'Req #'), 20),
      least(greatest(coalesce((snapshot #>> '{request_sequence,pad_width}')::smallint, 0), 0), 8),
      coalesce((snapshot #>> '{request_sequence,add_to_title}')::boolean, true),
      case when snapshot #>> '{request_sequence,assign_to}' = 'all_tasks' then 'all_tasks' else 'form_submissions' end
    );
  end if;

  -- Sections -------------------------------------------------------------------------------------
  i := 0;
  for item in select * from jsonb_array_elements(case when jsonb_typeof(snapshot -> 'sections') = 'array' then snapshot -> 'sections' else '[]' end) loop
    continue when nullif(trim(item ->> 'name'), '') is null;
    i := i + 1;
    insert into public.sections (project_id, name, sort_order)
    values (new_project, left(trim(item ->> 'name'), 200), i * 1024)
    returning id into found_id;
    if nullif(item ->> 'id', '') is not null then
      id_map := id_map || jsonb_build_object(item ->> 'id', found_id);
    end if;
    n_sections := n_sections + 1;
  end loop;

  -- Custom field definitions (option ids are kept, so rule/form/value references stay valid) -------
  i := 0;
  for item in select * from jsonb_array_elements(case when jsonb_typeof(snapshot -> 'fields') = 'array' then snapshot -> 'fields' else '[]' end) loop
    i := i + 1;
    insert into public.custom_fields (project_id, name, field_type, options, bound_to_sections, show_in_views, sort_order)
    values (
      new_project,
      left(trim(item ->> 'name'), 100),
      item ->> 'field_type',
      case when jsonb_typeof(item -> 'options') = 'array' then item -> 'options' else '[]'::jsonb end,
      coalesce((item ->> 'bound_to_sections')::boolean, false),
      coalesce((item ->> 'show_in_views')::boolean, false),
      i * 1024
    )
    returning id into found_id;
    if nullif(item ->> 'id', '') is not null then
      id_map := id_map || jsonb_build_object(item ->> 'id', found_id);
    end if;
    n_fields := n_fields + 1;
  end loop;

  -- Forms (closed until someone opens them; ones that no longer validate are skipped) --------------
  for item in select * from jsonb_array_elements(case when jsonb_typeof(snapshot -> 'forms') = 'array' then snapshot -> 'forms' else '[]' end) loop
    begin
      insert into public.forms (project_id, title, description, questions, destination_section_id, accepting_responses,
        send_confirmation, confirmation_message, created_by)
      values (
        new_project,
        left(coalesce(nullif(trim(item ->> 'title'), ''), 'Form'), 200),
        item ->> 'description',
        coalesce(public.template_remap(item -> 'questions', id_map), '[]'::jsonb),
        (id_map ->> (item ->> 'destination_section_id'))::uuid,
        false,
        coalesce((item ->> 'send_confirmation')::boolean, true),
        item ->> 'confirmation_message',
        me
      )
      returning id into found_id;
      if nullif(item ->> 'id', '') is not null then
        id_map := id_map || jsonb_build_object(item ->> 'id', found_id);
      end if;
      n_forms := n_forms + 1;
    exception when check_violation or not_null_violation or invalid_text_representation
      or foreign_key_violation or invalid_parameter_value or raise_exception then
      n_forms_skipped := n_forms_skipped + 1;
    end;
  end loop;

  -- Rules: ALWAYS disabled (rules_04_copy_disabled forces it too). Invalid ones are skipped. --------
  i := 0;
  for item in select * from jsonb_array_elements(case when jsonb_typeof(snapshot -> 'rules') = 'array' then snapshot -> 'rules' else '[]' end) loop
    i := i + 1;
    begin
      insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, conditions, actions,
        preset_key, created_by, sort_order)
      values (
        new_project,
        left(coalesce(nullif(trim(item ->> 'name'), ''), 'Copied rule'), 200),
        false,
        item ->> 'trigger_type',
        coalesce(public.template_remap(item -> 'trigger_config', id_map), '{}'::jsonb),
        coalesce(public.template_remap(item -> 'conditions', id_map), '[]'::jsonb),
        coalesce(public.template_remap(item -> 'actions', id_map), '[]'::jsonb),
        item ->> 'preset_key',
        me,
        i * 1024
      );
      n_rules := n_rules + 1;
    exception when check_violation or not_null_violation or invalid_text_representation
      or foreign_key_violation or invalid_parameter_value or raise_exception then
      n_rules_skipped := n_rules_skipped + 1;
    end;
  end loop;

  -- Saved views replace the default tabs when at least one copies cleanly --------------------------
  i := 0;
  for item in select * from jsonb_array_elements(case when jsonb_typeof(snapshot -> 'views') = 'array' then snapshot -> 'views' else '[]' end) loop
    i := i + 1;
    begin
      insert into public.project_views (project_id, name, layout, config, sort_order, created_by)
      values (
        new_project,
        left(trim(item ->> 'name'), 100),
        item ->> 'layout',
        coalesce(public.template_remap(item -> 'config', id_map), '{}'::jsonb),
        i * 1024,
        me
      )
      returning id into found_id;
      kept_views := kept_views || found_id;
      n_views := n_views + 1;
    exception when check_violation or not_null_violation or invalid_text_representation
      or foreign_key_violation or invalid_parameter_value or raise_exception then
      n_views_skipped := n_views_skipped + 1;
    end;
  end loop;
  if cardinality(kept_views) > 0 then
    update public.project_views set deleted_at = now()
    where project_id = new_project and deleted_at is null and not (id = any (kept_views));
  end if;

  -- Tasks ------------------------------------------------------------------------------------------
  for item in select * from jsonb_array_elements(case when jsonb_typeof(snapshot -> 'tasks') = 'array' then snapshot -> 'tasks' else '[]' end) loop
    -- Assignees are kept only when they can read the new project (members copied with it, or the caller).
    assignee := (item ->> 'assignee_id')::uuid;
    if assignee is not null and public.profile_project_role(assignee, new_project) is null then
      assignee := null;
    end if;
    insert into public.tasks (home_project_id, title, notes, completed_at, assignee_id, due_on, start_on, created_by, kind)
    values (
      new_project,
      left(coalesce(nullif(trim(item ->> 'title'), ''), 'Untitled task'), 1000),
      item ->> 'notes',
      case when coalesce((item ->> 'completed')::boolean, false)
        then coalesce((item ->> 'completed_at')::timestamptz, now()) end,
      assignee,
      case when jsonb_typeof(item -> 'due_offset') = 'number' then base_date + (item ->> 'due_offset')::integer end,
      case when jsonb_typeof(item -> 'start_offset') = 'number' then base_date + (item ->> 'start_offset')::integer end,
      me,
      case when item ->> 'kind' in ('milestone', 'approval') then item ->> 'kind' else 'task' end
    )
    returning id into new_task;
    n_tasks := n_tasks + 1;
    perform public.apply_task_tags(new_task, item -> 'tags');
    if nullif(item ->> 'id', '') is not null then
      task_map := task_map || jsonb_build_object(item ->> 'id', new_task);
    end if;

    v_section := (id_map ->> (item ->> 'section_id'))::uuid;
    update public.task_projects
    set section_id = v_section,
        sort_order = coalesce((item ->> 'sort_order')::double precision, sort_order)
    where task_id = new_task and project_id = new_project;

    for child in select * from jsonb_array_elements(case when jsonb_typeof(item -> 'fields') = 'array' then item -> 'fields' else '[]' end) loop
      found_id := (id_map ->> (child ->> 'field_id'))::uuid;
      select f.field_type into v_field_type from public.custom_fields f where f.id = found_id;
      v_value := case
        when found_id is null then null
        when v_field_type = 'date' and jsonb_typeof(child -> 'offset') = 'number'
          then to_jsonb((base_date + (child ->> 'offset')::integer)::text)
        when v_field_type = 'date' then null
        else child -> 'value'
      end;
      if v_value is null then
        n_values_skipped := n_values_skipped + 1;
        continue;
      end if;
      begin
        insert into public.task_field_values (task_id, field_id, value) values (new_task, found_id, v_value);
      exception when check_violation or foreign_key_violation or invalid_text_representation then
        n_values_skipped := n_values_skipped + 1;
      end;
    end loop;

    sub_result := public.instantiate_subtasks(new_task, item -> 'subtasks', base_date, id_map, new_project, me);
    n_subtasks := n_subtasks + (sub_result ->> 'created')::integer;
    n_values_skipped := n_values_skipped + (sub_result ->> 'values_skipped')::integer;
  end loop;

  -- Dependencies between copied tasks (the source had no cycles, so neither does the copy) ---------
  insert into public.task_dependencies (project_id, predecessor_id, successor_id, created_by)
  select distinct new_project, (task_map ->> (d ->> 'predecessor'))::uuid, (task_map ->> (d ->> 'successor'))::uuid, me
  from jsonb_array_elements(case when jsonb_typeof(snapshot -> 'dependencies') = 'array' then snapshot -> 'dependencies' else '[]' end) d
  where task_map ? (d ->> 'predecessor') and task_map ? (d ->> 'successor')
    and d ->> 'predecessor' <> d ->> 'successor';

  -- The caller auto-followed every copied task as its creator; keep only the ones assigned to them.
  update public.task_followers tf set deleted_at = now()
  from public.tasks t
  where t.id = tf.task_id and t.home_project_id = new_project and tf.profile_id = me and tf.deleted_at is null
    and t.assignee_id is distinct from me;

  insert into public.project_stories (project_id, actor_id, kind, data)
  values (new_project, me, story_kind, coalesce(story_data, '{}'::jsonb) || jsonb_build_object(
    'start_on', base_date, 'tasks', n_tasks, 'rules', n_rules));

  return jsonb_build_object(
    'project_id', new_project,
    'sections', n_sections,
    'fields', n_fields,
    'tasks', n_tasks,
    'subtasks', n_subtasks,
    'rules', n_rules,
    'rules_skipped', n_rules_skipped,
    'forms', n_forms,
    'forms_skipped', n_forms_skipped,
    'views', n_views,
    'views_skipped', n_views_skipped,
    'values_skipped', n_values_skipped,
    'members', n_members
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- instantiate_subtasks: the same for subtasks
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.instantiate_subtasks(parent uuid, items jsonb, base_date date, id_map jsonb, new_project uuid, me uuid, depth integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  child jsonb;
  new_id uuid;
  assignee uuid;
  v_due date;
  v_start date;
  i integer := 0;
  created integer := 0;
  skipped integer := 0;
  sub jsonb;
begin
  for child in select * from jsonb_array_elements(case when jsonb_typeof(items) = 'array' then items else '[]' end) loop
    continue when jsonb_typeof(child) <> 'object' or nullif(trim(child ->> 'title'), '') is null;
    i := i + 1;
    assignee := case when child ->> 'assignee_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (child ->> 'assignee_id')::uuid end;
    if assignee is not null and public.profile_project_role(assignee, new_project) is null then
      assignee := null;
    end if;
    v_due := case when jsonb_typeof(child -> 'due_offset') = 'number' then base_date + (child ->> 'due_offset')::integer end;
    v_start := case when jsonb_typeof(child -> 'start_offset') = 'number' then base_date + (child ->> 'start_offset')::integer end;
    if v_start > v_due then
      v_start := null;
    end if;
    insert into public.tasks (parent_task_id, title, notes, completed_at, assignee_id, due_on, start_on, created_by, kind, subtask_order)
    values (
      parent,
      left(trim(child ->> 'title'), 1000),
      child ->> 'notes',
      case when coalesce((child ->> 'completed')::boolean, false)
        then coalesce((child ->> 'completed_at')::timestamptz, now()) end,
      assignee,
      v_due,
      v_start,
      me,
      case when child ->> 'kind' in ('milestone', 'approval') then child ->> 'kind' else 'task' end,
      i * 1024
    )
    returning id into new_id;
    created := created + 1;
    perform public.apply_task_tags(new_id, child -> 'tags');
    skipped := skipped + public.instantiate_task_fields(new_id, child -> 'fields', id_map, base_date);
    if depth < public.subtask_max_depth() then
      sub := public.instantiate_subtasks(new_id, child -> 'subtasks', base_date, id_map, new_project, me, depth + 1);
    else
      sub := public.instantiate_subtasks(parent, child -> 'subtasks', base_date, id_map, new_project, me, depth);
    end if;
    created := created + (sub ->> 'created')::integer;
    skipped := skipped + (sub ->> 'values_skipped')::integer;
  end loop;
  return jsonb_build_object('created', created, 'values_skipped', skipped);
end;
$function$;

-- ---------------------------------------------------------------------------
-- copy_subtask_tree (recurrence): subtasks keep their tags
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.copy_subtask_tree(source_parent uuid, target_parent uuid, day_shift integer)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  c public.tasks;
  tz text;
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
    tz := public.safe_timezone(c.time_zone);
    insert into public.tasks (
      parent_task_id, title, notes, assignee_id, start_on, due_on, start_at, due_at, time_zone, created_by,
      kind, subtask_order
    )
    values (
      target_parent, c.title, c.notes, c.assignee_id,
      c.start_on + day_shift, c.due_on + day_shift,
      ((c.start_at at time zone tz) + make_interval(days => day_shift)) at time zone tz,
      ((c.due_at at time zone tz) + make_interval(days => day_shift)) at time zone tz,
      c.time_zone, c.created_by, c.kind, c.subtask_order
    )
    returning id into new_id;
    copied := copied + 1;
    perform public.copy_task_tags(c.id, new_id);

    for r in
      select v.field_id, v.value from public.task_field_values v
      join public.custom_fields f on f.id = v.field_id and f.deleted_at is null and not f.bound_to_sections
      where v.task_id = c.id and v.value is not null and jsonb_typeof(v.value) <> 'null'
    loop
      begin
        insert into public.task_field_values (task_id, field_id, value) values (new_id, r.field_id, r.value);
      exception when check_violation or foreign_key_violation then
        null;
      end;
    end loop;

    for r in
      select f.profile_id from public.task_followers f where f.task_id = c.id and f.deleted_at is null
    loop
      perform public.follow_task(new_id, r.profile_id);
    end loop;

    copied := copied + public.copy_subtask_tree(c.id, new_id, day_shift);
  end loop;
  return copied;
end;
$function$;

-- ---------------------------------------------------------------------------
-- spawn_next_occurrence: the next occurrence keeps the task's tags
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.spawn_next_occurrence()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  rule jsonb := new.recurrence;
  ends jsonb := coalesce(new.recurrence -> 'ends', '{"type": "never"}'::jsonb);
  rule_tz text := public.safe_timezone(new.recurrence ->> 'timezone');
  time_tz text := public.safe_timezone(new.time_zone);
  anchor date := coalesce(new.due_on, new.start_on, (now() at time zone rule_tz)::date);
  next_anchor date;
  shift integer;
  next_id uuid;
  next_rule jsonb;
  next_title text := new.title;
  label text;
  r record;
begin
  if new.recurrence_next_id is not null and exists (
    select 1 from public.tasks t where t.id = new.recurrence_next_id and t.deleted_at is null
  ) then
    return null;
  end if;
  if ends ->> 'type' = 'after' and new.recurrence_seq >= (ends ->> 'count')::integer then
    return null;
  end if;
  -- A recurring subtask's next occurrence goes under the same parent, unless that is gone.
  if new.parent_task_id is not null and not exists (
    select 1 from public.tasks t where t.id = new.parent_task_id and t.deleted_at is null
  ) then
    return null;
  end if;
  next_anchor := public.recurrence_next_date(rule, anchor);
  if ends ->> 'type' = 'until' and next_anchor > (ends ->> 'until')::date then
    return null;
  end if;
  shift := next_anchor - anchor;

  -- A title prefixed with this task's Req # gets the next occurrence's own number instead.
  if new.req_number is not null then
    label := '[' || public.format_request_label(new.req_project_id, new.req_number) || '] ';
    if left(next_title, length(label)) = label then
      next_title := substr(next_title, length(label) + 1);
    end if;
  end if;

  next_rule := rule;
  if rule ->> 'freq' in ('monthly', 'yearly') and not rule ? 'month_day' then
    next_rule := rule || jsonb_build_object('month_day', extract(day from anchor)::integer);
  end if;

  insert into public.tasks (
    home_project_id, title, notes, assignee_id, start_on, due_on, start_at, due_at, time_zone, created_by,
    recurrence, recurrence_series_id, recurrence_seq, kind, parent_task_id, subtask_order
  )
  values (
    new.home_project_id,
    next_title,
    new.notes,
    new.assignee_id,
    new.start_on + shift,
    case when new.due_on is null and new.start_on is null then next_anchor else new.due_on + shift end,
    ((new.start_at at time zone time_tz) + make_interval(days => shift)) at time zone time_tz,
    ((new.due_at at time zone time_tz) + make_interval(days => shift)) at time zone time_tz,
    new.time_zone,
    new.created_by,
    next_rule,
    coalesce(new.recurrence_series_id, new.id),
    new.recurrence_seq + 1,
    new.kind,
    new.parent_task_id,
    case when new.parent_task_id is not null then coalesce((
      select max(s.subtask_order) from public.tasks s where s.parent_task_id = new.parent_task_id and s.deleted_at is null
    ), 0) + 1024 else 0 end
  )
  returning id into next_id;

  -- Same projects and sections (the home membership exists already via ensure_home_membership).
  update public.task_projects tp
  set section_id = src.section_id
  from public.task_projects src
  join public.sections s on s.id = src.section_id and s.deleted_at is null
  where tp.task_id = next_id
    and src.task_id = new.id
    and src.project_id = tp.project_id
    and src.deleted_at is null;

  insert into public.task_projects (task_id, project_id, section_id, sort_order)
  select
    next_id,
    src.project_id,
    (select s.id from public.sections s where s.id = src.section_id and s.deleted_at is null),
    coalesce((select max(x.sort_order) from public.task_projects x
              where x.project_id = src.project_id and x.deleted_at is null), 0) + 1024
  from public.task_projects src
  join public.projects p on p.id = src.project_id and p.deleted_at is null
  where src.task_id = new.id
    and src.deleted_at is null
    and src.project_id <> new.home_project_id
  on conflict (task_id, project_id) do nothing;

  -- Stored custom field values whose field still exists in one of the new task's projects. A value
  -- that no longer validates (e.g. a removed option) is skipped rather than blocking the completion.
  for r in
    select v.field_id, v.value
    from public.task_field_values v
    join public.custom_fields f on f.id = v.field_id and f.deleted_at is null and not f.bound_to_sections
    where v.task_id = new.id
      and v.value is not null
      and jsonb_typeof(v.value) <> 'null'
      and exists (
        select 1 from public.task_projects tp
        where tp.task_id = next_id and tp.project_id = f.project_id and tp.deleted_at is null
      )
  loop
    begin
      insert into public.task_field_values (task_id, field_id, value) values (next_id, r.field_id, r.value);
    exception when check_violation or foreign_key_violation then
      null;
    end;
  end loop;

  -- Tags (active, unarchived ones).
  perform public.copy_task_tags(new.id, next_id);

  -- The subtask tree (except approval subtasks), open, with dates shifted like the task's.
  perform public.copy_subtask_tree(new.id, next_id, shift);

  for r in
    select f.profile_id from public.task_followers f where f.task_id = new.id and f.deleted_at is null
  loop
    perform public.follow_task(next_id, r.profile_id);
  end loop;

  update public.tasks set recurrence_next_id = next_id where id = new.id;
  perform public.add_story(new.id, 'recurrence_spawned', jsonb_build_object(
    'next_task_id', next_id,
    'due_on', (select t.due_on from public.tasks t where t.id = next_id)
  ));
  return null;
end;
$function$;

-- ---------------------------------------------------------------------------
-- import_batch: Asana tags become native tags (batch task key "tags": [names]); result adds "tags".
-- Everything else, including the import mute, is unchanged.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.import_batch(target_run uuid, batch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  run public.import_runs;
  p uuid;
  src text;
  me uuid := public.current_profile_id();
  item jsonb;
  child jsonb;
  found_id uuid;
  key text;
  t uuid;
  task_is_new boolean;
  was_following boolean;
  assignee uuid;
  fld public.custom_fields;
  ftype text;
  merged_options jsonb;
  new_value jsonb;
  v_due date;
  v_start date;
  v_notes text;
  footer text[];
  author uuid;
  body text;
  url text;
  other uuid;
  pred uuid;
  succ uuid;
  n_sections integer := 0;
  n_fields integer := 0;
  n_rules integer := 0;
  n_tasks integer := 0;
  n_tasks_skipped integer := 0;
  n_subtasks integer := 0;
  n_comments integer := 0;
  n_attachments integer := 0;
  n_dependencies integer := 0;
  n_dependencies_skipped integer := 0;
  n_memberships integer := 0;
  n_unassigned integer := 0;
  n_values_skipped integer := 0;
  n_rules_skipped integer := 0;
  n_dates_dropped integer := 0;
  n_tags integer := 0;
begin
  select * into run from public.import_runs where id = target_run and deleted_at is null;
  if not found or not public.has_project_role(run.project_id, 'viewer') then
    raise exception 'Import not found' using errcode = 'no_data_found';
  end if;
  if not public.has_project_role(run.project_id, 'admin') then
    raise exception 'You need Admin access to import into this project' using errcode = 'insufficient_privilege';
  end if;
  if run.status <> 'running' then
    raise exception 'This import has already finished' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.projects pj where pj.id = run.project_id and pj.deleted_at is null) then
    raise exception 'Project not found' using errcode = 'no_data_found';
  end if;
  if jsonb_typeof(coalesce(batch, '{}'::jsonb)) <> 'object' then
    raise exception 'Invalid import batch' using errcode = 'check_violation';
  end if;

  p := run.project_id;
  src := run.source;
  -- One batch at a time per project, so two admins importing at once can't both create a row.
  perform pg_advisory_xact_lock(hashtextextended('alhc.import:' || p::text, 0));
  -- Left set until the transaction ends so the deferred task_created rule trigger sees it too.
  perform set_config('alhc.import_run_id', run.id::text, true);

  -- Project --------------------------------------------------------------------------------------
  if jsonb_typeof(batch -> 'project') = 'object' and nullif(batch #>> '{project,gid}', '') is not null then
    perform public.import_remember(p, src, 'project', batch #>> '{project,gid}', p, run.id);
  end if;

  -- Sections: by external key, else an active section with the same name, else a new one ----------
  for item in select * from jsonb_array_elements(case when jsonb_typeof(batch -> 'sections') = 'array' then batch -> 'sections' else '[]' end) loop
    key := nullif(item ->> 'key', '');
    continue when key is null or nullif(trim(item ->> 'name'), '') is null;
    found_id := public.import_local_id(p, src, 'section', key);
    if found_id is not null and not exists (
      select 1 from public.sections s where s.id = found_id and s.project_id = p and s.deleted_at is null
    ) then
      found_id := null;
    end if;
    if found_id is null then
      select s.id into found_id from public.sections s
      where s.project_id = p and s.deleted_at is null and lower(s.name) = lower(trim(item ->> 'name'))
      order by s.sort_order limit 1;
    end if;
    if found_id is null then
      insert into public.sections (project_id, name, sort_order)
      values (p, left(trim(item ->> 'name'), 200), coalesce(
        (select max(s.sort_order) + 1024 from public.sections s where s.project_id = p and s.deleted_at is null), 1024))
      returning id into found_id;
      n_sections := n_sections + 1;
    end if;
    perform public.import_remember(p, src, 'section', key, found_id, run.id);
  end loop;

  -- Custom fields: by key, else an active field with the same name and type, else a new one. Select
  -- options are matched by name; missing options are appended. -----------------------------------
  for item in select * from jsonb_array_elements(case when jsonb_typeof(batch -> 'fields') = 'array' then batch -> 'fields' else '[]' end) loop
    key := nullif(item ->> 'key', '');
    ftype := item ->> 'type';
    continue when key is null or nullif(trim(item ->> 'name'), '') is null
      or ftype is null or ftype not in ('text', 'number', 'date', 'single_select', 'multi_select', 'people');
    found_id := public.import_local_id(p, src, 'field', key);
    fld := null;
    if found_id is not null then
      select * into fld from public.custom_fields f where f.id = found_id and f.project_id = p and f.deleted_at is null;
    end if;
    if fld.id is null then
      select * into fld from public.custom_fields f
      where f.project_id = p and f.deleted_at is null and not f.bound_to_sections
        and f.field_type = ftype and lower(f.name) = lower(left(trim(item ->> 'name'), 100))
      order by f.sort_order limit 1;
    end if;
    if fld.id is null then
      insert into public.custom_fields (project_id, name, field_type, options, sort_order)
      values (
        p,
        -- A same-named field of another type (or the section-bound Status) keeps its name.
        case when exists (
          select 1 from public.custom_fields f
          where f.project_id = p and f.deleted_at is null and lower(f.name) = lower(left(trim(item ->> 'name'), 100))
        ) then left(left(trim(item ->> 'name'), 90) || ' (Asana)', 100) else left(trim(item ->> 'name'), 100) end,
        ftype,
        '[]'::jsonb,
        coalesce((select max(f.sort_order) + 1024 from public.custom_fields f where f.project_id = p and f.deleted_at is null), 1024)
      )
      returning * into fld;
      n_fields := n_fields + 1;
    end if;
    if ftype in ('single_select', 'multi_select') and jsonb_typeof(item -> 'options') = 'array' then
      merged_options := fld.options;
      for child in select * from jsonb_array_elements(item -> 'options') loop
        continue when jsonb_typeof(child) <> 'string' or nullif(trim(child #>> '{}'), '') is null;
        if not exists (
          select 1 from jsonb_array_elements(merged_options) o where lower(o ->> 'name') = lower(left(trim(child #>> '{}'), 100))
        ) then
          merged_options := merged_options || jsonb_build_array(jsonb_build_object(
            'id', gen_random_uuid()::text,
            'name', left(trim(child #>> '{}'), 100),
            'color', (array['zinc','blue','green','amber','red','violet','teal','orange','pink'])[jsonb_array_length(merged_options) % 9 + 1]
          ));
        end if;
      end loop;
      if merged_options is distinct from fld.options then
        update public.custom_fields set options = merged_options where id = fld.id;
      end if;
    end if;
    perform public.import_remember(p, src, 'field', key, fld.id, run.id);
  end loop;

  -- Rules: always disabled (rules_03_import_disabled also forces it). Invalid ones are skipped. ----
  for item in select * from jsonb_array_elements(case when jsonb_typeof(batch -> 'rules') = 'array' then batch -> 'rules' else '[]' end) loop
    key := nullif(item ->> 'key', '');
    continue when key is null or public.import_local_id(p, src, 'rule', key) is not null;
    begin
      insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, conditions, actions, created_by, sort_order)
      values (
        p,
        left(coalesce(nullif(trim(item ->> 'name'), ''), 'Imported rule'), 200),
        false,
        item ->> 'trigger_type',
        coalesce(item -> 'trigger_config', '{}'::jsonb),
        coalesce(item -> 'conditions', '[]'::jsonb),
        coalesce(item -> 'actions', '[]'::jsonb),
        me,
        coalesce((select max(r.sort_order) + 1024 from public.rules r where r.project_id = p and r.deleted_at is null), 1024)
      )
      returning id into found_id;
      perform public.import_remember(p, src, 'rule', key, found_id, run.id);
      n_rules := n_rules + 1;
    exception when check_violation or not_null_violation or invalid_text_representation
      or foreign_key_violation or invalid_parameter_value or raise_exception then
      n_rules_skipped := n_rules_skipped + 1;
    end;
  end loop;

  -- Tasks ------------------------------------------------------------------------------------------
  for item in select * from jsonb_array_elements(case when jsonb_typeof(batch -> 'tasks') = 'array' then batch -> 'tasks' else '[]' end) loop
    key := nullif(item ->> 'gid', '');
    continue when key is null;
    t := public.import_local_id(p, src, 'task', key);
    task_is_new := t is null;

    if not task_is_new then
      n_tasks_skipped := n_tasks_skipped + 1;
      -- Deleted here since the last import: leave it (and its children) alone.
      continue when not exists (select 1 from public.tasks x where x.id = t and x.deleted_at is null);
      select exists (
        select 1 from public.task_followers f where f.task_id = t and f.profile_id = me and f.deleted_at is null
      ) into was_following;
      assignee := (select x.assignee_id from public.tasks x where x.id = t);
    else
      was_following := false;
      footer := '{}';
      assignee := public.import_member(p, item ->> 'assignee_email');
      if assignee is null and coalesce(nullif(trim(item ->> 'assignee_name'), ''), nullif(trim(item ->> 'assignee_email'), '')) is not null then
        n_unassigned := n_unassigned + 1;
        footer := footer || format('Assignee in Asana: %s (not a member of this project, so left unassigned)',
          concat_ws(' ', nullif(trim(item ->> 'assignee_name'), ''),
            '<' || nullif(lower(trim(item ->> 'assignee_email')), '') || '>'));
      end if;
      v_due := public.import_date(item ->> 'due_on');
      v_start := public.import_date(item ->> 'start_on');
      if v_start is not null and v_due is not null and v_start > v_due then
        footer := footer || format('Start date in Asana: %s (after the due date, so not set)', v_start);
        v_start := null;
        n_dates_dropped := n_dates_dropped + 1;
      end if;
      v_notes := left(nullif(trim(coalesce(item ->> 'notes', '')), ''), 50000);
      if cardinality(footer) > 0 then
        v_notes := concat_ws(E'\n\n', v_notes, '— Imported from Asana —' || E'\n' || array_to_string(footer, E'\n'));
      end if;

      insert into public.tasks (home_project_id, title, notes, completed_at, assignee_id, due_on, start_on, source, created_by, kind)
      values (
        p,
        left(coalesce(nullif(trim(item ->> 'title'), ''), 'Untitled task'), 1000),
        v_notes,
        case when nullif(item ->> 'completed_at', '') is not null
          then coalesce(public.import_timestamp(item ->> 'completed_at'), now()) end,
        assignee,
        v_due,
        v_start,
        'import',
        me,
        case when item ->> 'kind' in ('milestone', 'approval') then item ->> 'kind' else 'task' end
      )
      returning id into t;
      n_tasks := n_tasks + 1;
      perform public.import_remember(p, src, 'task', key, t, run.id);

      found_id := case when nullif(item ->> 'section_key', '') is not null
        then public.import_local_id(p, src, 'section', item ->> 'section_key') end;
      if found_id is not null and exists (select 1 from public.sections s where s.id = found_id and s.deleted_at is null) then
        update public.task_projects set section_id = found_id where task_id = t and project_id = p;
      end if;

      -- Also home the task in other projects this source project's siblings were imported into.
      for child in select * from jsonb_array_elements(case when jsonb_typeof(item -> 'projects') = 'array' then item -> 'projects' else '[]' end) loop
        select x.local_id into other from public.import_external_ids x
        join public.projects pj on pj.id = x.local_id and pj.deleted_at is null
        where x.source = src and x.kind = 'project' and x.external_id = child ->> 'gid' and x.local_id <> p
          and public.has_project_role(x.local_id, 'editor')
        order by x.created_at limit 1;
        continue when other is null;
        insert into public.task_projects (task_id, project_id, section_id, sort_order)
        values (
          t, other,
          (select s.id from public.sections s
           where s.project_id = other and s.deleted_at is null and lower(s.name) = lower(trim(child ->> 'section_name'))
           order by s.sort_order limit 1),
          coalesce((select max(tp.sort_order) + 1024 from public.task_projects tp
                    where tp.project_id = other and tp.deleted_at is null), 1024)
        )
        on conflict (task_id, project_id) do nothing;
        if found then
          n_memberships := n_memberships + 1;
        end if;
      end loop;

      -- Field values (validated by task_field_values_validate; values that don't fit are skipped).
      for child in select * from jsonb_array_elements(case when jsonb_typeof(item -> 'fields') = 'array' then item -> 'fields' else '[]' end) loop
        found_id := public.import_local_id(p, src, 'field', child ->> 'key');
        fld := null;
        if found_id is not null then
          select * into fld from public.custom_fields f where f.id = found_id and f.deleted_at is null;
        end if;
        continue when fld.id is null or child -> 'value' is null or child -> 'value' = 'null'::jsonb;
        new_value := case fld.field_type
          when 'text' then case when jsonb_typeof(child -> 'value') in ('string', 'number')
            then to_jsonb(left(child ->> 'value', 10000)) end
          when 'number' then case when jsonb_typeof(child -> 'value') = 'number' then child -> 'value' end
          when 'date' then case when public.import_date(child ->> 'value') is not null
            then to_jsonb(public.import_date(child ->> 'value')::text) end
          when 'single_select' then (
            select o -> 'id' from jsonb_array_elements(fld.options) o
            where lower(o ->> 'name') = lower(trim(child ->> 'value')) limit 1)
          when 'multi_select' then (
            select jsonb_agg(distinct o -> 'id') from jsonb_array_elements(fld.options) o
            where jsonb_typeof(child -> 'value') = 'array'
              and exists (select 1 from jsonb_array_elements_text(child -> 'value') v where lower(trim(v)) = lower(o ->> 'name')))
          when 'people' then (
            select jsonb_agg(distinct to_jsonb(public.import_member(p, v)))
            from jsonb_array_elements_text(case when jsonb_typeof(child -> 'value') = 'array' then child -> 'value' else '[]' end) v
            where public.import_member(p, v) is not null)
        end;
        if new_value is null then
          n_values_skipped := n_values_skipped + 1;
          continue;
        end if;
        begin
          insert into public.task_field_values (task_id, field_id, value)
          values (t, fld.id, new_value)
          on conflict (task_id, field_id) do nothing;
        exception when check_violation or foreign_key_violation then
          n_values_skipped := n_values_skipped + 1;
        end;
      end loop;

      for child in select * from jsonb_array_elements(case when jsonb_typeof(item -> 'followers') = 'array' then item -> 'followers' else '[]' end) loop
        perform public.follow_task(t, public.import_member(p, child #>> '{}'));
      end loop;

      -- Asana tags become workspace tags (matched by name, created when missing).
      n_tags := n_tags + public.import_task_tags(p, t, item -> 'tags', me);
    end if;

    -- Subtasks: real subtasks, nested up to the depth limit (import_subtasks) ----------------------
    n_subtasks := n_subtasks + public.import_subtasks(p, src, run.id, t, item -> 'subtasks');

    -- Comments: by the matched member, else by the importer with the original author named --------
    for child in select * from jsonb_array_elements(case when jsonb_typeof(item -> 'comments') = 'array' then item -> 'comments' else '[]' end) loop
      continue when nullif(child ->> 'gid', '') is null or nullif(trim(child ->> 'body'), '') is null
        or public.import_local_id(p, src, 'comment', child ->> 'gid') is not null;
      author := public.import_member(p, child ->> 'author_email');
      body := trim(child ->> 'body');
      if author is null then
        author := me;
        body := format('%s wrote in Asana:', coalesce(nullif(trim(child ->> 'author_name'), ''), 'Someone')) || E'\n' || body;
      end if;
      insert into public.comments (task_id, author_id, body, created_at)
      values (t, author, left(body, 10000), coalesce(public.import_timestamp(child ->> 'created_at'), now()))
      returning id into found_id;
      perform public.import_remember(p, src, 'comment', child ->> 'gid', found_id, run.id);
      n_comments := n_comments + 1;
    end loop;

    -- Attachment links (no file copy) --------------------------------------------------------------
    for child in select * from jsonb_array_elements(case when jsonb_typeof(item -> 'attachments') = 'array' then item -> 'attachments' else '[]' end) loop
      continue when nullif(child ->> 'gid', '') is null or nullif(trim(child ->> 'name'), '') is null
        or public.import_local_id(p, src, 'attachment', child ->> 'gid') is not null;
      url := trim(child ->> 'url');
      if url is null or url !~ '^https://[^\s]+$' or length(url) > 2000 then
        url := null;
      end if;
      insert into public.task_attachment_links (task_id, source, name, url)
      values (t, src, left(trim(child ->> 'name'), 255), url)
      returning id into found_id;
      perform public.import_remember(p, src, 'attachment', child ->> 'gid', found_id, run.id);
      n_attachments := n_attachments + 1;
    end loop;

    -- The importer auto-followed as the creator (or comment author); don't keep them on every task.
    if not was_following and assignee is distinct from me
       and not (coalesce(item -> 'followers', '[]'::jsonb) @> to_jsonb(array[(select pr.email from public.profiles pr where pr.id = me)])) then
      update public.task_followers set deleted_at = now()
      where task_id = t and profile_id = me and deleted_at is null;
    end if;
  end loop;

  -- Dependencies: both tasks imported into this project and still active; cycles are skipped -------
  if jsonb_typeof(batch -> 'dependencies') = 'array' and jsonb_array_length(batch -> 'dependencies') > 0 then
    perform pg_advisory_xact_lock(hashtextextended('alhc.task_dependencies', 0));
  end if;
  for item in select * from jsonb_array_elements(case when jsonb_typeof(batch -> 'dependencies') = 'array' then batch -> 'dependencies' else '[]' end) loop
    key := (item ->> 'predecessor') || '>' || (item ->> 'successor');
    continue when key is null or public.import_local_id(p, src, 'dependency', key) is not null;
    pred := public.import_local_id(p, src, 'task', item ->> 'predecessor');
    succ := public.import_local_id(p, src, 'task', item ->> 'successor');
    if pred is null or succ is null or pred = succ
       or not exists (select 1 from public.tasks x join public.task_projects tp on tp.task_id = x.id and tp.project_id = p and tp.deleted_at is null
                      where x.id = pred and x.deleted_at is null)
       or not exists (select 1 from public.tasks x join public.task_projects tp on tp.task_id = x.id and tp.project_id = p and tp.deleted_at is null
                      where x.id = succ and x.deleted_at is null) then
      n_dependencies_skipped := n_dependencies_skipped + 1;
      continue;
    end if;
    select d.id into found_id from public.task_dependencies d
    where d.predecessor_id = pred and d.successor_id = succ and d.deleted_at is null;
    if found_id is null then
      if exists (
        with recursive downstream (task_id) as (
          select d.successor_id from public.task_dependencies d
          where d.predecessor_id = succ and d.deleted_at is null
          union
          select d.successor_id from public.task_dependencies d
          join downstream x on d.predecessor_id = x.task_id
          where d.deleted_at is null
        )
        select 1 from downstream where task_id = pred
      ) then
        n_dependencies_skipped := n_dependencies_skipped + 1;
        continue;
      end if;
      insert into public.task_dependencies (project_id, predecessor_id, successor_id, created_by)
      values (p, pred, succ, me)
      returning id into found_id;
      n_dependencies := n_dependencies + 1;
    end if;
    perform public.import_remember(p, src, 'dependency', key, found_id, run.id);
  end loop;

  return jsonb_build_object(
    'sections', n_sections,
    'fields', n_fields,
    'rules', n_rules,
    'rules_skipped', n_rules_skipped,
    'tasks', n_tasks,
    'tasks_skipped', n_tasks_skipped,
    'subtasks', n_subtasks,
    'comments', n_comments,
    'attachments', n_attachments,
    'dependencies', n_dependencies,
    'dependencies_skipped', n_dependencies_skipped,
    'memberships', n_memberships,
    'unassigned', n_unassigned,
    'values_skipped', n_values_skipped,
    'dates_dropped', n_dates_dropped,
    'tags', n_tags
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- Views: filters.tags = [tag id | null] (any-of; null = no tags)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.validate_view_filters(target_project uuid, filters jsonb)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  item jsonb;
  field public.custom_fields;
  due jsonb;
begin
  if filters is null or filters = 'null'::jsonb then
    return;
  end if;
  if jsonb_typeof(filters) <> 'object' then
    raise exception 'View filters must be an object' using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from jsonb_object_keys(filters) k
    where k not in ('completion', 'completed_within_days', 'sections', 'assignees', 'due', 'fields', 'text', 'tags')
  ) then
    raise exception 'Unknown view filter' using errcode = 'check_violation';
  end if;

  if filters ? 'completion' and coalesce(filters ->> 'completion', '') not in ('incomplete', 'completed', 'all') then
    raise exception 'Completion filter must be incomplete, completed, or all' using errcode = 'check_violation';
  end if;

  if filters ? 'completed_within_days' then
    if jsonb_typeof(filters -> 'completed_within_days') <> 'number'
      or (filters ->> 'completed_within_days')::numeric not between 1 and 3650
      or (filters ->> 'completed_within_days')::numeric <> trunc((filters ->> 'completed_within_days')::numeric) then
      raise exception '“Completed in the last N days” must be a whole number from 1 to 3650'
        using errcode = 'check_violation';
    end if;
    if filters ->> 'completion' is distinct from 'completed' then
      raise exception '“Completed in the last N days” only applies to completed tasks' using errcode = 'check_violation';
    end if;
  end if;

  if filters ? 'sections' then
    if jsonb_typeof(filters -> 'sections') <> 'array' or jsonb_array_length(filters -> 'sections') > 100 then
      raise exception 'Section filter must be a list' using errcode = 'check_violation';
    end if;
    for item in select value from jsonb_array_elements(filters -> 'sections') loop
      if item <> 'null'::jsonb and (
        jsonb_typeof(item) <> 'string' or not public.rule_section_ok(target_project, item #>> '{}')
      ) then
        raise exception 'A filter refers to a section outside this project' using errcode = 'check_violation';
      end if;
    end loop;
  end if;

  if filters ? 'assignees' then
    if jsonb_typeof(filters -> 'assignees') <> 'array' or jsonb_array_length(filters -> 'assignees') > 100 then
      raise exception 'Assignee filter must be a list' using errcode = 'check_violation';
    end if;
    for item in select value from jsonb_array_elements(filters -> 'assignees') loop
      if item <> 'null'::jsonb and item <> '"me"'::jsonb and (
        jsonb_typeof(item) <> 'string'
        or not exists (select 1 from public.profiles pr where pr.id::text = item #>> '{}')
      ) then
        raise exception 'A filter refers to an unknown person' using errcode = 'check_violation';
      end if;
    end loop;
  end if;

  if filters ? 'due' then
    due := filters -> 'due';
    if jsonb_typeof(due) <> 'object' or coalesce(due ->> 'kind', '') not in ('overdue', 'today', 'upcoming', 'no_date', 'range') then
      raise exception 'Unknown due date filter' using errcode = 'check_violation';
    end if;
    if exists (select 1 from jsonb_object_keys(due) k where k not in ('kind', 'days', 'from', 'to')) then
      raise exception 'Unknown due date filter option' using errcode = 'check_violation';
    end if;
    if due ? 'days' and (
      jsonb_typeof(due -> 'days') <> 'number'
      or (due ->> 'days')::numeric not between 1 and 365
      or (due ->> 'days')::numeric <> trunc((due ->> 'days')::numeric)
    ) then
      raise exception 'Upcoming days must be a whole number from 1 to 365' using errcode = 'check_violation';
    end if;
    if (due ? 'from' and not public.is_iso_date(due ->> 'from'))
      or (due ? 'to' and not public.is_iso_date(due ->> 'to')) then
      raise exception 'Due date range must use YYYY-MM-DD dates' using errcode = 'check_violation';
    end if;
  end if;

  if filters ? 'fields' then
    if jsonb_typeof(filters -> 'fields') <> 'array' or jsonb_array_length(filters -> 'fields') > 20 then
      raise exception 'Field filters must be a list of at most 20' using errcode = 'check_violation';
    end if;
    for item in select value from jsonb_array_elements(filters -> 'fields') loop
      if jsonb_typeof(item) <> 'object' then
        raise exception 'Invalid field filter' using errcode = 'check_violation';
      end if;
      field := public.rule_field(target_project, item ->> 'field_id');
      if field.id is null then
        raise exception 'A filter refers to a field outside this project' using errcode = 'check_violation';
      end if;
      if coalesce(item ->> 'op', '') not in ('in', 'equals', 'empty', 'not_empty') then
        raise exception 'Unknown field filter operator' using errcode = 'check_violation';
      end if;
      if item ->> 'op' = 'in' and (
        jsonb_typeof(item -> 'values') is distinct from 'array'
        or jsonb_array_length(item -> 'values') > 100
        or exists (select 1 from jsonb_array_elements(item -> 'values') v where jsonb_typeof(v) <> 'string')
      ) then
        raise exception 'Field filter values must be a list of ids' using errcode = 'check_violation';
      end if;
      if item ->> 'op' = 'equals' and coalesce(jsonb_typeof(item -> 'value'), 'missing') not in ('string', 'number', 'boolean') then
        raise exception 'Field filter needs a value' using errcode = 'check_violation';
      end if;
    end loop;
  end if;

  if filters ? 'tags' then
    if jsonb_typeof(filters -> 'tags') <> 'array' or jsonb_array_length(filters -> 'tags') > 100 then
      raise exception 'Tag filter must be a list' using errcode = 'check_violation';
    end if;
    for item in select value from jsonb_array_elements(filters -> 'tags') loop
      if item <> 'null'::jsonb and (
        jsonb_typeof(item) <> 'string'
        or not exists (
          select 1 from public.tags g
          join public.projects pr on pr.id = target_project and pr.workspace_id = g.workspace_id
          where g.id::text = item #>> '{}' and g.deleted_at is null
        )
      ) then
        raise exception 'A filter refers to an unknown tag' using errcode = 'check_violation';
      end if;
    end loop;
  end if;

  if filters ? 'text' and (jsonb_typeof(filters -> 'text') <> 'string' or length(filters ->> 'text') > 200) then
    raise exception 'Search text is limited to 200 characters' using errcode = 'check_violation';
  end if;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Views: group_by "tag"
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.validate_view_config(target_project uuid, config jsonb)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  item jsonb;
  field public.custom_fields;
  ref text;
begin
  if jsonb_typeof(config) <> 'object' then
    raise exception 'View config must be an object' using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from jsonb_object_keys(config) k where k not in ('filters', 'sort', 'group_by', 'columns')
  ) then
    raise exception 'Unknown view setting' using errcode = 'check_violation';
  end if;

  perform public.validate_view_filters(target_project, config -> 'filters');

  if config ? 'sort' then
    if jsonb_typeof(config -> 'sort') <> 'array' or jsonb_array_length(config -> 'sort') > 3 then
      raise exception 'Views sort by at most 3 keys' using errcode = 'check_violation';
    end if;
    for item in select value from jsonb_array_elements(config -> 'sort') loop
      ref := item ->> 'key';
      if jsonb_typeof(item) <> 'object' or coalesce(item ->> 'dir', '') not in ('asc', 'desc') or not (
        ref in ('manual', 'due', 'start', 'title', 'created', 'assignee')
        or (public.view_field_ref(target_project, ref)).id is not null
      ) then
        raise exception 'Invalid sort' using errcode = 'check_violation';
      end if;
    end loop;
  end if;

  if config ? 'group_by' then
    ref := config ->> 'group_by';
    if jsonb_typeof(config -> 'group_by') <> 'string' then
      raise exception 'Invalid grouping' using errcode = 'check_violation';
    end if;
    if ref not in ('section', 'assignee', 'tag', 'none') then
      field := public.view_field_ref(target_project, ref);
      if field.id is null or field.field_type <> 'single_select' then
        raise exception 'Group by a section, assignee, tag, or single-select field of this project'
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

  if config ? 'columns' then
    if jsonb_typeof(config -> 'columns') <> 'array' or jsonb_array_length(config -> 'columns') > 30 then
      raise exception 'Invalid columns' using errcode = 'check_violation';
    end if;
    for item in select value from jsonb_array_elements(config -> 'columns') loop
      ref := item #>> '{}';
      if jsonb_typeof(item) <> 'string' or not (
        ref in ('assignee', 'due', 'start', 'section') or (public.view_field_ref(target_project, ref)).id is not null
      ) then
        raise exception 'A column refers to a field outside this project' using errcode = 'check_violation';
      end if;
    end loop;
  end if;
end;
$function$;

-- ---------------------------------------------------------------------------
-- filter_project_tasks: the tag filter
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.filter_project_tasks(target_project uuid, filters jsonb DEFAULT '{}'::jsonb, tz text DEFAULT 'UTC'::text)
 RETURNS TABLE(task_id uuid, section_id uuid, assignee_id uuid, due_on date, completed_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with params as (
    select
      zone,
      (now() at time zone zone)::date as today,
      f,
      nullif(trim(coalesce(f ->> 'text', '')), '') as needle
    from (
      select
        public.safe_timezone(tz) as zone,
        case when jsonb_typeof(filters) = 'object' then filters else '{}'::jsonb end as f
    ) raw
  ),
  pattern as (
    select '%' || replace(replace(replace(p.needle, '\', '\\'), '%', '\%'), '_', '\_') || '%' as value
    from params p
  )
  select t.id, tp.section_id, t.assignee_id, t.due_on, t.completed_at
  from public.task_projects tp
  join public.tasks t on t.id = tp.task_id
  cross join params p
  cross join pattern
  where tp.project_id = target_project
    and tp.deleted_at is null
    and t.deleted_at is null
    and case coalesce(p.f ->> 'completion', 'incomplete')
      when 'incomplete' then t.completed_at is null
      when 'completed' then t.completed_at is not null
      else true
    end
    and (
      jsonb_typeof(p.f -> 'completed_within_days') is distinct from 'number'
      or (
        t.completed_at is not null
        and (t.completed_at at time zone p.zone)::date > p.today - (p.f ->> 'completed_within_days')::numeric::int
      )
    )
    and (
      jsonb_array_length(public.view_list(p.f -> 'sections')) = 0
      or p.f -> 'sections' @> jsonb_build_array(tp.section_id)
    )
    and (
      jsonb_array_length(public.view_list(p.f -> 'assignees')) = 0
      or p.f -> 'assignees' @> jsonb_build_array(t.assignee_id)
      or (p.f -> 'assignees' @> '["me"]'::jsonb and t.assignee_id = auth.uid())
    )
    and coalesce(
      case p.f -> 'due' ->> 'kind'
        when 'overdue' then t.due_on < p.today and t.completed_at is null
        when 'today' then t.due_on = p.today
        when 'upcoming' then t.due_on > p.today
          and t.due_on <= p.today + coalesce((p.f -> 'due' ->> 'days')::numeric::int, 7)
        when 'no_date' then t.due_on is null
        when 'range' then t.due_on is not null
          and (not public.is_iso_date(p.f -> 'due' ->> 'from') or t.due_on >= (p.f -> 'due' ->> 'from')::date)
          and (not public.is_iso_date(p.f -> 'due' ->> 'to') or t.due_on <= (p.f -> 'due' ->> 'to')::date)
        else true
      end,
      false
    )
    and (p.needle is null or t.title ilike pattern.value or coalesce(t.notes, '') ilike pattern.value)
    and (
      jsonb_array_length(public.view_list(p.f -> 'tags')) = 0
      or exists (
        select 1 from public.task_tags tt
        where tt.task_id = t.id and tt.deleted_at is null and p.f -> 'tags' @> jsonb_build_array(tt.tag_id)
      )
      or (p.f -> 'tags' @> '[null]'::jsonb and not exists (
        select 1 from public.task_tags tt
        join public.tags g on g.id = tt.tag_id and g.deleted_at is null
        where tt.task_id = t.id and tt.deleted_at is null
      ))
    )
    and not exists (
      select 1
      from jsonb_array_elements(public.view_list(p.f -> 'fields')) cond
      join public.custom_fields cf
        on cf.id::text = cond ->> 'field_id'
       and cf.project_id = target_project
       and cf.deleted_at is null
      left join public.task_field_values v on v.task_id = t.id and v.field_id = cf.id
      where not public.view_field_matches(cf.field_type, cf.bound_to_sections, tp.section_id, v.value, cond)
    );
$function$;

-- ---------------------------------------------------------------------------
-- search_tasks: also matches tasks carrying a tag whose name matches (after title / notes matches)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.search_tasks(query text, max_results integer DEFAULT 50)
 RETURNS TABLE(id uuid, title text, notes text, completed_at timestamp with time zone, due_on date, assignee_id uuid, home_project_id uuid, home_project_name text)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with pattern as (
    select '%' || replace(replace(replace(trim(query), '\', '\\'), '%', '\%'), '_', '\_') || '%' as value
  )
  select t.id, t.title, t.notes, t.completed_at, t.due_on, t.assignee_id, shown.id, shown.name
  from public.tasks t
  cross join pattern
  cross join lateral (
    select p.id, p.name
    from public.task_projects tp
    join public.projects p on p.id = tp.project_id
    where tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null and p.deleted_at is null
    order by (tp.project_id = t.home_project_id) desc, tp.created_at
    limit 1
  ) shown
  where length(trim(query)) > 0
    and t.deleted_at is null
    and (
      t.title ilike pattern.value
      or t.notes ilike pattern.value
      or exists (
        select 1 from public.task_tags tt
        join public.tags g on g.id = tt.tag_id and g.deleted_at is null
        where tt.task_id = t.id and tt.deleted_at is null and g.name ilike pattern.value
      )
    )
  order by t.completed_at is not null, t.title ilike pattern.value desc,
    coalesce(t.notes ilike pattern.value, false) desc, t.updated_at desc
  limit least(greatest(coalesce(max_results, 50), 1), 100);
$function$;

-- ---------------------------------------------------------------------------
-- bulk_update_tasks: add_tag / remove_tag {tag_id} (same per-task partial apply as the rest)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bulk_update_tasks(target_tasks uuid[], operation jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  action text := operation ->> 'action';
  task_ids uuid[];
  remaining uuid[];
  retry uuid[];
  t uuid;
  task_title text;
  task_deleted timestamptz;
  outcome text;
  reason text;
  progress boolean;
  changed integer;
  updated jsonb := '[]'::jsonb;
  unchanged jsonb := '[]'::jsonb;
  skipped jsonb := '[]'::jsonb;
  blocked jsonb := '{}'::jsonb;
  -- operation arguments
  arg_assignee uuid;
  arg_due date;
  arg_project uuid;
  arg_section uuid;
  arg_field uuid;
  arg_value jsonb;
  arg_tag uuid;
  field_row record;
  current_section uuid;
  err_state text;
  err_message text;
  err_constraint text;
begin
  if auth.uid() is null or not public.is_allowlisted() then
    raise exception 'Sign in to edit tasks' using errcode = 'insufficient_privilege';
  end if;
  if operation is null or jsonb_typeof(operation) <> 'object' then
    raise exception 'Invalid bulk operation' using errcode = 'invalid_parameter_value';
  end if;

  -- Deduplicate, keeping the caller's order.
  select coalesce(array_agg(id order by first_position), '{}') into task_ids
  from (
    select id, min(position) as first_position
    from unnest(coalesce(target_tasks, '{}')) with ordinality as u(id, position)
    where id is not null
    group by id
  ) d;
  if cardinality(task_ids) = 0 then
    raise exception 'Select at least one task' using errcode = 'invalid_parameter_value';
  end if;
  if cardinality(task_ids) > 200 then
    raise exception 'Bulk edits are limited to 200 tasks at a time' using errcode = 'invalid_parameter_value';
  end if;

  -- Validate the operation once, before touching any task.
  case action
    when 'complete', 'reopen', 'delete' then
      null;
    when 'assign' then
      if not (operation ? 'assignee_id') then
        raise exception 'Choose someone to assign, or unassign' using errcode = 'invalid_parameter_value';
      end if;
      arg_assignee := nullif(operation ->> 'assignee_id', '')::uuid;
      if arg_assignee is not null and not exists (select 1 from public.profiles p where p.id = arg_assignee) then
        raise exception 'That person doesn’t exist' using errcode = 'invalid_parameter_value';
      end if;
    when 'set_due' then
      if not (operation ? 'due_on') then
        raise exception 'Choose a due date, or clear it' using errcode = 'invalid_parameter_value';
      end if;
      arg_due := nullif(operation ->> 'due_on', '')::date;
    when 'move_section', 'add_to_project' then
      arg_project := (operation ->> 'project_id')::uuid;
      arg_section := nullif(operation ->> 'section_id', '')::uuid;
      if arg_project is null or not exists (
        select 1 from public.projects p where p.id = arg_project and p.deleted_at is null
      ) then
        raise exception 'Project not found' using errcode = 'invalid_parameter_value';
      end if;
      if not public.has_project_role(arg_project, 'editor') then
        raise exception 'Your role in that project doesn’t allow that' using errcode = 'insufficient_privilege';
      end if;
      if arg_section is not null and not exists (
        select 1 from public.sections s
        where s.id = arg_section and s.project_id = arg_project and s.deleted_at is null
      ) then
        raise exception 'That section isn’t in the project' using errcode = 'invalid_parameter_value';
      end if;
    when 'set_field' then
      arg_field := (operation ->> 'field_id')::uuid;
      if not (operation ? 'value') then
        raise exception 'Choose a value, or clear it' using errcode = 'invalid_parameter_value';
      end if;
      arg_value := operation -> 'value';
      select f.id, f.project_id, f.name, f.bound_to_sections into field_row
      from public.custom_fields f where f.id = arg_field and f.deleted_at is null;
      if not found then
        raise exception 'Field not found' using errcode = 'invalid_parameter_value';
      end if;
      if field_row.bound_to_sections then
        raise exception '“%” follows the sections; use Move to section instead', field_row.name
          using errcode = 'invalid_parameter_value';
      end if;
      if not public.has_project_role(field_row.project_id, 'editor') then
        raise exception 'Your role in that project doesn’t allow that' using errcode = 'insufficient_privilege';
      end if;
      arg_project := field_row.project_id;
    when 'add_tag', 'remove_tag' then
      arg_tag := nullif(operation ->> 'tag_id', '')::uuid;
      if arg_tag is null or not exists (select 1 from public.tags g where g.id = arg_tag and g.deleted_at is null) then
        raise exception 'Tag not found' using errcode = 'invalid_parameter_value';
      end if;
      if action = 'add_tag' and exists (select 1 from public.tags g where g.id = arg_tag and g.archived_at is not null) then
        raise exception 'Archived tags can’t be added to tasks' using errcode = 'invalid_parameter_value';
      end if;
    else
      raise exception 'Unknown bulk action: %', coalesce(action, '(none)') using errcode = 'invalid_parameter_value';
  end case;

  remaining := task_ids;
  loop
    progress := false;
    retry := '{}';

    foreach t in array remaining loop
      outcome := null;
      reason := null;

      -- RLS: an unreadable task looks like a missing one.
      select x.title, x.deleted_at into task_title, task_deleted from public.tasks x where x.id = t;
      if not found then
        skipped := skipped || jsonb_build_object('task_id', t, 'title', null,
          'reason', 'Not found, or you don’t have access to it');
        continue;
      end if;
      if task_deleted is not null then
        skipped := skipped || jsonb_build_object('task_id', t, 'title', task_title, 'reason', 'It’s in the Trash');
        continue;
      end if;
      if not public.has_task_role(t, 'editor') then
        skipped := skipped || jsonb_build_object('task_id', t, 'title', task_title,
          'reason', 'Your role doesn’t allow editing this task');
        continue;
      end if;

      begin
        case action
          when 'complete' then
            update public.tasks set completed_at = now() where id = t and completed_at is null;
            get diagnostics changed = row_count;
          when 'reopen' then
            update public.tasks set completed_at = null where id = t and completed_at is not null;
            get diagnostics changed = row_count;
          when 'delete' then
            update public.tasks set deleted_at = now() where id = t and deleted_at is null;
            get diagnostics changed = row_count;
          when 'assign' then
            if arg_assignee is not null and not public.profile_can_read_task(arg_assignee, t) then
              outcome := 'skipped';
              reason := coalesce(
                (select coalesce(nullif(p.full_name, ''), p.email) from public.profiles p where p.id = arg_assignee),
                'That person'
              ) || ' isn’t a member of this task’s projects';
            else
              update public.tasks set assignee_id = arg_assignee
              where id = t and assignee_id is distinct from arg_assignee;
              get diagnostics changed = row_count;
            end if;
          when 'set_due' then
            update public.tasks set due_on = arg_due where id = t and due_on is distinct from arg_due;
            get diagnostics changed = row_count;
          when 'move_section' then
            select tp.section_id into current_section
            from public.task_projects tp
            where tp.task_id = t and tp.project_id = arg_project and tp.deleted_at is null;
            if not found then
              outcome := 'skipped';
              reason := 'It isn’t in this project';
            elsif current_section is not distinct from arg_section then
              changed := 0;
            else
              update public.task_projects
              set section_id = arg_section,
                  sort_order = coalesce((
                    select max(m.sort_order) from public.task_projects m
                    where m.project_id = arg_project
                      and m.section_id is not distinct from arg_section
                      and m.deleted_at is null
                  ), 0) + 1024
              where task_id = t and project_id = arg_project;
              get diagnostics changed = row_count;
            end if;
          when 'add_to_project' then
            if exists (
              select 1 from public.task_projects tp
              where tp.task_id = t and tp.project_id = arg_project and tp.deleted_at is null
            ) then
              changed := 0;
            else
              insert into public.task_projects (task_id, project_id, section_id, sort_order, deleted_at)
              values (t, arg_project, arg_section, coalesce((
                select max(m.sort_order) from public.task_projects m
                where m.project_id = arg_project
                  and m.section_id is not distinct from arg_section
                  and m.deleted_at is null
              ), 0) + 1024, null)
              on conflict (task_id, project_id) do update
                set deleted_at = null, section_id = excluded.section_id, sort_order = excluded.sort_order;
              get diagnostics changed = row_count;
            end if;
          when 'set_field' then
            if not exists (
              select 1 from public.task_projects tp
              where tp.task_id = t and tp.project_id = arg_project and tp.deleted_at is null
            ) then
              outcome := 'skipped';
              reason := 'It isn’t in the field’s project';
            elsif (arg_value is null or arg_value = 'null'::jsonb) and not exists (
              select 1 from public.task_field_values v
              where v.task_id = t and v.field_id = arg_field and v.value <> 'null'::jsonb
            ) then
              changed := 0;
            else
              insert into public.task_field_values (task_id, field_id, value)
              values (t, arg_field, coalesce(arg_value, 'null'::jsonb))
              on conflict (task_id, field_id) do update
                set value = excluded.value
                where public.task_field_values.value is distinct from excluded.value;
              get diagnostics changed = row_count;
            end if;
          when 'add_tag' then
            if exists (
              select 1 from public.task_tags tt where tt.task_id = t and tt.tag_id = arg_tag and tt.deleted_at is null
            ) then
              changed := 0;
            else
              insert into public.task_tags (task_id, tag_id) values (t, arg_tag);
              get diagnostics changed = row_count;
            end if;
          when 'remove_tag' then
            update public.task_tags set deleted_at = now()
            where task_id = t and tag_id = arg_tag and deleted_at is null;
            get diagnostics changed = row_count;
        end case;
      exception when others then
        get stacked diagnostics err_state = returned_sqlstate, err_message = message_text,
          err_constraint = constraint_name;
        outcome := 'skipped';
        reason := public.bulk_skip_reason(err_state, err_message, err_constraint);
        -- Blocked by a dependency: another task in this request may be its blocker, so try again
        -- after the rest of the pass.
        if action = 'complete' and err_state = '23514' and err_message like 'This task is blocked by%' then
          outcome := 'retry';
        end if;
      end;

      if outcome = 'retry' then
        retry := retry || t;
        blocked := blocked || jsonb_build_object(t::text, jsonb_build_object('title', task_title, 'reason', reason));
      elsif outcome = 'skipped' then
        skipped := skipped || jsonb_build_object('task_id', t, 'title', task_title, 'reason', reason);
      elsif changed > 0 then
        updated := updated || to_jsonb(t);
        progress := true;
      else
        unchanged := unchanged || to_jsonb(t);
      end if;
    end loop;

    exit when cardinality(retry) = 0;
    if not progress then
      foreach t in array retry loop
        skipped := skipped || jsonb_build_object('task_id', t,
          'title', blocked -> t::text ->> 'title', 'reason', blocked -> t::text ->> 'reason');
      end loop;
      exit;
    end if;
    remaining := retry;
  end loop;

  return jsonb_build_object('updated', updated, 'unchanged', unchanged, 'skipped', skipped);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Report filter: tags = [tag id] (any-of, on each row's own tags; a subtask row uses the subtask's)
-- ---------------------------------------------------------------------------
-- Same functions as in 20261006090000_reporting_export.sql plus the tags key and its condition.

create or replace function public.validate_report_filters(filters jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  item jsonb;
begin
  if filters is null or filters = 'null'::jsonb then
    return;
  end if;
  if jsonb_typeof(filters) <> 'object' then
    raise exception 'Report filters must be an object' using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from jsonb_object_keys(filters) k
    where k not in ('projects', 'assignees', 'from', 'to', 'status', 'include_subtasks', 'tags')
  ) then
    raise exception 'Unknown report filter' using errcode = 'check_violation';
  end if;

  if filters ? 'projects' then
    if jsonb_typeof(filters -> 'projects') <> 'array' or jsonb_array_length(filters -> 'projects') > 100 then
      raise exception 'Project filter must be a list of up to 100 projects' using errcode = 'check_violation';
    end if;
    for item in select value from jsonb_array_elements(filters -> 'projects') loop
      if jsonb_typeof(item) <> 'string'
        or (item #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'Project filter must list project ids' using errcode = 'check_violation';
      end if;
    end loop;
  end if;

  if filters ? 'assignees' then
    if jsonb_typeof(filters -> 'assignees') <> 'array' or jsonb_array_length(filters -> 'assignees') > 100 then
      raise exception 'Assignee filter must be a list of up to 100 people' using errcode = 'check_violation';
    end if;
    for item in select value from jsonb_array_elements(filters -> 'assignees') loop
      if item <> 'null'::jsonb and item <> '"me"'::jsonb and (
        jsonb_typeof(item) <> 'string'
        or (item #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ) then
        raise exception 'Assignee filter must list people, "me", or null' using errcode = 'check_violation';
      end if;
    end loop;
  end if;

  if filters ? 'from' and not public.is_iso_date(filters ->> 'from') then
    raise exception 'The start of the date range must be a date (YYYY-MM-DD)' using errcode = 'check_violation';
  end if;
  if filters ? 'to' and not public.is_iso_date(filters ->> 'to') then
    raise exception 'The end of the date range must be a date (YYYY-MM-DD)' using errcode = 'check_violation';
  end if;
  if filters ? 'from' and filters ? 'to' and (filters ->> 'from')::date > (filters ->> 'to')::date then
    raise exception 'The date range must start on or before its end' using errcode = 'check_violation';
  end if;

  if filters ? 'status' and coalesce(filters ->> 'status', '') not in ('all', 'open', 'completed', 'overdue') then
    raise exception 'Status filter must be all, open, completed, or overdue' using errcode = 'check_violation';
  end if;
  if filters ? 'tags' then
    if jsonb_typeof(filters -> 'tags') <> 'array' or jsonb_array_length(filters -> 'tags') > 100 then
      raise exception 'Tag filter must be a list of up to 100 tags' using errcode = 'check_violation';
    end if;
    for item in select value from jsonb_array_elements(filters -> 'tags') loop
      if jsonb_typeof(item) <> 'string'
        or (item #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'Tag filter must list tag ids' using errcode = 'check_violation';
      end if;
    end loop;
  end if;
  if filters ? 'include_subtasks' and jsonb_typeof(filters -> 'include_subtasks') <> 'boolean' then
    raise exception 'Include subtasks must be true or false' using errcode = 'check_violation';
  end if;
end;
$$;

revoke all on function public.validate_report_filters(jsonb) from public, anon;
grant execute on function public.validate_report_filters(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Report rows (invoker): one row per (readable project, task) matching the filter
-- ---------------------------------------------------------------------------
-- Top-level tasks come from active task_projects rows of active projects the caller can read (RLS on
-- every table plus an explicit has_project_role check). With include_subtasks, every active subtask of
-- such a task joins with the root's project and section. Invalid filters raise (check_violation).

create or replace function public.report_task_rows(filters jsonb default '{}'::jsonb, tz text default 'UTC')
returns table (
  project_id uuid,
  task_id uuid,
  section_id uuid,
  assignee_id uuid,
  due_on date,
  completed_at timestamptz,
  is_subtask boolean
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  f jsonb := case when jsonb_typeof(filters) = 'object' then filters else '{}'::jsonb end;
  zone text := public.safe_timezone(tz);
  today date := (now() at time zone public.safe_timezone(tz))::date;
  wanted_projects jsonb := public.view_list(f -> 'projects');
  wanted_assignees jsonb := public.view_list(f -> 'assignees');
  wanted_tags jsonb := public.view_list(f -> 'tags');
  range_from date;
  range_to date;
  wanted_status text := coalesce(f ->> 'status', 'all');
  with_subtasks boolean := coalesce(f -> 'include_subtasks' = 'true'::jsonb, false);
  me uuid := auth.uid();
begin
  perform public.validate_report_filters(f);
  range_from := case when f ? 'from' then (f ->> 'from')::date end;
  range_to := case when f ? 'to' then (f ->> 'to')::date end;

  return query
  with readable as (
    select pr.id
    from public.projects pr
    where pr.deleted_at is null
      and (jsonb_array_length(wanted_projects) = 0 or wanted_projects @> jsonb_build_array(pr.id))
      and public.has_project_role(pr.id, 'viewer')
  ),
  top_level as (
    select tp.project_id, t.id as task_id, tp.section_id, t.assignee_id, t.due_on, t.completed_at, false as is_subtask
    from readable r
    join public.task_projects tp on tp.project_id = r.id and tp.deleted_at is null
    join public.tasks t on t.id = tp.task_id and t.deleted_at is null and t.parent_task_id is null
  ),
  everything as (
    select * from top_level
    union all
    select tl.project_id, s.id, tl.section_id, s.assignee_id, s.due_on, s.completed_at, true
    from top_level tl
    join public.tasks s on s.root_task_id = tl.task_id and s.deleted_at is null
    where with_subtasks
  )
  select e.project_id, e.task_id, e.section_id, e.assignee_id, e.due_on, e.completed_at, e.is_subtask
  from everything e
  where (
      jsonb_array_length(wanted_assignees) = 0
      or wanted_assignees @> jsonb_build_array(e.assignee_id)
      or (wanted_assignees @> '["me"]'::jsonb and e.assignee_id = me)
    )
    and (
      (range_from is null and range_to is null)
      or (e.due_on is not null
          and e.due_on >= coalesce(range_from, '-infinity'::date)
          and e.due_on <= coalesce(range_to, 'infinity'::date))
      or (e.completed_at is not null
          and (e.completed_at at time zone zone)::date >= coalesce(range_from, '-infinity'::date)
          and (e.completed_at at time zone zone)::date <= coalesce(range_to, 'infinity'::date))
    )
    and (
      jsonb_array_length(wanted_tags) = 0
      or exists (
        select 1 from public.task_tags tt
        where tt.task_id = e.task_id and tt.deleted_at is null and wanted_tags @> jsonb_build_array(tt.tag_id)
      )
    )
    and case wanted_status
      when 'open' then e.completed_at is null
      when 'completed' then e.completed_at is not null
      when 'overdue' then e.completed_at is null and e.due_on < today
      else true
    end;
end;
$$;

revoke all on function public.report_task_rows(jsonb, text) from public, anon;
grant execute on function public.report_task_rows(jsonb, text) to authenticated;


-- ---------------------------------------------------------------------------
-- Task templates carry tags (same invoker functions plus the tags column)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_task_template()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if jsonb_array_length(new.subtasks) > 100 or exists (
    select 1 from jsonb_array_elements(new.subtasks) s
    where jsonb_typeof(s) <> 'string' or length(trim(s #>> '{}')) not between 1 and 1000
  ) then
    raise exception 'Subtasks must be up to 100 non-empty titles' using errcode = 'check_violation';
  end if;
  if jsonb_array_length(new.field_values) > 100 or exists (
    select 1 from jsonb_array_elements(new.field_values) v
    where jsonb_typeof(v) <> 'object' or not v ? 'field_id' or not v ? 'value'
      or coalesce(v ->> 'field_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception 'Invalid template field values' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(new.tags) <> 'array' or jsonb_array_length(new.tags) > 50 or exists (
    select 1 from jsonb_array_elements(new.tags) g
    where jsonb_typeof(g) <> 'string'
      or (g #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception 'Template tags must be up to 50 tag ids' using errcode = 'check_violation';
  end if;
  if not public.is_client_role() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    new.deleted_at := null;
    return new;
  end if;
  if new.project_id <> old.project_id then
    raise exception 'A task template cannot move to another project' using errcode = 'check_violation';
  end if;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  if new.deleted_at is distinct from old.deleted_at and not public.has_project_role(old.project_id, 'admin') then
    raise exception 'Only project admins can delete task templates' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.save_task_as_template(target_task uuid, target_project uuid, template_name text, include_assignee boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  t public.tasks;
  clean_title text;
  label text;
  created uuid;
begin
  select * into t from public.tasks where id = target_task and deleted_at is null;
  if not found then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if not exists (
    select 1 from public.task_projects tp
    where tp.task_id = coalesce(t.root_task_id, t.id) and tp.project_id = target_project and tp.deleted_at is null
  ) then
    raise exception 'This task isn’t in that project' using errcode = 'check_violation';
  end if;
  if not public.has_project_role(target_project, 'editor') then
    raise exception 'Only editors and above can save task templates' using errcode = 'insufficient_privilege';
  end if;
  clean_title := t.title;
  if t.req_number is not null then
    label := '[' || public.format_request_label(t.req_project_id, t.req_number) || '] ';
    if left(clean_title, length(label)) = label and length(clean_title) > length(label) then
      clean_title := substr(clean_title, length(label) + 1);
    end if;
  end if;
  insert into public.task_templates (project_id, name, title, notes, subtasks, field_values, assignee_id, sort_order, kind, tags)
  values (
    target_project,
    left(coalesce(nullif(trim(template_name), ''), clean_title), 100),
    left(clean_title, 1000),
    t.notes,
    coalesce((
      select jsonb_agg(to_jsonb(s.title) order by s.subtask_order, s.created_at)
      from (select * from public.tasks s where s.parent_task_id = t.id and s.deleted_at is null
            order by s.subtask_order, s.created_at limit 100) s
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object('field_id', v.field_id, 'value', v.value))
      from public.task_field_values v
      join public.custom_fields f on f.id = v.field_id and f.project_id = target_project and f.deleted_at is null
        and not f.bound_to_sections
      where v.task_id = t.id and v.value is not null and v.value <> 'null'::jsonb
    ), '[]'::jsonb),
    case when include_assignee then t.assignee_id end,
    coalesce((select max(x.sort_order) from public.task_templates x
              where x.project_id = target_project and x.deleted_at is null), 0) + 1024,
    t.kind,
    coalesce((
      select jsonb_agg(tt.tag_id order by lower(g.name), g.id)
      from public.task_tags tt
      join public.tags g on g.id = tt.tag_id and g.deleted_at is null and g.archived_at is null
      where tt.task_id = t.id and tt.deleted_at is null
    ), '[]'::jsonb)
  )
  returning id into created;
  return created;
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_task_from_template(target_template uuid, target_section uuid DEFAULT NULL::uuid, task_title text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  tpl public.task_templates;
  new_task uuid;
  item jsonb;
  i integer := 0;
begin
  select * into tpl from public.task_templates where id = target_template and deleted_at is null;
  if not found then
    raise exception 'Task template not found' using errcode = 'no_data_found';
  end if;
  if not public.has_project_role(tpl.project_id, 'editor') then
    raise exception 'Only editors and above can add tasks here' using errcode = 'insufficient_privilege';
  end if;
  if target_section is not null and not exists (
    select 1 from public.sections s where s.id = target_section and s.project_id = tpl.project_id and s.deleted_at is null
  ) then
    raise exception 'That section isn’t in this project' using errcode = 'check_violation';
  end if;

  new_task := public.create_task(tpl.project_id, target_section,
    left(coalesce(nullif(trim(coalesce(task_title, '')), ''), tpl.title), 1000));

  if tpl.notes is not null or tpl.kind <> 'task'
     or (tpl.assignee_id is not null and public.profile_can_read_task(tpl.assignee_id, new_task)) then
    update public.tasks
    set notes = coalesce(tpl.notes, notes),
        kind = tpl.kind,
        assignee_id = case when tpl.assignee_id is not null and public.profile_can_read_task(tpl.assignee_id, new_task)
          then tpl.assignee_id else assignee_id end
    where id = new_task;
  end if;

  for item in select * from jsonb_array_elements(tpl.subtasks) loop
    continue when jsonb_typeof(item) <> 'string' or nullif(trim(item #>> '{}'), '') is null;
    i := i + 1;
    insert into public.tasks (parent_task_id, title, subtask_order) values (new_task, left(trim(item #>> '{}'), 1000), i * 1024);
  end loop;

  for item in select * from jsonb_array_elements(tpl.field_values) loop
    continue when jsonb_typeof(item) <> 'object' or item -> 'value' is null or item -> 'value' = 'null'::jsonb;
    begin
      insert into public.task_field_values (task_id, field_id, value)
      values (new_task, (item ->> 'field_id')::uuid, item -> 'value');
    exception when check_violation or foreign_key_violation or invalid_text_representation
      or insufficient_privilege or raise_exception then
      null;
    end;
  end loop;

  -- Tags that still exist and aren't archived (a normal Editor insert, so RLS applies).
  insert into public.task_tags (task_id, tag_id)
  select new_task, g.id
  from public.tags g
  where tpl.tags @> jsonb_build_array(g.id) and g.deleted_at is null and g.archived_at is null
    and g.workspace_id = (select x.workspace_id from public.tasks x where x.id = new_task)
  on conflict (task_id, tag_id) where deleted_at is null do nothing;

  return new_task;
end;
$function$;
