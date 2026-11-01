-- Nov 1 notes, batch 12 (20261101060000_nov1_batch12_a.sql): email-in activity and automation comments.
--   83 task_email_activity: a forwarded email's task ("Created by email from … · subject") and a
--      submitter's emailed reply ("Comment added by email from …"), read with the task; the one-time
--      backfill (fixtures/before_20261101060000_nov1_batch12_a.sql) and what earlier suites sent in.
--   84 People in an automation's comment are @mentions (or a name), never an email address; other rule
--      text is unchanged. The run markers read rule_runs, which task readers already see.
--   a3100120…01 b12-owner@example.com    Bo Owner (owns P)
--   a3100120…02 b12-viewer@example.com   Vi Viewer (Viewer of P)
--   a3100120…03 b12-other@example.com    Oz Other (not in P)
--   a3100120…04 b12-nameless@example.com (no name; Editor of P)
--   a3100120…05 b12-emailname@example.com (their "name" is their email address; Editor of P)

\set ON_ERROR_STOP 1

create temporary table b12_ids (name text primary key, id uuid) on commit preserve rows;
grant all on b12_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('b12-owner@example.com', 'batch 12'),
  ('b12-viewer@example.com', 'batch 12'),
  ('b12-other@example.com', 'batch 12'),
  ('b12-nameless@example.com', 'batch 12'),
  ('b12-emailname@example.com', 'batch 12');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a3100120-0000-4000-8000-000000000001', 'b12-owner@example.com', now(), '{"full_name":"Bo Owner"}'),
  ('a3100120-0000-4000-8000-000000000002', 'b12-viewer@example.com', now(), '{"full_name":"Vi Viewer"}'),
  ('a3100120-0000-4000-8000-000000000003', 'b12-other@example.com', now(), '{"full_name":"Oz Other"}'),
  ('a3100120-0000-4000-8000-000000000004', 'b12-nameless@example.com', now(), '{}'),
  ('a3100120-0000-4000-8000-000000000005', 'b12-emailname@example.com', now(), '{}');
update public.profiles set full_name = null where id = 'a3100120-0000-4000-8000-000000000004';
update public.profiles set full_name = 'b12-emailname@example.com' where id = 'a3100120-0000-4000-8000-000000000005';

-- ---------------------------------------------------------------------------------------------
-- Shape: a table nobody writes, read with the task
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert (select relrowsecurity from pg_class where oid = 'public.task_email_activity'::regclass), 'RLS is on';
  assert has_table_privilege('authenticated', 'public.task_email_activity', 'select'), 'members read it';
  assert not has_table_privilege('authenticated', 'public.task_email_activity', 'insert')
    and not has_table_privilege('authenticated', 'public.task_email_activity', 'update')
    and not has_table_privilege('authenticated', 'public.task_email_activity', 'truncate'), 'nobody writes it';
  assert not has_table_privilege('anon', 'public.task_email_activity', 'select'), 'anon reads nothing';
  assert not has_function_privilege('authenticated', 'public.on_comment_email_activity()', 'execute')
    and not has_function_privilege('anon', 'public.on_comment_email_activity()', 'execute'), 'the trigger is internal';
  assert not has_function_privilege('authenticated', 'public.profile_mention_name(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.rule_comment_people(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.profile_handle(uuid)', 'execute'), 'the helpers are internal';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 83 The backfill (fixture) and what earlier suites sent in
-- ---------------------------------------------------------------------------------------------

do $$
declare
  ea public.task_email_activity;
