-- ALHC Projects — Oct 29 notes, batch 7 (items 52, 53, 47, 54, 49, 48, 55, 51, 55b; item 50, formula
-- fields, is parked and not built).
--
-- One migration, built from four parallel tracks in this order (each section below starts with its own
-- notes):
--   T1  52. Only an approval task's approvers complete it (the bug: any Editor could tick one before
--           "Ready for approval"). guard_task_kind refuses everyone else, rules' Mark complete steps skip
--           approval tasks, and rows learn whether the viewer approves (task_approval_states,
--           project_task_cards.approval_is_approver). Once the task's latest round is approved, the
--           approval has been given and the task completes normally again (anyone who can edit it;
--           rules too) — approval_round_approved().
--       53. List header alignment: app only, no SQL.
--   T2  47. Select fields need at least one option (people's writes; system paths unchanged).
--       54. A 20-color palette (option_colors()); tags keep the picked color in tags.palette_color.
--       49. Number field symbol (custom_fields / portfolio_fields.number_prefix, format_number_value()).
--       48. Long text editor: app only (the 10,000-character limit is pinned by the suite).
--   T3  55. Library fields are shared across projects: placements (custom_fields.library_field_id) with
--           one definition (library_field_definition_columns(), number_prefix included) and one value
--           per task; add_library_field and project_field_sharing (client definers, pinned in suite 60);
--           existing clear copies are linked once (library_field_links, library_field_link_conflicts).
--       51. Field lock (custom_fields.locked / locked_by / locked_at): values, definition, and removal
--           for the project's Owners and Admins; rules only while their owner is one.
--   T4  55b. No home project in the UI: tasks.home_project_id stays an internal pointer the database
--           keeps on one of the task's active projects; removing the task's last project is refused;
--           links, labels, and emails follow the stable rule (the first project the task was added to);
--           task_project_labels returns every number a viewer may read.
--
-- New client SECURITY DEFINER functions (suite 60): add_library_field, project_field_sharing. Nothing new
-- for anon. After it's applied, the field library's linking step reports its counts in a NOTICE; read
-- the details with `select * from public.library_field_links;` and
-- `select * from public.library_field_link_conflicts;`.
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


-- =================================================================================================
-- Track T1: 52. Only approvers complete an approval task
-- =================================================================================================

-- 52. Only approvers approve or complete an approval task (BUG: before "Ready for approval" any Editor
--     could tick an approval task complete; the guard only refused it while a round was pending).

-- ---------------------------------------------------------------------------------------------------
-- 52. Only approvers approve or complete an approval task.
--
--   * A person (client role) may complete a task of kind 'approval' (top-level or subtask) — its
--     completed_at going from null to a value, or a new row inserted complete — only while they are one
--     of its active approvers (task_approvers). While a round is pending nobody ticks it complete: an
--     approver whose decision is still open is told to Approve (the decision path), everyone else that
--     it's waiting for approval. With no approvers nobody completes it by hand. A statement that switches
--     an approval task to another type and completes it at once is checked the same way.
--   * Once the task's LATEST round is approved (e.g. approved with "More steps after approval", so the
--     round didn't complete it), the approval has been given: the task completes normally again — anyone
--     who can edit it, and rules' Mark complete steps (approval_round_approved(), invoker). Until then
--     (no round, pending, changes requested, rejected, withdrawn, paused) the approver-only rule holds.
--   * Rules never complete approval tasks before that: the rule engine's "Mark complete" step (and
--     "Convert to a project … and complete the task", and My Tasks rules' "Mark complete") skip them with
--     a logged reason instead of failing the run; the guard refuses a completion in rule context as a
--     backstop.
--   * System paths keep working: an approved round (finish_approved_round, which names its task in the
--     transaction-local alhc.approval_finish), the older approval_completes_task / complete_approval_task
--     decisions, imports, copies (templates, Duplicate project), and recurrence (definer code, not a
--     client role). Reopening is unchanged.
--   * bulk_update_tasks needs no change: the guard's message is its skip reason ("Only its approvers can
--     complete an approval task. Send it with Ready for approval."), and it lets an approved one through.
--   * Rows learn whether the viewer approves the task: project_task_cards adds approval_is_approver,
--     task_approval_state adds is_approver, and task_approval_states (invoker) returns the state of many
--     approval tasks at once (My tasks rows, subtask rows).
-- ---------------------------------------------------------------------------------------------------

-- Whether the task's latest approval round is approved (the approval has been given). Invoker: the guard
-- runs as the person (an Editor reads the task's rounds through RLS); definer callers read every round.
create or replace function public.approval_round_approved(target_task uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select r.status = 'approved'
    from public.approval_rounds r
    where r.task_id = target_task
    order by r.round_number desc
    limit 1
  ), false);
$$;

revoke all on function public.approval_round_approved(uuid) from public, anon;
grant execute on function public.approval_round_approved(uuid) to authenticated, service_role;
select public.alhc_revoke_anon_execute(array['approval_round_approved(uuid)']);

select public.alhc_patch_function(
  'public.guard_task_kind()'::regprocedure,
  $old$  if tg_op = 'UPDATE'
     and public.is_client_role()
     and new.kind = 'approval'
     and old.completed_at is null and new.completed_at is not null
     and exists (
       select 1 from public.approval_rounds r where r.task_id = new.id and r.status = 'pending'
     ) then
    raise exception 'This task is waiting for approval. Withdraw the request first, or wait for the approver'
      using errcode = 'check_violation';
  end if;$old$,
  $new$  -- Oct 29 notes, batch 7 (item 52): only an approval task's approvers complete it by hand, never
  -- while a round is pending, and rules never do — also when the same statement switches it to another
  -- type — until its latest round is approved (the approval has been given: then anyone who can edit
  -- it, rules too). Imports, copies, and an approved round (which names its task in
  -- alhc.approval_finish) aren't checked; other system code isn't a client role.
  if (new.kind = 'approval' or (tg_op = 'UPDATE' and old.kind = 'approval'))
     and new.completed_at is not null
     and (tg_op = 'INSERT' or old.completed_at is null)
     and public.import_context_id() is null
     and public.copy_context_id() is null
     and coalesce(current_setting('alhc.approval_finish', true), '') is distinct from new.id::text then
    if public.is_client_role() then
      if tg_op = 'UPDATE' and exists (
        select 1 from public.approval_rounds r where r.task_id = new.id and r.status = 'pending'
      ) then
        if exists (
          select 1 from public.approval_requests q
          join public.approval_rounds r on r.id = q.round_id
          where r.task_id = new.id and r.status = 'pending' and q.status = 'pending'
            and q.approver_id = (select auth.uid()) and q.deleted_at is null
        ) then
          raise exception 'This task is waiting for your approval. Approve it instead of marking it complete.'
            using errcode = 'check_violation';
        elsif exists (
          select 1 from public.task_approvers a
          where a.task_id = new.id and a.profile_id = (select auth.uid()) and a.deleted_at is null
        ) then
          raise exception 'This task is waiting for the other approvers.'
            using errcode = 'check_violation';
        end if;
        raise exception 'This task is waiting for approval. Only its approvers can complete it.'
          using errcode = 'check_violation';
      end if;
      if not exists (
        select 1 from public.task_approvers a
        where a.task_id = new.id and a.profile_id = (select auth.uid()) and a.deleted_at is null
      ) and not public.approval_round_approved(new.id) then
        raise exception 'Only its approvers can complete an approval task. Send it with Ready for approval.'
          using errcode = 'check_violation';
      end if;
    elsif tg_op = 'UPDATE' and coalesce(current_setting('alhc.rule_id', true), '') <> ''
          and not public.approval_round_approved(new.id) then
      raise exception 'Approval tasks are completed by their approvers'
        using errcode = 'check_violation';
    end if;
  end if;$new$
);

-- An approved round completes its task (the system, not a person or a rule).
select public.alhc_patch_function(
  'public.finish_approved_round(uuid)'::regprocedure,
  $old$  if r.after_approval = 'complete' then
    update public.tasks set completed_at = now()
    where id = r.task_id and completed_at is null and deleted_at is null;$old$,
  $new$  if r.after_approval = 'complete' then
    perform set_config('alhc.approval_finish', r.task_id::text, true);
    update public.tasks set completed_at = now()
    where id = r.task_id and completed_at is null and deleted_at is null;
    perform set_config('alhc.approval_finish', '', true);$new$
);

-- The rule engine's "Mark complete" skips approval tasks (logged) until their latest round is approved,
-- and so does "Convert to a project … and complete the task".
select public.alhc_patch_function(
  'public.execute_rule_actions(public.rules,uuid,jsonb,jsonb)'::regprocedure,
  $old$        when 'complete_task' then
          update public.tasks set completed_at = now() where id = target_task and completed_at is null;
          if not found then
            outcome := 'unchanged';
            result := 'Already complete';
          else
            result := 'Marked complete';
          end if;$old$,
  $new$        when 'complete_task' then
          if t.kind = 'approval' and t.completed_at is null and not public.approval_round_approved(target_task) then
            outcome := 'skipped';
            result := 'Approval tasks are completed by their approvers';
          else
            update public.tasks set completed_at = now() where id = target_task and completed_at is null;
            if not found then
              outcome := 'unchanged';
              result := 'Already complete';
            else
              result := 'Marked complete';
            end if;
          end if;$new$,
  $old$          if coalesce((a ->> 'complete_task')::boolean, false) then
            update public.tasks set completed_at = now() where id = target_task and completed_at is null;
          end if;$old$,
  $new$          if coalesce((a ->> 'complete_task')::boolean, false)
             and (t.kind is distinct from 'approval' or public.approval_round_approved(target_task)) then
            update public.tasks set completed_at = now() where id = target_task and completed_at is null;
          end if;$new$,
  $old$            || coalesce(' in “' || (input ->> 'portfolio') || '”', '');$old$,
  $new$            || coalesce(' in “' || (input ->> 'portfolio') || '”', '')
            || case when coalesce((a ->> 'complete_task')::boolean, false) and t.kind = 'approval' and t.completed_at is null
                   and not public.approval_round_approved(target_task)
                 then '. The task wasn’t marked complete: approval tasks are completed by their approvers' else '' end;$new$
);

-- My Tasks rules' "Mark complete" skips approval tasks too (until their latest round is approved).
select public.alhc_patch_function(
  'public.run_my_task_rule(public.my_task_rules,uuid,jsonb,text)'::regprocedure,
  $old$        when 'complete_task' then
          if not public.has_task_role(target_task, 'editor') then$old$,
  $new$        when 'complete_task' then
          if t.kind = 'approval' and not public.approval_round_approved(target_task) then
            outcome := 'skipped';
            result := 'Approval tasks are completed by their approvers';
          else
          if not public.has_task_role(target_task, 'editor') then$new$,
  $old$          update public.tasks set completed_at = now() where id = target_task and completed_at is null;
          result := 'Marked complete';$old$,
  $new$          update public.tasks set completed_at = now() where id = target_task and completed_at is null;
          result := 'Marked complete';
          end if;$new$
);

-- Whether the caller is one of the task's approvers (rows draw "Ready for approval" for everyone else).
select public.alhc_patch_function(
  'public.task_approval_state(uuid)'::regprocedure,
  $old$    'round_number', r.round_number
  )$old$,
  $new$    'round_number', r.round_number,
    'is_approver', exists (
      select 1 from public.task_approvers a
      where a.task_id = target_task and a.profile_id = (select auth.uid()) and a.deleted_at is null
    )
  )$new$
);

