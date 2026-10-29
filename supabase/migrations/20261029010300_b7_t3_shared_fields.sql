-- ALHC Projects — Oct 29 notes, batch 7, track T3.
--
-- 55. Library fields are shared across projects ("linked placements"). Each project that uses a
--     library field keeps its own custom_fields row (a placement, custom_fields.library_field_id = the
--     published source field), so every project-scoped feature (views, filters, rules, forms, imports,
--     exports, reports, bulk edit, task templates, inbound webhooks, workload) works unchanged. A group
--     is coalesce(library_field_id, id):
--     - one definition: the definition columns (library_field_definition_columns(), the one list) are
--       copied to the whole group after any change (custom_fields_zz_library_sync, definer); only
--       Editors+ of the source's project change them while the source is active (else Editors+ of the
--       placement's own project) — custom_fields_05_library_guard (invoker) refuses everyone else;
--     - one value per task: a value written through one placement is written to every other active
--       placement whose project holds the task's top-level task (task_field_values_zzz_library_sync,
--       definer), quietly (no second story or notification; the other projects' rules fire for their
--       own placement); writers serialize on a transaction advisory lock per task and group
--       (task_field_values_03_library_lock); a task joining a project gets the group's newest value
--       (task_projects_14_library_values), and so does a subtask moved under a task of other
--       projects (tasks_zzz_library_values); a placement that comes back takes the group's definition;
--       the Asana importer adds options to a shared field only for people who may change it
--       (import_batch, asserted patch);
--     - add_library_field(target_project, library_field) (definer, Editor+ by own role; pinned in suite
--       60) adds a placement and fills its values; project_field_sharing(target_project) (definer,
--       pinned) tells the app which of a project's fields are shared and who may change them —
--       booleans and counts only, never another project;
--     - templates / Duplicate project carry the library link (project_snapshot / instantiate_project_snapshot,
--       asserted patches);
--     - existing copies that are clearly the same field are linked once (link_library_field_copies(),
--       library_field_links, library_field_link_conflicts; values are never lost: differing values are
--       both kept and recorded).
--
-- 51. Field lock (custom_fields.locked / locked_by / locked_at, a definition column, so it's shared across a
--     library group): a locked field's values, definition, and removal are for the Owners and Admins of
--     the field's project (custom_fields_06_lock_guard, task_field_values_02_field_lock; a shared field's
--     definition and lock: of its publishing project); rules change one only while their owner is an
--     Owner / Admin there (the Set field step is skipped and logged otherwise); bulk Field skips its
--     tasks with the reason; Duplicate task and task templates leave its values out; every other system
--     path (imports, copies, recurrence, forms, inbound webhooks, the library sync) writes as before.
--
-- No row-removal or object-removal keywords anywhere in this file (the hosted connector refuses them).
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

-- ---------------------------------------------------------------------------------------------------
-- 55. Library fields shared across projects
-- ---------------------------------------------------------------------------------------------------

-- 55.1 The link: a placement points at the published (source) field. The source keeps it null.
alter table public.custom_fields
  add column library_field_id uuid references public.custom_fields (id);

alter table public.custom_fields
  add constraint custom_fields_library_not_self check (library_field_id is null or library_field_id <> id),
  add constraint custom_fields_library_placement_check
    check (library_field_id is null or (not bound_to_sections and not in_library));

create index custom_fields_library_field_idx on public.custom_fields (library_field_id);

-- One live placement of a library field per project.
create unique index custom_fields_library_placement_key on public.custom_fields (project_id, library_field_id)
  where library_field_id is not null and deleted_at is null;

comment on column public.custom_fields.library_field_id is
  'Field library: set on a placement (this project''s copy of a shared library field) and points at the '
  'published source field; null on the source and on project-only fields. Written only by add_library_field, '
  'the copy engine, and link_library_field_copies; a group is coalesce(library_field_id, id).';

