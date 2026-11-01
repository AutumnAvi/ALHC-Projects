-- Nov 1 notes, batch 9b (20261101030000_nov1_batch9b_a.sql): My tasks as a checklist (checked items,
-- "Set a date" prompts, repeat after completion) and Home (home_dashboard). Every section starts as the
-- database owner with no signed-in person.

\set ON_ERROR_STOP 1

reset role;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset

insert into public.allowed_emails (email, note) values
  ('b9b-lead@example.com', 'nov 1 batch 9b'),
  ('b9b-doer@example.com', 'nov 1 batch 9b'),
  ('b9b-admin@example.com', 'nov 1 batch 9b'),
  ('b9b-outsider@example.com', 'nov 1 batch 9b');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b9b90101-0000-4000-8000-000000000001', 'b9b-lead@example.com', now(), '{"full_name":"Lea Lead"}'),
  ('b9b90101-0000-4000-8000-000000000002', 'b9b-doer@example.com', now(), '{"full_name":"Dov Doer"}'),
  ('b9b90101-0000-4000-8000-000000000003', 'b9b-admin@example.com', now(), '{"full_name":"Ada Admin"}'),
  ('b9b90101-0000-4000-8000-000000000004', 'b9b-outsider@example.com', now(), '{"full_name":"Oz Outsider"}');
select public.seed_workspace_admin('b9b-admin@example.com');

create temporary table b9b_ids (name text primary key, id uuid);
grant all on b9b_ids to authenticated, anon, service_role;

-- =================================================================================================
-- 64. Checked items preference: own row, three choices
-- =================================================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', 'b9b90101-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  assert public.set_my_tasks_checked('stay') = 'stay', 'stay is saved';
  assert public.set_my_tasks_checked('hide') = 'hide', 'hide is saved';
  assert public.set_my_tasks_checked('sink') = 'sink', 'sink is saved';
  assert (select my_tasks_checked from public.profile_preferences
          where profile_id = 'b9b90101-0000-4000-8000-000000000002') = 'sink', 'own row holds it';
  begin
    perform public.set_my_tasks_checked('vanish');
    raise exception 'an unknown mode must be refused';
  exception when check_violation then null;
  end;
  begin
    update public.profile_preferences set my_tasks_checked = 'nope'
    where profile_id = 'b9b90101-0000-4000-8000-000000000002';
    raise exception 'the CHECK must refuse a bad mode';
  exception when check_violation then null;
  end;
end $$;

