-- ALHC Projects — Phase: Timeline.
-- Task start dates (tasks.start_on), the `timeline` saved-view layout, the `start` sort/column key
-- in the shared view config, and EXECUTE hardening for SECURITY DEFINER trigger functions.
--
-- Date semantics (Timeline consumes start + due; Calendar and every filter stay on due_on):
--   start_on + due_on   bar from start_on through due_on (inclusive); start_on <= due_on is enforced
--   due_on only         one-day bar on the due day
--   start_on only       one-day bar on the start day, drawn open-ended (no due date yet)
--   neither             "Unscheduled" tray (incomplete tasks only), never a bar

-- ---------------------------------------------------------------------------
-- Start dates
-- ---------------------------------------------------------------------------

alter table public.tasks add column start_on date;
alter table public.tasks add constraint tasks_start_on_before_due_on
  check (start_on is null or due_on is null or start_on <= due_on);

comment on column public.tasks.start_on is
  'Optional first day of work. Must be on or before due_on when both are set. Used by Timeline only.';

alter table public.task_stories drop constraint task_stories_kind_check;
alter table public.task_stories add constraint task_stories_kind_check check (kind in (
  'created', 'completed', 'reopened', 'renamed', 'assigned', 'unassigned', 'due_changed', 'start_changed',
  'section_changed', 'project_added', 'project_removed', 'attachment_added', 'field_changed',
  'deleted', 'approval_requested', 'approval_decided', 'approval_cancelled', 'approval_resubmitted',
  'form_submitted', 'request_number_assigned', 'email_queued'
));

-- Same pattern as due_changed in on_task_update_collab(): one story per change with from/to dates.
create or replace function public.on_task_start_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is null and new.start_on is distinct from old.start_on then
    perform public.add_story(new.id, 'start_changed', jsonb_build_object('from', old.start_on, 'to', new.start_on));
  end if;
  return new;
end;
$$;

revoke all on function public.on_task_start_change() from public, anon, authenticated;

create trigger tasks_after_update_start
  after update of start_on on public.tasks
  for each row execute function public.on_task_start_change();

-- ---------------------------------------------------------------------------
-- View config: `start` joins the sort keys and the List/Board column keys
-- ---------------------------------------------------------------------------
--   sort:    [{ "key": "manual" | "due" | "start" | "title" | "created" | "assignee" | "field:<uuid>", ... }]
--   columns: ["assignee" | "due" | "start" | "section" | "field:<uuid>"]
-- Everything else in the schema at the top of 20261005030000_views_insights.sql is unchanged.

create or replace function public.validate_view_config(target_project uuid, config jsonb)
returns void
language plpgsql
stable
set search_path = ''
as $$
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
    if ref not in ('section', 'assignee', 'none') then
      field := public.view_field_ref(target_project, ref);
      if field.id is null or field.field_type <> 'single_select' then
        raise exception 'Group by a section, assignee, or single-select field of this project'
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
$$;

revoke all on function public.validate_view_config(uuid, jsonb) from public, anon;
grant execute on function public.validate_view_config(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Timeline layout + default views
-- ---------------------------------------------------------------------------

alter table public.project_views drop constraint project_views_layout_check;
alter table public.project_views add constraint project_views_layout_check
  check (layout in ('list', 'board', 'calendar', 'timeline'));

-- New projects get List, Board, Calendar, and Timeline views on the default config.
create or replace function public.create_default_project_views()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.project_views (project_id, name, layout, sort_order, created_by)
  values
    (new.id, 'List', 'list', 1024, new.created_by),
    (new.id, 'Board', 'board', 2048, new.created_by),
    (new.id, 'Calendar', 'calendar', 3072, new.created_by),
    (new.id, 'Timeline', 'timeline', 4096, new.created_by);
  return new;
end;
$$;

revoke all on function public.create_default_project_views() from public, anon, authenticated;

-- Existing projects get one Timeline view after their current last tab.
insert into public.project_views (project_id, name, layout, sort_order, created_by)
select
  p.id,
  'Timeline',
  'timeline',
  coalesce((select max(v.sort_order) from public.project_views v
            where v.project_id = p.id and v.deleted_at is null), 0) + 1024,
  p.created_by
from public.projects p
where not exists (
  select 1 from public.project_views v
  where v.project_id = p.id and v.layout = 'timeline' and v.deleted_at is null
);

-- ---------------------------------------------------------------------------
-- Hardening: trigger functions are never client RPCs
-- ---------------------------------------------------------------------------
-- Supabase's default privileges grant EXECUTE on new functions to anon and authenticated. Trigger
-- functions can't be invoked directly and Postgres doesn't check EXECUTE when a trigger fires, so
-- revoking it changes nothing at runtime; it just keeps SECURITY DEFINER code off the API surface.
-- Intentional RPCs keep their grants (anon: get_public_form, submit_form; authenticated: the
-- approval/request-number/form RPCs and is_allowlisted()).

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
