-- ALHC Projects — Asana importer.
--
-- An Admin of a project uploads Asana export files (project JSON and/or CSV); the app parses them
-- server-side into a normalized plan and sends it here in batches. Nothing in the database (or the
-- app) ever calls the Asana API or stores Asana credentials.
--
-- Tables
--   import_runs            One row per import into a project (who, files, status, summary). Admin+ read.
--   import_external_ids    Map of external ids (Asana gids) to the rows they created, per target project.
--                          Re-importing the same export looks ids up here and skips what exists, so
--                          nothing is duplicated. Append-only (like task_stories). Admin+ read.
--   task_attachment_links  Names + links of attachments that live in Asana (files are not copied).
--                          Readable with the task (viewer+); written only by the importer.
--
-- RPCs (all check Admin+ on the target project)
--   start_import_run(target_project, import_source, file_names) → run id
--   import_batch(target_run, batch)            idempotent; see the batch format above import_batch()
--   finish_import_run(target_run, run_status, run_summary)
--   import_lookup(import_source, external_ids) SECURITY INVOKER over import_external_ids (dry-run preview)
--
-- While a batch runs, the transaction-local GUC alhc.import_run_id is set (import_context_id()):
--   * rules never fire for imported rows (fire_rules returns early), including task_created at commit;
--   * nobody gets inbox items (notify_with returns early);
--   * only one activity story per imported task is written: `created`, tagged {"import": {...}};
--   * any rule inserted during an import lands disabled (rules_03_import_disabled).
-- Uploaded export files live in the private Storage bucket `imports` at
-- `<project_id>/<uploader id>/<uuid>-<name>`, readable and removable only by their uploader while
-- they are an Admin of the project; the app removes them once an import finishes.

-- ---------------------------------------------------------------------------
-- Import context
-- ---------------------------------------------------------------------------

create or replace function public.import_context_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('alhc.import_run_id', true), '')::uuid;
$$;

-- Not SECURITY DEFINER (it only reads a GUC); the invoker trigger rules_03_import_disabled calls it.
revoke all on function public.import_context_id() from public, anon;
grant execute on function public.import_context_id() to authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.import_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  source text not null check (source in ('asana')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  file_names text[] not null default '{}',
  summary jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object'),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  deleted_at timestamptz
);

create index import_runs_project_idx on public.import_runs (project_id, created_at desc) where deleted_at is null;
create index import_runs_created_by_idx on public.import_runs (created_by);

create trigger import_runs_set_updated_at
  before update on public.import_runs
  for each row execute function public.set_updated_at();

comment on table public.import_runs is
  'One row per import into a project. Written only by start_import_run / import_batch / finish_import_run.';

create table public.import_external_ids (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  source text not null check (source in ('asana')),
  kind text not null check (kind in (
    'project', 'section', 'field', 'task', 'subtask', 'comment', 'attachment', 'dependency', 'rule'
  )),
  external_id text not null check (length(external_id) between 1 and 300),
  local_id uuid not null,
  run_id uuid references public.import_runs (id),
  created_at timestamptz not null default now(),
  unique (project_id, source, kind, external_id)
);

create index import_external_ids_run_idx on public.import_external_ids (run_id);
create index import_external_ids_lookup_idx on public.import_external_ids (source, external_id);

comment on table public.import_external_ids is
  'External id (e.g. Asana gid) → local row, per target project. Makes re-imports idempotent. Append-only; sections and fields are re-pointed when their row was deleted.';

create table public.task_attachment_links (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id),
  source text not null check (source in ('asana')),
  name text not null check (length(trim(name)) > 0 and length(name) <= 255),
  url text check (url is null or (url ~ '^https://[^\s]+$' and length(url) <= 2000)),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index task_attachment_links_task_idx on public.task_attachment_links (task_id) where deleted_at is null;

comment on table public.task_attachment_links is
  'Attachments that stayed in the source system: name + https link only (no file copy). Written only by the importer.';

alter table public.import_runs enable row level security;
alter table public.import_external_ids enable row level security;
alter table public.task_attachment_links enable row level security;

create policy import_runs_select_admin on public.import_runs
  for select to authenticated
  using ((select public.has_project_role(project_id, 'admin')));
create policy import_external_ids_select_admin on public.import_external_ids
  for select to authenticated
  using ((select public.has_project_role(project_id, 'admin')));
create policy task_attachment_links_select_viewer on public.task_attachment_links
  for select to authenticated
  using ((select public.has_task_role(task_id, 'viewer')));
-- No insert/update policies: these change only through the SECURITY DEFINER RPCs below.

revoke insert, update, delete, truncate on public.import_runs, public.import_external_ids,
  public.task_attachment_links from anon, authenticated;