-- 55.2 The one list of definition columns (kept identical across a group). Per-placement columns
-- (show_in_views, sort_order, deleted_at) and in_library (the source's) are not in it. A later column
-- that belongs to the definition (a number symbol, a lock) is added here and nowhere else.
create or replace function public.library_field_definition_columns()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['name', 'description', 'field_type', 'options', 'notify_on_change', 'locked', 'locked_by', 'locked_at']::text[];
$$;

revoke all on function public.library_field_definition_columns() from public, anon;
grant execute on function public.library_field_definition_columns() to authenticated;

-- True for the quiet copy of a shared value into another placement (and for a whole field while
-- add_library_field fills it): the story, notification, rule, lock, and sync triggers skip it.
create or replace function public.library_value_sync_write(target_task uuid, target_field uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(current_setting('alhc.library_value_sync', true), '')
    in (target_task::text || ':' || target_field::text, '*:' || target_field::text);
$$;

revoke all on function public.library_value_sync_write(uuid, uuid) from public, anon, authenticated;

-- The project whose Editors change a field's definition: its own project, or — for a placement — the
-- source's project while the source is active (field live, project neither removed nor archived).
create or replace function public.library_field_governing_project(target_field uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when f.library_field_id is null then f.project_id
    else coalesce((
      select s.project_id
      from public.custom_fields s
      join public.projects p on p.id = s.project_id and p.deleted_at is null and p.archived_at is null
      where s.id = f.library_field_id and s.deleted_at is null
    ), f.project_id)
  end
  from public.custom_fields f
  where f.id = target_field;
$$;

revoke all on function public.library_field_governing_project(uuid) from public, anon, authenticated;

-- Copies the source's definition onto one field (no group sync while doing it).
create or replace function public.copy_library_definition(target_field uuid, source_field uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  prev text := coalesce(current_setting('alhc.library_definition_sync', true), '');
  set_list text;
begin
  select string_agg(format('%1$I = s.%1$I', c), ', ') into set_list
  from unnest(public.library_field_definition_columns()) c;
  perform set_config('alhc.library_definition_sync', 'on', true);
  execute format(
    'update public.custom_fields f set %s from public.custom_fields s where s.id = $2 and f.id = $1 and f.id <> s.id',
    set_list
  ) using target_field, source_field;
  perform set_config('alhc.library_definition_sync', prev, true);
end;
$$;

revoke all on function public.copy_library_definition(uuid, uuid) from public, anon, authenticated;

-- 55.3 For the app: which of a project's fields are shared, and who may change them. Booleans and
-- counts only (never another project's name or id): is_source = published here (in the library or
-- used elsewhere), is_shared = linked to other projects, placement_count = live fields of the group in
-- live projects, definition_editable / definition_manageable = the caller is Editor+ / Admin+ of the
-- governing project (library_field_governing_project). Nothing for people who can't open the project.
create or replace function public.project_field_sharing(target_project uuid)
returns table (
  field_id uuid,
  library_field_id uuid,
  is_source boolean,
  is_shared boolean,
  placement_count integer,
  definition_editable boolean,
  definition_manageable boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (
    select f.id, f.library_field_id, f.in_library, coalesce(f.library_field_id, f.id) as grp,
      public.library_field_governing_project(f.id) as governing
    from public.custom_fields f
    where f.project_id = target_project
      and f.deleted_at is null
      and public.has_project_role(target_project, 'viewer')
  ), counted as (
    select m.*, (
      select count(*)::integer
      from public.custom_fields g
      join public.projects p on p.id = g.project_id and p.deleted_at is null
      where (g.id = m.grp or g.library_field_id = m.grp) and g.deleted_at is null
    ) as n
    from mine m
  )
  select c.id, c.library_field_id,
    c.library_field_id is null and (c.in_library or c.n > 1),
    c.library_field_id is not null or c.n > 1,
    c.n,
    public.has_project_role(c.governing, 'editor'),
    public.has_project_role(c.governing, 'admin')
  from counted c
  order by c.id;
$$;

revoke all on function public.project_field_sharing(uuid) from public, anon;
grant execute on function public.project_field_sharing(uuid) to authenticated;

-- 55.4 People's writes to fields (invoker; system code passes). The link is never set or changed by
-- people (add_library_field does it); a placement's definition changes only for Editors+ of the
-- governing project; a shared field stays in its project, isn't Status, and only its source is listed
-- in the library.
create or replace function public.guard_custom_field_library()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  share record;
begin
  if not public.is_client_role() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.library_field_id is not null then
      raise exception 'Add a shared field from the field library (Add field → Choose from library)'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  if new.library_field_id is distinct from old.library_field_id then
    raise exception 'A field''s link to the field library can''t be changed' using errcode = 'insufficient_privilege';
  end if;

  if old.library_field_id is not null then
    if new.in_library and not old.in_library then
      raise exception 'Only the project that published a library field lists it in the field library'
        using errcode = 'check_violation';
    end if;
    if new.bound_to_sections and not old.bound_to_sections then
      raise exception 'A shared library field can''t follow the sections' using errcode = 'check_violation';
    end if;
    if new.project_id is distinct from old.project_id then
      raise exception 'A shared library field stays in its project' using errcode = 'check_violation';
    end if;
    -- A placement that comes back takes the group's current definition (sync_library_field_definition),
    -- so it can't bring a definition of its own with it.
    if old.deleted_at is not null and new.deleted_at is null and exists (
      select 1 from unnest(public.library_field_definition_columns()) c
      where to_jsonb(new) -> c is distinct from to_jsonb(old) -> c
    ) then
      raise exception 'Restore the shared field first, then change it' using errcode = 'check_violation';
    end if;
    if old.deleted_at is null and new.deleted_at is null and exists (
      select 1 from unnest(public.library_field_definition_columns()) c
      where to_jsonb(new) -> c is distinct from to_jsonb(old) -> c
    ) then
      select * into share from public.project_field_sharing(old.project_id) s where s.field_id = old.id;
      if not coalesce(share.definition_editable, false) then
        raise exception 'Shared from the field library. Only editors of the project that published it can change its name, description, and options.'
          using errcode = 'insufficient_privilege';
      end if;
    end if;
    return new;
  end if;

  -- A published field (or one other projects use): it stays where it is and never follows the sections.
  if new.project_id is distinct from old.project_id
     or (new.bound_to_sections and not old.bound_to_sections) then
    select * into share from public.project_field_sharing(old.project_id) s where s.field_id = old.id;
    if coalesce(share.is_shared, false) or old.in_library then
      raise exception 'A field other projects use from the field library stays in its project and can''t follow the sections'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_custom_field_library() from public, anon;
grant execute on function public.guard_custom_field_library() to authenticated;

create trigger custom_fields_05_library_guard
  before insert or update on public.custom_fields
  for each row execute function public.guard_custom_field_library();

-- One definition: after a live field of a group changes a definition column, the rest of the live
-- group (its source and every placement) gets the same values. Removed fields are left as they were;
-- one that comes back (restored) takes the live group's definition instead — a restore never pushes
-- an old definition (or one changed while it was removed) to the others.
create or replace function public.sync_library_field_definition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  grp uuid;
  prev text;
  set_list text;
  diff_list text;
  donor uuid;
begin
  if coalesce(current_setting('alhc.library_definition_sync', true), '') = 'on' or new.deleted_at is not null then
    return null;
  end if;
  if old.deleted_at is not null then
    -- The source when it is live (it always holds the current definition), else another live member.
    select g.id into donor
    from public.custom_fields g
    where (g.id = coalesce(new.library_field_id, new.id) or g.library_field_id = coalesce(new.library_field_id, new.id))
      and g.id <> new.id and g.deleted_at is null
    order by (g.id = coalesce(new.library_field_id, new.id)) desc, g.updated_at desc, g.id
    limit 1;
    if donor is not null then
      if exists (
        select 1 from unnest(public.library_field_definition_columns()) c
        where to_jsonb(new) -> c is distinct from to_jsonb(old) -> c
      ) then
        raise exception 'Restore the shared field first, then change it' using errcode = 'check_violation';
      end if;
      perform public.copy_library_definition(new.id, donor);
    end if;
    return null;
  end if;
  if not exists (
    select 1 from unnest(public.library_field_definition_columns()) c
    where to_jsonb(new) -> c is distinct from to_jsonb(old) -> c
  ) then
    return null;
  end if;
  grp := coalesce(new.library_field_id, new.id);
  if new.library_field_id is null
     and not exists (select 1 from public.custom_fields c where c.library_field_id = new.id) then
    return null;
  end if;
  select string_agg(format('%1$I = s.%1$I', c), ', '),
         string_agg(format('f.%1$I is distinct from s.%1$I', c), ' or ')
  into set_list, diff_list
  from unnest(public.library_field_definition_columns()) c;
  prev := coalesce(current_setting('alhc.library_definition_sync', true), '');
  perform set_config('alhc.library_definition_sync', 'on', true);
  execute format(
    'update public.custom_fields f set %s from public.custom_fields s '
    'where s.id = $1 and f.id <> s.id and (f.id = $2 or f.library_field_id = $2) and f.deleted_at is null and (%s)',
    set_list, diff_list
  ) using new.id, grp;
  perform set_config('alhc.library_definition_sync', prev, true);
  return null;
end;
$$;

revoke all on function public.sync_library_field_definition() from public, anon, authenticated;

create trigger custom_fields_zz_library_sync
  after update on public.custom_fields
  for each row execute function public.sync_library_field_definition();

-- The Asana importer matches a field by name and appends the select options it's missing. On a shared
-- library field that would change the definition in every project that uses it, so it does so only
-- when the importer may change that definition (Editor+ of the project that published it, the guard's
-- rule; Owner / Admin while the field is locked — item 51); otherwise values naming an option the
-- field lacks are skipped and counted like any value that doesn't fit.
select public.alhc_patch_function(
  'public.import_batch(uuid, jsonb)'::regprocedure,
  $old$      if merged_options is distinct from fld.options then$old$,
  $new$      if merged_options is distinct from fld.options
         and public.has_project_role(public.library_field_governing_project(fld.id),
               case when fld.locked then 'admin' else 'editor' end) then$new$
);

-- 55.5 One value per task.

-- The other live placements of a field's group whose project (not removed) holds the task's top-level task.
create or replace function public.library_value_siblings(target_task uuid, target_field uuid)
returns table (field_id uuid, project_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select coalesce(f.library_field_id, f.id) as grp from public.custom_fields f where f.id = target_field
  ), root as (
    select coalesce(t.root_task_id, t.id) as id from public.tasks t where t.id = target_task
  )
  select s.id, s.project_id
  from me
  join public.custom_fields s on (s.id = me.grp or s.library_field_id = me.grp)
  join public.projects p on p.id = s.project_id and p.deleted_at is null
  where s.id <> target_field
    and s.deleted_at is null
    and exists (
      select 1 from public.task_projects tp, root
      where tp.task_id = root.id and tp.project_id = s.project_id and tp.deleted_at is null
    )
  order by s.id;
$$;

revoke all on function public.library_value_siblings(uuid, uuid) from public, anon, authenticated;

-- Two people changing the same shared value from two projects wait for each other (the lock is taken
-- before the row is written by an upsert, the app's path) instead of crossing each other's copies.
create or replace function public.lock_library_field_value()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  grp uuid;
begin
  if public.library_value_sync_write(new.task_id, new.field_id) then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.value is not distinct from old.value then
    return new;
  end if;
  if not exists (select 1 from public.library_value_siblings(new.task_id, new.field_id)) then
    return new;
  end if;
  select coalesce(f.library_field_id, f.id) into grp from public.custom_fields f where f.id = new.field_id;
  perform pg_advisory_xact_lock(hashtextextended('alhc.library_value:' || new.task_id::text || ':' || grp::text, 0));
  return new;
end;
$$;

revoke all on function public.lock_library_field_value() from public, anon, authenticated;

create trigger task_field_values_03_library_lock
  before insert or update on public.task_field_values
  for each row execute function public.lock_library_field_value();

-- After a value changes through one placement, every other placement that holds the task gets it too:
-- quietly (no story, notification, or second sync), each in its own subtransaction (a copy that doesn't
-- fit is skipped, never failing the person's own write). Then the other projects' field_changed rules
-- run for their own placement (their own loop guards apply), as if the change were made there.
create or replace function public.sync_library_field_value()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_value jsonb;
  sibling record;
  prev text;
  written uuid[] := '{}';
  written_projects uuid[] := '{}';
  existing jsonb;
  has_row boolean;
  t public.tasks;
begin
  if public.library_value_sync_write(new.task_id, new.field_id) then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.value is not distinct from old.value then
    return null;
  end if;
  -- The value as it is now (a rule may already have changed it again inside this statement).
  select v.value into current_value from public.task_field_values v
  where v.task_id = new.task_id and v.field_id = new.field_id;
  prev := coalesce(current_setting('alhc.library_value_sync', true), '');
  for sibling in select * from public.library_value_siblings(new.task_id, new.field_id) loop
    select v.value, true into existing, has_row from public.task_field_values v
    where v.task_id = new.task_id and v.field_id = sibling.field_id;
    if not found then
      existing := null;
      has_row := false;
    end if;
    continue when has_row and existing is not distinct from current_value;
    continue when not has_row and current_value is null;
    perform set_config('alhc.library_value_sync', new.task_id::text || ':' || sibling.field_id::text, true);
    begin
      insert into public.task_field_values (task_id, field_id, value)
      values (new.task_id, sibling.field_id, current_value)
      on conflict (task_id, field_id) do update set value = excluded.value;
      written := written || sibling.field_id;
      written_projects := written_projects || sibling.project_id;
    exception when others then
      null;
    end;
    perform set_config('alhc.library_value_sync', prev, true);
  end loop;

  if cardinality(written) > 0 then
    select * into t from public.tasks tk where tk.id = new.task_id;
    -- rules_on_field_value_change's own conditions: top-level tasks, not in the creating transaction.
    if t.parent_task_id is null and not (public.rule_context_id() is null and t.created_at = now()) then
      for i in 1 .. cardinality(written) loop
        perform public.fire_rules('field_changed', new.task_id, written_projects[i],
          jsonb_build_object('field_id', written[i], 'value', current_value));
      end loop;
    end if;
  end if;
  return null;
end;
$$;

revoke all on function public.sync_library_field_value() from public, anon, authenticated;

create trigger task_field_values_zzz_library_sync
  after insert or update on public.task_field_values
  for each row execute function public.sync_library_field_value();

-- The quiet copies write no story, no field-change notification, and fire no rules from the row
-- trigger (sync_library_field_value fires the other projects' rules itself).
select public.alhc_patch_function(
  'public.on_task_field_value_change()'::regprocedure,
  $old$  if tg_op = 'UPDATE' and new.value is not distinct from old.value then$old$,
  $new$  if public.library_value_sync_write(new.task_id, new.field_id) then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.value is not distinct from old.value then$new$
);

select public.alhc_patch_function(
  'public.on_task_field_value_notify()'::regprocedure,
  $old$  if tg_op = 'UPDATE' and new.value is not distinct from old.value then$old$,
  $new$  if public.library_value_sync_write(new.task_id, new.field_id) then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.value is not distinct from old.value then$new$
);

select public.alhc_patch_function(
  'public.rules_on_field_value_change()'::regprocedure,
  $old$  if tg_op = 'UPDATE' and new.value is not distinct from old.value then$old$,
  $new$  if public.library_value_sync_write(new.task_id, new.field_id) then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.value is not distinct from old.value then$new$
);

-- Recurrence and Duplicate task copy a task's values one field at a time into a task that is already
-- in all of its projects, so a shared field's value written through one placement has already reached
-- the others by the time their own value comes: that one is left as it is (one value per task)
-- instead of failing the completion or the duplicate with a duplicate key.
-- (51, field lock: recurrence also marks each copy — alhc.field_value_copy = task:field:running rule —
-- so a locked field's value still reaches the next occurrence when a rule completes the task; the lock
-- guard lets exactly that write through. A failed write's subtransaction undoes the mark.)
select public.alhc_patch_function(
  'public.spawn_next_occurrence()'::regprocedure,
  $old$insert into public.task_field_values (task_id, field_id, value) values (next_id, r.field_id, r.value);$old$,
  $new$perform set_config('alhc.field_value_copy',
        next_id::text || ':' || r.field_id::text || ':' || coalesce(current_setting('alhc.rule_id', true), ''), true);
      insert into public.task_field_values (task_id, field_id, value) values (next_id, r.field_id, r.value)
        on conflict (task_id, field_id) do nothing;
      perform set_config('alhc.field_value_copy', '', true);$new$
);

select public.alhc_patch_function(
  'public.copy_subtask_tree(uuid, uuid, integer)'::regprocedure,
  $old$insert into public.task_field_values (task_id, field_id, value) values (new_id, r.field_id, r.value);$old$,
  $new$perform set_config('alhc.field_value_copy',
          new_id::text || ':' || r.field_id::text || ':' || coalesce(current_setting('alhc.rule_id', true), ''), true);
        insert into public.task_field_values (task_id, field_id, value) values (new_id, r.field_id, r.value)
          on conflict (task_id, field_id) do nothing;
        perform set_config('alhc.field_value_copy', '', true);$new$
);

select public.alhc_patch_function(
  'public.duplicate_task(uuid, jsonb)'::regprocedure,
  $old$insert into public.task_field_values (task_id, field_id, value) values (created, r.field_id, r.value);$old$,
  $new$insert into public.task_field_values (task_id, field_id, value) values (created, r.field_id, r.value)
          on conflict (task_id, field_id) do nothing;$new$
);

select public.alhc_patch_function(
  'public.duplicate_subtask_tree(uuid, uuid, jsonb)'::regprocedure,
  $old$insert into public.task_field_values (task_id, field_id, value) values (new_id, r.field_id, r.value);$old$,
  $new$insert into public.task_field_values (task_id, field_id, value) values (new_id, r.field_id, r.value)
            on conflict (task_id, field_id) do nothing;$new$
);

-- The group's newest value for one field's tasks: the given top-level tasks (null = every task of the
-- field's project) and their subtasks, written quietly where the field's own row differs. Returns how
-- many values it wrote.
create or replace function public.fill_library_values(target_field uuid, target_roots uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.custom_fields;
  grp uuid;
  r record;
  prev text;
  n integer := 0;
begin
  select * into f from public.custom_fields cf where cf.id = target_field and cf.deleted_at is null;
  if not found or f.bound_to_sections then
    return 0;
  end if;
  grp := coalesce(f.library_field_id, f.id);
  if f.library_field_id is null
     and not exists (select 1 from public.custom_fields c where c.library_field_id = f.id and c.deleted_at is null) then
    return 0;
  end if;
  prev := coalesce(current_setting('alhc.library_value_sync', true), '');
  for r in
    with roots as (
      select tp.task_id from public.task_projects tp
      where tp.project_id = f.project_id and tp.deleted_at is null
        and (target_roots is null or tp.task_id = any (target_roots))
    ), held as (
      select t.id from public.tasks t join roots on roots.task_id = t.id where t.deleted_at is null
      union
      select t.id from public.tasks t join roots on roots.task_id = t.root_task_id where t.deleted_at is null
    ), latest as (
      select distinct on (v.task_id) v.task_id, v.field_id, v.value
      from public.task_field_values v
      join held on held.id = v.task_id
      join public.custom_fields g on g.id = v.field_id and g.deleted_at is null
        and (g.id = grp or g.library_field_id = grp)
      order by v.task_id, v.updated_at desc, (v.field_id = target_field) desc, v.field_id
    )
    select l.task_id, l.value, x.task_id is not null as has_row, x.value as own_value
    from latest l
    left join public.task_field_values x on x.task_id = l.task_id and x.field_id = target_field
    where l.field_id <> target_field
  loop
    continue when r.has_row and r.own_value is not distinct from r.value;
    continue when not r.has_row and r.value is null;
    perform set_config('alhc.library_value_sync', r.task_id::text || ':' || target_field::text, true);
    begin
      insert into public.task_field_values (task_id, field_id, value)
      values (r.task_id, target_field, r.value)
      on conflict (task_id, field_id) do update set value = excluded.value;
      n := n + 1;
    exception when others then
      null;
    end;
    perform set_config('alhc.library_value_sync', prev, true);
  end loop;
  return n;
end;
$$;

revoke all on function public.fill_library_values(uuid, uuid[]) from public, anon, authenticated;

-- A task joining a project (added, or added back) gets the newest value of each shared field there.
create or replace function public.fill_library_values_on_join()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  fid uuid;
begin
  if new.deleted_at is not null then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.deleted_at is null then
    return null;
  end if;
  for fid in
    select f.id from public.custom_fields f
    where f.project_id = new.project_id and f.deleted_at is null and not f.bound_to_sections
      and (
        f.library_field_id is not null
        or exists (select 1 from public.custom_fields c where c.library_field_id = f.id and c.deleted_at is null)
      )
    order by f.id
  loop
    perform public.fill_library_values(fid, array[new.task_id]);
  end loop;
  return null;
end;
$$;

revoke all on function public.fill_library_values_on_join() from public, anon, authenticated;

create trigger task_projects_14_library_values
  after insert or update of deleted_at on public.task_projects
  for each row execute function public.fill_library_values_on_join();

-- One task (a subtask that moved under another top-level task, or a task that became one): each shared
-- field of the projects now holding its top-level task gets the group's newest value for it, quietly.
-- Returns how many values it wrote.
create or replace function public.fill_library_task_values(target_task uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  prev text := coalesce(current_setting('alhc.library_value_sync', true), '');
  n integer := 0;
begin
  for r in
    with root as (
      select coalesce(t.root_task_id, t.id) as id from public.tasks t where t.id = target_task and t.deleted_at is null
    ), targets as (
      select f.id as field_id, coalesce(f.library_field_id, f.id) as grp
      from public.custom_fields f
      join public.projects p on p.id = f.project_id and p.deleted_at is null
      where f.deleted_at is null and not f.bound_to_sections
        and exists (
          select 1 from public.task_projects tp, root
          where tp.task_id = root.id and tp.project_id = f.project_id and tp.deleted_at is null
        )
        and (
          f.library_field_id is not null
          or exists (select 1 from public.custom_fields c where c.library_field_id = f.id and c.deleted_at is null)
        )
    ), latest as (
      select distinct on (tg.field_id) tg.field_id, v.field_id as from_field, v.value
      from targets tg
      join public.custom_fields g on g.deleted_at is null and (g.id = tg.grp or g.library_field_id = tg.grp)
      join public.task_field_values v on v.task_id = target_task and v.field_id = g.id
      order by tg.field_id, v.updated_at desc, (v.field_id = tg.field_id) desc, v.field_id
    )
    select l.field_id, l.value, x.task_id is not null as has_row, x.value as own_value
    from latest l
    left join public.task_field_values x on x.task_id = target_task and x.field_id = l.field_id
    where l.from_field <> l.field_id
    order by l.field_id
  loop
    continue when r.has_row and r.own_value is not distinct from r.value;
    continue when not r.has_row and r.value is null;
    perform set_config('alhc.library_value_sync', target_task::text || ':' || r.field_id::text, true);
    begin
      insert into public.task_field_values (task_id, field_id, value)
      values (target_task, r.field_id, r.value)
      on conflict (task_id, field_id) do update set value = excluded.value;
      n := n + 1;
    exception when others then
      null;
    end;
    perform set_config('alhc.library_value_sync', prev, true);
  end loop;
  return n;
end;
$$;

revoke all on function public.fill_library_task_values(uuid) from public, anon, authenticated;

create or replace function public.fill_library_values_on_reparent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.fill_library_task_values(new.id);
  return null;
end;
$$;

revoke all on function public.fill_library_values_on_reparent() from public, anon, authenticated;

-- The subtree's roots change one level per update (tasks_cascade_subtasks), so each moved task fills
-- itself. A task that became a top-level task is filled when it joins its project (above).
create trigger tasks_zzz_library_values
  after update of parent_task_id, root_task_id on public.tasks
  for each row
  when (new.root_task_id is distinct from old.root_task_id and new.root_task_id is not null and new.deleted_at is null)
  execute function public.fill_library_values_on_reparent();

-- 55.6 Linking a field to a library field (the copy engine and the existing-copies migration; people
-- use add_library_field). Only when the source is a live library field of a live project in the same
-- workspace, the field is live, of the same type, not Status, not in the library, not linked, in
-- another project, and that project has no live placement of the source yet. Copies the source's
-- definition. Returns whether it linked.
create or replace function public.link_library_placement(placement uuid, source uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.custom_fields;
  s public.custom_fields;
  prev text := coalesce(current_setting('alhc.library_definition_sync', true), '');
begin
  select cf.* into s
  from public.custom_fields cf
  join public.projects p on p.id = cf.project_id and p.deleted_at is null
  where cf.id = source and cf.deleted_at is null and cf.in_library and not cf.bound_to_sections
    and cf.library_field_id is null;
  if not found then
    return false;
  end if;
  select cf.* into f from public.custom_fields cf where cf.id = placement and cf.deleted_at is null;
  if not found or f.library_field_id is not null or f.bound_to_sections or f.in_library
     or f.project_id = s.project_id or f.field_type <> s.field_type then
    return false;
  end if;
  if (select p.workspace_id from public.projects p where p.id = f.project_id)
     is distinct from (select p.workspace_id from public.projects p where p.id = s.project_id) then
    return false;
  end if;
  if exists (
    select 1 from public.custom_fields x
    where x.project_id = f.project_id and x.library_field_id = s.id and x.deleted_at is null
  ) then
    return false;
  end if;
  perform set_config('alhc.library_definition_sync', 'on', true);
  update public.custom_fields set library_field_id = s.id where id = f.id;
  perform set_config('alhc.library_definition_sync', prev, true);
  perform public.copy_library_definition(f.id, s.id);
  return true;
end;
$$;

revoke all on function public.link_library_placement(uuid, uuid) from public, anon, authenticated;

-- 55.7 Add field → Choose from library: this project's placement of a library field (Editor+ by own
-- role; the field live, published, of this workspace, not Status). Idempotent: the project's live
-- placement, or the source itself in its own project. The placement is pinned to views and goes last;
-- its values come from the group for the project's tasks and subtasks.
create or replace function public.add_library_field(target_project uuid, library_field uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_ws uuid;
  src public.custom_fields;
  existing uuid;
  new_field uuid;
  next_order double precision;
begin
  if target_project is null or library_field is null then
    raise exception 'Choose a project and a library field' using errcode = 'invalid_parameter_value';
  end if;
  if not public.has_project_role(target_project, 'editor') then
    raise exception 'Only Editors and above can add fields to this project' using errcode = 'insufficient_privilege';
  end if;
  select p.workspace_id into target_ws from public.projects p where p.id = target_project and p.deleted_at is null;
  if not found then
    raise exception 'Project not found' using errcode = 'no_data_found';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('alhc.add_library_field:' || target_project::text, 0));
  select f.* into src
  from public.custom_fields f
  join public.projects p on p.id = f.project_id and p.deleted_at is null
  where f.id = library_field and f.deleted_at is null and f.in_library and not f.bound_to_sections
    and f.library_field_id is null and p.workspace_id = target_ws;
  if not found then
    raise exception 'This field isn''t in the field library any more' using errcode = 'no_data_found';
  end if;
  if src.project_id = target_project then
    return src.id;
  end if;
  select f.id into existing from public.custom_fields f
  where f.project_id = target_project and f.library_field_id = src.id and f.deleted_at is null;
  if found then
    return existing;
  end if;
  select coalesce(max(f.sort_order), 0) + 1024 into next_order
  from public.custom_fields f where f.project_id = target_project and f.deleted_at is null;
  insert into public.custom_fields (project_id, name, field_type, show_in_views, sort_order, library_field_id)
  values (target_project, src.name, src.field_type, true, next_order, src.id)
  returning id into new_field;
  perform public.copy_library_definition(new_field, src.id);
  perform public.fill_library_values(new_field, null);
  return new_field;
end;
$$;

revoke all on function public.add_library_field(uuid, uuid) from public, anon;
grant execute on function public.add_library_field(uuid, uuid) to authenticated;

-- 55.8 Templates and Duplicate project: a copied field that is (a placement of) a live library field
-- becomes a placement of it in the new project. The snapshot carries the source's id; the new project
-- links it only if that field is still a live library field then (else a plain copy, as before).
create or replace function public.library_field_source_for_copy(target_field uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id
  from public.custom_fields f
  join public.custom_fields s on s.id = coalesce(f.library_field_id, f.id)
  join public.projects p on p.id = s.project_id and p.deleted_at is null
  where f.id = target_field
    and not f.bound_to_sections
    and s.deleted_at is null and s.in_library and not s.bound_to_sections and s.library_field_id is null;
$$;

revoke all on function public.library_field_source_for_copy(uuid) from public, anon, authenticated;

select public.alhc_patch_function(
  'public.project_snapshot(uuid, jsonb)'::regprocedure,
  $old$'id', f.id, 'name', f.name,$old$,
  $new$'id', f.id, 'library_field_id', public.library_field_source_for_copy(f.id), 'name', f.name,$new$
);

select public.alhc_patch_function(
  'public.instantiate_project_snapshot(jsonb, text, date, uuid, text, jsonb)'::regprocedure,
  $old$    n_fields := n_fields + 1;$old$,
  $new$    -- 51. A locked field stays locked in the copy (the copy's owner can unlock it).
    if item ->> 'locked' = 'true' and not coalesce((item ->> 'bound_to_sections')::boolean, false) then
      update public.custom_fields set locked = true where id = found_id;
    end if;
    if coalesce(item ->> 'library_field_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      perform public.link_library_placement(found_id, (item ->> 'library_field_id')::uuid);
    end if;
    n_fields := n_fields + 1;$new$
);

-- 55.9 Existing copies. Nothing recorded which fields were copied from the library ("Choose from
-- library" made unrelated copies), so a field C is linked to a live library field S only when it is
-- clearly the same field: same workspace, C live in another live (not archived) project, not Status,
-- not itself in the library, not linked, same type, same name (trimmed, any case), made after S, and —
-- for select fields — exactly the same non-empty set of option ids (random ids: a strong fingerprint),
-- else the same non-empty description. A C matching more than one S, or a project with more than one
-- C for the same S, is left alone (counted as ambiguous). After linking, for each task in more than
-- one of the group's projects: one value → copied to the placements without one (quietly); equal
-- values → nothing; different values → both kept and recorded in library_field_link_conflicts. An
-- empty value (none, "", [], or false — what views count as empty, view_value_is_empty) is no value.

do $do$
begin
  execute $sql$
    create table public.library_field_links (
      id uuid primary key default gen_random_uuid(),
      field_id uuid not null references public.custom_fields (id),
      library_field_id uuid not null references public.custom_fields (id),
      matched_by text not null constraint library_field_links_matched_by_check check (matched_by in ('options', 'description')),
      previous_definition jsonb not null default '{}'::jsonb,
      linked_at timestamptz not null default now()
    )
  $sql$;
  execute 'alter table public.library_field_links enable row level security';
  execute 'revoke all on public.library_field_links from anon, authenticated';
  execute $sql$
    create table public.library_field_link_conflicts (
      id uuid primary key default gen_random_uuid(),
      task_id uuid not null references public.tasks (id),
      field_id uuid not null references public.custom_fields (id),
      value jsonb,
      other_field_id uuid not null references public.custom_fields (id),
      other_value jsonb,
      created_at timestamptz not null default now(),
      constraint library_field_link_conflicts_key unique (task_id, field_id, other_field_id)
    )
  $sql$;
  execute 'alter table public.library_field_link_conflicts enable row level security';
  execute 'revoke all on public.library_field_link_conflicts from anon, authenticated';
end;
$do$;

create index library_field_links_field_idx on public.library_field_links (field_id);
create index library_field_links_library_field_idx on public.library_field_links (library_field_id);
create index library_field_link_conflicts_field_idx on public.library_field_link_conflicts (field_id);
create index library_field_link_conflicts_other_field_idx on public.library_field_link_conflicts (other_field_id);

select public.alhc_revoke_anon_grants(array['library_field_links', 'library_field_link_conflicts']);
select public.alhc_revoke_client_truncate(array['library_field_links', 'library_field_link_conflicts']);

comment on table public.library_field_links is
  'Field library: existing fields linked to a library field by link_library_field_copies (how they matched, '
  'and the definition the field had before it took the library field''s). No client access.';
comment on table public.library_field_link_conflicts is
  'Field library: tasks whose linked fields held different values when they were linked (both kept, '
  'untouched). No client access.';

-- The live fields of a group whose project (not removed) holds a task's top-level task, with the
-- task's value in each (has_row false = no value row).
create or replace function public.library_group_task_members(grp uuid, target_task uuid)
returns table (field_id uuid, created_at timestamptz, is_source boolean, has_row boolean, value jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select f.id, f.created_at, f.id = grp, v.task_id is not null, v.value
  from public.custom_fields f
  join public.projects p on p.id = f.project_id and p.deleted_at is null
  left join public.task_field_values v on v.task_id = target_task and v.field_id = f.id
  where (f.id = grp or f.library_field_id = grp)
    and f.deleted_at is null
    and exists (
      select 1 from public.task_projects tp
      where tp.task_id = (select coalesce(tk.root_task_id, tk.id) from public.tasks tk where tk.id = target_task)
        and tp.project_id = f.project_id and tp.deleted_at is null
    )
  order by f.id;
$$;

revoke all on function public.library_group_task_members(uuid, uuid) from public, anon, authenticated;

create or replace function public.link_library_field_copies()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c record;
  t record;
  m record;
  grp uuid;
  groups uuid[] := '{}';
  ambiguous uuid[] := '{}';
  n_linked integer := 0;
  n_filled integer := 0;
  n_conflicts integer := 0;
  n_members integer;
  distinct_values integer;
  the_value jsonb;
  ref_field uuid;
  ref_value jsonb;
  prev text := coalesce(current_setting('alhc.library_value_sync', true), '');
  inserted integer;
  previous jsonb;
begin
  for c in
    with sources as (
      select s.id, s.project_id, s.name, s.field_type, s.options, s.description, s.created_at, p.workspace_id
      from public.custom_fields s
      join public.projects p on p.id = s.project_id and p.deleted_at is null
      where s.in_library and s.deleted_at is null and not s.bound_to_sections and s.library_field_id is null
    ), candidates as (
      select f.id as field_id, f.project_id, s.id as source_id,
        case when f.field_type in ('single_select', 'multi_select') then 'options' else 'description' end as matched_by
      from public.custom_fields f
      join public.projects p on p.id = f.project_id and p.deleted_at is null and p.archived_at is null
      join sources s on s.workspace_id = p.workspace_id
        and s.project_id <> f.project_id
        and s.field_type = f.field_type
        and lower(trim(s.name)) = lower(trim(f.name))
        and f.created_at > s.created_at
      where f.deleted_at is null and not f.bound_to_sections and not f.in_library and f.library_field_id is null
        and (
          (f.field_type in ('single_select', 'multi_select')
            and jsonb_array_length(s.options) > 0
            and (select array_agg(o ->> 'id' order by o ->> 'id') from jsonb_array_elements(f.options) o)
              = (select array_agg(o ->> 'id' order by o ->> 'id') from jsonb_array_elements(s.options) o))
          or (f.field_type not in ('single_select', 'multi_select')
            and nullif(trim(coalesce(s.description, '')), '') is not null
            and trim(coalesce(f.description, '')) = trim(s.description))
        )
    )
    select cd.*,
      count(*) over (partition by cd.field_id) as per_field,
      count(*) over (partition by cd.project_id, cd.source_id) as per_project
    from candidates cd
    order by cd.source_id, cd.field_id
  loop
    if c.per_field > 1 or c.per_project > 1 then
      if not c.field_id = any (ambiguous) then
        ambiguous := ambiguous || c.field_id;
      end if;
      continue;
    end if;
    -- The copy takes the library field's definition; what it had before is kept here.
    select coalesce(jsonb_object_agg(col, to_jsonb(f) -> col), '{}'::jsonb) into previous
    from public.custom_fields f, unnest(public.library_field_definition_columns()) col
    where f.id = c.field_id;
    if public.link_library_placement(c.field_id, c.source_id) then
      insert into public.library_field_links (field_id, library_field_id, matched_by, previous_definition)
      values (c.field_id, c.source_id, c.matched_by, previous);
      n_linked := n_linked + 1;
      if not c.source_id = any (groups) then
        groups := groups || c.source_id;
      end if;
    end if;
  end loop;

  -- Values: per task with a value in a newly linked group and in more than one of its projects.
  foreach grp in array groups loop
    for t in
      select distinct v.task_id
      from public.task_field_values v
      join public.custom_fields f on f.id = v.field_id and f.deleted_at is null
        and (f.id = grp or f.library_field_id = grp)
      where not public.view_value_is_empty(v.value)
      order by v.task_id
    loop
      select count(*), count(distinct mm.value) filter (where not public.view_value_is_empty(mm.value))
      into n_members, distinct_values
      from public.library_group_task_members(grp, t.task_id) mm;
      continue when n_members < 2;
      if distinct_values = 1 then
        select mm.value into the_value from public.library_group_task_members(grp, t.task_id) mm
        where not public.view_value_is_empty(mm.value) limit 1;
        for m in select * from public.library_group_task_members(grp, t.task_id) mm where public.view_value_is_empty(mm.value) loop
          perform set_config('alhc.library_value_sync', t.task_id::text || ':' || m.field_id::text, true);
          begin
            insert into public.task_field_values (task_id, field_id, value)
            values (t.task_id, m.field_id, the_value)
            on conflict (task_id, field_id) do update set value = excluded.value;
            n_filled := n_filled + 1;
          exception when others then
            null;
          end;
          perform set_config('alhc.library_value_sync', prev, true);
        end loop;
      elsif distinct_values > 1 then
        -- Both kept. The reference is the source's value when it has one, else the oldest field's.
        select mm.field_id, mm.value into ref_field, ref_value
        from public.library_group_task_members(grp, t.task_id) mm
        where not public.view_value_is_empty(mm.value)
        order by mm.is_source desc, mm.created_at, mm.field_id
        limit 1;
        for m in
          select * from public.library_group_task_members(grp, t.task_id) mm
          where not public.view_value_is_empty(mm.value) and mm.field_id <> ref_field and mm.value is distinct from ref_value
        loop
          insert into public.library_field_link_conflicts (task_id, field_id, value, other_field_id, other_value)
          values (t.task_id, m.field_id, m.value, ref_field, ref_value)
          on conflict on constraint library_field_link_conflicts_key do nothing;
          get diagnostics inserted = row_count;
          n_conflicts := n_conflicts + inserted;
        end loop;
      end if;
    end loop;
  end loop;

  return jsonb_build_object(
    'linked', n_linked, 'filled', n_filled, 'conflicts', n_conflicts, 'ambiguous', cardinality(ambiguous)
  );
end;
$$;

revoke all on function public.link_library_field_copies() from public, anon, authenticated;

-- (The existing copies are linked at the end of this file, once every definition column exists.)

-- ---------------------------------------------------------------------------------------------------
-- 51. Field lock
-- ---------------------------------------------------------------------------------------------------
-- A locked field's values are changed only by the Owners and Admins of the project they're written
-- through (the field's project); its definition (name, description, options, notifications) and
-- removing it need Owner / Admin too. Locking and unlocking are Owner / Admin of the project whose
-- Editors change the definition (library_field_governing_project: a shared field's publishing project
-- while its source is live, else its own). `locked` is a definition column, so locking a shared library
-- field locks it in every project that uses it.
-- Values (task_field_values_02_field_lock, invoker): people → Admin+ of the field's project; rules →
-- only while the rule's owner is an Owner / Admin of it (execute_rule_actions skips the step with a
-- logged reason before it gets there); every other system path (imports, copies, recurrence, form
-- submissions, inbound webhooks, the library sync) writes as before. Bulk Field skips a locked field's
-- tasks with the reason; Duplicate task and task templates leave locked values out (they already skip
-- values the caller may not write, and Duplicate task counts them).

-- 51.1 The lock (who and when are kept by the guard; people can't set them).
alter table public.custom_fields
  add column locked boolean not null default false,
  add column locked_by uuid references public.profiles (id),
  add column locked_at timestamptz;

alter table public.custom_fields
  add constraint custom_fields_lock_check check (not (bound_to_sections and locked));

create index custom_fields_locked_by_idx on public.custom_fields (locked_by);

comment on column public.custom_fields.locked is
  'Field lock (Oct 29 notes, batch 7): values, definition, and removal only by the project''s Owners and '
  'Admins (rules only while their owner is one). A definition column: shared across a library group.';

-- 51.2 People's writes to a locked field's definition (invoker; system code passes, the guard's
-- bookkeeping included). Runs after custom_fields_05_library_guard (which refuses a shared definition
-- to people who aren't Editors of the publishing project).
create or replace function public.guard_custom_field_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  share record;
  lock_changed boolean;
  definition_changed boolean;
begin
  -- Who locked it and when (copied as they are inside a library group).
  if coalesce(current_setting('alhc.library_definition_sync', true), '') <> 'on' then
    lock_changed := tg_op = 'INSERT' or new.locked is distinct from old.locked;
    if not new.locked then
      new.locked_by := null;
      new.locked_at := null;
    elsif lock_changed then
      new.locked_by := (select p.id from public.profiles p where p.id = auth.uid());
      new.locked_at := now();
    else
      new.locked_by := old.locked_by;
      new.locked_at := old.locked_at;
    end if;
  end if;

  if not public.is_client_role() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.locked and not public.has_project_role(new.project_id, 'admin') then
      raise exception 'Only project Owners and Admins can lock a field' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if not old.locked and not new.locked then
    return new;
  end if;

  lock_changed := new.locked is distinct from old.locked;
  definition_changed := exists (
    select 1 from unnest(public.library_field_definition_columns()) c
    where c not in ('locked_by', 'locked_at') and to_jsonb(new) -> c is distinct from to_jsonb(old) -> c
  );
  -- Publishing a locked field in the field library (or taking it out) is Owner / Admin too: an Editor
  -- could otherwise share it into a project of their own and change its values there (one value per
  -- task across the group).
  if definition_changed or new.in_library is distinct from old.in_library then
    select * into share from public.project_field_sharing(old.project_id) s where s.field_id = old.id;
    if not coalesce(share.definition_manageable, false) then
      if lock_changed then
        raise exception '%', case when old.library_field_id is not null
            then 'Shared from the field library. Only Owners and Admins of the project that published it can lock or unlock it.'
            else 'Only project Owners and Admins can lock or unlock a field' end
          using errcode = 'insufficient_privilege';
      end if;
      raise exception '%', case when old.library_field_id is not null
          then 'Locked — only Owners and Admins of the project that published it can change this field'
          else 'Locked — only project Owners and Admins can change this field' end
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  -- Removing it (or bringing it back) here: this project's Owners and Admins.
  if new.deleted_at is distinct from old.deleted_at and not public.has_project_role(old.project_id, 'admin') then
    raise exception 'Locked — only project Owners and Admins can change this field' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_custom_field_lock() from public, anon;
grant execute on function public.guard_custom_field_lock() to authenticated;

create trigger custom_fields_06_lock_guard
  before insert or update on public.custom_fields
  for each row execute function public.guard_custom_field_lock();

-- 51.3 A rule changes a locked field only while its owner (else its creator) is still an allowlisted
-- Owner or Admin of the field's project.
create or replace function public.rule_owner_manages_project(target_rule uuid, target_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select public.profile_is_allowlisted(coalesce(r.owner_id, r.created_by))
      and coalesce(public.profile_project_role(coalesce(r.owner_id, r.created_by), target_project), '') in ('admin', 'owner')
    from public.rules r
    where r.id = target_rule
  ), false);
$$;

revoke all on function public.rule_owner_manages_project(uuid, uuid) from public, anon, authenticated;

-- 51.4 Values of a locked field (invoker: people are checked with their own role; definer code — the
-- system paths — passes, except a rule, which is checked against its owner).
create or replace function public.guard_locked_field_value()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  client boolean := public.is_client_role();
  rule uuid;
  f record;
begin
  if not client then
    -- The library's quiet copy of a shared value (the write it copies was checked), and every other
    -- system path but a rule.
    if public.library_value_sync_write(new.task_id, new.field_id) then
      return new;
    end if;
    rule := public.rule_context_id();
    if rule is null then
      return new;
    end if;
    -- A system copy inside a rule's run: recurrence (a rule completed a recurring task) copies the
    -- completed occurrence's values into the next one — not the rule's change. spawn_next_occurrence and
    -- copy_subtask_tree mark each such write with its task, field, and the running rule (a rule that runs
    -- inside that write has another id, so it is checked as usual).
    if coalesce(current_setting('alhc.field_value_copy', true), '')
         = new.task_id::text || ':' || new.field_id::text || ':' || rule::text then
      return new;
    end if;
  end if;
  select cf.locked, cf.project_id into f from public.custom_fields cf where cf.id = new.field_id;
  if not coalesce(f.locked, false) then
    return new;
  end if;
  -- Nothing changes (no value written where there was none, or the value the row already has: an
  -- upsert's INSERT trigger runs before its conflict is found).
  if tg_op = 'UPDATE' and new.value is not distinct from old.value then
    return new;
  end if;
  if tg_op = 'INSERT' and (new.value is null or new.value = 'null'::jsonb) then
    return new;
  end if;
  if tg_op = 'INSERT' and exists (
    select 1 from public.task_field_values v
    where v.task_id = new.task_id and v.field_id = new.field_id and v.value is not distinct from new.value
  ) then
    return new;
  end if;
  if client then
    if public.has_project_role(f.project_id, 'admin') then
      return new;
    end if;
  elsif public.rule_owner_manages_project(rule, f.project_id) then
    return new;
  end if;
  raise exception 'Locked — only project Owners and Admins can change this field' using errcode = 'insufficient_privilege';
end;
$$;

revoke all on function public.guard_locked_field_value() from public, anon;
grant execute on function public.guard_locked_field_value() to authenticated;

create trigger task_field_values_02_field_lock
  before insert or update on public.task_field_values
  for each row execute function public.guard_locked_field_value();

-- 51.5 Rules: Set field on a locked field is skipped (logged, the run goes on) unless the rule's owner
-- is an Owner or Admin of the field's project.
select public.alhc_patch_function(
  'public.execute_rule_actions(public.rules, uuid, jsonb, jsonb)'::regprocedure,
  $old$          elsif field.bound_to_sections then
            -- The section-bound Status field IS the section: setting it moves the task, nothing is stored.$old$,
  $new$          elsif field.locked and not public.rule_owner_manages_project(r.id, field.project_id) then
            outcome := 'locked';
            result := 'Skipped: “' || field.name || '” is locked, and only project Owners and Admins change it. '
              || 'This rule''s owner isn''t one.';
          elsif field.bound_to_sections then
            -- The section-bound Status field IS the section: setting it moves the task, nothing is stored.$new$,
  $old$          if field.id is not null then
            result := case when outcome = 'unchanged'$old$,
  $new$          if field.id is not null and outcome <> 'locked' then
            result := case when outcome = 'unchanged'$new$,
  -- Apply task template: the template's values of locked fields are left out the same way (the step
  -- itself still runs), and the run log says how many and why.
  $old$                if found then counts[3] := counts[3] + 1; end if;
              exception when others then$old$,
  $new$                if found then counts[3] := counts[3] + 1; end if;
              exception when insufficient_privilege then
                if sqlerrm like 'Locked%' then
                  counts[4] := coalesce(counts[4], 0) + 1;
                end if;
              when others then$new$,
  $old$|| counts[3] || ' field values';$old$,
  $new$|| counts[3] || ' field values'
              || case when coalesce(counts[4], 0) > 0
                then ' (' || counts[4] || ' locked field value' || case when counts[4] = 1 then '' else 's' end
                  || ' left out: only project Owners and Admins change locked fields, and this rule''s owner isn''t one)'
                else '' end;$new$
);

-- 51.5b Duplicate task counts a value as left out only when the copy ended up without it: a shared
-- library field's value refused through one project (locked, the caller isn't its Admin there) can still
-- reach the copy through another project that holds it, where the caller may set it.
select public.alhc_patch_function(
  'public.duplicate_task(uuid, jsonb)'::regprocedure,
  $old$        skipped_fields := skipped_fields + 1;
      end;
    end loop;
  end if;$old$,
  $new$        skipped_fields := skipped_fields + 1;
      end;
    end loop;
    if skipped_fields > 0 then
      skipped_fields := (
        select count(*)::integer from public.task_field_values v
        join public.custom_fields f on f.id = v.field_id and f.deleted_at is null and not f.bound_to_sections
        where v.task_id = src.id and v.value is not null and jsonb_typeof(v.value) <> 'null'
          and not exists (
            select 1 from public.task_field_values c
            where c.task_id = created and c.field_id = v.field_id and c.value is not distinct from v.value
          )
      );
    end if;
  end if;$new$
);

-- 51.6 Bulk Field: a locked field's tasks are skipped with the reason (below Owner / Admin).
select public.alhc_patch_function(
  'public.bulk_update_tasks(uuid[], jsonb)'::regprocedure,
  $old$reason := 'It isn’t in the field’s project';$old$,
  $new$reason := 'It isn’t in the field’s project';
            elsif exists (select 1 from public.custom_fields lf where lf.id = arg_field and lf.locked)
                  and not public.has_project_role(arg_project, 'admin') then
              outcome := 'skipped';
              reason := 'Locked — only project Owners and Admins can change this field';$new$
);

-- 51.7 Templates and Duplicate project keep the lock (instantiate_project_snapshot sets it: see 55.8).
select public.alhc_patch_function(
  'public.project_snapshot(uuid, jsonb)'::regprocedure,
  $old$'bound_to_sections', f.bound_to_sections, 'show_in_views', f.show_in_views$old$,
  $new$'bound_to_sections', f.bound_to_sections, 'show_in_views', f.show_in_views, 'locked', f.locked$new$
);

-- ---------------------------------------------------------------------------------------------------
-- 55.9 (continued) Link the existing copies, now that every definition column exists.
-- ---------------------------------------------------------------------------------------------------
do $do$
declare
  result jsonb := public.link_library_field_copies();
begin
  raise notice 'Field library: linked % existing copies, filled % values, recorded % conflicts (library_field_link_conflicts), left % ambiguous fields alone',
    result ->> 'linked', result ->> 'filled', result ->> 'conflicts', result ->> 'ambiguous';
end;
$do$;
