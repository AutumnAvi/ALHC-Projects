-- ALHC Projects — Oct 19 test notes (fix batch).
--
-- 1. Task numbering settings take effect everywhere. "Wrap the label in brackets" was saved but no
--    screen read it (every label was drawn as "[label]"). Labels stay bare in tasks.req_label; the
--    display rule lives in request_display_label(label, wrap) (mirrored by formatRequestLabel() in
--    src/lib/request-numbers.ts), and task_request_labels(task ids) hands the app each visible task's
--    { label, wrap } in one call (invoker: RLS decides, a POST body so max_rows can't cut it).
--    task_request_display_label(task) is the same rule for one task. Same class of bug, also fixed:
--    allocate_request_number's ON CONFLICT was ambiguous with its own parameter names, so a yearly /
--    monthly reset made every new task fail and a per-field counter made field writes fail;
--    "Number subtasks" off now hides subtask labels (like "enabled" hides all of them) and turning it
--    back on with Save numbers the subtasks made meanwhile; a {parent} template is current after one
--    save (top-level labels first, then each subtask depth); a sequence apply_task_numbering creates
--    never bakes labels into titles; Duplicate project and project templates keep every numbering
--    setting; email_design_context tells the drain the issuing project's bracket setting.
--    Tokens and payloads stay bare on purpose: the webhook "req", Slack {req}, the email fill-in
--    {request_number}, submit_form's request_label, and the inbound response.
--
-- No new SECURITY DEFINER function for clients (suite 60 unchanged); the new functions are invoker or
-- immutable helpers, revoked from anon. fire_rules, notify_with, notify_message, and add_story are
-- untouched. Additive: the release on main never calls the new functions, and every patched function
-- keeps its signature and grants.

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

-- =============================================================================================
-- 1. Task numbering labels and settings
-- =============================================================================================

-- The counter row's conflict target named columns that are also this function's parameters
-- (period_key, counter_key): "column reference is ambiguous" on every task created under a reset
-- period or a per-field counter. Name the constraint instead.
select public.alhc_patch_function(
  'public.allocate_request_number(uuid, text, text)'::regprocedure,
  $p$  on conflict (project_id, period_key, counter_key) do nothing;$p$,
  $p$  on conflict on constraint request_counters_key do nothing;$p$
);

-- How a label is shown in front of a task name: "[Task #3]" or "Task #3".
create or replace function public.request_display_label(label text, wrap boolean)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when label is null or btrim(label) = '' then null
    when coalesce(wrap, true) then '[' || label || ']'
    else label
  end;
$$;

revoke all on function public.request_display_label(text, boolean) from public, anon;
grant execute on function public.request_display_label(text, boolean) to authenticated, service_role;

-- "Number subtasks" off hides the subtask labels already stored, the way "enabled" hides every label.
select public.alhc_patch_function(
  'public.task_request_label(uuid)'::regprocedure,
  $p$select case when s.enabled then public.compose_request_label(t.id) else null end$p$,
  $p$select case when s.enabled and (t.parent_task_id is null or s.number_subtasks) then public.compose_request_label(t.id) else null end$p$
);

create or replace function public.task_request_display_label(target_task uuid)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select public.request_display_label(public.task_request_label(t.id), s.wrap_brackets)
  from public.tasks t
  join public.request_sequences s
    on s.project_id = coalesce(t.req_project_id, t.home_project_id)
   and s.deleted_at is null
  where t.id = target_task;
$$;

revoke all on function public.task_request_display_label(uuid) from public, anon;
grant execute on function public.task_request_display_label(uuid) to authenticated, service_role;

-- Every app surface reads labels here: { "<task id>": { "label": "Task #3", "wrap": false } } for
-- the tasks the caller can read whose numbering is on (subtasks only while "Number subtasks" is on).
-- Invoker, so RLS on tasks and request_sequences decides exactly as before. At most 5,000 ids a call.
create or replace function public.task_request_labels(task_ids uuid[])
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    jsonb_object_agg(t.id, jsonb_build_object('label', t.req_label, 'wrap', s.wrap_brackets)),
    '{}'::jsonb
  )
  from public.tasks t
  join public.request_sequences s
    on s.project_id = coalesce(t.req_project_id, t.home_project_id)
   and s.deleted_at is null
   and s.enabled
  where t.id = any (task_ids[1:5000])
    and t.req_label is not null
    and (t.parent_task_id is null or s.number_subtasks);
$$;

revoke all on function public.task_request_labels(uuid[]) from public, anon;
grant execute on function public.task_request_labels(uuid[]) to authenticated;

