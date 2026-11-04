-- Nov 4 notes, batch 20 (20261104010000_nov4_batch20_a.sql).
--   149 My Tasks automations: new triggers (events in trigger_config), conditions, and actions; their own
--       changes never start another My Tasks automation.
--   151 an automation that assigns (or adds followers) through a project role links the task to the role.
--   b2000000…11 b20-ana@example.com   Ana Owner   (owns the project, has the My Tasks automations)
--   b2000000…12 b20-ben@example.com   Ben Editor  (works on Ana's tasks)

\set ON_ERROR_STOP 1

create temporary table b20_ids (name text primary key, id uuid) on commit preserve rows;
grant all on b20_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('b20-ana@example.com', 'batch 20'),
  ('b20-ben@example.com', 'batch 20');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b2000000-0000-4000-8000-000000000011', 'b20-ana@example.com', now(), '{"full_name":"Ana Owner"}'),
  ('b2000000-0000-4000-8000-000000000012', 'b20-ben@example.com', now(), '{"full_name":"Ben Editor"}');

do $$
begin
  assert has_function_privilege('authenticated', 'public.my_task_rules_batch20_ready()', 'execute'), 'the app can ask';
  assert not has_function_privilege('anon', 'public.my_task_rules_batch20_ready()', 'execute'), 'nothing for anon';
  assert not has_function_privilege('authenticated', 'public.fire_my_task_rules(uuid, uuid, text, jsonb)', 'execute'), 'internal';
  assert not has_function_privilege('authenticated', 'public.rule_link_task_role(uuid, jsonb, text)', 'execute'), 'internal';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b2000000-0000-4000-8000-000000000011', false) is not null as ok \gset
do $$
declare
  p uuid;
  s uuid;
  tag uuid;
  role_id uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B20 Project') returning id into p;
  insert into public.sections (project_id, name) values (p, 'Doing') returning id into s;
  perform public.add_project_member(p, 'b20-ben@example.com', 'editor');
  insert into public.tags (workspace_id, name, color) values ('00000000-0000-4000-8000-000000000001', 'B20 Flag', 'red') returning id into tag;
  insert into public.project_roles (project_id, name, profile_id)
  values (p, 'B20 Designer', 'b2000000-0000-4000-8000-000000000012') returning id into role_id;
  insert into b20_ids values ('p', p), ('s', s), ('tag', tag), ('role', role_id);
end $$;

-- 149: the vocabulary the guard takes and refuses.
do $$
declare
  tag uuid := (select id from b20_ids where name = 'tag');
begin
  begin
    insert into public.my_task_rules (name, trigger_type, trigger_config, actions)
    values ('bad event', 'assigned', '{"event":"nope"}', '[{"type":"complete_task"}]');
    assert false, 'an unknown event is refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.my_task_rules (name, trigger_type, trigger_config, actions)
    values ('bad date', 'task_overdue', '{"date":"start","days":1}', '[{"type":"complete_task"}]');
    assert false, 'only due soon counts from the start date';
  exception when check_violation then null;
  end;
  begin
    insert into public.my_task_rules (name, trigger_type, actions)
    values ('bad comment', 'assigned', '[{"type":"add_comment","body":"  "}]');
    assert false, 'an empty comment is refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.my_task_rules (name, trigger_type, actions)
    values ('bad type', 'assigned', '[{"type":"set_task_type","kind":"approval"}]');
    assert false, 'approval is not a type a My Tasks automation sets';
  exception when check_violation then null;
  end;

  -- Assigned: name contains "B20", not created by me -> tag it and comment.
  insert into public.my_task_rules (name, trigger_type, conditions, actions) values ('B20 on assign', 'assigned',
    '[{"type":"title_contains","text":"b20"},{"type":"not_created_by_me"}]',
    jsonb_build_array(jsonb_build_object('type', 'add_tag', 'tag_id', tag), jsonb_build_object('type', 'add_comment', 'body', 'Got {{task.name}}')));
  -- A tag added: would comment, but never from inside another My Tasks automation.
  insert into public.my_task_rules (name, trigger_type, trigger_config, actions)
  values ('B20 on tag', 'assigned', jsonb_build_object('event', 'tag_added', 'tag_id', tag), '[{"type":"add_comment","body":"tag seen"}]');
  -- Someone comments -> follow up and set a start date.
  insert into public.my_task_rules (name, trigger_type, trigger_config, actions)
  values ('B20 on comment', 'assigned', '{"event":"comment_added"}', '[{"type":"add_comment","body":"Thanks!"},{"type":"set_start_date","days":0}]');
  -- Due date changed -> it becomes a milestone.
  insert into public.my_task_rules (name, trigger_type, trigger_config, conditions, actions)
  values ('B20 on due', 'assigned', '{"event":"due_date_changed"}', '[{"type":"has_due_date"}]', '[{"type":"set_task_type","kind":"milestone"}]');
  -- All subtasks done -> complete the parent.
  insert into public.my_task_rules (name, trigger_type, trigger_config, actions)
  values ('B20 on subtasks', 'assigned', '{"event":"subtasks_completed"}', '[{"type":"complete_task"}]');
  -- Completed, with the tag -> comment.
  insert into public.my_task_rules (name, trigger_type, trigger_config, conditions, actions)
  values ('B20 on done', 'assigned', '{"event":"task_completed"}', jsonb_build_array(jsonb_build_object('type', 'has_tag', 'tag_id', tag)),
    '[{"type":"add_comment","body":"All done"}]');
  -- Starts soon (start date) is a valid trigger.
  insert into public.my_task_rules (name, trigger_type, trigger_config, actions)
  values ('B20 starts', 'due_approaching', '{"date":"start","days":0}', '[{"type":"add_comment","body":"starts today"}]');
end $$;

-- Ben makes a task for Ana: "a task is assigned to me" runs (and only that automation).
select set_config('request.jwt.claim.sub', 'b2000000-0000-4000-8000-000000000012', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b20_ids where name = 'p');
  s uuid := (select id from b20_ids where name = 's');
  t uuid;
begin
  t := public.create_task(p, s, 'B20 brochure');
  update public.tasks set assignee_id = 'b2000000-0000-4000-8000-000000000011' where id = t;
  insert into b20_ids values ('t', t);
end $$;
reset role;
do $$
declare
  t uuid := (select id from b20_ids where name = 't');
  tag uuid := (select id from b20_ids where name = 'tag');
begin
  assert exists (select 1 from public.task_tags where task_id = t and tag_id = tag and deleted_at is null), 'the assign automation tagged it';
  assert exists (select 1 from public.comments where task_id = t and body = 'Got B20 brochure'
                   and author_id = 'b2000000-0000-4000-8000-000000000011'), 'it commented as Ana, with the placeholder filled in';
  assert not exists (select 1 from public.comments where task_id = t and body = 'tag seen'), 'its tag started no other My Tasks automation';
  assert not exists (select 1 from public.comments where task_id = t and body = 'Thanks!'), 'its own comment started nothing either';
  assert (select count(*) from public.my_task_rule_runs rr join public.my_task_rules ru on ru.id = rr.rule_id
          where rr.task_id = t and ru.name = 'B20 on assign' and rr.status = 'succeeded') = 1, 'one run, logged';
end $$;

-- Ben comments, changes the due date, then finishes the subtasks.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b2000000-0000-4000-8000-000000000012', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b20_ids where name = 't');
  a uuid;
  b uuid;
begin
  insert into public.comments (task_id, author_id, body) values (t, 'b2000000-0000-4000-8000-000000000012', 'Draft attached');
  assert exists (select 1 from public.comments where task_id = t and body = 'Thanks!'), 'someone else''s comment ran the comment automation';
  assert (select start_on from public.tasks where id = t) is not null, 'and set the start date';
  update public.tasks set due_on = current_date + 10, start_on = null where id = t;
  assert (select kind from public.tasks where id = t) = 'milestone', 'a due date change ran the due automation';
  a := public.create_subtask(t, 'B20 part A', null);
  b := public.create_subtask(t, 'B20 part B', null);
  update public.tasks set completed_at = now() where id = a;
  assert (select completed_at from public.tasks where id = t) is null, 'one subtask left: the parent stays open';
end $$;
reset role;

-- The last subtask done: Ana's automation completes the parent. A My Tasks automation's own change starts no
-- other My Tasks automation, so "a task of mine is completed" waits for a person's completion.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b2000000-0000-4000-8000-000000000012', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b20_ids where name = 't');
begin
  update public.tasks set completed_at = now() where parent_task_id = t and completed_at is null;
  assert (select completed_at from public.tasks where id = t) is not null, 'all subtasks done: Ana''s automation completed the parent';
  assert not exists (select 1 from public.comments where task_id = t and body = 'All done'), 'its own completion started nothing';
