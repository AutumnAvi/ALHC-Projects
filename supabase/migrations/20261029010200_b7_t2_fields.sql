-- ALHC Projects — Oct 29 notes, batch 7, track T2 (fields).
--
-- 47. Select fields need at least one option: a person can't create a single- or multi-select field
--     (project fields: not the section-bound Status; portfolio fields: single-select) with no options,
--     or save one so that it has none. guard_select_field_options() (invoker; one function for both
--     tables) checks client roles only, so system paths — imports, the copy engine (templates incl. the
--     seeded Creative Requests example, whose select fields have no options, Duplicate project) — keep
--     working, and a select field that already has no options can still be renamed or described.
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