select public.alhc_patch_function(
  'public.project_task_cards(uuid,uuid[])'::regprocedure,
  $old$           ), false) as waiting_on_me
    from member m$old$,
  $new$           ), false) as waiting_on_me,
           exists (
             select 1 from public.task_approvers ta
             where ta.task_id = m.task_id and ta.profile_id = (select auth.uid()) and ta.deleted_at is null
           ) as is_approver
    from member m$new$,
  $old$      'approval_waiting_on_me', coalesce(ap.waiting_on_me, false)$old$,
  $new$      'approval_waiting_on_me', coalesce(ap.waiting_on_me, false),
      'approval_is_approver', coalesce(ap.is_approver, false)$new$
);

-- The approval state of many tasks at once ({ "<task id>": task_approval_state }), approval tasks the
-- caller can read only (RLS), at most 500.
create or replace function public.task_approval_states(task_ids uuid[])
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(t.id, public.task_approval_state(t.id)), '{}'::jsonb)
  from public.tasks t
  where t.id = any ((task_ids)[1:500])
    and t.kind = 'approval'
    and t.deleted_at is null;
$$;

revoke all on function public.task_approval_states(uuid[]) from public, anon;
grant execute on function public.task_approval_states(uuid[]) to authenticated;
select public.alhc_revoke_anon_execute(array['task_approval_states(uuid[])']);


-- =================================================================================================
-- Track T2: 47 select options, 54 colors, 49 number symbol, 48 long text
-- =================================================================================================

-- 47. Select fields need at least one option: a person can't create a single- or multi-select field
--     (project fields: not the section-bound Status; portfolio fields: single-select) with no options,
--     or save one so that it has none. guard_select_field_options() (invoker; one function for both
--     tables) checks client roles only, so system paths — imports, the copy engine (templates incl. the
--     seeded Creative Requests example, whose select fields have no options, Duplicate project) — keep
--     working, and a select field that already has no options can still be renamed or described.
-- 54. More option colors: a 20-color palette (option_colors()) for field options, portfolio field
--     options, and tags; tags keep the picked color in the new tags.palette_color and the nearest of
--     the original nine in tags.color (whose CHECK can't be widened additively).
-- 49. Number field symbol: custom_fields.number_prefix and portfolio_fields.number_prefix (number fields
--     only; 1–4 characters, trimmed, no control characters or line breaks) shown before the value
--     everywhere (format_number_value(); task_field_text and rule_field_value_label use it, so Inbox
--     field changes, notification emails, and rule placeholders / emails / run logs show "$1,250").
--     The stored value stays a plain number. Templates and Duplicate project keep the symbol.
-- 48. Long text editor: app only (the pop-out editor counts against validate_task_field_value()'s
--     10,000-character limit for text values; suite zz36 pins that limit). Nothing here.

-- ---------------------------------------------------------------------------------------------------
-- 47. Select fields need at least one option.
--
-- One BEFORE INSERT / UPDATE trigger function on custom_fields and portfolio_fields (bound_to_sections
-- is read through to_jsonb, so the same body serves portfolio_fields, which has no such column).
-- Refused for a client role (a person through the API):
--   * inserting a select field with no options;
--   * an update that leaves a select field with no options, unless it already was that same select
--     field with no options (older fields and template copies stay renameable; they just can't be
--     emptied once they have options).
-- Removed fields (deleted_at set) aren't checked. Definer code (import_batch, the copy engine, library
-- placements) runs as its owner, not a client role, so it is never refused here.
-- ---------------------------------------------------------------------------------------------------

create or replace function public.guard_select_field_options()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  new_bound boolean := coalesce((to_jsonb(new) ->> 'bound_to_sections')::boolean, false);
begin
  if not public.is_client_role() or new.deleted_at is not null then
    return new;
  end if;
  if new.field_type not in ('single_select', 'multi_select') or new_bound then
    return new;
  end if;
  -- A non-array is the options CHECK's to refuse.
  if jsonb_typeof(new.options) is distinct from 'array' or jsonb_array_length(new.options) > 0 then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.field_type = new.field_type
     and not coalesce((to_jsonb(old) ->> 'bound_to_sections')::boolean, false)
     and jsonb_typeof(old.options) = 'array'
     and jsonb_array_length(old.options) = 0 then
    return new;
  end if;
  raise exception 'Add at least one option to the “%” field', btrim(new.name)
    using errcode = 'check_violation',
          hint = 'A single- or multi-select field needs at least one option for people to pick.';
end;
$$;

revoke all on function public.guard_select_field_options() from public, anon, authenticated;

create trigger custom_fields_07_select_options
  before insert or update on public.custom_fields
  for each row execute function public.guard_select_field_options();

create trigger portfolio_fields_07_select_options
  before insert or update on public.portfolio_fields
  for each row execute function public.guard_select_field_options();

-- ---------------------------------------------------------------------------------------------------
-- 54. More option colors: one palette everywhere colors are picked (project field options, portfolio
-- field options, tags). The palette grows from 9 to 20 colors; the first nine keep their names and order
-- (the app cycles new options through the list). Mirrored by OPTION_COLORS in src/lib/fields.ts.
--
--   * public.option_colors(): the palette, the one SQL list. guard_portfolio_field (portfolio option
--     colors) and ensure_tag (tags made by the importer / the old Tags field migration) now read it.
--     Project field option colors were never checked in SQL (the app keeps unknown ones as Gray).
--   * Tags: tags_color_check only knows the first nine and can't be widened without removing it, so the
--     picked color lives in a new column, tags.palette_color (CHECK = the full palette, nullable), and
--     `color` keeps the nearest of the nine (public.option_color_base(): nearest in OKLab at the 500
--     shades) for readers that don't know the new column. The invoker trigger tags_06_palette_color keeps
--     the two in step for every writer:
--       - a palette color sent in `color` (ensure_tag, the importer) moves to palette_color;
--       - palette_color set → color := its nearest base color;
--       - a writer that changes only `color` (the release before this one) clears palette_color.
--     A tag's color is coalesce(palette_color, color): the app reads it so, and tag stories store it.
-- Additive: the release still on main writes and reads `color` as before.
-- ---------------------------------------------------------------------------------------------------

create or replace function public.option_colors()
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select array[
    'zinc', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink',
    'lime', 'emerald', 'cyan', 'sky', 'indigo', 'purple', 'fuchsia', 'rose', 'yellow', 'slate', 'stone'
  ]::text[];
$$;

comment on function public.option_colors() is
  'Oct 29 notes, item 54: every color people can pick for a field option or a tag (mirrors OPTION_COLORS in src/lib/fields.ts; the first nine are the original colors).';

