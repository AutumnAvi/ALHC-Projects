-- Oct 29 notes, batch 7, track T2 (fields) (20261029010200_b7_t2_fields.sql; ships inside
-- 20261029010000_oct29_batch7_a.sql).
--   b7f20029…01 b7f-owner@example.com   owner of B7F A, owner of the B7F portfolio
--   b7f20029…02 b7f-editor@example.com  Editor of B7F A, Editor of the B7F portfolio
--   b7f20029…03 b7f-viewer@example.com  Viewer of B7F A

\set ON_ERROR_STOP 1

insert into public.allowed_emails (email, note) values
  ('b7f-owner@example.com', 'oct 29 batch 7 fields'),
  ('b7f-editor@example.com', 'oct 29 batch 7 fields'),
  ('b7f-viewer@example.com', 'oct 29 batch 7 fields');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b7f20029-0000-4000-8000-000000000001', 'b7f-owner@example.com', now(), '{"full_name":"Fern Owner"}'),
  ('b7f20029-0000-4000-8000-000000000002', 'b7f-editor@example.com', now(), '{"full_name":"Finn Editor"}'),
  ('b7f20029-0000-4000-8000-000000000003', 'b7f-viewer@example.com', now(), '{"full_name":"Faye Viewer"}');

create temporary table b7f_ids (name text primary key, id uuid);
grant all on b7f_ids to authenticated, anon;

-- ---------------------------------------------------------------------------------------------
-- Setup: project B7F A and portfolio B7F P
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  a uuid;
  p uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B7F A') returning id into a;
  perform public.add_project_member(a, 'b7f-editor@example.com', 'editor');
  perform public.add_project_member(a, 'b7f-viewer@example.com', 'viewer');
  insert into public.portfolios (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B7F P') returning id into p;
  perform public.add_portfolio_member(p, 'b7f-editor@example.com', 'editor');
  insert into b7f_ids values ('a', a), ('p', p);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 47. Select fields need at least one option (people; system paths are untouched).
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b7f_ids where name = 'a');
  f uuid;
  status_field uuid;
  t uuid;
  opts jsonb := '[{"id": "o1", "name": "High", "color": "red"}, {"id": "o2", "name": "Low", "color": "zinc"}]';
begin
  -- No options: refused for single- and multi-select, whether options are left out or sent empty.
  begin
    insert into public.custom_fields (project_id, name, field_type) values (a, 'Priority', 'single_select');
    raise exception 'a single-select with no options must be refused';
  exception when check_violation then
    assert sqlerrm like 'Add at least one option to the “Priority” field%', 'says what to do: ' || sqlerrm;
  end;
  begin
    insert into public.custom_fields (project_id, name, field_type, options) values (a, 'Channels', 'multi_select', '[]');
    raise exception 'a multi-select with no options must be refused';
  exception when check_violation then null;
  end;

  -- With an option it's fine; other types and the section-bound Status need none.
  insert into public.custom_fields (project_id, name, field_type, options) values (a, 'Priority', 'single_select', opts)
  returning id into f;
  insert into b7f_ids values ('f47', f);
  insert into public.custom_fields (project_id, name, field_type, options)
  values (a, 'Channels', 'multi_select', '[{"id": "c1", "name": "Email", "color": "blue"}]');
  insert into public.custom_fields (project_id, name, field_type) values (a, 'Notes', 'text');
  insert into public.custom_fields (project_id, name, field_type) values (a, 'Budget', 'number');
  insert into public.custom_fields (project_id, name, field_type, bound_to_sections)
  values (a, 'Status', 'single_select', true) returning id into status_field;
  assert (select options from public.custom_fields where id = status_field) = '[]'::jsonb, 'the section-bound Status keeps no options';
  update public.custom_fields set name = 'Stage' where id = status_field;
  assert (select name from public.custom_fields where id = status_field) = 'Stage', 'and is renamed as before';

  -- Emptying a select field is refused; renaming, reordering, recoloring, and replacing options work.
  begin
    update public.custom_fields set options = '[]' where id = f;
    raise exception 'emptying a select field must be refused';
  exception when check_violation then null;
  end;
  assert jsonb_array_length((select options from public.custom_fields where id = f)) = 2, 'its options are kept';
  update public.custom_fields
     set name = 'Urgency', options = '[{"id": "o2", "name": "Low", "color": "green"}]'
   where id = f;
  assert (select name from public.custom_fields where id = f) = 'Urgency', 'renamed';
  assert (select options -> 0 ->> 'color' from public.custom_fields where id = f) = 'green', 'one option left, recolored';
  update public.custom_fields set description = 'How soon' where id = f;

  -- A field can't become an empty select either (another type turned into a select).
  begin
    update public.custom_fields set field_type = 'single_select', options = '[]'
     where project_id = a and name = 'Notes';
    raise exception 'turning a text field into an empty select must be refused';
  exception when check_violation then null;
  end;

  -- Values still work on the field, and removing the field (soft delete) is allowed.
  t := public.create_task(a, null, 'Option task');
  insert into public.task_field_values (task_id, field_id, value) values (t, f, '"o2"');
  update public.custom_fields set deleted_at = now() where project_id = a and name = 'Channels';
  assert (select deleted_at is not null from public.custom_fields where project_id = a and name = 'Channels'),
    'a select field can still be removed';
