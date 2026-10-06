-- ALHC Projects — Templates.
--
-- One copy engine serves three features:
--   * Project templates: "Save as template" snapshots a project (sections, tasks with due/start dates
--     stored as day offsets from a project start date, subtasks, custom field definitions + stored
--     values, rules, forms, saved views, Req # settings) into project_templates.content. "Use template"
--     instantiates the snapshot into a new project, resolving each offset from the chosen start date.
--   * Duplicate project: the same snapshot + instantiate in one transaction, with options to include
--     tasks, assignees, dates, rules, forms, and members.
--   * Task templates (per project): title, notes, subtasks, field values, optional assignee; used from
--     quick-add through create_task_from_template (a normal task creation — rules fire as usual).
--
-- Snapshot format (version 1, internal; written only by project_snapshot() and the seed below):
--   { version: 1,
--     project:  { description, approval_completes_task },
--     anchor_on: "YYYY-MM-DD" | null,      date the offsets are relative to (the source's start date)
--     request_sequence: { enabled, prefix, pad_width, add_to_title, assign_to } | null,
--     sections: [{ id, name }],             in order
--     fields:   [{ id, name, field_type, options, bound_to_sections, show_in_views }],
--     forms:    [{ id, title, description, questions, destination_section_id, send_confirmation,
--                  confirmation_message }],
--     rules:    [{ name, trigger_type, trigger_config, conditions, actions, preset_key }],
--     views:    [{ name, layout, config }],
--     tasks:    [{ id, title, notes, section_id, sort_order, completed, completed_at, assignee_id,
--                  due_offset, start_offset, fields: [{ field_id, value } | { field_id, offset }],
--                  subtasks: [{ title, completed }] }],
--     dependencies: [{ predecessor, successor }],
--     members:  [{ profile_id, role }] }
--   Ids are the source rows' ids and only serve as keys: instantiating maps every section, field, and
--   form id to a new row, then rewrites rule configs, form questions, and view configs by replacing
--   the old ids (UUIDs are unique, so a text replacement is exact). Option ids are kept as they are.
--
-- Copies are quiet (same pattern as the Asana importer): while instantiate_project_snapshot() runs, the
-- transaction-local GUC alhc.copy_id is set (copy_context_id()) and stays set until commit, so
--   * no rule fires (fire_rules returns early), including task_created at commit;
--   * nobody is notified (notify_with returns early);
--   * no task stories are written (add_story returns early) — instead ONE project_stories row is
--     written per created project (created_from_template / duplicated);
--   * every rule inserted lands disabled (rules_04_copy_disabled), whatever the snapshot says.
-- Integration secrets (Slack / webhook URLs and shared secrets) are never copied: rule actions keep
-- use_project_webhook and the message, and the creator re-enters URLs before enabling the rule.

-- ---------------------------------------------------------------------------
-- Copy context
-- ---------------------------------------------------------------------------

create or replace function public.copy_context_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('alhc.copy_id', true), '')::uuid;
$$;

-- Not SECURITY DEFINER (it only reads a GUC); the invoker trigger rules_04_copy_disabled calls it.
revoke all on function public.copy_context_id() from public, anon;
grant execute on function public.copy_context_id() to authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.project_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  name text not null check (length(trim(name)) between 1 and 100),
  description text check (length(description) <= 2000),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  summary jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object'),
  source_project_id uuid references public.projects (id),
  is_example boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index project_templates_workspace_idx on public.project_templates (workspace_id, name) where deleted_at is null;
create index project_templates_source_idx on public.project_templates (source_project_id);
create index project_templates_created_by_idx on public.project_templates (created_by);

create trigger project_templates_set_updated_at
  before update on public.project_templates
  for each row execute function public.set_updated_at();

comment on table public.project_templates is
  'Workspace project templates (a snapshot of a project; dates as day offsets). Readable by everyone allowlisted; written only by the template RPCs.';

create table public.project_stories (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  actor_id uuid references public.profiles (id) on delete set null,
  kind text not null check (kind in ('created_from_template', 'duplicated')),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index project_stories_project_idx on public.project_stories (project_id, created_at);
create index project_stories_actor_idx on public.project_stories (actor_id);

comment on table public.project_stories is
  'Project-level activity: one row per project created by the copy engine. Append-only; written only by SECURITY DEFINER code.';

create table public.task_templates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  name text not null check (length(trim(name)) between 1 and 100),
  title text not null check (length(trim(title)) between 1 and 1000),
  notes text check (length(notes) <= 50000),
  subtasks jsonb not null default '[]'::jsonb check (jsonb_typeof(subtasks) = 'array'),
  field_values jsonb not null default '[]'::jsonb check (jsonb_typeof(field_values) = 'array'),
  assignee_id uuid references public.profiles (id) on delete set null,
  sort_order double precision not null default 0,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index task_templates_project_idx on public.task_templates (project_id, sort_order) where deleted_at is null;
create index task_templates_created_by_idx on public.task_templates (created_by);
create index task_templates_assignee_idx on public.task_templates (assignee_id);

create trigger task_templates_set_updated_at
  before update on public.task_templates
  for each row execute function public.set_updated_at();

comment on table public.task_templates is
  'Per-project task templates: title, notes, subtask titles, field values [{field_id, value}], optional assignee.';

-- Shape checks + column guards for task templates (runs as the caller).
create or replace function public.guard_task_template()
returns trigger
language plpgsql
set search_path = ''
as $$
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
$$;

revoke all on function public.guard_task_template() from public, anon, authenticated;

create trigger task_templates_05_guard
  before insert or update on public.task_templates
  for each row execute function public.guard_task_template();

alter table public.project_templates enable row level security;
alter table public.project_stories enable row level security;
alter table public.task_templates enable row level security;

-- Workspace-level, like rule_presets: templates are meant to be shared across projects.
create policy project_templates_select_allowlisted on public.project_templates
  for select to authenticated
  using ((select public.is_allowlisted()));
create policy project_stories_select_viewer on public.project_stories
  for select to authenticated
  using ((select public.has_project_role(project_id, 'viewer')));
create policy task_templates_select_viewer on public.task_templates
  for select to authenticated
  using ((select public.has_project_role(project_id, 'viewer')));
create policy task_templates_insert_editor on public.task_templates
  for insert to authenticated
  with check ((select public.has_project_role(project_id, 'editor')));
create policy task_templates_update_editor on public.task_templates
  for update to authenticated
  using ((select public.has_project_role(project_id, 'editor')))
  with check ((select public.has_project_role(project_id, 'editor')));
-- No DELETE policies. project_templates / project_stories change only through the RPCs below.

revoke insert, update, delete, truncate on public.project_templates, public.project_stories from anon, authenticated;
revoke all on public.project_templates, public.project_stories, public.task_templates from anon;
revoke delete, truncate on public.task_templates from authenticated;

-- ---------------------------------------------------------------------------
-- Side effects are muted while a copy runs
-- ---------------------------------------------------------------------------

-- Same as the Asana importer version, plus: no rule fires for rows written by a copy.
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
  if public.copy_context_id() is not null then
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

-- Same as the Asana importer version, plus: a copy notifies nobody.
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
  if public.copy_context_id() is not null then
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

-- Same as the Asana importer version, plus: a copy writes no task stories (the copy engine writes
-- one project_stories row per created project instead).
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
  if public.copy_context_id() is not null then
    return;
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

-- Copied and templated rules always land disabled, whatever the snapshot says.
create or replace function public.disable_copied_rule()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.copy_context_id() is not null then
    new.enabled := false;
  end if;
  return new;
end;
$$;

revoke all on function public.disable_copied_rule() from public, anon, authenticated;

create trigger rules_04_copy_disabled
  before insert on public.rules
  for each row execute function public.disable_copied_rule();

-- ---------------------------------------------------------------------------
-- Copy engine (internal)
-- ---------------------------------------------------------------------------

-- Counts shown on gallery cards.
create or replace function public.template_summary(snapshot jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'sections', coalesce(jsonb_array_length(case when jsonb_typeof(snapshot -> 'sections') = 'array' then snapshot -> 'sections' end), 0),
    'tasks', coalesce(jsonb_array_length(case when jsonb_typeof(snapshot -> 'tasks') = 'array' then snapshot -> 'tasks' end), 0),
    'fields', coalesce(jsonb_array_length(case when jsonb_typeof(snapshot -> 'fields') = 'array' then snapshot -> 'fields' end), 0),
    'rules', coalesce(jsonb_array_length(case when jsonb_typeof(snapshot -> 'rules') = 'array' then snapshot -> 'rules' end), 0),
    'forms', coalesce(jsonb_array_length(case when jsonb_typeof(snapshot -> 'forms') = 'array' then snapshot -> 'forms' end), 0),
    'views', coalesce(jsonb_array_length(case when jsonb_typeof(snapshot -> 'views') = 'array' then snapshot -> 'views' end), 0),
    'dated_tasks', (
      select count(*) from jsonb_array_elements(case when jsonb_typeof(snapshot -> 'tasks') = 'array' then snapshot -> 'tasks' else '[]' end) t
      where jsonb_typeof(t -> 'due_offset') = 'number' or jsonb_typeof(t -> 'start_offset') = 'number'
    )
  );
$$;

revoke all on function public.template_summary(jsonb) from public, anon, authenticated;

-- Replaces every old id (key) with its new id (value) anywhere in a JSON document. Ids are UUIDs, so a
-- plain text replacement is exact; it also covers "field:<uuid>" sort/group/column keys.
create or replace function public.template_remap(doc jsonb, id_map jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  txt text;
  k text;
  v text;
begin
  if doc is null then
    return null;
  end if;
  txt := doc::text;
  for k, v in select key, value from jsonb_each_text(coalesce(id_map, '{}'::jsonb)) loop
    txt := replace(txt, k, v);
  end loop;
  return txt::jsonb;
end;
$$;

revoke all on function public.template_remap(jsonb, jsonb) from public, anon, authenticated;

-- Snapshot of a project in the format above. Callers check access first. Options (all boolean unless
-- noted): tasks (true), assignees (false), dates (true), keep_completion (false), rules (true),
-- forms (true), views (true), members (false); anchor_on (date, default = earliest start/due date of
-- the copied tasks, else today).
create or replace function public.project_snapshot(source_project uuid, opts jsonb default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
      sort_order double precision, completed_at timestamptz, assignee_id uuid, due_on date, start_on date
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
      t.notes, s.id, s.sort_order, tp.sort_order, t.completed_at, t.assignee_id, t.due_on, t.start_on
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
        'subtasks', coalesce((
          select jsonb_agg(jsonb_build_object('title', sb.title, 'completed', keep_completion and sb.completed_at is not null)
            order by sb.sort_order, sb.created_at)
          from public.subtasks sb
          where sb.task_id = st.id and sb.deleted_at is null
            and not exists (select 1 from public.approval_requests a where a.subtask_id = sb.id)
        ), '[]'::jsonb)
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
$$;

revoke all on function public.project_snapshot(uuid, jsonb) from public, anon, authenticated;

-- Creates a project from a snapshot, owned by the caller. Offsets resolve from start_on. Returns
-- { project_id, sections, fields, tasks, rules, rules_skipped, forms, forms_skipped, views,
--   views_skipped, values_skipped, members }.
create or replace function public.instantiate_project_snapshot(
  snapshot jsonb,
  project_name text,
  start_on date,
  target_workspace uuid,
  story_kind text,
  story_data jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
    insert into public.tasks (home_project_id, title, notes, completed_at, assignee_id, due_on, start_on, created_by)
    values (
      new_project,
      left(coalesce(nullif(trim(item ->> 'title'), ''), 'Untitled task'), 1000),
      item ->> 'notes',
      case when coalesce((item ->> 'completed')::boolean, false)
        then coalesce((item ->> 'completed_at')::timestamptz, now()) end,
      assignee,
      case when jsonb_typeof(item -> 'due_offset') = 'number' then base_date + (item ->> 'due_offset')::integer end,
      case when jsonb_typeof(item -> 'start_offset') = 'number' then base_date + (item ->> 'start_offset')::integer end,
      me
    )
    returning id into new_task;
    n_tasks := n_tasks + 1;
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

    i := 0;
    for child in select * from jsonb_array_elements(case when jsonb_typeof(item -> 'subtasks') = 'array' then item -> 'subtasks' else '[]' end) loop
      continue when nullif(trim(child ->> 'title'), '') is null;
      i := i + 1;
      insert into public.subtasks (task_id, title, completed_at, sort_order)
      values (
        new_task,
        left(trim(child ->> 'title'), 1000),
        case when coalesce((child ->> 'completed')::boolean, false) then now() end,
        i * 1024
      );
    end loop;
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
$$;

revoke all on function public.instantiate_project_snapshot(jsonb, text, date, uuid, text, jsonb)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Who may rename or delete a project template: Admin+ of its source project while that project is
-- active; when it has none (the seeded example) or it was deleted, Admin+ of any active project in the
-- template's workspace.
create or replace function public.can_manage_project_template(target_template uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_allowlisted() and exists (
    select 1 from public.project_templates t
    left join public.projects src on src.id = t.source_project_id and src.deleted_at is null
    where t.id = target_template and t.deleted_at is null
      and (
        (src.id is not null and public.has_project_role(src.id, 'admin'))
        or (src.id is null and exists (
          select 1 from public.project_members m
          join public.projects pj on pj.id = m.project_id and pj.deleted_at is null and pj.workspace_id = t.workspace_id
          where m.profile_id = auth.uid() and m.deleted_at is null and m.role in ('owner', 'admin')
        ))
      )
  );
$$;

revoke all on function public.can_manage_project_template(uuid) from public, anon;
grant execute on function public.can_manage_project_template(uuid) to authenticated;

-- Saves a project as a workspace template (Admin+ on the project: everyone in the workspace can then
-- see its sections, task titles, notes, rules, and forms). No assignees, members, or completion state;
-- dates become offsets from anchor_on (default: the earliest start/due date among its tasks).
-- replace_template: overwrite that template's content instead of creating one (needs
-- can_manage_project_template); this is how the team edits a template, the seeded example included.
create or replace function public.save_project_as_template(
  source_project uuid,
  template_name text,
  template_description text default null,
  anchor_on date default null,
  replace_template uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.projects;
  snap jsonb;
  created uuid;
begin
  select * into p from public.projects where id = source_project and deleted_at is null;
  if not found or not public.has_project_role(source_project, 'viewer') then
    raise exception 'Project not found' using errcode = 'no_data_found';
  end if;
  if not public.has_project_role(source_project, 'admin') then
    raise exception 'Only project owners and admins can save a project as a template'
      using errcode = 'insufficient_privilege';
  end if;
  if nullif(trim(coalesce(template_name, '')), '') is null or length(trim(template_name)) > 100 then
    raise exception 'Template name must be 1–100 characters' using errcode = 'check_violation';
  end if;
  if length(template_description) > 2000 then
    raise exception 'Template description is limited to 2,000 characters' using errcode = 'check_violation';
  end if;
  if replace_template is not null then
    if not exists (select 1 from public.project_templates t where t.id = replace_template and t.deleted_at is null) then
      raise exception 'Template not found' using errcode = 'no_data_found';
    end if;
    if not public.can_manage_project_template(replace_template) then
      raise exception 'Only admins can replace this template' using errcode = 'insufficient_privilege';
    end if;
  end if;

  snap := public.project_snapshot(source_project, jsonb_build_object(
    'tasks', true, 'assignees', false, 'dates', true, 'keep_completion', false,
    'rules', true, 'forms', true, 'views', true, 'members', false, 'anchor_on', anchor_on
  ));
  if replace_template is not null then
    update public.project_templates
    set name = trim(template_name),
        description = nullif(trim(coalesce(template_description, '')), ''),
        content = snap,
        summary = public.template_summary(snap),
        source_project_id = p.id,
        is_example = false
    where id = replace_template
    returning id into created;
    return created;
  end if;
  insert into public.project_templates (workspace_id, name, description, content, summary, source_project_id, created_by)
  values (p.workspace_id, trim(template_name), nullif(trim(coalesce(template_description, '')), ''), snap,
    public.template_summary(snap), p.id, public.current_profile_id())
  returning id into created;
  return created;
end;
$$;

revoke all on function public.save_project_as_template(uuid, text, text, date, uuid) from public, anon;
grant execute on function public.save_project_as_template(uuid, text, text, date, uuid) to authenticated;

-- Creates a project from a template; anyone allowlisted can (like creating a project) and owns it.
create or replace function public.create_project_from_template(
  target_template uuid,
  project_name text,
  start_on date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.project_templates;
begin
  select * into t from public.project_templates where id = target_template and deleted_at is null;
  if not found or not public.is_allowlisted() then
    raise exception 'Template not found' using errcode = 'no_data_found';
  end if;
  return public.instantiate_project_snapshot(
    t.content, project_name, coalesce(start_on, current_date), t.workspace_id, 'created_from_template',
    jsonb_build_object('template_id', t.id, 'template_name', t.name)
  );
end;
$$;

revoke all on function public.create_project_from_template(uuid, text, date) from public, anon;
grant execute on function public.create_project_from_template(uuid, text, date) to authenticated;

-- Duplicates a project (Editor+ on it). Options: tasks (true), assignees (true), dates (true),
-- start_on (date; default = the source's earliest start/due date, so dates stay the same), rules
-- (true), forms (true), members (false). Completion state is kept. Copied rules land disabled.
create or replace function public.duplicate_project(
  source_project uuid,
  project_name text,
  options jsonb default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.projects;
  opts jsonb := case when jsonb_typeof(options) = 'object' then options else '{}'::jsonb end;
  want_tasks boolean;
  snap jsonb;
begin
  select * into p from public.projects where id = source_project and deleted_at is null;
  if not found or not public.has_project_role(source_project, 'viewer') then
    raise exception 'Project not found' using errcode = 'no_data_found';
  end if;
  if not public.has_project_role(source_project, 'editor') then
    raise exception 'Only editors and above can duplicate this project' using errcode = 'insufficient_privilege';
  end if;
  want_tasks := coalesce((opts ->> 'tasks')::boolean, true);
  snap := public.project_snapshot(source_project, jsonb_build_object(
    'tasks', want_tasks,
    'assignees', want_tasks and coalesce((opts ->> 'assignees')::boolean, true),
    'dates', want_tasks and coalesce((opts ->> 'dates')::boolean, true),
    'keep_completion', true,
    'rules', coalesce((opts ->> 'rules')::boolean, true),
    'forms', coalesce((opts ->> 'forms')::boolean, true),
    'views', true,
    'members', coalesce((opts ->> 'members')::boolean, false)
  ));
  return public.instantiate_project_snapshot(
    snap, project_name,
    coalesce(nullif(opts ->> 'start_on', '')::date, (snap ->> 'anchor_on')::date),
    p.workspace_id, 'duplicated',
    jsonb_build_object('source_project_id', p.id, 'source_project_name', p.name, 'options', opts - 'start_on')
  );
end;
$$;

revoke all on function public.duplicate_project(uuid, text, jsonb) from public, anon;
grant execute on function public.duplicate_project(uuid, text, jsonb) to authenticated;

create or replace function public.update_project_template(
  target_template uuid,
  template_name text,
  template_description text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.project_templates t where t.id = target_template and t.deleted_at is null)
     or not public.is_allowlisted() then
    raise exception 'Template not found' using errcode = 'no_data_found';
  end if;
  if not public.can_manage_project_template(target_template) then
    raise exception 'Only admins can change this template' using errcode = 'insufficient_privilege';
  end if;
  if nullif(trim(coalesce(template_name, '')), '') is null or length(trim(template_name)) > 100 then
    raise exception 'Template name must be 1–100 characters' using errcode = 'check_violation';
  end if;
  if length(template_description) > 2000 then
    raise exception 'Template description is limited to 2,000 characters' using errcode = 'check_violation';
  end if;
  update public.project_templates
  set name = trim(template_name), description = nullif(trim(coalesce(template_description, '')), '')
  where id = target_template;
end;
$$;

revoke all on function public.update_project_template(uuid, text, text) from public, anon;
grant execute on function public.update_project_template(uuid, text, text) to authenticated;

-- Soft delete (no hard deletes anywhere).
create or replace function public.delete_project_template(target_template uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.project_templates t where t.id = target_template and t.deleted_at is null)
     or not public.is_allowlisted() then
    raise exception 'Template not found' using errcode = 'no_data_found';
  end if;
  if not public.can_manage_project_template(target_template) then
    raise exception 'Only admins can delete this template' using errcode = 'insufficient_privilege';
  end if;
  update public.project_templates set deleted_at = now() where id = target_template;
end;
$$;

revoke all on function public.delete_project_template(uuid) from public, anon;
grant execute on function public.delete_project_template(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Task templates (SECURITY INVOKER: RLS and every trigger apply as for a normal task)
-- ---------------------------------------------------------------------------

-- Saves a task as a template of the given project (Editor+ there): title (without its Req # prefix),
-- notes, open and done subtask titles, stored values of that project's fields, optionally the assignee.
create or replace function public.save_task_as_template(
  target_task uuid,
  target_project uuid,
  template_name text,
  include_assignee boolean default false
)
returns uuid
language plpgsql
set search_path = ''
as $$
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
    where tp.task_id = t.id and tp.project_id = target_project and tp.deleted_at is null
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
  insert into public.task_templates (project_id, name, title, notes, subtasks, field_values, assignee_id, sort_order)
  values (
    target_project,
    left(coalesce(nullif(trim(template_name), ''), clean_title), 100),
    left(clean_title, 1000),
    t.notes,
    coalesce((
      select jsonb_agg(to_jsonb(s.title) order by s.sort_order, s.created_at)
      from (select * from public.subtasks s where s.task_id = t.id and s.deleted_at is null
            order by s.sort_order, s.created_at limit 100) s
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
              where x.project_id = target_project and x.deleted_at is null), 0) + 1024
  )
  returning id into created;
  return created;
end;
$$;

revoke all on function public.save_task_as_template(uuid, uuid, text, boolean) from public, anon;
grant execute on function public.save_task_as_template(uuid, uuid, text, boolean) to authenticated;

-- Creates a task from a task template in the template's project (Editor+). This is a normal task
-- creation: stories are written and task_created rules fire at commit. Field values that no longer
-- validate are skipped; the assignee is kept only if they can read the new task.
create or replace function public.create_task_from_template(
  target_template uuid,
  target_section uuid default null,
  task_title text default null
)
returns uuid
language plpgsql
set search_path = ''
as $$
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

  if tpl.notes is not null
     or (tpl.assignee_id is not null and public.profile_can_read_task(tpl.assignee_id, new_task)) then
    update public.tasks
    set notes = coalesce(tpl.notes, notes),
        assignee_id = case when tpl.assignee_id is not null and public.profile_can_read_task(tpl.assignee_id, new_task)
          then tpl.assignee_id else assignee_id end
    where id = new_task;
  end if;

  for item in select * from jsonb_array_elements(tpl.subtasks) loop
    continue when jsonb_typeof(item) <> 'string' or nullif(trim(item #>> '{}'), '') is null;
    i := i + 1;
    insert into public.subtasks (task_id, title, sort_order) values (new_task, left(trim(item #>> '{}'), 1000), i * 1024);
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

  return new_task;
end;
$$;

revoke all on function public.create_task_from_template(uuid, uuid, text) from public, anon;
grant execute on function public.create_task_from_template(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Seed: an example workspace template the team can edit (generic; nothing team-specific)
-- ---------------------------------------------------------------------------

insert into public.project_templates (id, workspace_id, name, description, content, summary, is_example)
select
  '00000000-0000-4000-8000-0000000000c1',
  w.id,
  'Creative Requests',
  'Example template — a starting point for a creative request intake. Rename sections, add options to the fields, and save your own version from a project.',
  c.content,
  public.template_summary(c.content),
  true
from public.workspaces w
cross join (select jsonb_build_object(
  'version', 1,
  'project', jsonb_build_object('description', null, 'approval_completes_task', false),
  'anchor_on', null,
  'request_sequence', null,
  'sections', jsonb_build_array(
    jsonb_build_object('id', '00000000-0000-4000-8000-0000000c1001', 'name', 'Intake'),
    jsonb_build_object('id', '00000000-0000-4000-8000-0000000c1002', 'name', 'In Progress'),
    jsonb_build_object('id', '00000000-0000-4000-8000-0000000c1003', 'name', 'Review'),
    jsonb_build_object('id', '00000000-0000-4000-8000-0000000c1004', 'name', 'Approved'),
    jsonb_build_object('id', '00000000-0000-4000-8000-0000000c1005', 'name', 'Delivered')
  ),
  'fields', jsonb_build_array(
    jsonb_build_object('id', '00000000-0000-4000-8000-0000000c2001', 'name', 'Request type',
      'field_type', 'single_select', 'options', '[]'::jsonb, 'bound_to_sections', false, 'show_in_views', true),
    jsonb_build_object('id', '00000000-0000-4000-8000-0000000c2002', 'name', 'Due date priority',
      'field_type', 'single_select', 'options', '[]'::jsonb, 'bound_to_sections', false, 'show_in_views', true)
  ),
  'forms', '[]'::jsonb,
  'rules', '[]'::jsonb,
  'views', '[]'::jsonb,
  'tasks', '[]'::jsonb,
  'dependencies', '[]'::jsonb,
  'members', '[]'::jsonb
) as content) c
where w.id = '00000000-0000-4000-8000-000000000001'
on conflict (id) do nothing;
