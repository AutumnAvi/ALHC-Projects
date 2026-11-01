-- Nov 1 notes, batch 11 (20261101050000_nov1_batch11_a.sql):
--   75 the personal email digest: workdays only (Sunday–Thursday by default; never Friday or Saturday),
--      tasks due or overdue next to unread Inbox items, re-read at send time as the recipient.
--   73 a response's subject no longer comes from a stored email design.
-- People:
--   a3100041…01 b11-owner@example.com   Ona Owner (owns P)
--   a3100041…02 b11-person@example.com  Pia Person (Editor of P; the digest's recipient)

\set ON_ERROR_STOP 1

create temporary table b11_ids (name text primary key, id uuid) on commit preserve rows;
grant all on b11_ids to authenticated, anon, service_role;

-- The pure checks below need real workdays.
set alhc.digest_every_day = 'off';

insert into public.allowed_emails (email, note) values
  ('b11-owner@example.com', 'batch 11'),
  ('b11-person@example.com', 'batch 11');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a3100041-0000-4000-8000-000000000001', 'b11-owner@example.com', now(), '{"full_name":"Ona Owner"}'),
  ('a3100041-0000-4000-8000-000000000002', 'b11-person@example.com', now(), '{"full_name":"Pia Person"}');

-- EXECUTE surface ------------------------------------------------------------------------------------

do $$
begin
  assert has_function_privilege('service_role', 'public.digest_email_tasks(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.digest_email_tasks(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.digest_email_tasks(uuid)', 'execute'),
    'digest_email_tasks: the drain only';
  assert not has_function_privilege('authenticated', 'public.digest_task_candidates(uuid, date)', 'execute')
    and not has_function_privilege('anon', 'public.digest_task_candidates(uuid, date)', 'execute'),
    'digest_task_candidates is internal';
  assert not (select prosecdef from pg_proc where oid = 'public.digest_next_at(text, integer, integer, text, timestamptz)'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.digest_is_workday(timestamptz, text)'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.digest_work_week()'::regprocedure),
    'the workday helpers are invoker';
  assert not has_function_privilege('anon', 'public.digest_next_at(text, integer, integer, text, timestamptz)', 'execute')
    and not has_function_privilege('anon', 'public.digest_is_workday(timestamptz, text)', 'execute'),
    'nothing new for anon';
end $$;

-- 75 Workdays -------------------------------------------------------------------------------------------

do $$
begin
  assert public.digest_work_week() = '{0,1,2,3,4}'::smallint[], 'the default workweek is Sunday–Thursday';
  -- 2026-11-01 is a Sunday.
  assert public.digest_is_workday('2026-11-01 12:00+00', 'UTC'), 'Sunday is a workday';
  assert public.digest_is_workday('2026-11-05 12:00+00', 'UTC'), 'Thursday is a workday';
  assert not public.digest_is_workday('2026-11-06 12:00+00', 'UTC'), 'Friday is not';
  assert not public.digest_is_workday('2026-11-07 12:00+00', 'UTC'), 'Saturday is not';
  -- The local day counts: Thursday 23:30 in New York is Friday in UTC.
  assert public.digest_is_workday('2026-11-06 04:30+00', 'America/New_York'), 'Thursday evening in New York';
  assert not public.digest_is_workday('2026-11-06 04:30+00', 'UTC'), 'but Friday in UTC';

  assert public.digest_next_at('daily', 8, 1, 'UTC', '2026-11-04 09:00+00') = '2026-11-05 08:00+00',
    'daily: Wednesday after 8 → Thursday 8:00';
  assert public.digest_next_at('daily', 8, 1, 'UTC', '2026-11-05 09:00+00') = '2026-11-08 08:00+00',
    'daily: Thursday after 8 → Sunday (never Friday or Saturday)';
  assert public.digest_next_at('daily', 8, 1, 'UTC', '2026-11-06 07:00+00') = '2026-11-08 08:00+00',
    'daily: from a Friday morning → Sunday';
  assert public.digest_next_at('weekly', 9, 1, 'UTC', '2026-11-01 10:00+00') = '2026-11-02 09:00+00',
    'weekly on Monday';
  assert public.digest_next_at('weekly', 9, 5, 'UTC', '2026-11-01 10:00+00') = '2026-11-08 09:00+00',
    'weekly on a Friday (an older setting) goes out on the next workday';
  assert public.digest_next_at('off', 9, 1, 'UTC', now()) is null, 'off = none';
  assert public.digest_next_at('daily', 8, 1, 'Asia/Jerusalem', '2026-11-05 07:00+00') = '2026-11-08 06:00+00',
    'daily in Jerusalem: Thursday after 8 local → Sunday 8:00 local';
end $$;

set alhc.digest_every_day = 'on';
do $$
begin
  assert public.digest_is_workday('2026-11-06 12:00+00', 'UTC'), 'the harness switch lets every day through';
end $$;
set alhc.digest_every_day = 'off';

-- set_email_digest: a weekly digest's day must be a workday; the saved send time is on one.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100041-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  next_at timestamptz;
begin
  begin
    perform public.set_email_digest('weekly', 8, 5, 'UTC');
    assert false, 'a Friday weekly digest is refused';
  exception when check_violation then
    assert sqlerrm like 'Choose a workday%', sqlerrm;
  end;
  begin
    perform public.set_email_digest('weekly', 8, 6, 'UTC');
    assert false, 'a Saturday weekly digest is refused';
  exception when check_violation then null;
  end;
  next_at := public.set_email_digest('weekly', 8, 0, 'UTC');
  assert extract(dow from next_at at time zone 'UTC') = 0, 'weekly on Sunday';
  next_at := public.set_email_digest('daily', 8, 0, 'UTC');
  assert public.digest_is_workday(next_at, 'UTC'), format('the next daily digest is on a workday: %s', next_at);
  assert (select digest_next_at from public.email_preferences) = next_at, 'stored on her own row';
end $$;

-- 75 Tasks in the digest ----------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'a3100041-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid;
  s uuid;
  today date := (now() at time zone 'UTC')::date;
  t uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B11 Digest')
    returning id into p;
  insert into b11_ids values ('p', p);
  perform public.add_project_member(p, 'b11-person@example.com', 'editor');
  insert into public.sections (project_id, name) values (p, 'Doing') returning id into s;

  t := public.create_task(p, s, 'Overdue report');
  update public.tasks set assignee_id = 'a3100041-0000-4000-8000-000000000002', due_on = today - 3 where id = t;
  insert into b11_ids values ('overdue', t);
  t := public.create_task(p, s, 'Due today');
  update public.tasks set assignee_id = 'a3100041-0000-4000-8000-000000000002', due_on = today where id = t;
  insert into b11_ids values ('today', t);
  t := public.create_task(p, s, 'Due in three days');
  update public.tasks set assignee_id = 'a3100041-0000-4000-8000-000000000002', due_on = today + 3 where id = t;
  insert into b11_ids values ('soon', t);
  t := public.create_task(p, s, 'Done already');
  update public.tasks set assignee_id = 'a3100041-0000-4000-8000-000000000002', due_on = today - 1,
    completed_at = now() where id = t;
  t := public.create_task(p, s, 'Someone else''s');
  update public.tasks set assignee_id = 'a3100041-0000-4000-8000-000000000001', due_on = today - 1 where id = t;
  t := public.create_task(p, s, 'No date');
  update public.tasks set assignee_id = 'a3100041-0000-4000-8000-000000000002' where id = t;
end $$;

reset role;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset

-- The queue runs on whatever day this suite runs; the harness switch makes today a workday.
set alhc.digest_every_day = 'on';
update public.inbox_items set read_at = now() where recipient_id = 'a3100041-0000-4000-8000-000000000002';
update public.email_preferences set time_zone = 'UTC', digest_next_at = now() - interval '1 minute'
where profile_id = 'a3100041-0000-4000-8000-000000000002';

do $$
declare
  e public.email_outbox;
  n integer;
begin
  assert public.queue_digest_emails() >= 1, 'a digest is queued';
  select * into e from public.email_outbox where payload ->> 'kind' = 'digest' and to_profile_id = 'a3100041-0000-4000-8000-000000000002';
  assert found, 'Pia''s digest';
  insert into b11_ids values ('digest', e.id);
  assert (e.payload ->> 'total')::integer = 0, 'no unread Inbox items';
  assert (e.payload ->> 'task_total')::integer = 2, format('overdue + due today: %s', e.payload);
  assert (e.payload -> 'task_ids') ? (select id::text from b11_ids where name = 'overdue')
    and (e.payload -> 'task_ids') ? (select id::text from b11_ids where name = 'today')
    and not (e.payload -> 'task_ids') ? (select id::text from b11_ids where name = 'soon'),
    'a daily digest lists today''s and overdue tasks only';
  assert e.task_id is null and e.template = 'custom', 'no task reader sees the row';

  select count(*) into n from public.digest_email_tasks(e.id);
  assert n = 2, 'the drain re-reads both';
  assert (select overdue from public.digest_email_tasks(e.id) d where d.task_id = (select id from b11_ids where name = 'overdue'))
    and not (select overdue from public.digest_email_tasks(e.id) d where d.task_id = (select id from b11_ids where name = 'today')),
    'overdue flag';
  assert (select path from public.digest_email_tasks(e.id) d where d.task_id = (select id from b11_ids where name = 'today'))
    = '/projects/' || (select id from b11_ids where name = 'p') || '?task=' || (select id from b11_ids where name = 'today'),
    'links to the task in its project';
  assert (select project_name from public.digest_email_tasks(e.id) limit 1) = 'B11 Digest', 'the project''s name';
  assert public.scheduled_email_block_reason(e.id) is null, 'sendable on a workday';
end $$;

-- Done before it goes out: a finished task drops out; with nothing left the digest isn't sent.
update public.tasks set completed_at = now() where id = (select id from b11_ids where name = 'overdue');
do $$
begin
  assert (select count(*) from public.digest_email_tasks((select id from b11_ids where name = 'digest'))) = 1,
    'one task left';
  assert public.digest_has_items((select id from b11_ids where name = 'digest')), 'still something to send';
end $$;
update public.tasks set assignee_id = 'a3100041-0000-4000-8000-000000000001' where id = (select id from b11_ids where name = 'today');
do $$
begin
  assert not public.digest_has_items((select id from b11_ids where name = 'digest')), 'nothing left once reassigned';
  assert public.scheduled_email_block_reason((select id from b11_ids where name = 'digest')) like 'Not sent: everything in it%',
    'not sent with nothing left';
end $$;

-- A weekly digest lists the week's tasks.
update public.tasks set assignee_id = 'a3100041-0000-4000-8000-000000000002' where id = (select id from b11_ids where name = 'today');
update public.email_outbox set status = 'failed' where id = (select id from b11_ids where name = 'digest');
update public.email_preferences set digest = 'weekly', digest_weekday = 0
where profile_id = 'a3100041-0000-4000-8000-000000000002';
-- (A schedule change recomputes the send time, so make it due separately.)
update public.email_preferences set digest_next_at = now() - interval '1 minute'
where profile_id = 'a3100041-0000-4000-8000-000000000002';
do $$
declare
  e public.email_outbox;
begin
  perform public.queue_digest_emails();
  select * into e from public.email_outbox where payload ->> 'kind' = 'digest'
    and to_profile_id = 'a3100041-0000-4000-8000-000000000002' and id <> (select id from b11_ids where name = 'digest');
  assert found, 'a weekly digest';
  assert (e.payload ->> 'task_total')::integer = 2
    and (e.payload -> 'task_ids') ? (select id::text from b11_ids where name = 'soon')
    and (e.payload -> 'task_ids') ? (select id::text from b11_ids where name = 'today'),
    format('due this week (the finished one left out): %s', e.payload);
  assert (e.payload ->> 'due_until')::date = (now() at time zone 'UTC')::date + 6, 'seven days';
end $$;

-- Off: nothing queued.
update public.email_preferences set digest = 'off' where profile_id = 'a3100041-0000-4000-8000-000000000002';
do $$
begin
  assert (select digest_next_at from public.email_preferences where profile_id = 'a3100041-0000-4000-8000-000000000002') is null,
    'off = no next time';
end $$;

-- 73 Hard-coded emails --------------------------------------------------------------------------------

do $$
begin
  assert position('resolve_email_design' in pg_get_functiondef('public.submitter_response_subject(uuid, uuid)'::regprocedure)) = 0,
    'a response''s subject never comes from a stored design';
end $$;

reset alhc.digest_every_day;
select 'nov1 batch11 smoke: all assertions passed' as result;