-- Nobody else's row changes.
select set_config('request.jwt.claim.sub', 'b9b90101-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
declare
  n integer;
begin
  update public.profile_preferences set my_tasks_checked = 'stay'
  where profile_id = 'b9b90101-0000-4000-8000-000000000002';
  get diagnostics n = row_count;
  assert n = 0, 'another person''s preference is out of reach';
  assert (select count(*) from public.profile_preferences where profile_id = 'b9b90101-0000-4000-8000-000000000002') = 0,
    'and unreadable';
end $$;
reset role;

-- =================================================================================================
-- 64. The checklist's cards: start date, repeat, assigned_at, and the "Set a date" prompt
-- =================================================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', 'b9b90101-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid;
  t_new uuid;
  t_dated uuid;
  t_repeat uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B9b Lead project')
  returning id into p;
  perform public.add_project_member(p, 'b9b-doer@example.com', 'editor');
  t_new := public.create_task(p, null, 'B9b no date yet');
  t_dated := public.create_task(p, null, 'B9b has a date');
  t_repeat := public.create_task(p, null, 'B9b repeats');
  update public.tasks set assignee_id = 'b9b90101-0000-4000-8000-000000000002' where id in (t_new, t_dated, t_repeat);
  update public.tasks set due_on = current_date + 3, start_on = current_date + 1 where id = t_dated;
  update public.tasks set due_on = current_date + 5,
    recurrence = '{"freq":"daily","interval":3,"from_completion":true}' where id = t_repeat;
  insert into b9b_ids values ('project', p), ('new', t_new), ('dated', t_dated), ('repeat', t_repeat);
end $$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b9b90101-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  cards jsonb := public.my_task_cards();
  card jsonb;
  mine uuid;
begin
  select c into card from jsonb_array_elements(cards -> 'open') c where c ->> 'id' = (select id::text from b9b_ids where name = 'new');
  assert (card ->> 'date_prompt')::boolean, 'a dateless task someone else assigned asks for a date';
  assert card ->> 'assigned_at' is not null, 'assigned_at comes back';
  select c into card from jsonb_array_elements(cards -> 'open') c where c ->> 'id' = (select id::text from b9b_ids where name = 'dated');
  assert not (card ->> 'date_prompt')::boolean, 'a dated task doesn''t';
  assert card ->> 'start_on' = (current_date + 1)::text, 'start_on comes back';
  select c into card from jsonb_array_elements(cards -> 'open') c where c ->> 'id' = (select id::text from b9b_ids where name = 'repeat');
  assert (card ->> 'recurring')::boolean, 'recurring comes back';

  -- A private task the person made for themself isn't news.
  mine := public.create_private_task('B9b my own note');
  select c into card from jsonb_array_elements(public.my_task_cards() -> 'open') c where c ->> 'id' = mine::text;
  assert not (card ->> 'date_prompt')::boolean, 'my own task doesn''t ask';

  -- "Not now" puts the prompt away (and only remembers readable tasks).
  perform public.dismiss_task_date_prompt((select id from b9b_ids where name = 'new'));
  perform public.dismiss_task_date_prompt((select id from b9b_ids where name = 'new'));
  assert (select cardinality(date_prompt_dismissed) from public.profile_preferences
          where profile_id = 'b9b90101-0000-4000-8000-000000000002') = 1, 'remembered once';
  select c into card from jsonb_array_elements(public.my_task_cards() -> 'open') c
  where c ->> 'id' = (select id::text from b9b_ids where name = 'new');
  assert not (card ->> 'date_prompt')::boolean, 'Not now hides the prompt';
  begin
    perform public.dismiss_task_date_prompt('b9b90101-dead-4000-8000-000000000000');
    raise exception 'an unknown task must be refused';
  exception when no_data_found then null;
  end;
end $$;
reset role;

-- =================================================================================================
-- 64. Repeat after completion
-- =================================================================================================

do $$
begin
  assert public.normalize_recurrence('{"freq":"weekly","from_completion":true}') ->> 'from_completion' = 'true',
    'from_completion is kept';
  assert not public.normalize_recurrence('{"freq":"weekly","from_completion":false}') ? 'from_completion',
    'off is the same as missing';
  begin
    perform public.normalize_recurrence('{"freq":"weekly","from_completion":"yes"}');
    raise exception 'a non-boolean must be refused';
  exception when check_violation then null;
  end;
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b9b90101-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b9b_ids where name = 'repeat');
  nxt uuid;
  fixed uuid;
  tz text;
begin
  tz := public.safe_timezone(null);
  -- Due in 5 days, completed today, every 3 days after completion: the next one is due in 3 days.
  update public.tasks set completed_at = now() where id = t;
  select recurrence_next_id into nxt from public.tasks where id = t;
  assert nxt is not null, 'the next occurrence was made';
  assert (select due_on from public.tasks where id = nxt) = (now() at time zone tz)::date + 3,
    format('counted from completion: %s', (select due_on from public.tasks where id = nxt));
  assert (select recurrence ->> 'from_completion' from public.tasks where id = nxt) = 'true', 'and keeps repeating that way';

  -- Without it, the same rule counts from the due date.
  fixed := public.create_private_task('B9b fixed schedule');
  update public.tasks set due_on = current_date + 5, recurrence = '{"freq":"daily","interval":3}' where id = fixed;
  update public.tasks set completed_at = now() where id = fixed;
  assert (select n.due_on from public.tasks o join public.tasks n on n.id = o.recurrence_next_id where o.id = fixed)
    = current_date + 8, 'a fixed schedule counts from the due date';
end $$;
reset role;

