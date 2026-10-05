-- ALHC Projects — collaboration phase.
-- Followers, activity stories, comments + @mentions, inbox, custom fields, attachments, search.
-- Same rules as core spine: RLS on every table, soft delete, no DELETE policies.
-- Rows written on behalf of other users (stories, inbox, mentions, auto-follow) are produced only by
-- SECURITY DEFINER triggers; clients have no INSERT policy on those tables.

create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.regex_escape(value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(value, '([]\[^$.*+?(){}|\\-])', '\\\1', 'g');
$$;

revoke all on function public.regex_escape(text) from public, anon, authenticated;

create or replace function public.current_profile_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id from public.profiles p where p.id = auth.uid();
$$;

revoke all on function public.current_profile_id() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Followers
-- ---------------------------------------------------------------------------

create table public.task_followers (
  task_id uuid not null references public.tasks (id),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (task_id, profile_id)
);

create index task_followers_profile_idx
  on public.task_followers (profile_id)
  where deleted_at is null;

create or replace function public.follow_task(target_task uuid, target_profile uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if target_profile is null
     or not exists (select 1 from public.profiles p where p.id = target_profile) then
    return;
  end if;
  insert into public.task_followers (task_id, profile_id)
  values (target_task, target_profile)
  on conflict (task_id, profile_id) do update
    set deleted_at = null
    where public.task_followers.deleted_at is not null;
end;
$$;

revoke all on function public.follow_task(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Activity stories (append-only)
-- ---------------------------------------------------------------------------

create table public.task_stories (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id),
  actor_id uuid references public.profiles (id) on delete set null,
  kind text not null check (kind in (
    'created', 'completed', 'reopened', 'renamed', 'assigned', 'unassigned', 'due_changed',
    'section_changed', 'project_added', 'project_removed', 'attachment_added', 'field_changed',
    'deleted'
  )),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index task_stories_task_idx on public.task_stories (task_id, created_at);
create index task_stories_actor_idx on public.task_stories (actor_id);

create or replace function public.add_story(target_task uuid, story_kind text, story_data jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.task_stories (task_id, actor_id, kind, data)
  values (target_task, public.current_profile_id(), story_kind, coalesce(story_data, '{}'::jsonb));
$$;

revoke all on function public.add_story(uuid, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Comments + mentions
-- ---------------------------------------------------------------------------

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id),
  author_id uuid not null default auth.uid() references public.profiles (id),
  body text not null check (length(trim(body)) > 0 and length(body) <= 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index comments_task_idx on public.comments (task_id, created_at) where deleted_at is null;
create index comments_author_idx on public.comments (author_id);

create trigger comments_set_updated_at
  before update on public.comments
  for each row execute function public.set_updated_at();

create table public.comment_mentions (
  comment_id uuid not null references public.comments (id),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, profile_id)
);

create index comment_mentions_profile_idx on public.comment_mentions (profile_id);

-- ---------------------------------------------------------------------------
-- Inbox
-- ---------------------------------------------------------------------------

create table public.inbox_items (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  actor_id uuid references public.profiles (id) on delete set null,
  task_id uuid not null references public.tasks (id),
  comment_id uuid references public.comments (id),
  kind text not null check (kind in ('assigned', 'comment', 'mention', 'completed')),
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index inbox_items_recipient_idx on public.inbox_items (recipient_id, created_at desc);
create index inbox_items_unread_idx on public.inbox_items (recipient_id) where read_at is null;
create index inbox_items_task_idx on public.inbox_items (task_id);
create index inbox_items_comment_idx on public.inbox_items (comment_id);
create index inbox_items_actor_idx on public.inbox_items (actor_id);

-- Never notifies the acting user about their own action.
create or replace function public.notify(
  recipient uuid,
  target_task uuid,
  item_kind text,
  source_comment uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := public.current_profile_id();
begin
  if recipient is null or recipient is not distinct from actor then
    return;
  end if;
  if not exists (select 1 from public.profiles p where p.id = recipient) then
    return;
  end if;
  insert into public.inbox_items (recipient_id, actor_id, task_id, comment_id, kind)
  values (recipient, actor, target_task, source_comment, item_kind);
end;
$$;

revoke all on function public.notify(uuid, uuid, text, uuid) from public, anon, authenticated;

-- Mentions are parsed in the database so every client gets identical behaviour:
-- "@Full Name" or "@emaillocalpart", case-insensitive, followed by a non-word character or the end.
create or replace function public.on_comment_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  perform public.follow_task(new.task_id, new.author_id);

  insert into public.comment_mentions (comment_id, profile_id)
  select new.id, p.id
  from public.profiles p
  where p.id <> new.author_id
    and (
      (nullif(trim(p.full_name), '') is not null
        and new.body ~* ('@' || public.regex_escape(trim(p.full_name)) || '([^[:alnum:]_]|$)'))
      or new.body ~* ('@' || public.regex_escape(split_part(p.email, '@', 1)) || '([^[:alnum:]_]|$)')
    )
  on conflict do nothing;

  for r in select m.profile_id from public.comment_mentions m where m.comment_id = new.id loop
    perform public.follow_task(new.task_id, r.profile_id);
    perform public.notify(r.profile_id, new.task_id, 'mention', new.id);
  end loop;

  for r in
    select f.profile_id
    from public.task_followers f
    where f.task_id = new.task_id
      and f.deleted_at is null
      and f.profile_id <> new.author_id
      and not exists (
        select 1 from public.comment_mentions m
        where m.comment_id = new.id and m.profile_id = f.profile_id
      )
  loop
    perform public.notify(r.profile_id, new.task_id, 'comment', new.id);
  end loop;

  return new;
end;
$$;

create trigger comments_after_insert
  after insert on public.comments
  for each row execute function public.on_comment_insert();

-- ---------------------------------------------------------------------------
-- Task + membership activity
-- ---------------------------------------------------------------------------

create or replace function public.on_task_insert_collab()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.add_story(new.id, 'created', '{}'::jsonb);
  perform public.follow_task(new.id, new.created_by);
  if new.assignee_id is not null then
    perform public.follow_task(new.id, new.assignee_id);
    perform public.add_story(new.id, 'assigned', jsonb_build_object('assignee_id', new.assignee_id));
    perform public.notify(new.assignee_id, new.id, 'assigned');
  end if;
  return new;
end;
$$;

create trigger tasks_after_insert_collab
  after insert on public.tasks
  for each row execute function public.on_task_insert_collab();

create or replace function public.on_task_update_collab()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  if new.deleted_at is not null and old.deleted_at is null then
    perform public.add_story(new.id, 'deleted', '{}'::jsonb);
    return new;
  end if;

  if new.completed_at is not null and old.completed_at is null then
    perform public.add_story(new.id, 'completed', '{}'::jsonb);
    for r in
      select f.profile_id from public.task_followers f
      where f.task_id = new.id and f.deleted_at is null
    loop
      perform public.notify(r.profile_id, new.id, 'completed');
    end loop;
  elsif new.completed_at is null and old.completed_at is not null then
    perform public.add_story(new.id, 'reopened', '{}'::jsonb);
  end if;

  if new.title is distinct from old.title then
    perform public.add_story(new.id, 'renamed', jsonb_build_object('from', old.title, 'to', new.title));
  end if;

  if new.assignee_id is distinct from old.assignee_id then
    if new.assignee_id is null then
      perform public.add_story(new.id, 'unassigned', jsonb_build_object('previous_id', old.assignee_id));
    else
      perform public.follow_task(new.id, new.assignee_id);
      perform public.add_story(new.id, 'assigned', jsonb_build_object('assignee_id', new.assignee_id));
      perform public.notify(new.assignee_id, new.id, 'assigned');
    end if;
  end if;

  if new.due_on is distinct from old.due_on then
    perform public.add_story(new.id, 'due_changed', jsonb_build_object('from', old.due_on, 'to', new.due_on));
  end if;

  return new;
end;
$$;

create trigger tasks_after_update_collab
  after update on public.tasks
  for each row execute function public.on_task_update_collab();

-- Memberships created in the same transaction as their task (home membership, initial section) are
-- part of "created", not separate stories.
create or replace function public.on_task_project_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  project_name text;
  task_is_new boolean;
begin
  select p.name into project_name from public.projects p where p.id = new.project_id;
  select t.created_at = now() into task_is_new from public.tasks t where t.id = new.task_id;

  if tg_op = 'INSERT' then
    if not task_is_new then
      perform public.add_story(new.task_id, 'project_added',
        jsonb_build_object('project_id', new.project_id, 'project_name', project_name));
    end if;
    return new;
  end if;

  if new.deleted_at is not null and old.deleted_at is null then
    perform public.add_story(new.task_id, 'project_removed',
      jsonb_build_object('project_id', new.project_id, 'project_name', project_name));
  elsif new.deleted_at is null and old.deleted_at is not null then
    perform public.add_story(new.task_id, 'project_added',
      jsonb_build_object('project_id', new.project_id, 'project_name', project_name));
  end if;

  if new.section_id is distinct from old.section_id and not task_is_new and new.deleted_at is null then
    perform public.add_story(new.task_id, 'section_changed', jsonb_build_object(
      'project_id', new.project_id,
      'project_name', project_name,
      'from', (select s.name from public.sections s where s.id = old.section_id),
      'to', (select s.name from public.sections s where s.id = new.section_id)
    ));
  end if;

  return new;
end;
$$;

create trigger task_projects_after_change_collab
  after insert or update on public.task_projects
  for each row execute function public.on_task_project_change();

-- Creates a task and places it in a section atomically (caller's RLS applies).
create or replace function public.create_task(
  target_project uuid,
  target_section uuid,
  task_title text
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  new_task_id uuid;
begin
  insert into public.tasks (home_project_id, title)
  values (target_project, task_title)
  returning id into new_task_id;

  if target_section is not null then
    update public.task_projects
    set section_id = target_section
    where task_id = new_task_id and project_id = target_project;
  end if;

  return new_task_id;
end;
$$;

revoke all on function public.create_task(uuid, uuid, text) from public, anon;
grant execute on function public.create_task(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Custom fields
-- ---------------------------------------------------------------------------

create table public.custom_fields (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  name text not null check (length(trim(name)) > 0 and length(name) <= 100),
  field_type text not null check (field_type in (
    'text', 'number', 'date', 'boolean', 'single_select', 'multi_select', 'people'
  )),
  -- Select options: [{ "id": "<stable id>", "name": "Label", "color": "zinc" }]
  options jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array'),
  -- A section-bound field is a single-select whose value IS the task's section in this project.
  -- It stores no values; changing it moves the task. One per project.
  bound_to_sections boolean not null default false,
  show_in_views boolean not null default false,
  sort_order double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (not bound_to_sections or field_type = 'single_select')
);

create index custom_fields_project_idx
  on public.custom_fields (project_id, sort_order)
  where deleted_at is null;
create unique index custom_fields_one_section_bound_idx
  on public.custom_fields (project_id)
  where bound_to_sections and deleted_at is null;

create trigger custom_fields_set_updated_at
  before update on public.custom_fields
  for each row execute function public.set_updated_at();

create table public.task_field_values (
  task_id uuid not null references public.tasks (id),
  field_id uuid not null references public.custom_fields (id),
  value jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (task_id, field_id)
);

create index task_field_values_field_idx on public.task_field_values (field_id);

create trigger task_field_values_set_updated_at
  before update on public.task_field_values
  for each row execute function public.set_updated_at();

create or replace function public.validate_task_field_value()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  field public.custom_fields;
  option_ids jsonb;
begin
  select * into field from public.custom_fields f where f.id = new.field_id and f.deleted_at is null;
  if not found then
    raise exception 'Unknown custom field' using errcode = 'foreign_key_violation';
  end if;
  if field.bound_to_sections then
    raise exception 'Section-bound fields change by moving the task between sections'
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.task_projects tp
    where tp.task_id = new.task_id and tp.project_id = field.project_id and tp.deleted_at is null
  ) then
    raise exception 'Task is not in the project that owns this field' using errcode = 'check_violation';
  end if;

  if new.value is null or new.value = 'null'::jsonb then
    new.value := null;
    return new;
  end if;

  select coalesce(jsonb_agg(o -> 'id'), '[]'::jsonb) into option_ids
  from jsonb_array_elements(field.options) o;

  if not (case field.field_type
    when 'text' then jsonb_typeof(new.value) = 'string' and length(new.value #>> '{}') <= 10000
    when 'number' then jsonb_typeof(new.value) = 'number'
    when 'boolean' then jsonb_typeof(new.value) = 'boolean'
    when 'date' then jsonb_typeof(new.value) = 'string' and (new.value #>> '{}') ~ '^\d{4}-\d{2}-\d{2}$'
    when 'single_select' then jsonb_typeof(new.value) = 'string' and option_ids @> jsonb_build_array(new.value)
    when 'multi_select' then jsonb_typeof(new.value) = 'array' and option_ids @> new.value
    when 'people' then jsonb_typeof(new.value) = 'array' and not exists (
      select 1 from jsonb_array_elements(new.value) v
      where jsonb_typeof(v) <> 'string'
        or (v #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
    else false
  end) then
    raise exception 'Invalid value for % field "%"', field.field_type, field.name
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger task_field_values_validate
  before insert or update on public.task_field_values
  for each row execute function public.validate_task_field_value();

create or replace function public.on_task_field_value_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.value is not distinct from old.value then
    return new;
  end if;
  perform public.add_story(new.task_id, 'field_changed', jsonb_build_object(
    'field_id', new.field_id,
    'field_name', (select f.name from public.custom_fields f where f.id = new.field_id),
    'value', new.value
  ));
  return new;
end;
$$;

create trigger task_field_values_after_change
  after insert or update on public.task_field_values
  for each row execute function public.on_task_field_value_change();

-- ---------------------------------------------------------------------------
-- Attachments (metadata; bytes live in Storage bucket "task-attachments")
-- ---------------------------------------------------------------------------

create table public.task_attachments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id),
  storage_path text not null unique check (storage_path like (task_id::text || '/%')),
  file_name text not null check (length(trim(file_name)) > 0 and length(file_name) <= 255),
  content_type text,
  size_bytes bigint not null check (size_bytes >= 0 and size_bytes <= 26214400),
  uploaded_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index task_attachments_task_idx on public.task_attachments (task_id, created_at) where deleted_at is null;
create index task_attachments_uploaded_by_idx on public.task_attachments (uploaded_by);

create or replace function public.on_attachment_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.add_story(new.task_id, 'attachment_added',
    jsonb_build_object('attachment_id', new.id, 'file_name', new.file_name));
  return new;
end;
$$;

create trigger task_attachments_after_insert
  after insert on public.task_attachments
  for each row execute function public.on_attachment_insert();

insert into storage.buckets (id, name, public, file_size_limit)
values ('task-attachments', 'task-attachments', false, 26214400)
on conflict (id) do nothing;

-- Objects are never updated or deleted through the API; attachment removal is a metadata soft delete.
create policy task_attachments_objects_select_allowlisted on storage.objects
  for select to authenticated
  using (bucket_id = 'task-attachments' and (select public.is_allowlisted()));
create policy task_attachments_objects_insert_allowlisted on storage.objects
  for insert to authenticated
  with check (bucket_id = 'task-attachments' and (select public.is_allowlisted()));

-- ---------------------------------------------------------------------------
-- Search
-- ---------------------------------------------------------------------------

create index tasks_title_trgm_idx
  on public.tasks using gin (title extensions.gin_trgm_ops)
  where deleted_at is null;
create index tasks_notes_trgm_idx
  on public.tasks using gin (notes extensions.gin_trgm_ops)
  where deleted_at is null;

-- SECURITY INVOKER: callers only ever see rows their RLS allows.
create or replace function public.search_tasks(query text, max_results integer default 50)
returns table (
  id uuid,
  title text,
  notes text,
  completed_at timestamptz,
  due_on date,
  assignee_id uuid,
  home_project_id uuid,
  home_project_name text
)
language sql
stable
set search_path = ''
as $$
  with pattern as (
    select '%' || replace(replace(replace(trim(query), '\', '\\'), '%', '\%'), '_', '\_') || '%' as value
  )
  select t.id, t.title, t.notes, t.completed_at, t.due_on, t.assignee_id, t.home_project_id, p.name
  from public.tasks t
  join public.projects p on p.id = t.home_project_id
  cross join pattern
  where length(trim(query)) > 0
    and t.deleted_at is null
    and p.deleted_at is null
    and (t.title ilike pattern.value or t.notes ilike pattern.value)
  order by t.completed_at is not null, t.title ilike pattern.value desc, t.updated_at desc
  limit least(greatest(coalesce(max_results, 50), 1), 100);
$$;

revoke all on function public.search_tasks(text, integer) from public, anon;
grant execute on function public.search_tasks(text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.task_followers enable row level security;
alter table public.task_stories enable row level security;
alter table public.comments enable row level security;
alter table public.comment_mentions enable row level security;
alter table public.inbox_items enable row level security;
alter table public.custom_fields enable row level security;
alter table public.task_field_values enable row level security;
alter table public.task_attachments enable row level security;

create policy task_followers_select_allowlisted on public.task_followers
  for select to authenticated using ((select public.is_allowlisted()));
create policy task_followers_insert_allowlisted on public.task_followers
  for insert to authenticated with check ((select public.is_allowlisted()));
create policy task_followers_update_allowlisted on public.task_followers
  for update to authenticated
  using ((select public.is_allowlisted()))
  with check ((select public.is_allowlisted()));

create policy task_stories_select_allowlisted on public.task_stories
  for select to authenticated using ((select public.is_allowlisted()));

create policy comments_select_allowlisted on public.comments
  for select to authenticated using ((select public.is_allowlisted()));
create policy comments_insert_own on public.comments
  for insert to authenticated
  with check ((select public.is_allowlisted()) and author_id = (select auth.uid()));
create policy comments_update_own on public.comments
  for update to authenticated
  using ((select public.is_allowlisted()) and author_id = (select auth.uid()))
  with check ((select public.is_allowlisted()) and author_id = (select auth.uid()));

create policy comment_mentions_select_allowlisted on public.comment_mentions
  for select to authenticated using ((select public.is_allowlisted()));

create policy inbox_items_select_own on public.inbox_items
  for select to authenticated
  using ((select public.is_allowlisted()) and recipient_id = (select auth.uid()));
create policy inbox_items_update_own on public.inbox_items
  for update to authenticated
  using ((select public.is_allowlisted()) and recipient_id = (select auth.uid()))
  with check ((select public.is_allowlisted()) and recipient_id = (select auth.uid()));

-- Recipients may only flip read state, never rewrite who/what an item is about.
revoke update on public.inbox_items from anon, authenticated;
grant update (read_at) on public.inbox_items to authenticated;

create policy custom_fields_select_allowlisted on public.custom_fields
  for select to authenticated using ((select public.is_allowlisted()));
create policy custom_fields_insert_allowlisted on public.custom_fields
  for insert to authenticated with check ((select public.is_allowlisted()));
create policy custom_fields_update_allowlisted on public.custom_fields
  for update to authenticated
  using ((select public.is_allowlisted()))
  with check ((select public.is_allowlisted()));

create policy task_field_values_select_allowlisted on public.task_field_values
  for select to authenticated using ((select public.is_allowlisted()));
create policy task_field_values_insert_allowlisted on public.task_field_values
  for insert to authenticated with check ((select public.is_allowlisted()));
create policy task_field_values_update_allowlisted on public.task_field_values
  for update to authenticated
  using ((select public.is_allowlisted()))
  with check ((select public.is_allowlisted()));

create policy task_attachments_select_allowlisted on public.task_attachments
  for select to authenticated using ((select public.is_allowlisted()));
create policy task_attachments_insert_own on public.task_attachments
  for insert to authenticated
  with check ((select public.is_allowlisted()) and uploaded_by = (select auth.uid()));
create policy task_attachments_update_allowlisted on public.task_attachments
  for update to authenticated
  using ((select public.is_allowlisted()))
  with check ((select public.is_allowlisted()));

-- ---------------------------------------------------------------------------
-- Realtime (no-op where the publication doesn't exist, e.g. plain Postgres test harness)
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.comments, public.task_stories, public.inbox_items;
  end if;
end;
$$;