end $$;

-- Viewers still can't write fields at all (RLS, unchanged).
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b7f_ids where name = 'a');
begin
  begin
    insert into public.custom_fields (project_id, name, field_type, options)
    values (a, 'Sneaky', 'single_select', '[{"id": "s1", "name": "S", "color": "zinc"}]');
    raise exception 'viewers can''t add fields';
  exception when insufficient_privilege then null;
  end;
end $$;

-- System paths keep making empty select fields: a direct write as the database owner, and the seeded
-- Creative Requests template (its two select fields have no options) through create_project_from_template.
reset role;
do $$
declare
  a uuid := (select id from b7f_ids where name = 'a');
  legacy uuid;
begin
  insert into public.custom_fields (project_id, name, field_type) values (a, 'Legacy pick', 'single_select')
  returning id into legacy;
  insert into b7f_ids values ('legacy', legacy);
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  legacy uuid := (select id from b7f_ids where name = 'legacy');
  created jsonb;
  copy uuid;
begin
  -- An existing select field with no options can still be renamed and described (and saved empty again),
  -- but once it has options it can't be emptied.
  update public.custom_fields set name = 'Legacy choice', description = 'Older field' where id = legacy;
  assert (select name from public.custom_fields where id = legacy) = 'Legacy choice', 'an empty select is renameable';
  update public.custom_fields set options = '[]' where id = legacy;
  update public.custom_fields set options = '[{"id": "l1", "name": "Yes", "color": "green"}]' where id = legacy;
  begin
    update public.custom_fields set options = '[]' where id = legacy;
    raise exception 'once it has options it can''t be emptied';
  exception when check_violation then null;
  end;

  -- The seeded template (definer code) still copies its option-less select fields.
  created := public.create_project_from_template('00000000-0000-4000-8000-0000000000c1', 'B7F from template', current_date);
  copy := (created ->> 'project_id')::uuid;
  insert into b7f_ids values ('template_copy', copy);
  assert (select count(*) from public.custom_fields
           where project_id = copy and field_type = 'single_select' and not bound_to_sections
             and options = '[]'::jsonb and deleted_at is null) = 2,
    'a project from Creative Requests keeps its two option-less select fields';
  -- Its creator (the owner) can rename them, and give them options.
  update public.custom_fields set name = 'Kind of request'
   where project_id = copy and name = 'Request type';
  assert exists (select 1 from public.custom_fields where project_id = copy and name = 'Kind of request'),
    'a template''s empty select is renameable';
end $$;

-- Duplicate project (definer copy engine) copies a project with an empty select field too.
do $$
declare
  copy uuid := (select id from b7f_ids where name = 'template_copy');
  dup jsonb;
begin
  dup := public.duplicate_project(copy, 'B7F duplicate', '{}'::jsonb);
  assert (select count(*) from public.custom_fields
           where project_id = (dup ->> 'project_id')::uuid and options = '[]'::jsonb
             and field_type = 'single_select' and not bound_to_sections and deleted_at is null) = 2,
    'Duplicate project copies option-less select fields';
end $$;

-- Portfolio fields: single-select needs an option too.
do $$
declare
  p uuid := (select id from b7f_ids where name = 'p');
  pf uuid;