-- apply_task_numbering: a sequence it creates never bakes labels into titles (the column default is
-- the old behavior, kept for the older paths); a save relabels top-level tasks first, then each
-- subtask depth, so {parent} is current after one save; and with "Number subtasks" on, a save gives
-- indexes to subtasks made while it was off (it still never hands out new top-level numbers).
select public.alhc_patch_function(
  'public.apply_task_numbering(uuid, jsonb, text)'::regprocedure,
  $p$  insert into public.request_sequences (project_id, enabled)
  values (target_project, false)$p$,
  $p$  insert into public.request_sequences (project_id, enabled, add_to_title)
  values (target_project, false, false)$p$,
  $p$    update public.tasks t
    set req_label = public.compose_request_label(t.id)
    where t.deleted_at is null and t.home_project_id = target_project
      and (t.req_number is not null or t.req_subindex is not null);
    numbered := 0;$p$,
  $p$    if seq.enabled and seq.number_subtasks then
      for numbered in 1..4 loop
        with kids as (
          select c.id,
                 coalesce((
                   select max(s.req_subindex) from public.tasks s
                   where s.parent_task_id = c.parent_task_id and s.deleted_at is null and s.req_subindex is not null
                 ), 0) + row_number() over (
                   partition by c.parent_task_id
                   order by c.subtask_order, c.created_at, c.id
                 ) as idx
          from public.tasks c
          join public.tasks p on p.id = c.parent_task_id
          where c.deleted_at is null
            and c.home_project_id = target_project
            and c.req_subindex is null
            and p.req_path is not null
            and p.deleted_at is null
        )
        update public.tasks t
        set req_subindex = k.idx
        from kids k
        where t.id = k.id;
        update public.tasks c
        set req_path = p.req_path || seq.subtask_separator || c.req_subindex::text
        from public.tasks p
        where c.parent_task_id = p.id
          and c.req_subindex is not null
          and c.deleted_at is null
          and p.req_path is not null
          and c.home_project_id = target_project;
      end loop;
    end if;
    update public.tasks t
    set req_label = public.compose_request_label(t.id)
    where t.deleted_at is null
      and t.parent_task_id is null
      and t.req_number is not null
      and (t.home_project_id = target_project or t.req_project_id = target_project);
    for numbered in 1..4 loop
      update public.tasks c
      set req_label = public.compose_request_label(c.id)
      where c.deleted_at is null
        and c.req_subindex is not null
        and c.home_project_id = target_project
        and char_length(c.req_path) - char_length(replace(c.req_path, seq.subtask_separator, '')) = numbered;
    end loop;
    numbered := 0;$p$
);

-- Duplicate project and project templates keep every numbering setting (they kept only the legacy
-- prefix / padding / scope before). Section and field references are remapped once those exist.
select public.alhc_patch_function(
  'public.project_snapshot(uuid, jsonb)'::regprocedure,
  $p$      select jsonb_build_object('enabled', rs.enabled, 'prefix', rs.prefix, 'pad_width', rs.pad_width,
        'add_to_title', rs.add_to_title, 'assign_to', rs.assign_to)$p$,
  $p$      select jsonb_build_object('enabled', rs.enabled, 'prefix', rs.prefix, 'pad_width', rs.pad_width,
        'add_to_title', rs.add_to_title, 'assign_to', rs.assign_to,
        'template', rs.template, 'wrap_brackets', rs.wrap_brackets, 'number_subtasks', rs.number_subtasks,
        'subtask_separator', rs.subtask_separator, 'number_scope', rs.number_scope,
        'section_ids', to_jsonb(rs.section_ids), 'task_kinds', to_jsonb(rs.task_kinds),
        'reset_period', rs.reset_period, 'counter_field_id', rs.counter_field_id,
        'project_code', rs.project_code, 'renumber_on_move', rs.renumber_on_move,
        'time_zone', rs.time_zone, 'reuse_deleted', rs.reuse_deleted, 'fill_gaps', rs.fill_gaps,
        'start_number', rs.start_number)$p$
);

