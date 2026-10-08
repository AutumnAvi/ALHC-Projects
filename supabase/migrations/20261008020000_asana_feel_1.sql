-- ALHC Projects — Phase: Asana feel, batch 1.
-- Mostly UI. The database only gains what the List view needs:
--
--   1. A "tags" column key for saved views. List shows a task's tags in their own column (one of the
--      default columns now), so validate_view_config accepts "tags" in config.columns alongside
--      assignee / due / start / section / field:<uuid>. Mirrored by src/lib/views.ts.
--   2. Column widths per person per project (list_column_widths): a List column's width is dragged to
--      size and remembered for that person in that project on every device. Own rows only (RLS), and a
--      row can only be written for a project the person can read (Viewer+). Written through the invoker
--      RPC set_list_column_widths(target_project, new_widths), an upsert. widths =
--      { "<column key>": <pixels 48..800> }, keys task | assignee | due | start | section | tags |
--      field:<uuid>, at most 60.
--
-- No new SECURITY DEFINER function; suite 60's list is unchanged. Nothing for anon (alhc_revoke_*).
-- fire_rules, notify_with, notify_message, and add_story are untouched. Additive: the release still on
-- main keeps working once this is applied (it never writes a "tags" column or reads the new table).
-- No statement here needs a row- or object-removal keyword, so there is no tail section.

-- ---------------------------------------------------------------------------
-- Patch helper (kept on the hosted project; see AGENTS.md → Conventions)
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
-- Views: a Tags column
-- ---------------------------------------------------------------------------

select public.alhc_patch_function('public.validate_view_config(uuid, jsonb)',
$p$ref in ('assignee', 'due', 'start', 'section') or$p$,
$p$ref in ('assignee', 'due', 'start', 'section', 'tags') or$p$);

-- ---------------------------------------------------------------------------
-- List column widths (per person, per project)
-- ---------------------------------------------------------------------------

create table public.list_column_widths (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null default auth.uid() references public.profiles (id),
  project_id uuid not null references public.projects (id),
  widths jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint list_column_widths_one_per_project unique (profile_id, project_id)
);

comment on table public.list_column_widths is
  'List column widths per person and project (dragged in the List header). Own rows only; written through '
  'set_list_column_widths. widths = { column key: pixels 48..800 }.';

create index list_column_widths_project_idx on public.list_column_widths (project_id);

alter table public.list_column_widths enable row level security;
revoke all on public.list_column_widths from anon, authenticated;
grant select on public.list_column_widths to authenticated;
grant insert (project_id, widths) on public.list_column_widths to authenticated;
grant update (widths) on public.list_column_widths to authenticated;

create policy list_column_widths_select_own on public.list_column_widths
  for select to authenticated
  using (list_column_widths.profile_id = (select auth.uid()));

create policy list_column_widths_insert_own_viewer on public.list_column_widths
  for insert to authenticated
  with check (
    list_column_widths.profile_id = (select auth.uid())
    and (select public.has_project_role(list_column_widths.project_id, 'viewer'))
  );

create policy list_column_widths_update_own_viewer on public.list_column_widths
  for update to authenticated
  using (list_column_widths.profile_id = (select auth.uid()))
  with check (
    list_column_widths.profile_id = (select auth.uid())
    and (select public.has_project_role(list_column_widths.project_id, 'viewer'))
  );

-- The shape of widths, mirrored by src/lib/column-widths.ts.
create or replace function public.validate_list_column_widths(widths jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  entry record;
begin
  if widths is null or jsonb_typeof(widths) <> 'object' then
    raise exception 'Column widths are an object' using errcode = 'check_violation';
  end if;
  if (select count(*) from jsonb_object_keys(widths)) > 60 then
    raise exception 'Too many column widths' using errcode = 'check_violation';
  end if;
  for entry in select key, value from jsonb_each(widths) loop
    if entry.key !~ '^(task|assignee|due|start|section|tags|field:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' then
      raise exception 'Unknown column %', left(entry.key, 60) using errcode = 'check_violation';
    end if;
    if jsonb_typeof(entry.value) <> 'number'
       or (entry.value #>> '{}')::numeric <> trunc((entry.value #>> '{}')::numeric)
       or (entry.value #>> '{}')::numeric not between 48 and 800 then
      raise exception 'A column width is a whole number of pixels from 48 to 800' using errcode = 'check_violation';
    end if;
  end loop;
end;
$$;

select public.alhc_revoke_anon_execute(array['validate_list_column_widths(jsonb)']);
grant execute on function public.validate_list_column_widths(jsonb) to authenticated;

-- Invoker guard: owner and project fixed, owner = the caller on client inserts, widths validated.
create or replace function public.guard_list_column_widths()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.profile_id := auth.uid();
    end if;
    new.created_at := now();
  elsif new.profile_id is distinct from old.profile_id or new.project_id is distinct from old.project_id
        or new.created_at is distinct from old.created_at then
    raise exception 'Column widths can’t be moved' using errcode = 'insufficient_privilege';
  end if;
  perform public.validate_list_column_widths(new.widths);
  new.updated_at := now();
  return new;
end;
$$;

select public.alhc_revoke_anon_execute(array['guard_list_column_widths()']);
grant execute on function public.guard_list_column_widths() to authenticated;

create trigger list_column_widths_05_guard
  before insert or update on public.list_column_widths
  for each row execute function public.guard_list_column_widths();

select public.alhc_revoke_anon_grants(array['list_column_widths']);

-- Upsert the caller's widths for a project (Viewer+; RLS decides). Returns the stored widths.
create or replace function public.set_list_column_widths(target_project uuid, new_widths jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  stored jsonb;
begin
  if not public.has_project_role(target_project, 'viewer') then
    raise exception 'Project not found' using errcode = 'no_data_found';
  end if;
  insert into public.list_column_widths as w (project_id, widths)
  values (target_project, new_widths)
  on conflict (profile_id, project_id) do update set widths = excluded.widths
  returning w.widths into stored;
  return stored;
end;
$$;

select public.alhc_revoke_anon_execute(array['set_list_column_widths(uuid,jsonb)']);
grant execute on function public.set_list_column_widths(uuid, jsonb) to authenticated;