revoke all on function public.option_colors() from public, anon;
grant execute on function public.option_colors() to authenticated, service_role;

-- The nearest of the first nine colors (what tags.color can hold); a base or unknown color is returned
-- as it is. Mirrors OPTION_BASE_COLOR in src/lib/fields.ts.
create or replace function public.option_color_base(color text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case color
    when 'lime' then 'green'
    when 'emerald' then 'teal'
    when 'cyan' then 'teal'
    when 'sky' then 'blue'
    when 'indigo' then 'violet'
    when 'purple' then 'violet'
    when 'fuchsia' then 'pink'
    when 'rose' then 'red'
    when 'yellow' then 'amber'
    when 'slate' then 'zinc'
    when 'stone' then 'zinc'
    else color
  end;
$$;

revoke all on function public.option_color_base(text) from public, anon;
grant execute on function public.option_color_base(text) to authenticated, service_role;

-- Portfolio single-select options accept the whole palette.
select public.alhc_patch_function(
  'public.guard_portfolio_field()'::regprocedure,
  $old$or coalesce(o ->> 'color', '') not in ('zinc', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink')$old$,
  $new$or not (coalesce(o ->> 'color', '') = any (public.option_colors()))$new$
);

-- Tags made by the importer (and the one-time Tags field migration) keep a palette color.
select public.alhc_patch_function(
  'public.ensure_tag(uuid, text, text, uuid)'::regprocedure,
  $old$case when tag_color in ('zinc', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink')$old$,
  $new$case when tag_color = any (public.option_colors())$new$
);

alter table public.tags add column palette_color text;

alter table public.tags add constraint tags_palette_color_check check (
  palette_color is null
  or palette_color = any (array[
    'zinc', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink',
    'lime', 'emerald', 'cyan', 'sky', 'indigo', 'purple', 'fuchsia', 'rose', 'yellow', 'slate', 'stone'
  ]::text[])
);

comment on column public.tags.palette_color is
  'Oct 29 notes, item 54: the color picked from the full palette (public.option_colors()); color then holds its nearest of the first nine. A tag''s color is coalesce(palette_color, color).';

-- Tag managers (the update policy) recolor through it; inserts already have the table-level grant.
grant update (palette_color) on public.tags to authenticated;

create or replace function public.guard_tag_palette_color()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- A writer that only knows `color` (the release before this one) picked another color: it replaces
  -- the palette color.
  if tg_op = 'UPDATE'
     and new.color is distinct from old.color
     and new.palette_color is not distinct from old.palette_color then
    new.palette_color := null;
  end if;
  -- A palette color sent in `color` (ensure_tag, the importer) moves to palette_color.
  if new.color = any (public.option_colors()) and new.color <> public.option_color_base(new.color) then
    new.palette_color := new.color;
  end if;
  -- `color` keeps the nearest of the first nine for readers that don't know palette_color. Unknown
  -- colors are left for the CHECKs to refuse.
  if new.palette_color = any (public.option_colors()) then
    new.color := public.option_color_base(new.palette_color);
  end if;
  return new;
end;
$$;

revoke all on function public.guard_tag_palette_color() from public, anon, authenticated;

create trigger tags_06_palette_color
  before insert or update on public.tags
  for each row execute function public.guard_tag_palette_color();

-- Tag stories carry the color people see.
select public.alhc_patch_function(
  'public.on_task_tag_story()'::regprocedure,
  $old$select * into tag from public.tags t where t.id = new.tag_id;$old$,
  $new$select * into tag from public.tags t where t.id = new.tag_id;
  tag.color := coalesce(tag.palette_color, tag.color);$new$
);

-- ---------------------------------------------------------------------------------------------------
-- 49. Number field symbol (a prefix such as $, €, #, ₪ shown before a number field's value).
--
--   * custom_fields.number_prefix / portfolio_fields.number_prefix: null = none. CHECK: number fields
--     only, 1–4 characters (code points), no surrounding spaces, no control characters or line breaks.
--     The invoker trigger normalize_number_prefix() trims surrounding spaces first and turns an empty
--     symbol into null (both tables).
--   * public.format_number_value(value, prefix): the one SQL rendering of a number, mirroring
--     formatNumberValue() in src/lib/fields.ts — grouped with commas, at most three decimals (rounded
--     half away from zero), the minus sign before the symbol ("-$1,250.5"), and a space after a symbol
--     that ends in a letter ("USD 1,250").
--   * task_field_text() (Inbox field changes, notification emails, rule placeholders {{field.…}},
--     Send email's "include a field") and rule_field_value_label() (rule run logs, the dry run) render
--     numbers through it. Numbers there are now grouped like everywhere in the app ("1,250").
--   * Templates and Duplicate project keep the symbol (project_snapshot carries it,
--     instantiate_project_snapshot sets it; a symbol that no longer fits is left out, never failing the
--     copy).
-- The stored value stays a plain JSON number: sorting, filtering, rules, and exports are unchanged.
-- Additive: the release still on main never reads or writes the new columns.
-- ---------------------------------------------------------------------------------------------------

alter table public.custom_fields add column number_prefix text;
alter table public.portfolio_fields add column number_prefix text;

alter table public.custom_fields add constraint custom_fields_number_prefix_check check (
  number_prefix is null
  or (
    field_type = 'number'
    and char_length(number_prefix) between 1 and 4
    and number_prefix = btrim(number_prefix)
    and number_prefix !~ '[\x01-\x1f\x7f-\x9f\u2028\u2029]'
  )
);

alter table public.portfolio_fields add constraint portfolio_fields_number_prefix_check check (
  number_prefix is null
  or (
    field_type = 'number'
    and char_length(number_prefix) between 1 and 4
    and number_prefix = btrim(number_prefix)
    and number_prefix !~ '[\x01-\x1f\x7f-\x9f\u2028\u2029]'
  )
);

comment on column public.custom_fields.number_prefix is
  'Oct 29 notes, item 49: a number field''s symbol (e.g. $, €, #), shown before its values; null = none. The values stay plain numbers.';
comment on column public.portfolio_fields.number_prefix is
  'Oct 29 notes, item 49: a number field''s symbol (e.g. $, €, #), shown before its values; null = none. The values stay plain numbers.';

create or replace function public.normalize_number_prefix()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Surrounding spaces (incl. no-break and ideographic ones) go; an empty symbol is no symbol.
  new.number_prefix := nullif(btrim(new.number_prefix, E' \t\n\r\u00a0\u2007\u202f\u3000'), '');
  return new;
end;
$$;

revoke all on function public.normalize_number_prefix() from public, anon, authenticated;

create trigger custom_fields_08_number_prefix
  before insert or update on public.custom_fields
  for each row execute function public.normalize_number_prefix();

create trigger portfolio_fields_08_number_prefix
  before insert or update on public.portfolio_fields
  for each row execute function public.normalize_number_prefix();

-- "1,250", "$1,250.5", "-$40", "€0.125", "USD 7"; null for a null value. Mirrors formatNumberValue().
create or replace function public.format_number_value(value numeric, prefix text default null)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case when r.n < 0 then '-' else '' end
    || coalesce(prefix, '')
    -- A symbol ending in a letter (USD, Rs, CHF) gets a space before the digits.
    || case when prefix ~ '[A-Za-z]$' then ' ' else '' end
    || regexp_replace(trunc(abs(r.n))::text, '(\d)(?=(\d{3})+$)', '\1,', 'g')
    || coalesce('.' || nullif(rtrim(split_part((abs(r.n) - trunc(abs(r.n)))::text, '.', 2), '0'), ''), '')
  from (select round(value, 3) as n) r
  where r.n is not null;
$$;

comment on function public.format_number_value(numeric, text) is
  'Oct 29 notes, item 49: a number as people read it (commas, up to three decimals, the field''s symbol after the sign). Mirrors formatNumberValue() in src/lib/fields.ts.';

revoke all on function public.format_number_value(numeric, text) from public, anon;
grant execute on function public.format_number_value(numeric, text) to authenticated, service_role;

-- Inbox field changes, notification emails, rule placeholders, and Send email's field line.
select public.alhc_patch_function(
  'public.task_field_text(uuid, uuid)'::regprocedure,
  $old$    else v.value #>> '{}'$old$,
  $new$    when 'number' then case when jsonb_typeof(v.value) = 'number'
      then public.format_number_value((v.value #>> '{}')::numeric, f.number_prefix) end
    else v.value #>> '{}'$new$
);

-- Rule run logs and the dry run ("Set Budget to $1,250").
select public.alhc_patch_function(
  'public.rule_field_value_label(public.custom_fields, jsonb)'::regprocedure,
  $old$    else left(value #>> '{}', 200)$old$,
  $new$    when field.field_type = 'number' and jsonb_typeof(value) = 'number'
      then public.format_number_value((value #>> '{}')::numeric, field.number_prefix)
    else left(value #>> '{}', 200)$new$
);

-- Templates and Duplicate project keep the symbol.
select public.alhc_patch_function(
  'public.project_snapshot(uuid, jsonb)'::regprocedure,
  $old$'field_type', f.field_type, 'options', f.options,$old$,
  $new$'field_type', f.field_type, 'options', f.options, 'number_prefix', f.number_prefix,$new$
);

select public.alhc_patch_function(
  'public.instantiate_project_snapshot(jsonb, text, date, uuid, text, jsonb)'::regprocedure,
  $old$    n_fields := n_fields + 1;$old$,
  $new$    if item ->> 'field_type' = 'number' and nullif(btrim(coalesce(item ->> 'number_prefix', '')), '') is not null then
      begin
        update public.custom_fields set number_prefix = item ->> 'number_prefix' where id = found_id;
      exception when check_violation then
        null; -- a symbol that no longer fits is left out; the copy goes on
      end;
    end if;
    n_fields := n_fields + 1;$new$
);


-- =================================================================================================
-- Track T3: 55 shared library fields, 51 field lock
-- =================================================================================================

-- 55. Library fields are shared across projects ("linked placements"). Each project that uses a
--     library field keeps its own custom_fields row (a placement, custom_fields.library_field_id = the
--     published source field), so every project-scoped feature (views, filters, rules, forms, imports,
--     exports, reports, bulk edit, task templates, inbound webhooks, workload) works unchanged. A group
--     is coalesce(library_field_id, id):
--     - one definition: the definition columns (library_field_definition_columns(), the one list —
--       name, description, type, options, notify, the number symbol of item 49, and the lock of item
--       51) are copied to the whole group after any change (custom_fields_zz_library_sync, definer); only
--       Editors+ of the source's project change them while the source is live (frozen while that project
--       is archived; Editors+ of the placement's own project once the source field or its project is
--       removed) — custom_fields_05_library_guard (invoker) refuses everyone else; no field changes
--       project or type through people's writes;
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
--     definition and lock: of its publishing project; a shared field's value: of every project of the
--     task that uses it — locked_field_value_writable, pinned in suite 60); rules change one only while
--     their owner is an Owner / Admin there (the Set field step is skipped and logged otherwise); bulk Field skips its
--     tasks with the reason; Duplicate task and task templates leave its values out; every other system
--     path (imports, copies, recurrence, forms, inbound webhooks, the library sync) writes as before.

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
  select array['name', 'description', 'field_type', 'options', 'notify_on_change', 'number_prefix', 'locked', 'locked_by', 'locked_at']::text[];
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
-- source's project while the source is active (field live, project not removed). An archived
-- publishing project keeps governing: archiving caps everyone there at Viewer, so the shared definition
-- and lock are frozen until it's unarchived (the placements' own projects never take over — anyone can
-- make a project and add a library field to it). The placement's own project decides only once the
-- source field was removed or its project deleted.
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
      join public.projects p on p.id = s.project_id and p.deleted_at is null
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
-- in the library. No field changes project or type through people's writes (the app never does either:
-- a moved field could carry a lock out of its project and back unlocked, and a new type would turn every
-- project's stored values into ones that no longer fit).
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
  if new.project_id is distinct from old.project_id then
    raise exception 'A field stays in its project' using errcode = 'check_violation';
  end if;
  if new.field_type is distinct from old.field_type then
    raise exception 'A field''s type can''t be changed once it''s created' using errcode = 'check_violation';
  end if;

  if old.library_field_id is not null then
    if new.in_library and not old.in_library then
      raise exception 'Only the project that published a library field lists it in the field library'
        using errcode = 'check_violation';
    end if;
    if new.bound_to_sections and not old.bound_to_sections then
      raise exception 'A shared library field can''t follow the sections' using errcode = 'check_violation';
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

  -- A published field (or one other projects use) never follows the sections.
  if new.bound_to_sections and not old.bound_to_sections then
    select * into share from public.project_field_sharing(old.project_id) s where s.field_id = old.id;
    if coalesce(share.is_shared, false) or old.in_library then
      raise exception 'A field other projects use from the field library can''t follow the sections'
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
-- an old definition (or one changed while it was removed) to the others — and the group's newest
-- values for its project's tasks (values written while it was removed never reached it). Bringing back
-- a field of a locked group is for its project's Owners and Admins (51: the guard before this one only
-- sees the removed row's own, possibly older, lock).
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
      if (select g.locked from public.custom_fields g where g.id = donor)
         and auth.uid() is not null and not public.has_project_role(new.project_id, 'admin') then
        raise exception 'Locked — only project Owners and Admins can change this field' using errcode = 'insufficient_privilege';
      end if;
      perform public.copy_library_definition(new.id, donor);
      perform public.fill_library_values(new.id, null);
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
    -- 51: a locked field's own, different value here (left from an earlier time the task was in this
    -- project) is replaced only by someone who may change it here (library_fill_overwrite_allowed).
    if f.locked and r.has_row and not public.library_fill_overwrite_allowed(f.project_id) then
      raise exception 'Locked — a locked shared field already has a different value for this task in one of its projects, and only that project''s Owners and Admins can change it'
        using errcode = 'insufficient_privilege';
    end if;
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
    select l.field_id, l.value, x.task_id is not null as has_row, x.value as own_value, cf.locked, cf.project_id
    from latest l
    join public.custom_fields cf on cf.id = l.field_id
    left join public.task_field_values x on x.task_id = target_task and x.field_id = l.field_id
    where l.from_field <> l.field_id
    order by l.field_id
  loop
    continue when r.has_row and r.own_value is not distinct from r.value;
    continue when not r.has_row and r.value is null;
    -- 51: as in fill_library_values.
    if r.locked and r.has_row and not public.library_fill_overwrite_allowed(r.project_id) then
      raise exception 'Locked — a locked shared field already has a different value for this task in one of its projects, and only that project''s Owners and Admins can change it'
        using errcode = 'insufficient_privilege';
    end if;
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
-- use add_library_field). Only when the source is a live library field of a live (not archived) project
-- in the same workspace, the field is live, of the same type, not Status, not in the library, not linked, in
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
  join public.projects p on p.id = cf.project_id and p.deleted_at is null and p.archived_at is null
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
-- role; the field live, published, of this workspace, not Status, its project not archived). Idempotent: the project's live
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
  -- (A field of an archived project isn't offered: its definition is frozen until it's unarchived.)
  select f.* into src
  from public.custom_fields f
  join public.projects p on p.id = f.project_id and p.deleted_at is null and p.archived_at is null
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
-- not itself in the library, not linked, same type, same name (trimmed, any case), made after S and
-- after its own project (so never one the copy engine made with a templated or duplicated project), and —
-- for select fields — exactly the same non-empty set of option ids (random ids: a strong fingerprint),
-- else the same non-empty description. A C matching more than one S, or a project with more than one
-- C for the same S, is left alone (counted as ambiguous). After linking, for each task in more than
-- one of the group's projects: one value → copied to the placements without one (quietly); equal
-- values → nothing; different values → both kept and recorded in library_field_link_conflicts. Only no
-- row, JSON null, "", and [] count as no value (library_link_value_empty) — an unticked checkbox (false)
-- is a value, so true on one side and false on the other is a conflict, both kept.

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
        -- Added after its own project was made: "Choose from library" copies always are; the copy engine
        -- (templates, Duplicate project) makes a project's fields with the project, and never from the
        -- library (its option ids and descriptions are copied too, so they'd match).
        and f.created_at > p.created_at
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
      where not public.library_link_value_empty(v.value)
      order by v.task_id
    loop
      select count(*), count(distinct mm.value) filter (where not public.library_link_value_empty(mm.value))
      into n_members, distinct_values
      from public.library_group_task_members(grp, t.task_id) mm;
      continue when n_members < 2;
      if distinct_values = 1 then
        select mm.value into the_value from public.library_group_task_members(grp, t.task_id) mm
        where not public.library_link_value_empty(mm.value) limit 1;
        for m in select * from public.library_group_task_members(grp, t.task_id) mm where public.library_link_value_empty(mm.value) loop
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
        where not public.library_link_value_empty(mm.value)
        order by mm.is_source desc, mm.created_at, mm.field_id
        limit 1;
        for m in
          select * from public.library_group_task_members(grp, t.task_id) mm
          where not public.library_link_value_empty(mm.value) and mm.field_id <> ref_field and mm.value is distinct from ref_value
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
-- through (the field's project) — and, for a shared library field, of every other project the value
-- reaches (51.4, 51.8); its definition (name, description, options, notifications) and
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
-- system paths — passes, except a rule, which is checked against its owner). A shared library field's
-- value is one value in every project that holds the task (55), so a locked one is changed only by
-- someone who is an Owner or Admin of each of them — the project written through and every other
-- project the library copies it into (archived ones aside: nobody is an Admin there) — and a rule only
-- while its owner is (locked_field_value_writable, rule_owner_writes_locked_value). Otherwise anyone
-- could make a project of their own, add the task and the library field to it, and change the locked
-- value everywhere from there. A value row never moves to another task or field through people's
-- writes (the app never moves one; a move would carry a value past the lock or out from under it).
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
  if client and tg_op = 'UPDATE'
     and (new.task_id is distinct from old.task_id or new.field_id is distinct from old.field_id) then
    raise exception 'A field value can''t move to another task or field' using errcode = 'insufficient_privilege';
  end if;
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
    if public.locked_field_value_writable(new.task_id, new.field_id) then
      return new;
    end if;
    if public.has_project_role(f.project_id, 'admin') then
      raise exception 'Locked — only Owners and Admins of every project this task is in can change this shared field'
        using errcode = 'insufficient_privilege';
    end if;
  elsif public.rule_owner_writes_locked_value(rule, new.task_id, new.field_id) then
    return new;
  elsif public.rule_owner_manages_project(rule, f.project_id) then
    raise exception 'Locked — only Owners and Admins of every project this task is in can change this shared field'
      using errcode = 'insufficient_privilege';
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
-- is an Owner or Admin of the field's project (and, for a shared library field, of every other project
-- the value would reach: rule_owner_writes_locked_value).
select public.alhc_patch_function(
  'public.execute_rule_actions(public.rules, uuid, jsonb, jsonb)'::regprocedure,
  $old$          elsif field.bound_to_sections then
            -- The section-bound Status field IS the section: setting it moves the task, nothing is stored.$old$,
  $new$          elsif field.locked and not public.rule_owner_manages_project(r.id, field.project_id) then
            outcome := 'locked';
            result := 'Skipped: “' || field.name || '” is locked, and only project Owners and Admins change it. '
              || 'This rule''s owner isn''t one.';
          elsif field.locked and not public.rule_owner_writes_locked_value(r.id, target_task, field.id) then
            outcome := 'locked';
            result := 'Skipped: “' || field.name || '” is locked and shared with other projects this task is in, '
              || 'and only someone who is an Owner or Admin of all of them changes it. This rule''s owner isn''t.';
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
      -- (One count per field: a shared field's copies in several projects are one value, and it's left
      -- out only when no copy of it in the new task has that value.)
      skipped_fields := (
        select count(distinct coalesce(f.library_field_id, f.id))::integer from public.task_field_values v
        join public.custom_fields f on f.id = v.field_id and f.deleted_at is null and not f.bound_to_sections
        where v.task_id = src.id and v.value is not null and jsonb_typeof(v.value) <> 'null'
          and not exists (
            select 1 from public.task_field_values c
            join public.custom_fields cf on cf.id = c.field_id and cf.deleted_at is null
            where c.task_id = created and coalesce(cf.library_field_id, cf.id) = coalesce(f.library_field_id, f.id)
              and c.value is not distinct from v.value
          )
      );
    end if;
  end if;$new$
);

-- 51.6 Bulk Field: a locked field's tasks are skipped with the reason (below Owner / Admin; for a shared
-- field, of any project the value would reach).
select public.alhc_patch_function(
  'public.bulk_update_tasks(uuid[], jsonb)'::regprocedure,
  $old$reason := 'It isn’t in the field’s project';$old$,
  $new$reason := 'It isn’t in the field’s project';
            elsif exists (select 1 from public.custom_fields lf where lf.id = arg_field and lf.locked)
                  and not public.has_project_role(arg_project, 'admin') then
              outcome := 'skipped';
              reason := 'Locked — only project Owners and Admins can change this field';
            elsif exists (select 1 from public.custom_fields lf where lf.id = arg_field and lf.locked)
                  and not public.locked_field_value_writable(t, arg_field) then
              outcome := 'skipped';
              reason := 'Locked — only Owners and Admins of every project this task is in can change this shared field';$new$
);

-- 51.7 Templates and Duplicate project keep the lock (instantiate_project_snapshot sets it: see 55.8).
select public.alhc_patch_function(
  'public.project_snapshot(uuid, jsonb)'::regprocedure,
  $old$'bound_to_sections', f.bound_to_sections, 'show_in_views', f.show_in_views$old$,
  $new$'bound_to_sections', f.bound_to_sections, 'show_in_views', f.show_in_views, 'locked', f.locked$new$
);

-- 51.8 Review fixes (Oct 29 notes, batch 7: 55 × 51).

-- The existing-copies migration's "no value" (link_library_field_copies): no row, JSON null, "", or [].
-- An unticked checkbox (false) is a value someone chose, unlike view_value_is_empty.
create or replace function public.library_link_value_empty(value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select value is null or value in ('null'::jsonb, '""'::jsonb, '[]'::jsonb);
$$;

revoke all on function public.library_link_value_empty(jsonb) from public, anon, authenticated;

-- Whether whoever is acting may change a locked field's value in a project: a rule while its owner is an
-- Owner / Admin there, a person who is one, and the other system paths (imports, copies, forms, cron).
-- fill_library_values / fill_library_task_values ask it before they replace a locked field's own,
-- different value when a task joins (or comes back to) a project, a subtask moves, a removed field or
-- project comes back: otherwise an Editor could take a task out of a project, change the value where
-- they're an Admin, and add the task back.
create or replace function public.library_fill_overwrite_allowed(target_project uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  rule uuid := public.rule_context_id();
begin
  if rule is not null then
    return public.rule_owner_manages_project(rule, target_project);
  end if;
  if public.import_context_id() is not null or public.copy_context_id() is not null or auth.uid() is null then
    return true;
  end if;
  return public.has_project_role(target_project, 'admin');
end;
$$;

revoke all on function public.library_fill_overwrite_allowed(uuid) from public, anon, authenticated;

-- Whether the caller may change a locked field's value for a task (task_field_values_02_field_lock and
-- bulk Field ask it): Owner / Admin of the field's project and of every other project the library copies
-- the value into (library_value_siblings; archived projects aside — nobody is an Admin there, and the
-- copy reaches them as it always has). About the caller only, for a task they can read. Pinned in suite 60.
create or replace function public.locked_field_value_writable(target_task uuid, target_field uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select public.has_task_role(target_task, 'viewer')
      and public.has_project_role(f.project_id, 'admin')
      and not exists (
        select 1
        from public.library_value_siblings(target_task, target_field) s
        join public.projects p on p.id = s.project_id
        where p.archived_at is null and not public.has_project_role(s.project_id, 'admin')
      )
    from public.custom_fields f
    where f.id = target_field
  ), false);
$$;

revoke all on function public.locked_field_value_writable(uuid, uuid) from public, anon;
grant execute on function public.locked_field_value_writable(uuid, uuid) to authenticated;

-- The same for a rule: its owner (else its creator) is an Owner / Admin of the field's project and of
-- every other (not archived) project the value would reach.
create or replace function public.rule_owner_writes_locked_value(target_rule uuid, target_task uuid, target_field uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select public.rule_owner_manages_project(target_rule, f.project_id)
      and not exists (
        select 1
        from public.library_value_siblings(target_task, target_field) s
        join public.projects p on p.id = s.project_id
        where p.archived_at is null and not public.rule_owner_manages_project(target_rule, s.project_id)
      )
    from public.custom_fields f
    where f.id = target_field
  ), false);
$$;

revoke all on function public.rule_owner_writes_locked_value(uuid, uuid, uuid) from public, anon, authenticated;

-- The field library lists no field of an archived project (it can't be added; its definition is frozen
-- until the project is unarchived).
select public.alhc_patch_function(
  'public.list_field_library()'::regprocedure,
  $old$  join public.projects p on p.id = f.project_id and p.deleted_at is null
  where public.is_allowlisted()$old$,
  $new$  join public.projects p on p.id = f.project_id and p.deleted_at is null and p.archived_at is null
  where public.is_allowlisted()$new$
);

-- A removed project that comes back gets the newest value of each shared field for its tasks: values
-- written in the other projects while it was removed never reached it (definitions did — the sync keeps
-- every live field of a group alike). Only its Owners restore a project (projects_05_guard_columns).
create or replace function public.fill_library_values_on_project_restore()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  fid uuid;
begin
  for fid in
    select f.id from public.custom_fields f
    where f.project_id = new.id and f.deleted_at is null and not f.bound_to_sections
      and (
        f.library_field_id is not null
        or exists (select 1 from public.custom_fields c where c.library_field_id = f.id and c.deleted_at is null)
      )
    order by f.id
  loop
    perform public.fill_library_values(fid, null);
  end loop;
  return null;
end;
$$;

revoke all on function public.fill_library_values_on_project_restore() from public, anon, authenticated;

create trigger projects_zz_library_restore
  after update of deleted_at on public.projects
  for each row
  when (old.deleted_at is not null and new.deleted_at is null)
  execute function public.fill_library_values_on_project_restore();

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


-- =================================================================================================
-- Track T4: 55b no home project
-- =================================================================================================

-- ---------------------------------------------------------------------------------------------------
-- Oct 29 notes, batch 7 — track T4: 55b. No home project in the UI.
--
-- tasks.home_project_id stays, as an internal pointer the database keeps on one of the task's active
-- projects (numbering, private tasks, access checks that already read "the pointer or any active
-- project"). People no longer see or set it:
--
--   * Removing a task from the project the pointer is on is allowed now: the definer trigger
--     task_projects_20_move_pointer moves the pointer to the next active project by the stable rule
--     (the first project the task was added to: task_projects.created_at, then project id; membership
--     active, project not deleted). It reuses the old "Make home" path (shape_task_number moves that
--     project's number onto tasks.req_*), and never renumbers (maybe_renumber_on_move stands down while
--     the pointer moves).
--   * Removing the task's LAST active project is refused (check_violation, detail last_project): "This is
--     the task's only project. Add it to another project first, or move the task to the Trash." The guard
--     (guard_home_membership) became SECURITY DEFINER so it counts memberships the caller can't see, and
--     it locks the task's row first, so two removals at the same time run one after the other (the
--     second sees the first). While the pointer moves, ensure_home_membership leaves the memberships
--     alone (the pointer went to an active one), so a removal can't come back or deadlock.
--   * search_tasks / filter_project_tasks match the task's own number columns (the pointer's number)
--     only while the caller can read the project that issued them: no finding a task by the number of a
--     project you can't open.
--   * task_project_labels(task_ids) (invoker, authenticated): every project of each task the caller can
--     read, in the stable order, with that project's number when it numbers the task (task_request_labels_in
--     per project, so subtasks get their path there). Never a project — or a number — the caller can't read.
--   * Links and defaults follow the stable rule instead of "home first": comment_email_project (the
--     recipient's project), calendar_feed, duplicate_task, my_task_cards, portfolio_workload,
--     report_overdue_tasks(_after), search_tasks, subtask_parent_candidates, task_open_blockers,
--     review_check_view (the form's project, else the first), dependency_shift_mode (the first project),
--     restore_task (refuses only when none of the task's projects is active), the rule
--     actions Move to another project / Remove from this project (the database moves the pointer).
--   * Emails: email_design_context returns task_numbers — the first number the recipient can read with
--     the rest for "+N" (recipient_task_numbers, run as the recipient), or the request's own number (its
--     form's project) for requester emails; submitter_response_subject uses the form's project too.
--
-- New internal helpers (revoked from clients): task_first_project, task_number_in, recipient_task_numbers,
-- move_task_pointer_on_removal. No new client SECURITY DEFINER function (suite 60 unchanged); nothing for
-- anon. No row-removal or object-removal keywords anywhere in this file. Additive: no tail.
-- ---------------------------------------------------------------------------------------------------

-- ---------------------------------------------------------------------------------------------------
-- 55b. The stable rule, for code that has no viewer: the first project the task (a subtask: its
--      top-level task) was added to whose membership is active and whose project isn't deleted. Null for a
--      private task. Internal (definer, revoked): emails, the review page.
-- ---------------------------------------------------------------------------------------------------

create or replace function public.task_first_project(target_task uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select tp.project_id
  from public.tasks t
  join public.task_projects tp on tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null
  join public.projects p on p.id = tp.project_id and p.deleted_at is null
  where t.id = target_task
  order by tp.created_at, tp.project_id
  limit 1;
$$;

revoke all on function public.task_first_project(uuid) from public, anon, authenticated;

-- A top-level task's label in one project, while that project numbers tasks (else null). Internal.
create or replace function public.task_number_in(target_task uuid, target_project uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select x.req_label
  from public.task_project_numbers x
  join public.request_sequences s on s.project_id = x.project_id and s.enabled and s.deleted_at is null
  where x.task_id = target_task and x.project_id = target_project and x.req_label is not null;
$$;

revoke all on function public.task_number_in(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 55b. Every project of each task the caller can read, in the stable order, with the number that
--      project gives the task (null when it doesn't number tasks, or not this one). Invoker: RLS plus an
--      explicit has_project_role per project, so a project the caller can't read — and its number — never
--      comes back (also when a definer helper runs it as someone else, see recipient_task_numbers).
--      { "<task id>": [ { project_id, project_name, label, wrap }, ... ] }; tasks with no readable project
--      (private tasks, unreadable ones) are left out. At most 2,000 tasks.
-- ---------------------------------------------------------------------------------------------------

create or replace function public.task_project_labels(task_ids uuid[])
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  ids uuid[] := (select coalesce(array_agg(distinct x), '{}') from unnest(task_ids[1:2000]) x where x is not null);
  p record;
  by_project jsonb := '{}'::jsonb;
  result jsonb;
begin
  if cardinality(ids) = 0 then
    return '{}'::jsonb;
  end if;
  -- Each numbering project's own labels, subtasks included (their path in that project).
  for p in
    select tp.project_id, array_agg(distinct t.id) as tids
    from public.tasks t
    join public.task_projects tp on tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null
    join public.projects pj on pj.id = tp.project_id and pj.deleted_at is null
    join public.request_sequences s on s.project_id = tp.project_id and s.enabled and s.deleted_at is null
    where t.id = any (ids)
      and public.has_project_role(tp.project_id, 'viewer')
    group by tp.project_id
  loop
    by_project := by_project || jsonb_build_object(p.project_id::text, public.task_request_labels_in(p.project_id, p.tids));
  end loop;

  select coalesce(jsonb_object_agg(x.task_id, x.projects), '{}'::jsonb) into result
  from (
    select t.id as task_id,
      jsonb_agg(jsonb_build_object(
        'project_id', tp.project_id,
        'project_name', pj.name,
        'label', by_project -> tp.project_id::text -> t.id::text ->> 'label',
        'wrap', by_project -> tp.project_id::text -> t.id::text -> 'wrap'
      ) order by tp.created_at, tp.project_id) as projects
    from public.tasks t
    join public.task_projects tp on tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null
    join public.projects pj on pj.id = tp.project_id and pj.deleted_at is null
    where t.id = any (ids)
      and public.has_project_role(tp.project_id, 'viewer')
    group by t.id
  ) x;
  return result;
end;
$$;

revoke all on function public.task_project_labels(uuid[]) from public, anon;
grant execute on function public.task_project_labels(uuid[]) to authenticated;

-- The numbers a person can read for one task, in the stable order: [ { label, wrap, project_name } ].
-- Runs task_project_labels as that person (request.jwt.claim.sub set locally, then put back), so emails
-- show only numbers of projects the recipient can open. Internal (definer, revoked): email_design_context.
create or replace function public.recipient_task_numbers(target_task uuid, target_profile uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_sub text := current_setting('request.jwt.claim.sub', true);
  list jsonb;
begin
  if target_task is null or target_profile is null then
    return '[]'::jsonb;
  end if;
  perform set_config('request.jwt.claim.sub', target_profile::text, true);
  list := public.task_project_labels(array[target_task]) -> target_task::text;
  perform set_config('request.jwt.claim.sub', coalesce(previous_sub, ''), true);
  return coalesce((
    select jsonb_agg(jsonb_build_object('label', e ->> 'label', 'wrap', coalesce((e ->> 'wrap')::boolean, true),
                                        'project_name', e ->> 'project_name') order by n)
    from jsonb_array_elements(coalesce(list, '[]'::jsonb)) with ordinality as x(e, n)
    where coalesce(e ->> 'label', '') <> ''
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.recipient_task_numbers(uuid, uuid) from public, anon, authenticated;

-- The stable rule reads task_projects.created_at = when the task was (last) added to the project. It's
-- the database's: every new membership is stamped with the clock (not the transaction's start, so the
-- projects a task joins in one transaction — its first project, then the others a copy, recurrence, or
-- import adds — keep that order, and the internal pointer, set first, stays first); people can't change
-- it; and adding a task back to a project it was removed from puts that project last, after the ones it
-- stayed in (so the pointer, which moves to the first remaining project, stays the first one). Invoker.
create or replace function public.stamp_task_project_created()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or (old.deleted_at is not null and new.deleted_at is null) then
    new.created_at := clock_timestamp();
  elsif public.is_client_role() then
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

select public.alhc_revoke_anon_execute(array['stamp_task_project_created()']);
grant execute on function public.stamp_task_project_created() to authenticated;

create trigger task_projects_04_stamp_created
  before insert or update of created_at, deleted_at on public.task_projects
  for each row
  execute function public.stamp_task_project_created();

-- ---------------------------------------------------------------------------------------------------
-- 55b. Removing a task from a project. The project the pointer is on can be removed now (the pointer
--      moves, below); the task's last active project can't. Definer, so the count sees memberships in
--      projects the caller can't read (a task in your project and in someone else's private one isn't in
--      its last project). Subtasks have no memberships; private tasks none either.
-- ---------------------------------------------------------------------------------------------------

alter function public.guard_home_membership() security definer;

select public.alhc_patch_function(
  'public.guard_home_membership()'::regprocedure,
  $old$  if new.deleted_at is not null and old.deleted_at is null and exists (
    select 1 from public.tasks t
    where t.id = new.task_id and t.home_project_id = new.project_id and t.parent_task_id is null
  ) then
    raise exception 'Cannot remove a task from its home project; change the home project first'
      using errcode = 'check_violation';
  end if;$old$,
  $new$  -- Oct 29 notes (55b): any project can be removed but the task's last active one. The task's row is
  -- locked first, so two removals from the same task run one after the other: the second one sees the
  -- first (each statement here reads afresh) and can't take the task's last project with it.
  if new.deleted_at is not null and old.deleted_at is null then
    perform 1 from public.tasks t
    where t.id = new.task_id and t.parent_task_id is null and t.home_project_id is not null
    for no key update;
    if found and not exists (
      select 1 from public.task_projects o
      join public.projects p on p.id = o.project_id and p.deleted_at is null
      where o.task_id = new.task_id and o.project_id <> new.project_id and o.deleted_at is null
    ) then
      raise exception 'This is the task’s only project. Add it to another project first, or move the task to the Trash.'
        using errcode = 'check_violation', detail = 'last_project';
    end if;
  end if;$new$
);

revoke all on function public.guard_home_membership() from public, anon, authenticated;

-- The pointer follows: when the membership it points at is removed, it moves to the next active project
-- by the stable rule — the old "Make home" path, so that project's number becomes the task's outside
-- number (shape_task_number) and nothing is renumbered (maybe_renumber_on_move stands down meanwhile).
create or replace function public.move_task_pointer_on_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_project uuid;
begin
  if not exists (
    select 1 from public.tasks t
    where t.id = new.task_id and t.parent_task_id is null and t.home_project_id = new.project_id
  ) then
    return null;
  end if;
  select tp.project_id into next_project
  from public.task_projects tp
  join public.projects p on p.id = tp.project_id and p.deleted_at is null
  where tp.task_id = new.task_id and tp.deleted_at is null
  order by tp.created_at, tp.project_id
  limit 1;
  if next_project is null then
    return null;
  end if;
  -- req_label is named too, so the label triggers run when shape_task_number changes it (column triggers
  -- only fire for columns the statement sets): the subtasks' paths follow (renumber_task_children) and
  -- the mirror stays in step. No "assigned request number" story: nothing was assigned.
  perform set_config('alhc.home_pointer_move', 'on', true);
  update public.tasks set home_project_id = next_project, req_label = req_label where id = new.task_id;
  perform set_config('alhc.home_pointer_move', '', true);
  return null;
end;
$$;

revoke all on function public.move_task_pointer_on_removal() from public, anon, authenticated;

create trigger task_projects_20_move_pointer
  after update of deleted_at on public.task_projects
  for each row
  when (old.deleted_at is null and new.deleted_at is not null)
  execute function public.move_task_pointer_on_removal();

-- While the pointer moves, ensure_home_membership has nothing to make: the pointer went to one of the
-- task's active memberships, and the guard's lock on the task (every removal takes it first) keeps that
-- membership in place until this transaction ends. Not touching it also means a removal of that very
-- membership running at the same time simply waits for this one, then sees the task's last project —
-- instead of the two writing each other's rows (a removal coming back, or a deadlock).
select public.alhc_patch_function(
  'public.ensure_home_membership()'::regprocedure,
  $old$  -- Private tasks have no project at all.
  if new.home_project_id is null then
    return new;
  end if;$old$,
  $new$  -- Private tasks have no project at all.
  if new.home_project_id is null then
    return new;
  end if;
  -- Oct 29 notes (55b): the database moving its internal pointer picked an active membership.
  if coalesce(current_setting('alhc.home_pointer_move', true), '') = 'on' then
    return new;
  end if;$new$
);

select public.alhc_patch_function(
  'public.story_request_number()'::regprocedure,
  $old$  if public.import_context_id() is not null or public.copy_context_id() is not null then
    return new;
  end if;$old$,
  $new$  if public.import_context_id() is not null or public.copy_context_id() is not null then
    return new;
  end if;
  -- Oct 29 notes (55b): the database moving its pointer after a project was removed assigns nothing.
  if coalesce(current_setting('alhc.home_pointer_move', true), '') = 'on' then
    return new;
  end if;$new$
);

select public.alhc_patch_function(
  'public.maybe_renumber_on_move()'::regprocedure,
  $old$  if new.parent_task_id is not null
     or new.home_project_id is not distinct from old.home_project_id$old$,
  $new$  -- Oct 29 notes (55b): the database moving its pointer after a project was removed never renumbers.
  if coalesce(current_setting('alhc.home_pointer_move', true), '') = 'on'
     or new.parent_task_id is not null
     or new.home_project_id is not distinct from old.home_project_id$new$
);

-- Rule actions Move to another project / Remove from this project: leave the pointer to the database.
select public.alhc_patch_function(
  'public.execute_rule_actions(public.rules, uuid, jsonb, jsonb)'::regprocedure,
  $old$          -- The task leaves this project (its home moves to the new project first).
          if t.home_project_id = r.project_id then
            update public.tasks set home_project_id = target_project where id = target_task;
          end if;
$old$,
  $new$          -- The task leaves this project (the database moves its internal pointer; Oct 29 notes, 55b).
$new$,
  $old$          order by (tp.project_id = t.home_project_id) desc, tp.created_at
          limit 1;$old$,
  $new$          order by tp.created_at, tp.project_id
          limit 1;$new$,
  $old$            if t.home_project_id = r.project_id then
              update public.tasks set home_project_id = new_home where id = target_task;
            end if;
$old$,
  $new$$new$,
  -- The run log is read by the rule's project's Viewers, who may not open the task's other projects:
  -- don't name them.
  $old$            result := 'Removed from “' || coalesce(input ->> 'project', 'this project') || '” (it stays in “'
              || coalesce((select pj.name from public.projects pj where pj.id = new_home), '?') || '”)';$old$,
  $new$            result := 'Removed from “' || coalesce(input ->> 'project', 'this project') || '” (it stays in its other projects)';$new$
);

select public.alhc_patch_function(
  'public.assign_request_number(uuid)'::regprocedure,
  $old$'Request numbers are not enabled for this task''s home project'$old$,
  $new$'Request numbers are not enabled for this task''s project'$new$
);

-- ---------------------------------------------------------------------------------------------------
-- 55b. Links and labels: the stable rule instead of "home first".
-- ---------------------------------------------------------------------------------------------------

-- The recipient's project for an email's link: the first one (stable rule) they're a member of.
select public.alhc_patch_function(
  'public.comment_email_project(uuid, uuid)'::regprocedure,
  $old$  order by (p.id = t.home_project_id) desc, p.name, p.id$old$,
  $new$  order by (
    select tp.created_at from public.task_projects tp
    where tp.task_id = coalesce(t.root_task_id, t.id) and tp.project_id = p.id
  ) nulls last, p.id$new$
);

select public.alhc_patch_function(
  'public.calendar_feed(text)'::regprocedure,
  $old$(pr.id = t.home_project_id) desc, pr.name$old$,
  $new$tp.created_at, pr.id$new$
);

-- The copy's first project: the first of the task's projects the caller edits (stable rule).
select public.alhc_patch_function(
  'public.duplicate_task(uuid, jsonb)'::regprocedure,
  $old$    order by (tp.project_id = src.home_project_id) desc, tp.created_at, tp.project_id$old$,
  $new$    order by tp.created_at, tp.project_id$new$
);

select public.alhc_patch_function(
  'public.my_task_cards()'::regprocedure,
  $old$        when a.home_project_id is not null and exists (
          select 1 from named n where n.project_id = a.home_project_id
        ) then a.home_project_id$old$,
  $new$        -- The first project the task was added to that the viewer can read (Oct 29 notes, 55b).
        when a.home_project_id is null then null$new$
);

select public.alhc_patch_function(
  'public.portfolio_workload(uuid, date, date, text)'::regprocedure,
  $old$(vp.project_id = t.home_project_id) desc, vp.sort_order, vp.project_id$old$,
  $new$tp.created_at, vp.project_id$new$
);

select public.alhc_patch_function(
  'public.report_overdue_tasks(jsonb, text, integer)'::regprocedure,
  $old$    order by r.task_id, (r.project_id = coalesce(t.home_project_id, r.project_id)) desc, r.project_id$old$,
  $new$    order by r.task_id, (
      select tp.created_at from public.task_projects tp
      where tp.task_id = coalesce(t.root_task_id, t.id) and tp.project_id = r.project_id
    ) nulls last, r.project_id$new$
);

select public.alhc_patch_function(
  'public.report_overdue_tasks_after(jsonb, text, date, text, uuid, integer)'::regprocedure,
  $old$    order by r.task_id, (r.project_id = coalesce(t.home_project_id, r.project_id)) desc, r.project_id$old$,
  $new$    order by r.task_id, (
      select tp.created_at from public.task_projects tp
      where tp.task_id = coalesce(t.root_task_id, t.id) and tp.project_id = r.project_id
    ) nulls last, r.project_id$new$
);

-- Search labels and links a task with the first of its projects the caller can read (RLS on
-- task_projects); the result columns keep their names.
select public.alhc_patch_function(
  'public.search_tasks(text, integer)'::regprocedure,
  $old$    order by (tp.project_id = t.home_project_id) desc, tp.created_at
    limit 1$old$,
  $new$    order by tp.created_at, tp.project_id
    limit 1$new$
);

-- Number privacy in search and a view's text filter: the task's own number columns (tasks.req_label /
-- req_number / req_path, the internal pointer's number — a subtask's path too) match only while the
-- caller can read the project that issued them, so searching another project's number ("C-1") never
-- finds a task in a project you can't open. The per-project numbers (task_project_numbers) were already
-- read through RLS.
select public.alhc_patch_function(
  'public.search_tasks(text, integer)'::regprocedure,
  $old$      or coalesce(t.req_label, '') ilike pattern.value
$old$,
  $new$      or (
        coalesce(t.req_label, '') ilike pattern.value
        and public.has_project_role(coalesce(t.req_project_id, t.home_project_id), 'viewer')
      )
$new$,
  $old$        public.request_number_query(trim(query)) is not null
$old$,
  $new$        public.request_number_query(trim(query)) is not null
        and public.has_project_role(coalesce(t.req_project_id, t.home_project_id), 'viewer')
$new$
);

select public.alhc_patch_function(
  'public.filter_project_tasks(uuid, jsonb, text)'::regprocedure,
  $old$      or coalesce(t.req_label, '') ilike pattern.value
$old$,
  $new$      or (
        coalesce(t.req_label, '') ilike pattern.value
        and public.has_project_role(coalesce(t.req_project_id, t.home_project_id), 'viewer')
      )
$new$,
  $old$        public.request_number_query(p.needle) is not null
$old$,
  $new$        public.request_number_query(p.needle) is not null
        and public.has_project_role(coalesce(t.req_project_id, t.home_project_id), 'viewer')
$new$
);

select public.alhc_patch_function(
  'public.subtask_parent_candidates(uuid, text, integer)'::regprocedure,
  $old$  select t.id, t.title, t.parent_task_id, coalesce(r.home_project_id, t.home_project_id), t.completed_at$old$,
  $new$  select t.id, t.title, t.parent_task_id, (
    select tp.project_id
    from public.task_projects tp
    join public.projects pj on pj.id = tp.project_id and pj.deleted_at is null
    where tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null
      and public.has_project_role(tp.project_id, 'viewer')
    order by tp.created_at, tp.project_id
    limit 1
  ), t.completed_at$new$
);

select public.alhc_patch_function(
  'public.task_open_blockers(uuid)'::regprocedure,
  $old$'home_project_id', coalesce(r.home_project_id, p.home_project_id)$old$,
  $new$'home_project_id', (
          select tp.project_id
          from public.task_projects tp
          join public.projects pj on pj.id = tp.project_id and pj.deleted_at is null
          where tp.task_id = coalesce(r.id, p.id) and tp.deleted_at is null
            and public.has_project_role(tp.project_id, 'viewer')
          order by tp.created_at, tp.project_id
          limit 1
        )$new$
);

-- Dependency shifting: each task's first project (stable rule; one the caller can read — the one the
-- shift dialog links to) decides for it; across tasks, Ask me wins and Off only when all are Off.
select public.alhc_patch_function(
  'public.dependency_shift_mode(uuid[])'::regprocedure,
  $old$    left join public.tasks r on r.id = t.root_task_id
    left join public.projects p on p.id = coalesce(r.home_project_id, t.home_project_id)$old$,
  $new$    left join public.projects p on p.id = (
      select tp.project_id
      from public.task_projects tp
      join public.projects pj on pj.id = tp.project_id and pj.deleted_at is null
      where tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null
      order by tp.created_at, tp.project_id
      limit 1
    )$new$
);

-- Restoring needs one of the task's projects to be active (not the pointer's in particular).
select public.alhc_patch_function(
  'public.restore_task(uuid)'::regprocedure,
  $old$  if exists (select 1 from public.projects p where p.id = t.home_project_id and p.deleted_at is not null) then
    raise exception 'This task''s home project is deleted' using errcode = 'check_violation',
      hint = 'Restore the project or make another project the task''s home first';
  end if;$old$,
  $new$  if t.home_project_id is not null and not exists (
    select 1 from public.task_projects tp
    join public.projects p on p.id = tp.project_id and p.deleted_at is null
    where tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null
  ) then
    raise exception 'This task''s projects are deleted' using errcode = 'check_violation',
      hint = 'Restore one of its projects first';
  end if;$new$
);

-- The review page names the request's project: its form's, else the first of the task's projects.
select public.alhc_patch_function(
  'public.review_check_view(text)'::regprocedure,
  $old$  where p.id = coalesce((select root.home_project_id from public.tasks root where root.id = coalesce(t.root_task_id, t.id)), t.home_project_id);$old$,
  $new$  where p.id = coalesce(
    (select f.project_id from public.task_submitter(t.id) s join public.forms f on f.id = s.form_id),
    public.task_first_project(t.id)
  );$new$
);

-- A response's subject: the request's own project (its form's) and its number there.
select public.alhc_patch_function(
  'public.submitter_response_subject(uuid, uuid)'::regprocedure,
  $old$  tmpl := public.resolve_email_design('requester', r.home_project_id, s.form_id) ->> 'subject_template';$old$,
  $new$  tmpl := public.resolve_email_design('requester',
    coalesce((select f.project_id from public.forms f where f.id = s.form_id), r.home_project_id), s.form_id) ->> 'subject_template';$new$,
  $old$    'request_number', public.task_request_label(r.id),$old$,
  $new$    'request_number', coalesce(
      public.task_number_in(r.id, (select f.project_id from public.forms f where f.id = s.form_id)),
      public.task_request_label(r.id)
    ),$new$,
  $old$    'project_name', (select p.name from public.projects p where p.id = r.home_project_id),$old$,
  $new$    'project_name', (select p.name from public.projects p
      where p.id = coalesce((select f.project_id from public.forms f where f.id = s.form_id), r.home_project_id)),$new$
);

-- ---------------------------------------------------------------------------------------------------
-- 55b. Emails: the project (links, design) and the numbers shown.
--   * requester emails: the request's form's project, and the request's number there;
--   * emails to a person: the first of the task's projects they can read (comment_email_project) unless
--     the email names one, and task_numbers = the numbers they can read, in the stable order (the app
--     shows the first and "+N");
--   * anything else: the first active project, and the label the email was queued with.
-- ---------------------------------------------------------------------------------------------------

select public.alhc_patch_function(
  'public.email_design_context(uuid)'::regprocedure,
  $old$  design_kind text := 'internal';$old$,
  $new$  design_kind text := 'internal';
  numbers jsonb;
  request_numbers jsonb;
  form_project uuid;$new$,
  $old$  project := case
    when coalesce(o.payload ->> 'project_id', '') ~ uuid_pattern then (o.payload ->> 'project_id')::uuid
    else r.home_project_id
  end;
  if design_kind = 'requester' then
    form := sub.form_id;
  end if;$old$,
  $new$  if design_kind = 'requester' then
    form := sub.form_id;
    form_project := (select f.project_id from public.forms f where f.id = form);
  end if;
  project := case
    when form_project is not null then form_project
    when coalesce(o.payload ->> 'project_id', '') ~ uuid_pattern then (o.payload ->> 'project_id')::uuid
    when r.id is not null and o.to_profile_id is not null then public.comment_email_project(o.to_profile_id, r.id)
    else public.task_first_project(r.id)
  end;
  if r.id is not null then
    if form_project is not null then
      -- Null when the form's project doesn't number it: the email keeps the label it was queued with.
      numbers := (
        select jsonb_build_array(jsonb_build_object('label', x.req_label, 'wrap', s.wrap_brackets))
        from public.task_project_numbers x
        join public.request_sequences s on s.project_id = x.project_id and s.enabled and s.deleted_at is null
        where x.task_id = r.id and x.project_id = form_project and x.req_label is not null
      );
      request_numbers := numbers;
    elsif o.to_profile_id is not null and t.id is not null then
      numbers := public.recipient_task_numbers(t.id, o.to_profile_id);
      request_numbers := case when t.id = r.id then numbers else public.recipient_task_numbers(r.id, o.to_profile_id) end;
    end if;
  end if;$new$,
  $old$      'request_number', case when r.id is not null then public.task_request_label(r.id) end,
      'request_wrap', coalesce((
        select s.wrap_brackets from public.request_sequences s
        where s.project_id = coalesce(t.req_project_id, t.home_project_id) and s.deleted_at is null
      ), true),$old$,
  $new$      'request_number', case
        when r.id is null then null
        when jsonb_array_length(coalesce(request_numbers, '[]'::jsonb)) > 0 then request_numbers -> 0 ->> 'label'
        when form_project is not null then public.task_request_label(r.id)
        when request_numbers is not null then null
        else public.task_request_label(r.id)
      end,
      'request_wrap', coalesce(
        (request_numbers -> 0 ->> 'wrap')::boolean,
        (select s.wrap_brackets from public.request_sequences s
         where s.project_id = coalesce(t.req_project_id, t.home_project_id) and s.deleted_at is null),
        true
      ),
      'task_numbers', numbers,$new$
);
