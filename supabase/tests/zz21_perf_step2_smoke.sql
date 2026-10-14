-- My Tasks and Inbox stay the same rows after the set-based reads.
-- A member's cards match the old task query. A task in a project they cannot open is left out,
-- including for a workspace admin. The Inbox page and the unread count match the old reads.
--
--   d0d0…01 step2-owner@example.com   owner of Visible and Hidden
--   d0d0…02 step2-mate@example.com    editor of Visible only
--   d0d0…03 step2-admin@example.com   workspace admin, in no project

\set ON_ERROR_STOP 1

reset role;

insert into public.allowed_emails (email, note) values
  ('step2-owner@example.com', 'perf step 2'),
  ('step2-mate@example.com', 'perf step 2'),
  ('step2-admin@example.com', 'perf step 2');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('d0d0d0d0-0000-4000-8000-000000000001', 'step2-owner@example.com', now(), '{"full_name":"Step Owner"}'),
  ('d0d0d0d0-0000-4000-8000-000000000002', 'step2-mate@example.com', now(), '{"full_name":"Step Mate"}'),
  ('d0d0d0d0-0000-4000-8000-000000000003', 'step2-admin@example.com', now(), '{"full_name":"Step Admin"}');
insert into public.workspace_admins (workspace_id, profile_id)
values ('00000000-0000-4000-8000-000000000001', 'd0d0d0d0-0000-4000-8000-000000000003');

do $$
begin
  assert has_function_privilege('authenticated', 'public.my_task_cards()', 'execute')
    and has_function_privilege('authenticated', 'public.inbox_page(text)', 'execute')
    and has_function_privilege('authenticated', 'public.inbox_unread_count()', 'execute'),
    'signed-in members can call the My Tasks and Inbox functions';
  assert not has_function_privilege('anon', 'public.my_task_cards()', 'execute')
    and not has_function_privilege('anon', 'public.inbox_page(text)', 'execute')
    and not has_function_privilege('anon', 'public.inbox_unread_count()', 'execute'),
    'anon cannot call them';
  assert (select prosecdef from pg_proc where oid = 'public.my_task_cards()'::regprocedure)
    and (select prosecdef from pg_proc where oid = 'public.inbox_page(text)'::regprocedure)
    and (select prosecdef from pg_proc where oid = 'public.inbox_unread_count()'::regprocedure),
    'the three functions are security definer';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'd0d0d0d0-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  mate uuid := 'd0d0d0d0-0000-4000-8000-000000000002';
  p uuid;
  hidden uuid;
  section uuid;
  early uuid;
  mid uuid;
  parent uuid;
  child uuid;
  done_new uuid;
  done_old uuid;
  secret uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Step2 Visible') returning id into p;
  insert into public.projects (workspace_id, name) values (ws, 'Step2 Hidden') returning id into hidden;
  insert into public.sections (project_id, name, sort_order) values (p, 'Doing', 1024) returning id into section;
  perform public.add_project_member(p, 'step2-mate@example.com', 'editor');

  early := public.create_task(p, section, 'Early');
  mid := public.create_task(hidden, null, 'Lives in the other project');
  parent := public.create_task(p, section, 'Parent');
  child := public.create_subtask(parent, 'Child');
  done_new := public.create_task(p, section, 'Done lately');
  done_old := public.create_task(p, section, 'Done earlier');

  insert into public.task_projects (task_id, project_id, sort_order) values (mid, p, 4096);

  update public.tasks set assignee_id = mate, due_on = date '2026-10-01' where id = early;
  update public.tasks set assignee_id = mate, due_on = date '2026-10-03' where id = mid;
  update public.tasks set assignee_id = mate, due_on = date '2026-10-20' where id = child;
  update public.tasks set assignee_id = mate, completed_at = timestamptz '2026-10-02' where id = done_old;
  update public.tasks set assignee_id = mate, completed_at = timestamptz '2026-10-09' where id = done_new;

  -- A task only in Hidden. Mate cannot read it, so assigning them writes no inbox row.
  insert into public.tasks (home_project_id, title, assignee_id)
  values (hidden, 'Secret', mate)
  returning id into secret;
  perform set_config('step2.secret', secret::text, false);

  perform set_config('step2.visible', p::text, false);
  perform set_config('step2.hidden', hidden::text, false);
  perform set_config('step2.early', early::text, false);
  perform set_config('step2.mid', mid::text, false);
  perform set_config('step2.parent', parent::text, false);
  perform set_config('step2.child', child::text, false);
  perform set_config('step2.done_new', done_new::text, false);
  perform set_config('step2.done_old', done_old::text, false);
end $$;

reset role;
alter table public.inbox_items disable trigger user;
insert into public.inbox_items (recipient_id, actor_id, task_id, kind, data)
select 'd0d0d0d0-0000-4000-8000-000000000002', 'd0d0d0d0-0000-4000-8000-000000000001', t.id, 'assigned', '{}'::jsonb
from public.tasks t
where t.title = 'Secret' and t.home_project_id = current_setting('step2.hidden')::uuid;
alter table public.inbox_items enable trigger user;

