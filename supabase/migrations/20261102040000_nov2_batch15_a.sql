-- Nov 2 notes, batch 15 (items 107–118): roles, the sidebar, approvals, Timeline, tabs, and views.
-- Additive: one new column, one new invoker guard function, and one asserted patch; nothing is renamed or
-- taken away, and there is no tail. The release still on main never reads the new column or key, and the
-- patched function keeps its signature, its grants, and every key it returned before.
--
-- What the database gains (the app does the rest):
--   * 111 project_task_cards also returns blocker_ids: the visible open tasks that hold up completing each
--     task (the same rows it already counts in blocked_by — tasks the caller can read). Completing one of
--     them in the browser unblocks the row at once instead of after the next refresh.
--   * 117 project_view_settings.hidden_view_ids: the project's shared view tabs (List, Board, Calendar,
--     Timeline, …) hidden for everyone, next to hidden_tabs (Overview, Dashboard, Messages, Workload,
--     Files). Editors+ (the existing policies); the invoker guard keeps only this project's live shared
--     views, once each, at most 200.
-- No new client SECURITY DEFINER function (suite 60 unchanged); nothing for anon. fire_rules, notify_with,
-- notify_message, and add_story are untouched.

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

-- ---------------------------------------------------------------------------------------------
-- 111 Blocker ids on project cards
-- ---------------------------------------------------------------------------------------------

select public.alhc_patch_function('public.project_task_cards(uuid, uuid[])'::regprocedure,
$p$    select d.successor_id as task_id, count(*)::integer as blocked_by
$p$,
$p$    select d.successor_id as task_id, count(*)::integer as blocked_by, array_agg(d.predecessor_id) as blocker_ids
$p$,
$p$      'blocked_by', coalesce(b.blocked_by, 0),
$p$,
$p$      'blocked_by', coalesce(b.blocked_by, 0),
      'blocker_ids', coalesce(to_jsonb(b.blocker_ids), '[]'::jsonb),
$p$
);

-- ---------------------------------------------------------------------------------------------
-- 117 Hidden view tabs
-- ---------------------------------------------------------------------------------------------

alter table public.project_view_settings
  add column if not exists hidden_view_ids uuid[] not null default '{}';

grant insert (hidden_view_ids) on public.project_view_settings to authenticated;
grant update (hidden_view_ids) on public.project_view_settings to authenticated;

comment on column public.project_view_settings.hidden_view_ids is
  'Nov 2 notes (batch 15, 117): shared view tabs hidden for everyone (Editors+); shown again from Customize → Tabs.';

create or replace function public.guard_project_view_hidden_views()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.hidden_view_ids is not distinct from old.hidden_view_ids then
    return new;
  end if;
  select coalesce(array_agg(distinct v.id order by v.id), '{}') into new.hidden_view_ids
  from public.project_views v
  where v.id = any (coalesce(new.hidden_view_ids, '{}'))
    and v.project_id = new.project_id
    and v.owner_id is null
    and v.deleted_at is null;
  if cardinality(new.hidden_view_ids) > 200 then
    raise exception 'At most 200 hidden tabs' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function public.guard_project_view_hidden_views() is
  'Nov 2 notes (batch 15, 117): keeps project_view_settings.hidden_view_ids to this project''s live shared views, once each.';

select public.alhc_revoke_anon_execute(array['guard_project_view_hidden_views()']);
grant execute on function public.guard_project_view_hidden_views() to authenticated;

create trigger project_view_settings_06_hidden_views
  before insert or update on public.project_view_settings
  for each row execute function public.guard_project_view_hidden_views();