begin
  select * into ea from public.task_email_activity
  where task_id = 'f12f12f1-0000-4000-8000-0000000000b1' and kind = 'task_created';
  assert ea.id is not null, 'an old forward got its "created by email" line';
  assert ea.sender_email = 'legacy-forwarder@example.com' and ea.sender_profile_id = 'f12f12f1-0000-4000-8000-000000000001'
    and ea.project_id = 'f12f12f1-0000-4000-8000-0000000000a1' and ea.subject = 'Legacy brief'
    and ea.created_at = '2026-10-20T09:00:00Z', 'the forwarder, the project, the task''s name for the subject, the time';
  select * into ea from public.task_email_activity where comment_id = 'f12f12f1-0000-4000-8000-0000000000c1';
  assert ea.kind = 'comment_added' and ea.sender_email = 'client@example.org' and ea.sender_profile_id is null
    and ea.subject = 'Re: "Brief" submission received' and ea.project_id = 'f12f12f1-0000-4000-8000-0000000000a1'
    and ea.created_at = '2026-10-21T10:00:00Z', 'an old emailed reply got its "comment added by email" line';
  assert (select count(*) from public.task_email_activity where task_id = 'f12f12f1-0000-4000-8000-0000000000b1') = 2,
    'a rejected forward adds nothing';

  -- zz15 forwarded "Fwd: RE: Brief for Q4"; zz19 / zz27 / zz28 posted submitters' emailed replies; zz32 / zz34
  -- posted review outcomes (received comments that didn't come by email).
  assert exists (
    select 1 from public.task_email_activity a join public.email_forwards f on f.task_id = a.task_id
    where a.kind = 'task_created' and f.provider_id = 'fw-1' and a.subject = 'Fwd: RE: Brief for Q4'
      and a.sender_email = 'r1-editor@example.com' and a.sender_profile_id = f.profile_id and a.project_id = f.project_id
  ), 'a forward records its sender and the subject as it came';
  assert not exists (
    select 1 from public.email_forwards f join public.tasks t on t.id = f.task_id
    where f.status = 'created'
      and not exists (select 1 from public.task_email_activity a where a.task_id = f.task_id and a.kind = 'task_created')
  ), 'every task made from a forward has its line';
  assert exists (select 1 from public.comments where email_direction = 'received' and review_check_id is null),
    'earlier suites posted emailed replies';
  assert not exists (
    select 1 from public.comments c
    where c.email_direction = 'received' and c.review_check_id is null
      and nullif(btrim(coalesce(c.email_address, '')), '') is not null
      and not exists (select 1 from public.task_email_activity a where a.comment_id = c.id and a.kind = 'comment_added')
  ), 'every emailed reply has its line';
  assert exists (select 1 from public.comments where email_direction = 'received' and review_check_id is not null),
    'earlier suites posted review outcomes';
  assert not exists (
    select 1 from public.task_email_activity a join public.comments c on c.id = a.comment_id where c.review_check_id is not null
  ), 'a review''s outcome came from the review page, not by email';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Setup: P (Inbox, Done), a People field, members
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100120-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid;
  s uuid;
  f uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B12 Email and automations')
    returning id into p;
  insert into b12_ids values ('p', p);
  perform public.add_project_member(p, 'b12-viewer@example.com', 'viewer');
  perform public.add_project_member(p, 'b12-nameless@example.com', 'editor');
  perform public.add_project_member(p, 'b12-emailname@example.com', 'editor');
  insert into public.sections (project_id, name, sort_order) values (p, 'Inbox', 1024) returning id into s;
  insert into b12_ids values ('inbox', s);
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Reviewer', 'people') returning id into f;
  insert into b12_ids values ('reviewer', f);
end $$;
reset role;

-- The owner's forwarding address, sending into P.
set role authenticated;
do $$
declare
  a public.email_forwarding_addresses;
begin
  a := public.my_forwarding_address();
  update public.email_forwarding_addresses set default_project_id = (select id from b12_ids where name = 'p') where id = a.id;
  insert into b12_ids values ('addr', a.id);
end $$;
reset role;

-- ---------------------------------------------------------------------------------------------
-- 83 A forwarded email (the inbound route, as service_role)
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
set role service_role;
do $$
declare
  result jsonb;
  t uuid;
begin
  result := public.post_email_forward(
    (select token from public.email_forwarding_addresses where id = (select id from b12_ids where name = 'addr')),
    'B12-Owner@Example.com', true, '  Fwd: Spring flyer  ', 'Please print 200.', 'b12-fw-1');
  assert result ->> 'status' = 'created', result::text;
  t := (result ->> 'task_id')::uuid;
  insert into b12_ids values ('fw_task', t);
  assert exists (
    select 1 from public.task_email_activity
    where task_id = t and kind = 'task_created' and sender_email = 'b12-owner@example.com'
      and sender_profile_id = 'a3100120-0000-4000-8000-000000000001' and subject = 'Fwd: Spring flyer'
      and project_id = (select id from b12_ids where name = 'p') and comment_id is null
  ), 'a forwarded email''s task records who sent it and the subject';
  -- A retried webhook makes no second task and no second line.
  result := public.post_email_forward(
    (select token from public.email_forwarding_addresses where id = (select id from b12_ids where name = 'addr')),
    'b12-owner@example.com', true, 'Fwd: Spring flyer', 'x', 'b12-fw-1');
  assert result ->> 'status' = 'duplicate', result::text;
  assert (select count(*) from public.task_email_activity where task_id = t) = 1, 'one line per task';
  -- A refused forward adds nothing.
  result := public.post_email_forward(
    (select token from public.email_forwarding_addresses where id = (select id from b12_ids where name = 'addr')),
    'b12-owner@example.com', false, 'Unverified', 'x', 'b12-fw-2');
  assert result ->> 'reason' = 'not_authenticated', result::text;
  assert not exists (select 1 from public.task_email_activity where subject = 'Unverified'), 'refused mail leaves no line';
end $$;
reset role;

-- A comment that came in by email (what post_submitter_reply writes: authorless, received).
insert into public.comments (task_id, author_id, body, email_direction, email_address, email_subject)
values ((select id from b12_ids where name = 'fw_task'), null, 'Can it be glossy?', 'received', 'client@example.org', 'Re: Spring flyer');

do $$
begin
  assert exists (
    select 1 from public.task_email_activity a join public.comments c on c.id = a.comment_id
    where a.task_id = (select id from b12_ids where name = 'fw_task') and a.kind = 'comment_added'
      and a.sender_email = 'client@example.org' and a.subject = 'Re: Spring flyer'
      and a.project_id = (select id from b12_ids where name = 'p') and a.created_at = c.created_at
  ), 'an emailed comment records its sender and subject';
end $$;

-- A person's own comment adds nothing.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100120-0000-4000-8000-000000000001', false) is not null as ok \gset
insert into public.comments (task_id, body) values ((select id from b12_ids where name = 'fw_task'), 'On it');
reset role;
do $$
begin
  assert (select count(*) from public.task_email_activity where task_id = (select id from b12_ids where name = 'fw_task')) = 2,
    'only email-in is recorded';