-- =================================================================================================
-- 65. Home: my projects for everyone, the lead cards only for people who lead
-- =================================================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', 'b9b90101-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b9b_ids where name = 'project');
  late_task uuid;
  done_task uuid;
  home jsonb;
begin
  late_task := public.create_task(p, null, 'B9b late one');
  update public.tasks set due_on = current_date - 2, assignee_id = 'b9b90101-0000-4000-8000-000000000002' where id = late_task;
  done_task := public.create_task(p, null, 'B9b done this week');
  update public.tasks set assignee_id = 'b9b90101-0000-4000-8000-000000000001', completed_at = now() where id = done_task;

  home := public.home_dashboard('UTC');
  assert jsonb_typeof(home -> 'lead') = 'object', 'an Owner gets the lead cards';
  assert (home -> 'lead' ->> 'project_count')::integer >= 1, 'over the projects they lead';
  assert exists (select 1 from jsonb_array_elements(home -> 'projects') x where x ->> 'id' = p::text), 'and sees the project';
  assert exists (
    select 1 from jsonb_array_elements(home -> 'lead' -> 'late' -> 'tasks') x
    where x ->> 'id' = late_task::text and (x ->> 'overdue')::boolean and x ->> 'assignee_name' = 'Dov Doer'
  ), 'the overdue task is in Late & at-risk';
  assert exists (
    select 1 from jsonb_array_elements(home -> 'lead' -> 'load' -> 'people') x
    where x ->> 'profile_id' = 'b9b90101-0000-4000-8000-000000000002' and (x ->> 'overdue')::integer >= 1
  ), 'team load counts the doer''s overdue work';
  assert (home -> 'lead' -> 'done' ->> 'total')::integer >= 1, 'done this week counts';
  assert exists (
    select 1 from jsonb_array_elements(home -> 'lead' -> 'health') x
    where x ->> 'id' = p::text and (x ->> 'overdue')::integer >= 1 and (x ->> 'completed')::integer >= 1
  ), 'project health counts the project';
end $$;

-- An Editor (no project they lead, not a workspace admin) gets their projects and no lead cards.
select set_config('request.jwt.claim.sub', 'b9b90101-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  home jsonb := public.home_dashboard('UTC');
  row jsonb;
begin
  assert jsonb_typeof(home -> 'lead') = 'null', 'no lead cards for an Editor';
  select x into row from jsonb_array_elements(home -> 'projects') x where x ->> 'id' = (select id::text from b9b_ids where name = 'project');
  assert row is not null, 'their project is listed';
  assert (row ->> 'my_open')::integer >= 2, 'with their open work counted';
  assert (row ->> 'total')::integer >= 4 and (row ->> 'completed')::integer >= 1, 'and its progress';
end $$;

-- A workspace admin who isn't in the project sees nothing of it; someone in no project sees nothing.
select set_config('request.jwt.claim.sub', 'b9b90101-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  home jsonb := public.home_dashboard('UTC');
begin
  assert not exists (
    select 1 from jsonb_array_elements(home -> 'projects') x where x ->> 'id' = (select id::text from b9b_ids where name = 'project')
  ), 'a workspace admin doesn''t see a project they aren''t in';
  assert jsonb_typeof(home -> 'lead') = 'null'
    or not exists (
      select 1 from jsonb_array_elements(home -> 'lead' -> 'health') x where x ->> 'id' = (select id::text from b9b_ids where name = 'project')
    ), 'nor in the lead cards';
end $$;

select set_config('request.jwt.claim.sub', 'b9b90101-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
declare
  home jsonb := public.home_dashboard(null);
begin
  assert not exists (
    select 1 from jsonb_array_elements(home -> 'projects') x where x ->> 'id' = (select id::text from b9b_ids where name = 'project')
  ), 'an outsider gets nothing of it';
end $$;
reset role;

set role anon;
do $$
begin
  begin
    perform public.home_dashboard('UTC');
    raise exception 'anon must not run home_dashboard';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select 'zz39 nov1 batch9b smoke passed' as result;
