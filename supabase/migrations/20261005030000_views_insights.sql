-- ALHC Projects — Phase: Views & Insights.
-- Saved project views (list / board / calendar) and project dashboard widgets. Both use one filter
-- schema, evaluated by filter_project_tasks() under the caller's RLS. Nothing here is team-specific.
--
-- View config (mirrored by src/lib/views.ts; the browser parser drops invalid parts, the
-- validators below reject them):
-- {
--   "filters": {
--     "completion": "incomplete" | "completed" | "all",       default "incomplete" (= show_completed off)
--     "completed_within_days": 1..3650,                         completed on one of the last N local days;
--                                                               requires completion = "completed"
--     "sections":  [section uuid | null],                       any-of; null = "No section"
--     "assignees": [profile uuid | "me" | null],                any-of; null = unassigned
--     "due": { "kind": "overdue" | "today" | "upcoming" | "no_date" | "range",
--              "days"?: 1..365 (upcoming, default 7), "from"?: date, "to"?: date (range) },
--     "fields": [{ "field_id": uuid, "op": "in" | "equals" | "empty" | "not_empty",
--                  "values"?: [option/profile/section id], "value"?: scalar }],      all must match
--     "text": string                                            title or notes contains (case-insensitive)
--   },
--   "sort":     [{ "key": "manual" | "due" | "title" | "created" | "assignee" | "field:<uuid>",
--                  "dir": "asc" | "desc" }],                    max 3, default manual (board/list order)
--   "group_by": "section" | "assignee" | "none" | "field:<uuid>" (single-select), default "section"
--   "columns":  ["assignee" | "due" | "section" | "field:<uuid>"]   List columns and Board card
--                                                                   fields; absent = assignee, due,
--                                                                   and fields pinned with show_in_views
-- }
-- "Overdue" means due before the viewer's local today and still incomplete. "Today", "upcoming",
-- and "completed_within_days" use the viewer's IANA time zone (falls back to UTC).

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.safe_timezone(tz text)
returns text
language plpgsql
stable
set search_path = ''
as $$
begin
  if tz is null or tz = '' then
    return 'UTC';
  end if;
  perform now() at time zone tz;
  return tz;
exception when others then
  return 'UTC';
end;
$$;

revoke all on function public.safe_timezone(text) from public, anon;
grant execute on function public.safe_timezone(text) to authenticated;