set role authenticated;
select set_config('request.jwt.claim.sub', 'd0d0d0d0-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  me uuid := 'd0d0d0d0-0000-4000-8000-000000000002';
  cards jsonb := public.my_task_cards();
  open_ids jsonb;
  rls_open jsonb;
  completed_ids jsonb;
  rls_completed jsonb;
  page jsonb;
  rls_page jsonb;
  private_id uuid;
begin
  private_id := public.create_private_task('Just mine');
  update public.tasks set due_on = date '2026-11-01' where id = private_id;
  cards := public.my_task_cards();

  select coalesce(jsonb_agg(e.item->>'id' order by e.ordinality), '[]'::jsonb)
    into open_ids
  from jsonb_array_elements(cards->'open') with ordinality as e(item, ordinality);
  select coalesce(jsonb_agg(t.id::text order by t.due_on nulls last, t.created_at, t.id), '[]'::jsonb)
    into rls_open
  from public.tasks t
  where t.assignee_id = me and t.deleted_at is null and t.completed_at is null;
  assert open_ids = rls_open, format('open cards %s <> query %s', open_ids, rls_open);

  assert not (open_ids ? current_setting('step2.secret')),
    'a task in a project you cannot open is not a My Task';

  assert (
    select e->>'project_name' from jsonb_array_elements(cards->'open') e
    where e->>'id' = current_setting('step2.early')
  ) = 'Step2 Visible', 'the home project is the label';
  assert (
    select e->>'project_id' from jsonb_array_elements(cards->'open') e
    where e->>'id' = current_setting('step2.mid')
  ) = current_setting('step2.visible'), 'a home project you cannot open falls back to one you can';
  assert (
    select e->>'parent_title' from jsonb_array_elements(cards->'open') e
    where e->>'id' = current_setting('step2.child')
  ) = 'Parent', 'a subtask is labelled with its parent';
  assert (
    select e->>'project_id' from jsonb_array_elements(cards->'open') e
    where e->>'id' = private_id::text
  ) is null, 'a private task has no project';

  select coalesce(jsonb_agg(e.item->>'id' order by e.ordinality), '[]'::jsonb)
    into completed_ids
  from jsonb_array_elements(cards->'completed') with ordinality as e(item, ordinality);
  select coalesce(jsonb_agg(t.id::text order by t.completed_at desc, t.id desc), '[]'::jsonb)
    into rls_completed
  from (
    select id, completed_at from public.tasks
    where assignee_id = me and deleted_at is null and completed_at is not null
    order by completed_at desc, id desc
    limit 30
  ) t;
  assert completed_ids = rls_completed, 'completed cards are the latest 30';
  assert completed_ids->>0 = current_setting('step2.done_new'), 'the newer completion comes first';

  perform public.my_tasks_layout();
  assert exists (select 1 from public.my_tasks_layout() where task_id = current_setting('step2.early')::uuid),
    'an open task is placed';
  assert not exists (
    select 1 from public.my_tasks_layout() where task_id = current_setting('step2.secret')::uuid
  ), 'the layout skips a task you cannot open';

  page := public.inbox_page('activity');
  select coalesce(jsonb_agg(e.item->>'id' order by e.ordinality), '[]'::jsonb) into open_ids
  from jsonb_array_elements(page) with ordinality as e(item, ordinality);
  select coalesce(jsonb_agg(x.id::text order by x.n), '[]'::jsonb) into rls_page
  from (
    select i.id, row_number() over (order by i.created_at desc, i.id desc) as n
    from public.inbox_items i
    join public.tasks t on t.id = i.task_id and t.deleted_at is null
    where i.archived_at is null
    order by i.created_at desc, i.id desc
    limit 100
  ) x;
  assert open_ids = rls_page, format('inbox page %s <> query %s', open_ids, rls_page);
  assert exists (
    select 1 from jsonb_array_elements(page) e
    where e->>'task_id' = current_setting('step2.early') and e->>'task_title' = 'Early'
  ), 'an assignment is on the page with its title';
  assert not exists (
    select 1 from jsonb_array_elements(page) e
    where e->>'task_id' = current_setting('step2.secret')
  ), 'an inbox row for a task you cannot open is left out';

  assert public.inbox_unread_count() = (
    select count(*)::integer from public.inbox_items where read_at is null and archived_at is null
  ), 'the unread count matches the inbox read';
end $$;

select set_config('request.jwt.claim.sub', 'd0d0d0d0-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
begin
  assert public.my_task_cards() = '{"open":[],"completed":[]}'::jsonb,
    'a workspace admin who is not the assignee sees no My Tasks';
  assert public.inbox_page('activity') = '[]'::jsonb, 'and no inbox page';
  assert public.inbox_unread_count() = 0, 'and no unread count';
  assert not exists (select 1 from public.tasks where title = 'Secret'),
    'the admin cannot read the hidden task directly either';
end $$;

select set_config('request.jwt.claim.sub', 'd0d0d0d0-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  cards jsonb := public.my_task_cards();
begin
  assert not exists (
    select 1 from jsonb_array_elements(cards->'open') e
    where e->>'id' = current_setting('step2.early')
  ), 'the owner does not see tasks assigned to someone else';
end $$;

reset role;

select 'perf step 2 smoke: all assertions passed' as result;