begin
  begin
    insert into public.portfolio_fields (portfolio_id, name, field_type) values (p, 'Phase', 'single_select');
    raise exception 'an option-less portfolio single-select must be refused';
  exception when check_violation then
    assert sqlerrm like 'Add at least one option to the “Phase” field%', 'says what to do: ' || sqlerrm;
  end;
  insert into public.portfolio_fields (portfolio_id, name, field_type, options)
  values (p, 'Phase', 'single_select', '[{"id": "ph1", "name": "Plan", "color": "blue"}]') returning id into pf;
  insert into public.portfolio_fields (portfolio_id, name, field_type) values (p, 'Spend', 'number');
  begin
    update public.portfolio_fields set options = '[]' where id = pf;
    raise exception 'emptying a portfolio single-select must be refused';
  exception when check_violation then null;
  end;
  update public.portfolio_fields set name = 'Stage of work' where id = pf;
  assert (select name from public.portfolio_fields where id = pf) = 'Stage of work', 'renamed';
  update public.portfolio_fields set deleted_at = now() where id = pf;
end $$;

reset role;
do $$
declare
  p uuid := (select id from b7f_ids where name = 'p');
  pf uuid;
begin
  -- Older option-less portfolio single-selects stay renameable by people.
  insert into public.portfolio_fields (portfolio_id, name, field_type) values (p, 'Old phase', 'single_select')
  returning id into pf;
  insert into b7f_ids values ('old_pf', pf);
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  pf uuid := (select id from b7f_ids where name = 'old_pf');
begin
  update public.portfolio_fields set name = 'Older phase' where id = pf;
  assert (select name from public.portfolio_fields where id = pf) = 'Older phase', 'an empty portfolio select is renameable';
end $$;

-- The guard is a trigger helper: no client executes it.
reset role;
do $$
begin
  assert not has_function_privilege('anon', 'public.guard_select_field_options()', 'execute'), 'anon can''t execute the guard';
  assert not has_function_privilege('authenticated', 'public.guard_select_field_options()', 'execute'),
    'authenticated can''t execute the guard';
  assert exists (select 1 from pg_trigger where tgname = 'custom_fields_07_select_options' and not tgisinternal), 'project trigger';
  assert exists (select 1 from pg_trigger where tgname = 'portfolio_fields_07_select_options' and not tgisinternal), 'portfolio trigger';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 54. More option colors: one palette (option_colors()), tags keep a palette color in palette_color.
-- ---------------------------------------------------------------------------------------------

-- The palette and the nearest-base mapping.
do $$
declare
  c text;
  def text := (select pg_get_constraintdef(oid) from pg_constraint where conname = 'tags_palette_color_check');