-- A jsonb array, or an empty array for anything else (missing key, null, wrong type).
create or replace function public.view_list(value jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when jsonb_typeof(value) = 'array' then value else '[]'::jsonb end;
$$;

revoke all on function public.view_list(jsonb) from public, anon;
grant execute on function public.view_list(jsonb) to authenticated;

create or replace function public.view_value_is_empty(value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select value is null or value in ('null'::jsonb, '""'::jsonb, '[]'::jsonb, 'false'::jsonb);
$$;

revoke all on function public.view_value_is_empty(jsonb) from public, anon;
grant execute on function public.view_value_is_empty(jsonb) to authenticated;

-- One custom-field condition against one task. A section-bound Status field has no stored value:
-- it compares the task's section in the field's project instead.
create or replace function public.view_field_matches(
  field_type text,
  bound_to_sections boolean,
  task_section uuid,
  value jsonb,
  cond jsonb
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    case
      when bound_to_sections then
        case cond ->> 'op'
          when 'empty' then task_section is null
          when 'not_empty' then task_section is not null
          when 'in' then task_section is not null
            and public.view_list(cond -> 'values') @> jsonb_build_array(task_section)
          when 'equals' then task_section::text = cond ->> 'value'
          else true
        end
      else
        case cond ->> 'op'
          when 'empty' then public.view_value_is_empty(value)
          when 'not_empty' then not public.view_value_is_empty(value)
          when 'in' then
            case jsonb_typeof(value)
              when 'array' then exists (
                select 1 from jsonb_array_elements(value) element
                where public.view_list(cond -> 'values') @> jsonb_build_array(element)
              )
              when 'string' then public.view_list(cond -> 'values') @> jsonb_build_array(value)
              else false
            end
          when 'equals' then
            case field_type
              when 'text' then lower(value #>> '{}') = lower(cond ->> 'value')
              when 'boolean' then coalesce(value, 'false'::jsonb) = coalesce(cond -> 'value', 'true'::jsonb)
              else value = cond -> 'value'
            end
          else true
        end
    end,
    false
  );
$$;

revoke all on function public.view_field_matches(text, boolean, uuid, jsonb, jsonb) from public, anon;
grant execute on function public.view_field_matches(text, boolean, uuid, jsonb, jsonb) to authenticated;

create or replace function public.is_iso_date(value text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if value is null or value !~ '^\d{4}-\d{2}-\d{2}$' then
    return false;
  end if;
  perform value::date;
  return true;
exception when others then
  return false;
end;
$$;

revoke all on function public.is_iso_date(text) from public, anon;
grant execute on function public.is_iso_date(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Filtering + metrics (SECURITY INVOKER: RLS on tasks/task_projects applies)
-- ---------------------------------------------------------------------------

create or replace function public.filter_project_tasks(
  target_project uuid,
  filters jsonb default '{}'::jsonb,
  tz text default 'UTC'
)
returns table (
  task_id uuid,
  section_id uuid,
  assignee_id uuid,
  due_on date,
  completed_at timestamptz
)
language sql
stable
set search_path = ''
as $$
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
$$;

revoke all on function public.filter_project_tasks(uuid, jsonb, text) from public, anon;
grant execute on function public.filter_project_tasks(uuid, jsonb, text) to authenticated;

comment on function public.filter_project_tasks(uuid, jsonb, text) is
  'Tasks of a project matching a view filter (see the schema at the top of 20261005030000_views_insights.sql). '
  'Shared by List, Board, Calendar, and dashboard widgets.';

-- Task counts for a dashboard widget: one row per bucket (section id or assignee id; null bucket =
-- "No section" / "Unassigned", or the whole total when group_by = 'none'). Empty buckets are omitted.
create or replace function public.project_metrics(
  target_project uuid,
  filters jsonb default '{}'::jsonb,
  group_by text default 'none',
  tz text default 'UTC'
)
returns table (bucket uuid, task_count bigint)
language sql
stable
set search_path = ''
as $$
  select
    case group_by when 'section' then f.section_id when 'assignee' then f.assignee_id end as bucket,
    count(*) as task_count
  from public.filter_project_tasks(target_project, filters, tz) f
  group by 1;
$$;

revoke all on function public.project_metrics(uuid, jsonb, text, text) from public, anon;
grant execute on function public.project_metrics(uuid, jsonb, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Validation
-- ---------------------------------------------------------------------------

create or replace function public.validate_view_filters(target_project uuid, filters jsonb)
returns void
language plpgsql
stable
set search_path = ''
as $$
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
    where k not in ('completion', 'completed_within_days', 'sections', 'assignees', 'due', 'fields', 'text')
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

  if filters ? 'text' and (jsonb_typeof(filters -> 'text') <> 'string' or length(filters ->> 'text') > 200) then
    raise exception 'Search text is limited to 200 characters' using errcode = 'check_violation';
  end if;
end;
$$;

revoke all on function public.validate_view_filters(uuid, jsonb) from public, anon;
grant execute on function public.validate_view_filters(uuid, jsonb) to authenticated;

-- 'field:<uuid>' → that field when it belongs to the project.
create or replace function public.view_field_ref(target_project uuid, ref text)
returns public.custom_fields
language sql
stable
set search_path = ''
as $$
  select public.rule_field(target_project, substr(ref, 7)) where ref like 'field:%';
$$;

revoke all on function public.view_field_ref(uuid, text) from public, anon;
grant execute on function public.view_field_ref(uuid, text) to authenticated;

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
        ref in ('manual', 'due', 'title', 'created', 'assignee')
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
        ref in ('assignee', 'due', 'section') or (public.view_field_ref(target_project, ref)).id is not null
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
-- Saved views
-- ---------------------------------------------------------------------------

create table public.project_views (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  name text not null check (length(trim(name)) between 1 and 100),
  layout text not null check (layout in ('list', 'board', 'calendar')),
  config jsonb not null default '{}'::jsonb,
  sort_order double precision not null default 0,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index project_views_project_order_idx
  on public.project_views (project_id, sort_order)
  where deleted_at is null;
create index project_views_created_by_idx on public.project_views (created_by);

create trigger project_views_set_updated_at
  before update on public.project_views
  for each row execute function public.set_updated_at();

create or replace function public.validate_project_view()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.project_id <> old.project_id then
    raise exception 'A view cannot move to another project' using errcode = 'check_violation';
  end if;
  perform public.validate_view_config(new.project_id, new.config);
  return new;
end;
$$;

create trigger project_views_validate
  before insert or update of project_id, config on public.project_views
  for each row execute function public.validate_project_view();

-- Every project starts with List, Board, and Calendar views on the default config.
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
    (new.id, 'Calendar', 'calendar', 3072, new.created_by);
  return new;
end;
$$;

revoke all on function public.create_default_project_views() from public, anon, authenticated;

create trigger projects_create_default_views
  after insert on public.projects
  for each row execute function public.create_default_project_views();

insert into public.project_views (project_id, name, layout, sort_order, created_by)
select p.id, v.name, v.layout, v.sort_order, p.created_by
from public.projects p
cross join (values ('List', 'list', 1024), ('Board', 'board', 2048), ('Calendar', 'calendar', 3072))
  as v (name, layout, sort_order);

-- ---------------------------------------------------------------------------
-- Dashboard widgets (fixed project Dashboard tab)
-- ---------------------------------------------------------------------------

create table public.dashboard_widgets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  kind text not null check (kind in ('count', 'by_section', 'by_assignee')),
  title text not null check (length(trim(title)) between 1 and 100),
  filters jsonb not null default '{}'::jsonb,
  sort_order double precision not null default 0,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index dashboard_widgets_project_order_idx
  on public.dashboard_widgets (project_id, sort_order)
  where deleted_at is null;
create index dashboard_widgets_created_by_idx on public.dashboard_widgets (created_by);

create trigger dashboard_widgets_set_updated_at
  before update on public.dashboard_widgets
  for each row execute function public.set_updated_at();

create or replace function public.validate_dashboard_widget()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.project_id <> old.project_id then
    raise exception 'A widget cannot move to another project' using errcode = 'check_violation';
  end if;
  perform public.validate_view_filters(new.project_id, new.filters);
  return new;
end;
$$;

create trigger dashboard_widgets_validate
  before insert or update of project_id, filters on public.dashboard_widgets
  for each row execute function public.validate_dashboard_widget();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.project_views enable row level security;
alter table public.dashboard_widgets enable row level security;

create policy project_views_select_allowlisted on public.project_views
  for select to authenticated using ((select public.is_allowlisted()));
create policy project_views_insert_allowlisted on public.project_views
  for insert to authenticated with check ((select public.is_allowlisted()));
create policy project_views_update_allowlisted on public.project_views
  for update to authenticated
  using ((select public.is_allowlisted()))
  with check ((select public.is_allowlisted()));

create policy dashboard_widgets_select_allowlisted on public.dashboard_widgets
  for select to authenticated using ((select public.is_allowlisted()));
create policy dashboard_widgets_insert_allowlisted on public.dashboard_widgets
  for insert to authenticated with check ((select public.is_allowlisted()));
create policy dashboard_widgets_update_allowlisted on public.dashboard_widgets
  for update to authenticated
  using ((select public.is_allowlisted()))
  with check ((select public.is_allowlisted()));
