-- Nov 16 batch 42 (20261116010000_nov16_batch42_a.sql).
--   1. inbox_page_window(tab, max_items): definer like inbox_page, authenticated only; with 100 it is
--      exactly inbox_page; with 101 it adds the 101st item only when there is one (audit C97: the Inbox
--      tells "exactly 100" from "more than 100"); the size is capped to 1–200; someone else's items never.
--   2. Dates in automation text (audit C71): {{task.due_date}}, {{task.start_date}}, {{today}} read
--      "Oct 24, 2026" (empty without a date), and so does a date custom field ({{field.Launch}}) now.
--
--   e4200000-…-01 b42-owner@example.com   owns the project, gets 99 / 100 / 101 / 150 items as recipients 2–5
--   e4200000-…-02 … -05                    recipients with 99, 100, 101, 150 items

\set ON_ERROR_STOP 1

reset role;

insert into public.allowed_emails (email, note)
select format('b42-%s@example.com', n), 'batch 42' from generate_series(1, 5) n;
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
select format('e4200000-0000-4000-8000-00000000000%s', n)::uuid, format('b42-%s@example.com', n), now(),
       jsonb_build_object('full_name', format('B42 Person %s', n))
from generate_series(1, 5) n;

-- 1. The function ------------------------------------------------------------------------------------

do $$
declare
  fn regprocedure := 'public.inbox_page_window(text, integer)'::regprocedure;
begin
  assert (select prosecdef from pg_catalog.pg_proc where oid = fn), 'inbox_page_window is definer, like inbox_page';
  assert (select proconfig from pg_catalog.pg_proc where oid = fn) = array['search_path=""'], 'empty search_path';
  assert (select provolatile from pg_catalog.pg_proc where oid = fn)
       = (select provolatile from pg_catalog.pg_proc where oid = 'public.inbox_page(text)'::regprocedure), 'same volatility';
  assert has_function_privilege('authenticated', fn, 'execute'), 'authenticated calls it';
  assert not has_function_privilege('anon', fn, 'execute'), 'anon does not';
  assert not has_function_privilege('authenticated', 'public.alhc_plain_date(text)', 'execute')
    and not has_function_privilege('anon', 'public.alhc_plain_date(text)', 'execute'), 'alhc_plain_date is internal';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'e4200000-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid;
  s uuid;
  t uuid;
  n integer;
begin
  insert into public.projects (workspace_id, name) values (ws, 'B42 Project') returning id into p;
  insert into public.sections (project_id, name, sort_order) values (p, 'Doing', 1024) returning id into s;
  for n in 2 .. 5 loop
    perform public.add_project_member(p, format('b42-%s@example.com', n), 'editor');
  end loop;
  t := public.create_task(p, s, 'B42 Task');
  perform set_config('b42.project', p::text, false);
  perform set_config('b42.task', t::text, false);
end $$;

reset role;
alter table public.inbox_items disable trigger user;
insert into public.inbox_items (recipient_id, actor_id, task_id, kind, data, created_at)
select r.id, 'e4200000-0000-4000-8000-000000000001', current_setting('b42.task')::uuid, 'comment', '{}'::jsonb,
       timestamptz '2026-11-01' + make_interval(mins => g)
from (values ('e4200000-0000-4000-8000-000000000002'::uuid, 99), ('e4200000-0000-4000-8000-000000000003'::uuid, 100),
             ('e4200000-0000-4000-8000-000000000004'::uuid, 101), ('e4200000-0000-4000-8000-000000000005'::uuid, 150)) r(id, items)
cross join lateral generate_series(1, r.items) g;
alter table public.inbox_items enable trigger user;

set role authenticated;

do $$
declare
  people uuid[] := array['e4200000-0000-4000-8000-000000000002', 'e4200000-0000-4000-8000-000000000003',
                         'e4200000-0000-4000-8000-000000000004', 'e4200000-0000-4000-8000-000000000005']::uuid[];
  counts integer[] := array[99, 100, 101, 150];
  tab text;
  i integer;
  page jsonb;
  win jsonb;
  more jsonb;