begin
  assert cardinality(public.option_colors()) = 20, 'twenty colors';
  assert (public.option_colors())[1:9] = array['zinc', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'],
    'the first nine are the original colors, in their order';
  assert (select count(distinct x) from unnest(public.option_colors()) x) = 20, 'no repeats';
  foreach c in array public.option_colors() loop
    assert public.option_color_base(c) = any ((public.option_colors())[1:9]), c || ' maps to one of the first nine';
    if c = any ((public.option_colors())[1:9]) then
      assert public.option_color_base(c) = c, c || ' is its own base';
    end if;
    assert def like '%''' || c || '''%', 'the palette_color CHECK lists ' || c;
  end loop;
  assert (select count(*) from regexp_matches(def, '''[a-z]+''::text', 'g')) = 20, 'the CHECK lists only the palette';
  assert public.option_color_base('rose') = 'red' and public.option_color_base('cyan') = 'teal'
    and public.option_color_base('slate') = 'zinc' and public.option_color_base('yellow') = 'amber', 'nearest bases';
  assert public.option_color_base('neon') = 'neon', 'an unknown color is left alone';
end $$;

-- Tags: any palette color, kept in palette_color with the nearest base in color.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  c text;
  g uuid;
  n integer := 0;
begin
  -- The app's write: the picked color in palette_color, its base in color.
  insert into public.tags (name, color, palette_color) values ('B7F Rose', 'red', 'rose') returning id into g;
  assert (select (color, palette_color) = ('red', 'rose') from public.tags where id = g), 'rose kept, red as the base';
  insert into b7f_ids values ('tag_rose', g);
  -- A palette color sent in color (an older writer, ensure_tag) moves to palette_color.
  insert into public.tags (name, color) values ('B7F Cyan', 'cyan') returning id into g;
  assert (select (color, palette_color) = ('teal', 'cyan') from public.tags where id = g), 'cyan sent as color is kept';
  -- A base color sent alone stays as it was.
  insert into public.tags (name, color) values ('B7F Plain', 'blue') returning id into g;
  assert (select color = 'blue' and palette_color is null from public.tags where id = g), 'a base color as before';
  insert into b7f_ids values ('tag_plain', g);
  -- Inconsistent pair: the palette color wins and color follows it.
  insert into public.tags (name, color, palette_color) values ('B7F Odd', 'pink', 'lime') returning id into g;
  assert (select (color, palette_color) = ('green', 'lime') from public.tags where id = g), 'color follows palette_color';

  -- Every palette color can be picked.
  foreach c in array public.option_colors() loop
    n := n + 1;
    insert into public.tags (name, color, palette_color) values ('B7F Swatch ' || n, public.option_color_base(c), c) returning id into g;
    assert (select coalesce(palette_color, color) from public.tags where id = g) = c, c || ' reads back';
  end loop;

  -- Unknown colors are refused either way.
  begin
    insert into public.tags (name, color) values ('B7F Neon', 'neon');
    raise exception 'an unknown color must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.tags (name, color, palette_color) values ('B7F Neon', 'zinc', 'neon');
    raise exception 'an unknown palette color must be refused';
  exception when check_violation then null;
  end;
end $$;

do $$
declare
  rose uuid := (select id from b7f_ids where name = 'tag_rose');
  plain uuid := (select id from b7f_ids where name = 'tag_plain');
begin
  -- Renaming keeps the color.
  update public.tags set name = 'B7F Rose tag' where id = rose;
  assert (select (color, palette_color) = ('red', 'rose') from public.tags where id = rose), 'rename keeps rose';
  -- The app picks the base color the palette color was stored next to (red): it reads red.
  update public.tags set color = 'red', palette_color = 'red' where id = rose;
  assert (select coalesce(palette_color, color) from public.tags where id = rose) = 'red', 'red after rose';
  update public.tags set color = 'violet', palette_color = 'indigo' where id = rose;
  assert (select (color, palette_color) = ('violet', 'indigo') from public.tags where id = rose), 'indigo';
  -- The release before this one changes only color: the palette color goes.
  update public.tags set color = 'orange' where id = rose;
  assert (select color = 'orange' and palette_color is null from public.tags where id = rose), 'an older writer''s color wins';
  -- An older writer sending a palette name in color still works.
  update public.tags set color = 'fuchsia' where id = plain;
  assert (select (color, palette_color) = ('pink', 'fuchsia') from public.tags where id = plain), 'fuchsia sent as color';
end $$;

-- Someone who doesn't manage a tag can't recolor it (RLS, unchanged).
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  plain uuid := (select id from b7f_ids where name = 'tag_plain');
  hit integer;
begin
  update public.tags set color = 'teal', palette_color = 'emerald' where id = plain;
  get diagnostics hit = row_count;
  assert hit = 0, 'not the creator nor a workspace admin: nothing changes';
  assert (select palette_color from public.tags where id = plain) = 'fuchsia', 'still fuchsia';
end $$;

-- Tag stories carry the color people see; portfolio options take the whole palette.
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid;
begin
  t := public.create_task((select id from b7f_ids where name = 'a'), null, 'B7F colored task');
  insert into b7f_ids values ('t54', t);
end $$;
do $$
declare
  t uuid := (select id from b7f_ids where name = 't54');
  plain uuid := (select id from b7f_ids where name = 'tag_plain');
  p uuid := (select id from b7f_ids where name = 'p');
begin
  insert into public.task_tags (task_id, tag_id) values (t, plain);
  assert (select data ->> 'tag_color' from public.task_stories where task_id = t and kind = 'tag_added'
          order by created_at desc limit 1) = 'fuchsia', 'the tag_added story has the palette color';

  insert into public.portfolio_fields (portfolio_id, name, field_type, options)
  values (p, 'Mood', 'single_select', '[{"id": "m1", "name": "Calm", "color": "emerald"}, {"id": "m2", "name": "Bold", "color": "fuchsia"}]');
  begin
    insert into public.portfolio_fields (portfolio_id, name, field_type, options)
    values (p, 'Bad mood', 'single_select', '[{"id": "x", "name": "X", "color": "neon"}]');
    raise exception 'an unknown portfolio option color must be refused';
  exception when check_violation then null;
  end;
  -- Project field options take palette colors too (never checked in SQL; the app reads them).
  insert into public.custom_fields (project_id, name, field_type, options)
  values ((select id from b7f_ids where name = 'a'), 'Mood', 'single_select', '[{"id": "m1", "name": "Calm", "color": "sky"}]');
end $$;

reset role;
do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  g uuid;
begin
  -- ensure_tag (the importer, the old Tags field migration) keeps a palette color; unknown → Gray.
  g := public.ensure_tag(ws, 'B7F Imported', 'stone', 'b7f20029-0000-4000-8000-000000000001');
  assert (select (color, palette_color) = ('zinc', 'stone') from public.tags where id = g), 'imported stone';
  g := public.ensure_tag(ws, 'B7F Imported odd', 'neon', 'b7f20029-0000-4000-8000-000000000001');
  assert (select color = 'zinc' and palette_color is null from public.tags where id = g), 'unknown becomes Gray';

  -- Grants: the palette helpers are for signed-in people and the service role; the trigger for nobody.
  assert not has_function_privilege('anon', 'public.option_colors()', 'execute'), 'anon: option_colors';
  assert not has_function_privilege('anon', 'public.option_color_base(text)', 'execute'), 'anon: option_color_base';
  assert has_function_privilege('authenticated', 'public.option_colors()', 'execute'), 'authenticated: option_colors';
  assert has_function_privilege('authenticated', 'public.option_color_base(text)', 'execute'), 'authenticated: option_color_base';
  assert not has_function_privilege('anon', 'public.guard_tag_palette_color()', 'execute'), 'anon: the tag trigger';
  assert not has_function_privilege('authenticated', 'public.guard_tag_palette_color()', 'execute'), 'authenticated: the tag trigger';
  assert has_column_privilege('authenticated', 'public.tags', 'palette_color', 'UPDATE'), 'tag managers recolor (RLS decides)';
  assert not has_column_privilege('anon', 'public.tags', 'palette_color', 'SELECT'), 'anon reads nothing';
  assert exists (select 1 from pg_trigger where tgname = 'tags_06_palette_color' and not tgisinternal), 'tag trigger';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 49. Number field symbol: number_prefix on project and portfolio number fields, shown through
-- format_number_value() (task_field_text, rule_field_value_label); values stay plain numbers.
-- ---------------------------------------------------------------------------------------------

-- The one SQL rendering (the same vectors as tests/unit/oct29-batch7-number-prefix.test.ts).
do $$
begin
  assert public.format_number_value(1250, null) = '1,250', 'grouped';
  assert public.format_number_value(1250, '$') = '$1,250', 'the symbol first';
  assert public.format_number_value(-1250.5, '$') = '-$1,250.5', 'the sign before the symbol';
  assert public.format_number_value(0.12345, '€') = '€0.123', 'three decimals at most';
  assert public.format_number_value(1234567.891, null) = '1,234,567.891', 'millions';
  assert public.format_number_value(42.10, '#') = '#42.1', 'no trailing zeros';
  assert public.format_number_value(-0.0001, '$') = '$0', 'a value that rounds to zero has no sign';
  assert public.format_number_value(0, '₪') = '₪0', 'zero';
  assert public.format_number_value(1000, 'USD') = 'USD 1,000', 'a space after a symbol ending in a letter';
  assert public.format_number_value(-7, 'Rs') = '-Rs 7', 'and the sign still first';
  assert public.format_number_value(999, '') = '999', 'an empty symbol is none';
  assert public.format_number_value(null, '$') is null, 'no value, no text';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b7f_ids where name = 'a');
  f uuid;
  g uuid;
