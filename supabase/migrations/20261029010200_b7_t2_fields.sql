-- ALHC Projects — Oct 29 notes, batch 7, track T2 (fields).
--
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