select public.alhc_patch_function(
  (select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'instantiate_project_snapshot'),
  $p$  if jsonb_typeof(snapshot -> 'request_sequence') = 'object' then
    insert into public.request_sequences (project_id, enabled, prefix, pad_width, add_to_title, assign_to)
    values (
      new_project,
      coalesce((snapshot #>> '{request_sequence,enabled}')::boolean, true),
      left(coalesce(snapshot #>> '{request_sequence,prefix}', 'Req #'), 20),
      least(greatest(coalesce((snapshot #>> '{request_sequence,pad_width}')::smallint, 0), 0), 8),
      coalesce((snapshot #>> '{request_sequence,add_to_title}')::boolean, true),
      case when snapshot #>> '{request_sequence,assign_to}' = 'all_tasks' then 'all_tasks' else 'form_submissions' end
    );
  end if;$p$,
  $p$  if jsonb_typeof(snapshot -> 'request_sequence') = 'object' then
    insert into public.request_sequences (
      project_id, enabled, prefix, pad_width, add_to_title, assign_to,
      template, wrap_brackets, number_subtasks, subtask_separator, number_scope, task_kinds,
      reset_period, project_code, renumber_on_move, time_zone, reuse_deleted, fill_gaps, start_number
    )
    values (
      new_project,
      coalesce((snapshot #>> '{request_sequence,enabled}')::boolean, true),
      left(coalesce(snapshot #>> '{request_sequence,prefix}', 'Req #'), 20),
      least(greatest(coalesce((snapshot #>> '{request_sequence,pad_width}')::smallint, 0), 0), 8),
      coalesce((snapshot #>> '{request_sequence,add_to_title}')::boolean, true),
      case when snapshot #>> '{request_sequence,assign_to}' = 'all_tasks' then 'all_tasks' else 'form_submissions' end,
      coalesce(nullif(snapshot #>> '{request_sequence,template}', ''), 'Req #{n}'),
      coalesce((snapshot #>> '{request_sequence,wrap_brackets}')::boolean, true),
      coalesce((snapshot #>> '{request_sequence,number_subtasks}')::boolean, true),
      case when snapshot #>> '{request_sequence,subtask_separator}' in ('.', '-', '/')
        then snapshot #>> '{request_sequence,subtask_separator}' else '.' end,
      -- Sections are remapped below, once they exist.
      case when snapshot #>> '{request_sequence,number_scope}' in ('inherit', 'all_tasks', 'form_submissions', 'kinds')
        then snapshot #>> '{request_sequence,number_scope}' else 'inherit' end,
      coalesce(
        (select array_agg(x) from jsonb_array_elements_text(
          case when jsonb_typeof(snapshot #> '{request_sequence,task_kinds}') = 'array'
            then snapshot #> '{request_sequence,task_kinds}' else '[]'::jsonb end) x
         where x in ('task', 'milestone', 'approval')),
        array['task', 'milestone', 'approval']
      ),
      case when snapshot #>> '{request_sequence,reset_period}' in ('never', 'yearly', 'monthly')
        then snapshot #>> '{request_sequence,reset_period}' else 'never' end,
      nullif(snapshot #>> '{request_sequence,project_code}', ''),
      coalesce((snapshot #>> '{request_sequence,renumber_on_move}')::boolean, false),
      coalesce(nullif(snapshot #>> '{request_sequence,time_zone}', ''), 'UTC'),
      coalesce((snapshot #>> '{request_sequence,reuse_deleted}')::boolean, false),
      coalesce((snapshot #>> '{request_sequence,fill_gaps}')::boolean, false),
      greatest(coalesce((snapshot #>> '{request_sequence,start_number}')::bigint, 1), 1)
    );
  end if;$p$,
  $p$  -- Forms (closed until someone opens them; ones that no longer validate are skipped) --------------$p$,
  $p$  -- Numbering scope by section and per-field counters point at this copy's sections and fields. A
  -- reference that doesn't map (or no longer validates) leaves that setting at its default.
  if jsonb_typeof(snapshot -> 'request_sequence') = 'object' then
    begin
      update public.request_sequences rs
      set number_scope = 'sections',
          section_ids = (
            select array_agg((id_map ->> x)::uuid)
            from jsonb_array_elements_text(snapshot #> '{request_sequence,section_ids}') x
            where id_map ? x
          )
      where rs.project_id = new_project
        and snapshot #>> '{request_sequence,number_scope}' = 'sections'
        and jsonb_typeof(snapshot #> '{request_sequence,section_ids}') = 'array'
        and exists (
          select 1 from jsonb_array_elements_text(snapshot #> '{request_sequence,section_ids}') x
          where id_map ? x
        );
    exception when others then
      null;
    end;
    begin
      update public.request_sequences rs
      set counter_field_id = (id_map ->> (snapshot #>> '{request_sequence,counter_field_id}'))::uuid
      where rs.project_id = new_project
        and id_map ? coalesce(snapshot #>> '{request_sequence,counter_field_id}', '');
    exception when others then
      null;
    end;
  end if;

  -- Forms (closed until someone opens them; ones that no longer validate are skipped) --------------$p$
);

-- The drain reads each email's design context at send time: add the issuing project's bracket
-- setting, so the emailed "Task" / "Request" rows follow it like every screen does.
select public.alhc_patch_function(
  'public.email_design_context(uuid)'::regprocedure,
  $p$      'request_number', case when r.id is not null then public.task_request_label(r.id) end,$p$,
  $p$      'request_number', case when r.id is not null then public.task_request_label(r.id) end,
      'request_wrap', coalesce((
        select s.wrap_brackets from public.request_sequences s
        where s.project_id = coalesce(t.req_project_id, t.home_project_id) and s.deleted_at is null
      ), true),$p$
);

-- =============================================================================================
-- Statements that must run last (applied by hand) go after the marker below. None this time.
-- =============================================================================================
-- TAIL