begin
  -- An Editor sets a symbol on a number field; surrounding spaces go, an empty one is none.
  insert into public.custom_fields (project_id, name, field_type, number_prefix, notify_on_change)
  values (a, 'Cost', 'number', '  $ ', true) returning id into f;
  assert (select number_prefix from public.custom_fields where id = f) = '$', 'trimmed';
  insert into b7f_ids values ('cost', f);
  update public.custom_fields set number_prefix = '' where id = f;
  assert (select number_prefix is null from public.custom_fields where id = f), 'empty = none';
  update public.custom_fields set number_prefix = E' € ' where id = f;
  assert (select number_prefix from public.custom_fields where id = f) = '€', 'no-break spaces trimmed too';
  update public.custom_fields set number_prefix = '₪₪₪₪' where id = f;
  assert (select char_length(number_prefix) from public.custom_fields where id = f) = 4, 'four characters (code points)';
  update public.custom_fields set number_prefix = 'US $' where id = f;
  update public.custom_fields set number_prefix = '$' where id = f;

  -- Refused: too long, control characters / line breaks, and any field that isn't a number field.
  begin
    update public.custom_fields set number_prefix = 'Euros' where id = f;
    raise exception 'five characters must be refused';
  exception when check_violation then null;
  end;
  begin
    update public.custom_fields set number_prefix = E'$\n€' where id = f;
    raise exception 'a line break must be refused';
  exception when check_violation then null;
  end;
  begin
    update public.custom_fields set number_prefix = E'$ ' || '€' where id = f;
    raise exception 'a Unicode line separator must be refused';
  exception when check_violation then null;
  end;
  begin
    update public.custom_fields set number_prefix = E'\u0007#' where id = f;
    raise exception 'a control character must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.custom_fields (project_id, name, field_type, number_prefix) values (a, 'Label', 'text', '$');
    raise exception 'a text field has no symbol';
  exception when check_violation then null;
  end;
  insert into public.custom_fields (project_id, name, field_type, number_prefix) values (a, 'Label', 'text', '  ')
  returning id into g;
  assert (select number_prefix is null from public.custom_fields where id = g), 'blank on a text field is just none';
  assert (select number_prefix from public.custom_fields where id = f) = '$', 'still $';