begin
  for i in 1 .. 4 loop
    perform set_config('request.jwt.claim.sub', people[i]::text, false);
    foreach tab in array array['activity', 'archive', 'bookmarks', 'mentioned'] loop
      page := public.inbox_page(tab);
      win := public.inbox_page_window(tab, 100);
      assert win = page, format('%s / %s: inbox_page_window(…, 100) is inbox_page', counts[i], tab);
      assert public.inbox_page_window(tab, null) = page, 'null = 100';
    end loop;
    more := public.inbox_page_window('activity', 101);
    assert jsonb_array_length(more) = least(counts[i], 101),
      format('%s items: the 101 window holds %s', counts[i], jsonb_array_length(more));
    -- "More than shown" exactly when there are more than 100.
    assert (jsonb_array_length(more) > 100) = (counts[i] > 100), format('%s items: has more', counts[i]);
    -- The first 100 of the window are the page, in order.
    assert (select jsonb_agg(e order by o) from jsonb_array_elements(more) with ordinality x(e, o) where o <= 100)
         = public.inbox_page('activity'), 'same first 100, same order';
    assert jsonb_array_length(public.inbox_page_window('activity', 1000)) = least(counts[i], 200), 'capped at 200';
    assert jsonb_array_length(public.inbox_page_window('activity', 0)) = 1, 'at least 1';
  end loop;

  -- Someone with none of these items sees none of them.
  perform set_config('request.jwt.claim.sub', 'e4200000-0000-4000-8000-000000000001', false);
  assert jsonb_array_length(public.inbox_page_window('activity', 200)) = 0, 'never someone else''s items';
end $$;

-- 2. Dates in automation text --------------------------------------------------------------------------
-- The renderers are internal (automations run them as the owner), so this runs as the owner too.

reset role;
select set_config('request.jwt.claim.sub', 'e4200000-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid := current_setting('b42.project')::uuid;
  t uuid := current_setting('b42.task')::uuid;
  f uuid;
  text_field uuid;
begin
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Launch', 'date') returning id into f;
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Code', 'text') returning id into text_field;
  perform set_config('b42.field', f::text, false);

  -- No dates yet: the placeholders are empty, {due} says so.
  assert public.render_rule_text_as('[{{task.due_date}}][{{task.start_date}}][{{field.Launch}}] {due}', t, p, '{}', 'plain')
       = '[][][] no due date', 'no dates: empty';

  update public.tasks set start_on = date '2026-11-02', due_on = date '2026-11-14' where id = t;
  insert into public.task_field_values (task_id, field_id, value) values (t, f, '"2026-12-01"'::jsonb);
  insert into public.task_field_values (task_id, field_id, value) values (t, text_field, '"2026-12-01"'::jsonb);

  assert public.render_rule_text_as('Due {{task.due_date}}, starts {{task.start_date}}, {due}', t, p, '{}', 'plain')
       = 'Due Nov 14, 2026, starts Nov 2, 2026, Nov 14', 'task dates read as plain dates';
  assert public.render_rule_text_as('Launch {{field.Launch}} / {{field:launch}}', t, p, '{}', 'plain')
       = 'Launch Dec 1, 2026 / Dec 1, 2026', 'a date field reads as a plain date';
  assert public.render_rule_text_as('{{field.Code}}', t, p, '{}', 'plain') = '2026-12-01',
    'a text field keeps its text, even one that looks like a date';
  assert public.render_rule_text_as('{{field.Launch}}', t, p, '{}', 'slack') = 'Dec 1, 2026', 'Slack too';
  assert public.render_rule_text_as('{{today}}', t, p, '{}', 'plain') ~ '^[A-Z][a-z]{2} [1-9][0-9]?, [0-9]{4}$',
    'today reads as a plain date';
  assert public.task_field_text(t, f) = 'Dec 1, 2026', 'task_field_text';
end $$;

do $$
begin
  assert public.alhc_plain_date('2026-02-30') = '2026-02-30', 'not a real date: unchanged, no error';
  assert public.alhc_plain_date('soon') = 'soon', 'not a date: unchanged';
  assert public.alhc_plain_date(null) is null, 'null stays null';
  assert public.alhc_plain_date('2026-01-05') = 'Jan 5, 2026', 'no leading zero';
end $$;