end $$;
do $$
declare
  t uuid := (select id from b20_ids where name = 't');
begin
  update public.tasks set completed_at = null where id = t;
  update public.tasks set completed_at = now() where id = t;
  assert exists (select 1 from public.comments where task_id = t and body = 'All done'), 'Ben completing it ran "a task of mine is completed"';
end $$;
reset role;

-- A turned-off automation runs nothing (completed tasks don't run "someone comments" either: reopen first).
do $$
declare
  t uuid := (select id from b20_ids where name = 't');
begin
  update public.tasks set completed_at = null where id = t;
  update public.my_task_rules set enabled = false where name = 'B20 on comment';
  insert into public.comments (task_id, author_id, body) values (t, 'b2000000-0000-4000-8000-000000000012', 'Another note');
  assert (select count(*) from public.comments where task_id = t and body = 'Thanks!') = 1, 'turned off: no second reply';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 151: an automation's Set assignee / Add followers through a role links the task to it.
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b2000000-0000-4000-8000-000000000011', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b20_ids where name = 'p');
  s uuid := (select id from b20_ids where name = 's');
  role_id uuid := (select id from b20_ids where name = 'role');
  r uuid;
  t uuid;
  usage_count integer;
begin
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (p, 'B20 assign designer', true, 'manual', jsonb_build_array(
    jsonb_build_object('type', 'set_assignee', 'assignee', 'project_role:' || role_id),
    jsonb_build_object('type', 'add_followers', 'people', jsonb_build_array('project_role:' || role_id))
  )) returning id into r;
  t := public.create_task(p, s, 'B20 via role');
  perform public.run_manual_rule(r, t);
  assert (select assignee_id from public.tasks where id = t) = 'b2000000-0000-4000-8000-000000000012', 'assigned to the role''s person';
  assert exists (select 1 from public.task_role_links where task_id = t and project_role_id = role_id and slot = 'assignee' and deleted_at is null),
    'linked to the role as its assignee';
  assert exists (select 1 from public.task_role_links where task_id = t and project_role_id = role_id and slot = 'follower' and deleted_at is null),
    'and as a follower';
  insert into b20_ids values ('via_role', t);

  -- Changing who fills the role moves the task along.
  perform public.set_project_role_person(role_id, 'b2000000-0000-4000-8000-000000000011', true);
  assert (select assignee_id from public.tasks where id = t) = 'b2000000-0000-4000-8000-000000000011', 'the role change reached the task';
  assert exists (select 1 from public.task_role_links where task_id = t and project_role_id = role_id and slot = 'assignee' and deleted_at is null),
    'still linked after the role change';

  -- Someone assigns it to somebody else by hand: the link ends.
  update public.tasks set assignee_id = 'b2000000-0000-4000-8000-000000000012' where id = t;
  assert not exists (select 1 from public.task_role_links where task_id = t and slot = 'assignee' and deleted_at is null),
    'a manual reassignment unlinks it';
end $$;
reset role;

do $$
begin
  raise notice 'nov4 batch 20 smoke: all assertions passed';
end $$;