end $$;

-- A Viewer can't change a symbol (RLS, unchanged).
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  hit integer;
begin
  update public.custom_fields set number_prefix = '€' where id = (select id from b7f_ids where name = 'cost');
  get diagnostics hit = row_count;
  assert hit = 0, 'viewers change no field';
end $$;

-- A task with a value, followed by the owner (who hears about field changes).
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid;
begin
  t := public.create_task((select id from b7f_ids where name = 'a'), null, 'B7F costed task');
  insert into b7f_ids values ('t49', t);
end $$;
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000001', false) is not null as ok \gset
insert into public.task_followers (task_id, profile_id)
values ((select id from b7f_ids where name = 't49'), 'b7f20029-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7f_ids where name = 't49');
  f uuid := (select id from b7f_ids where name = 'cost');
  a uuid := (select id from b7f_ids where name = 'a');
begin
  insert into public.task_field_values (task_id, field_id, value) values (t, f, '1250.5');
  assert (select value from public.task_field_values where task_id = t and field_id = f) = '1250.5'::jsonb,
    'the stored value is a plain number';
  -- Filtering still compares numbers.
  assert t in (select x.task_id from public.filter_project_tasks(a, jsonb_build_object('completion', 'all',
    'fields', jsonb_build_array(jsonb_build_object('field_id', f, 'op', 'equals', 'value', 1250.5))), 'UTC') x),
    'a number filter still matches';
end $$;

-- The owner's Inbox: "Cost changed to $1,250.5".
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b7f_ids where name = 't49');
begin
  assert (select data ->> 'value_text' from public.inbox_items
           where recipient_id = 'b7f20029-0000-4000-8000-000000000001' and task_id = t and data ->> 'field_change' = 'true'
           order by created_at desc limit 1) = '$1,250.5', 'the Inbox shows the symbol';
  assert (select data ->> 'message' from public.inbox_items
           where recipient_id = 'b7f20029-0000-4000-8000-000000000001' and task_id = t and data ->> 'field_change' = 'true'
           order by created_at desc limit 1) = 'Cost changed to $1,250.5', 'in the message too';
end $$;

-- Rule text (placeholders, Send email's field line) and rule run logs.
reset role;
do $$
declare
  t uuid := (select id from b7f_ids where name = 't49');
  f uuid := (select id from b7f_ids where name = 'cost');
  a uuid := (select id from b7f_ids where name = 'a');
  task_row public.tasks;
  field_row public.custom_fields;
begin
  select * into task_row from public.tasks where id = t;
  select * into field_row from public.custom_fields where id = f;
  assert public.task_field_text(t, f) = '$1,250.5', 'task_field_text';
  assert public.rule_placeholder_value('field.Cost', task_row, a, '{}'::jsonb, 'text') = '$1,250.5', '{{field.Cost}}';
  assert public.render_rule_text_as('Budget: {{field.cost}}', t, a, '{}'::jsonb, 'text') = 'Budget: $1,250.5',
    'rendered in a rule message';
  assert public.rule_field_value_label(field_row, '-40'::jsonb) = '-$40', 'the run log''s value';
  assert public.rule_field_value_label(field_row, 'null'::jsonb) = 'empty', 'clearing still reads empty';
  -- A number field without a symbol is grouped, nothing else.
  select * into field_row from public.custom_fields where project_id = a and name = 'Budget';
  assert public.rule_field_value_label(field_row, '1250'::jsonb) = '1,250', 'no symbol';
end $$;

-- Templates and Duplicate project keep the symbol; a stored symbol that no longer fits is left out.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b7f_ids where name = 'a');
  dup jsonb;
  tmpl uuid;
  created jsonb;