revoke all on public.import_runs, public.import_external_ids, public.task_attachment_links from anon;

-- ---------------------------------------------------------------------------
-- Side effects are muted while an import batch runs
-- ---------------------------------------------------------------------------

-- Same as the workflows version, plus: no rule fires for rows written by an import.
create or replace function public.fire_rules(
  trigger_kind text,
  target_task uuid,
  target_project uuid,
  event jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rules;
  cfg jsonb;
begin
  if public.import_context_id() is not null then
    return;
  end if;
  for r in
    select ru.* from public.rules ru
    join public.projects p on p.id = ru.project_id and p.deleted_at is null
    join public.task_projects tp on tp.project_id = ru.project_id and tp.task_id = target_task and tp.deleted_at is null
    where ru.enabled and ru.deleted_at is null and ru.trigger_type = trigger_kind
      and (target_project is null or ru.project_id = target_project)
    order by ru.sort_order, ru.created_at
  loop
    cfg := r.trigger_config;
    continue when trigger_kind = 'section_changed' and cfg ->> 'section_id' is distinct from event ->> 'section_id';
    continue when trigger_kind = 'field_changed' and (
      cfg ->> 'field_id' is distinct from event ->> 'field_id'
      or (cfg ? 'option_id' and not coalesce(
        event -> 'value' = cfg -> 'option_id' or event -> 'value' @> jsonb_build_array(cfg -> 'option_id'), false
      ))
    );
    continue when trigger_kind = 'approval_decided' and cfg ? 'statuses'
      and not (cfg -> 'statuses') ? (event ->> 'status');
    continue when trigger_kind = 'form_submitted' and cfg ? 'form_id' and cfg ->> 'form_id' is distinct from event ->> 'form_id';
    perform public.run_rule(r, target_task, event);
  end loop;
end;
$$;

revoke all on function public.fire_rules(text, uuid, uuid, jsonb) from public, anon, authenticated;

-- Same as the Teams & permissions version, plus: an import notifies nobody.
create or replace function public.notify_with(
  recipient uuid,
  target_task uuid,
  item_kind text,
  source_comment uuid,
  item_data jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := public.current_actor_id();
  rule uuid := public.rule_context_id();
begin
  if public.import_context_id() is not null then
    return;
  end if;
  if recipient is null or recipient is not distinct from actor then
    return;
  end if;
  if not exists (select 1 from public.profiles p where p.id = recipient)
     or public.profile_task_role(recipient, target_task) is null then
    return;
  end if;
  insert into public.inbox_items (recipient_id, actor_id, task_id, comment_id, kind, data)
  values (
    recipient, actor, target_task, source_comment, item_kind,
    coalesce(item_data, '{}'::jsonb) || case
      when rule is null then '{}'::jsonb
      else jsonb_build_object('rule_id', rule, 'rule_name', (select r.name from public.rules r where r.id = rule))
    end
  );
end;
$$;

revoke all on function public.notify_with(uuid, uuid, text, uuid, jsonb) from public, anon, authenticated;

-- Same as the workflows version, plus: during an import only the `created` story is written, tagged
-- with the import (source + run), so a 1,000-task import doesn't write 10,000 field/assign stories.
create or replace function public.add_story(target_task uuid, story_kind text, story_data jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  rule uuid := public.rule_context_id();
  import_run uuid := public.import_context_id();
  extra jsonb := '{}'::jsonb;
begin
  if import_run is not null then
    if story_kind <> 'created' then
      return;
    end if;
    extra := jsonb_build_object('import', jsonb_build_object(
      'source', (select ir.source from public.import_runs ir where ir.id = import_run),
      'run_id', import_run
    ));
  end if;
  if rule is not null then
    extra := extra || jsonb_build_object(
      'rule_id', rule,
      'rule_name', (select r.name from public.rules r where r.id = rule)
    );
  end if;
  insert into public.task_stories (task_id, actor_id, kind, data)
  values (target_task, public.current_actor_id(), story_kind, coalesce(story_data, '{}'::jsonb) || extra);
end;
$$;

revoke all on function public.add_story(uuid, text, jsonb) from public, anon, authenticated;

-- Imported rules always land disabled, whatever the source says. (Asana's exports contain no rules;
-- this covers rules supplied in ALHC rule JSON alongside an export, and any future source.)
create or replace function public.disable_imported_rule()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.import_context_id() is not null then
    new.enabled := false;
  end if;
  return new;
end;
$$;

revoke all on function public.disable_imported_rule() from public, anon, authenticated;

create trigger rules_03_import_disabled
  before insert on public.rules
  for each row execute function public.disable_imported_rule();

-- ---------------------------------------------------------------------------
-- Storage: uploaded export files
-- ---------------------------------------------------------------------------

-- Object names are "<project_id>/<uploader id>/<file>"; returns the project id, or null.
create or replace function public.import_object_project(object_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(object_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(object_name, '/', 1)::uuid
  end;
$$;

revoke all on function public.import_object_project(text) from public, anon;
grant execute on function public.import_object_project(text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('imports', 'imports', false, 52428800)
on conflict (id) do nothing;

create policy imports_objects_insert_own_admin on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'imports'
    and split_part(name, '/', 2) = (select auth.uid())::text
    and (select public.has_project_role(public.import_object_project(name), 'admin'))
  );
create policy imports_objects_select_own_admin on storage.objects
  for select to authenticated
  using (
    bucket_id = 'imports'
    and split_part(name, '/', 2) = (select auth.uid())::text
    and (select public.has_project_role(public.import_object_project(name), 'admin'))
  );
-- Export files hold a copy of another system's data, so the uploader can remove them (the app does
-- once the import finishes). Content tables still have no DELETE policies.
create policy imports_objects_delete_own_admin on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'imports'
    and split_part(name, '/', 2) = (select auth.uid())::text
    and (select public.has_project_role(public.import_object_project(name), 'admin'))
  );

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

create or replace function public.import_local_id(
  target_project uuid, import_source text, item_kind text, external text
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select x.local_id from public.import_external_ids x
  where x.project_id = target_project and x.source = import_source and x.kind = item_kind
    and x.external_id = external;
$$;

revoke all on function public.import_local_id(uuid, text, text, text) from public, anon, authenticated;

-- Records (or, for sections/fields whose row was deleted, re-points) an external id.
create or replace function public.import_remember(
  target_project uuid, import_source text, item_kind text, external text, local_row uuid, run uuid
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.import_external_ids (project_id, source, kind, external_id, local_id, run_id)
  values (target_project, import_source, item_kind, left(external, 300), local_row, run)
  on conflict (project_id, source, kind, external_id) do update
    set local_id = excluded.local_id, run_id = excluded.run_id
    where public.import_external_ids.kind in ('section', 'field')
      and public.import_external_ids.local_id <> excluded.local_id;
$$;

revoke all on function public.import_remember(uuid, text, text, text, uuid, uuid) from public, anon, authenticated;

-- An active member of the project with this email (assignees, followers, comment authors, people
-- fields only ever match members; anyone else stays unmatched).
create or replace function public.import_member(target_project uuid, member_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id from public.profiles p
  join public.project_members m on m.profile_id = p.id and m.project_id = target_project and m.deleted_at is null
  where member_email is not null and p.email = lower(trim(member_email));
$$;

revoke all on function public.import_member(uuid, text) from public, anon, authenticated;

create or replace function public.import_date(value text)
returns date
language plpgsql
immutable
set search_path = ''
as $$
begin
  if value is null or value !~ '^\d{4}-\d{2}-\d{2}' then
    return null;
  end if;
  return left(value, 10)::date;
exception when others then
  return null;
end;
$$;

revoke all on function public.import_date(text) from public, anon, authenticated;

create or replace function public.import_timestamp(value text)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
begin
  if value is null or value !~ '^\d{4}-\d{2}-\d{2}' then
    return null;
  end if;
  return value::timestamptz;
exception when others then
  return null;
end;
$$;

revoke all on function public.import_timestamp(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

create or replace function public.start_import_run(
  target_project uuid,
  import_source text,
  file_names text[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  created uuid;
begin
  if target_project is null or not public.has_project_role(target_project, 'viewer')
     or not exists (select 1 from public.projects p where p.id = target_project and p.deleted_at is null) then
    raise exception 'Project not found' using errcode = 'no_data_found';
  end if;
  if not public.has_project_role(target_project, 'admin') then
    raise exception 'You need Admin access to import into this project' using errcode = 'insufficient_privilege';
  end if;
  if import_source is distinct from 'asana' then
    raise exception 'Unknown import source' using errcode = 'check_violation';
  end if;
  insert into public.import_runs (project_id, source, file_names, created_by)
  values (
    target_project,
    import_source,
    coalesce((select array_agg(left(f, 255)) from unnest(file_names[1:20]) f where f is not null), '{}'),
    public.current_profile_id()
  )
  returning id into created;
  return created;
end;
$$;

revoke all on function public.start_import_run(uuid, text, text[]) from public, anon;
grant execute on function public.start_import_run(uuid, text, text[]) to authenticated;

-- Batch format (every key optional; ids are the source's external ids, e.g. Asana gids):
--   project:  { gid, name }                       records which source project this is
--   sections: [{ key, name }]                     key = gid, or "name:<lower name>" when there is none
--   fields:   [{ key, name, type, options: [name] }]   type = a custom_fields.field_type except boolean
--   rules:    [{ key, name, trigger_type, trigger_config, conditions, actions }]   inserted DISABLED
--   tasks:    [{ gid, title, notes, completed_at, due_on, start_on, assignee_email, assignee_name,
--                section_key, projects: [{ gid, section_name }], fields: [{ key, value }],
--                followers: [email], subtasks: [{ gid, title, completed_at }],
--                comments: [{ gid, body, author_email, author_name, created_at }],
--                attachments: [{ gid, name, url }] }]
--              field values: text/number/date as JSON scalars, selects as option names (multi = array),
--              people as an array of emails.
--   dependencies: [{ predecessor, successor }]    task gids; finish-to-start
-- Rows that already exist (by external id) are skipped and never changed. A new task's subtasks,
-- comments and attachment links are added; for a task imported earlier only the ones not seen
-- before are added. Returns counts.
create or replace function public.import_batch(target_run uuid, batch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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

      insert into public.tasks (home_project_id, title, notes, completed_at, assignee_id, due_on, start_on, source, created_by)
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
        me
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
    end if;

    -- Subtasks (title + completion; nested subtasks arrive flattened) ------------------------------
    for child in select * from jsonb_array_elements(case when jsonb_typeof(item -> 'subtasks') = 'array' then item -> 'subtasks' else '[]' end) loop
      continue when nullif(child ->> 'gid', '') is null or public.import_local_id(p, src, 'subtask', child ->> 'gid') is not null;
      insert into public.subtasks (task_id, title, completed_at, sort_order)
      values (
        t,
        left(coalesce(nullif(trim(child ->> 'title'), ''), 'Untitled subtask'), 1000),
        case when nullif(child ->> 'completed_at', '') is not null
          then coalesce(public.import_timestamp(child ->> 'completed_at'), now()) end,
        coalesce((select max(s.sort_order) + 1024 from public.subtasks s where s.task_id = t and s.deleted_at is null), 1024)
      )
      returning id into found_id;
      perform public.import_remember(p, src, 'subtask', child ->> 'gid', found_id, run.id);
      n_subtasks := n_subtasks + 1;
    end loop;

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
    'dates_dropped', n_dates_dropped
  );
end;
$$;

revoke all on function public.import_batch(uuid, jsonb) from public, anon;
grant execute on function public.import_batch(uuid, jsonb) to authenticated;

-- Closes a run. The summary keeps the app's totals plus what the run actually created, counted from
-- import_external_ids (so it can't overstate what landed).
create or replace function public.finish_import_run(target_run uuid, run_status text, run_summary jsonb default '{}')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  run public.import_runs;
begin
  select * into run from public.import_runs where id = target_run and deleted_at is null for update;
  if not found or not public.has_project_role(run.project_id, 'viewer') then
    raise exception 'Import not found' using errcode = 'no_data_found';
  end if;
  if not public.has_project_role(run.project_id, 'admin') then
    raise exception 'You need Admin access to import into this project' using errcode = 'insufficient_privilege';
  end if;
  if run_status not in ('completed', 'failed') then
    raise exception 'Unknown import status' using errcode = 'check_violation';
  end if;
  if run.status <> 'running' then
    return;
  end if;
  update public.import_runs
  set status = run_status,
      finished_at = now(),
      summary = (case when jsonb_typeof(run_summary) = 'object' then run_summary else '{}'::jsonb end)
        || jsonb_build_object('created', coalesce((
          select jsonb_object_agg(c.kind, c.n) from (
            select x.kind, count(*) as n from public.import_external_ids x where x.run_id = run.id group by x.kind
          ) c
        ), '{}'::jsonb))
  where id = run.id;
end;
$$;

revoke all on function public.finish_import_run(uuid, text, jsonb) from public, anon;
grant execute on function public.finish_import_run(uuid, text, jsonb) to authenticated;

-- Dry-run helper: which of these external ids were already imported, into projects the caller can
-- administer (RLS on import_external_ids does the filtering).
create or replace function public.import_lookup(import_source text, external_ids text[])
returns table (project_id uuid, kind text, external_id text)
language sql
stable
set search_path = ''
as $$
  select x.project_id, x.kind, x.external_id
  from public.import_external_ids x
  join public.projects pj on pj.id = x.project_id and pj.deleted_at is null
  where x.source = import_source and x.external_id = any (external_ids[1:20000]);
$$;

revoke all on function public.import_lookup(text, text[]) from public, anon;
grant execute on function public.import_lookup(text, text[]) to authenticated;