end $$;

-- Read with the task: the project's Viewer reads both lines (as the Overview does, by project), an
-- outsider reads nothing, and nobody writes.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100120-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  assert (select count(*) from public.task_email_activity where project_id = (select id from b12_ids where name = 'p')) = 2,
    'a Viewer reads the project''s email-in';
  begin
    insert into public.task_email_activity (task_id, kind, sender_email)
    values ((select id from b12_ids where name = 'fw_task'), 'task_created', 'forged@example.com');
    raise exception 'a client wrote an email-in line';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', 'a3100120-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.task_email_activity where task_id = (select id from b12_ids where name = 'fw_task')),
    'someone outside the project reads nothing';
  assert not exists (select 1 from public.task_email_activity where project_id = (select id from b12_ids where name = 'p')),
    'nor the project''s list';
end $$;
reset role;

-- ---------------------------------------------------------------------------------------------
-- 84 People in an automation's comment
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert public.profile_handle('a3100120-0000-4000-8000-000000000001') = '@Bo Owner', 'a name stays a name';
  assert public.profile_handle('a3100120-0000-4000-8000-000000000004') = '@b12-nameless', 'no name: the email''s first part';
  assert public.profile_handle('a3100120-0000-4000-8000-000000000005') = '@b12-emailname', 'a "name" that is an email isn''t used';
  assert public.profile_mention_name('a3100120-0000-4000-8000-000000000005') = 'b12-emailname';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100120-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from b12_ids where name = 'p');
  t uuid;
begin
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions) values
    (p, 'Greeter', true, 'assignee_changed', '{}',
      '[{"type": "add_comment", "body": "hi {{task.assignee}} ({{task.assignee.name}}, {assignee}); reviewer {{field.Reviewer}}; by {{task.creator.name}}"}]');
  t := public.create_task(p, (select id from b12_ids where name = 'inbox'), 'Greeting task');
  insert into b12_ids values ('greet', t);
  insert into public.task_field_values (task_id, field_id, value)
  values (t, (select id from b12_ids where name = 'reviewer'), '["a3100120-0000-4000-8000-000000000005"]');
end $$;
-- A separate statement: changes made in the task's creating transaction don't fire assignee rules.
update public.tasks set assignee_id = 'a3100120-0000-4000-8000-000000000004' where id = (select id from b12_ids where name = 'greet');
reset role;

do $$
declare
  c public.comments;
begin
  select * into c from public.comments where task_id = (select id from b12_ids where name = 'greet') and rule_id is not null;
  assert c.id is not null, 'the automation commented';
  assert c.body = 'hi @b12-nameless (b12-nameless, @b12-nameless); reviewer @b12-emailname; by Bo Owner', c.body;
  assert position('@example.com' in c.body) = 0, 'no email address in the comment';
  assert exists (select 1 from public.comment_mentions where comment_id = c.id and profile_id = 'a3100120-0000-4000-8000-000000000004')
    and exists (select 1 from public.comment_mentions where comment_id = c.id and profile_id = 'a3100120-0000-4000-8000-000000000005'),
    'the people became mentions (chips; they hear about it like any mention)';
  -- Everywhere else rule text is as before (names, else the address).
  assert public.render_rule_text_as('{{task.assignee}}', (select id from b12_ids where name = 'greet'),
    (select id from b12_ids where name = 'p'), '{}', 'plain') = 'b12-nameless@example.com', 'plain text is unchanged';
  assert public.render_rule_text_as('{{field.Reviewer}}', (select id from b12_ids where name = 'greet'),
    (select id from b12_ids where name = 'p'), '{}', 'email') = 'b12-emailname@example.com', 'email text is unchanged';
end $$;

-- The run markers: the run is readable by the project's Viewer, not by an outsider.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100120-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  assert exists (
    select 1 from public.rule_runs rr join public.rules r on r.id = rr.rule_id
    where rr.task_id = (select id from b12_ids where name = 'greet') and rr.status = 'succeeded' and r.name = 'Greeter'
  ), 'a task''s readers see its automation runs (the activity''s markers)';
end $$;
select set_config('request.jwt.claim.sub', 'a3100120-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.rule_runs where task_id = (select id from b12_ids where name = 'greet')),
    'an outsider sees no runs';
end $$;
reset role;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