begin
  dup := public.duplicate_project(a, 'B7F A copy', '{}'::jsonb);
  assert (select number_prefix from public.custom_fields
           where project_id = (dup ->> 'project_id')::uuid and name = 'Cost' and deleted_at is null) = '$',
    'Duplicate project keeps the symbol';
  assert (select number_prefix is null from public.custom_fields
           where project_id = (dup ->> 'project_id')::uuid and name = 'Budget' and deleted_at is null),
    'and no symbol stays none';
  tmpl := public.save_project_as_template(a, 'B7F costs', null, null, null);
  insert into b7f_ids values ('tmpl49', tmpl);
  created := public.create_project_from_template(tmpl, 'B7F from costs', current_date);
  assert (select number_prefix from public.custom_fields
           where project_id = (created ->> 'project_id')::uuid and name = 'Cost' and deleted_at is null) = '$',
    'a project template keeps the symbol';
end $$;

reset role;
update public.project_templates
   set content = jsonb_set(content, '{fields}', (
     select jsonb_agg(case when x ->> 'name' = 'Cost' then x || '{"number_prefix": "Dollars"}' else x end)
     from jsonb_array_elements(content -> 'fields') x))
 where id = (select id from b7f_ids where name = 'tmpl49');
set role authenticated;
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  created jsonb;
begin
  created := public.create_project_from_template((select id from b7f_ids where name = 'tmpl49'), 'B7F odd costs', current_date);
  assert (select number_prefix is null from public.custom_fields
           where project_id = (created ->> 'project_id')::uuid and name = 'Cost' and deleted_at is null),
    'a symbol that no longer fits is left out, and the copy goes on';
end $$;

-- Portfolio number fields take a symbol too.
select set_config('request.jwt.claim.sub', 'b7f20029-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b7f_ids where name = 'p');
  pf uuid;
begin
  insert into public.portfolio_fields (portfolio_id, name, field_type, number_prefix) values (p, 'Spend B7F', 'number', ' € ')
  returning id into pf;
  assert (select number_prefix from public.portfolio_fields where id = pf) = '€', 'trimmed';
  update public.portfolio_fields set number_prefix = '#' where id = pf;
  update public.portfolio_fields set number_prefix = null where id = pf;
  begin
    update public.portfolio_fields set number_prefix = 'Euros' where id = pf;
    raise exception 'five characters must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.portfolio_fields (portfolio_id, name, field_type, number_prefix) values (p, 'Note B7F', 'text', '$');
    raise exception 'a portfolio text field has no symbol';
  exception when check_violation then null;
  end;
end $$;

reset role;
do $$
begin
  assert not has_function_privilege('anon', 'public.format_number_value(numeric, text)', 'execute'), 'anon: format_number_value';
  assert has_function_privilege('authenticated', 'public.format_number_value(numeric, text)', 'execute'),
    'authenticated: format_number_value';
  assert not has_function_privilege('anon', 'public.normalize_number_prefix()', 'execute'), 'anon: the trigger';
  assert not has_function_privilege('authenticated', 'public.normalize_number_prefix()', 'execute'), 'authenticated: the trigger';
  assert has_column_privilege('authenticated', 'public.custom_fields', 'number_prefix', 'UPDATE'), 'editors set it (RLS decides)';
  assert has_column_privilege('authenticated', 'public.portfolio_fields', 'number_prefix', 'UPDATE'), 'portfolio editors too';
  assert not has_column_privilege('anon', 'public.custom_fields', 'number_prefix', 'SELECT'), 'anon reads nothing';
  assert exists (select 1 from pg_trigger where tgname = 'custom_fields_08_number_prefix' and not tgisinternal), 'project trigger';
  assert exists (select 1 from pg_trigger where tgname = 'portfolio_fields_08_number_prefix' and not tgisinternal), 'portfolio trigger';
end $$;

do $$ begin raise notice 'Oct 29 batch 7 fields (T2) smoke: all assertions passed'; end $$;
