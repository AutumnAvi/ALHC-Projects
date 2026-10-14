-- Behavioural checks for Phase: Real features 3 (email extras): the Inbox email digest
-- (email_preferences, set_email_digest, queue_digest_emails, digest_email_items, the one-click
-- email_unsubscribe), scheduled report emails (report_schedules, queue_report_emails, each copy built with
-- the recipient's own access), bounce and complaint tracking (record_email_event, email_suppressions,
-- every claim skipping suppressed addresses), the Admin console's delivery overview, and the send-time
-- checks of claim_scheduled_emails. Workspace admins never get project data from any of it.
-- Fresh people for this suite:
--   a3a3…01 r3-owner@example.com   Rhona Realthree: owner of R3 P and R3 Side
--   a3a3…02 r3-mate@example.com    Theo Tripleby: Editor of R3 P; owner of the private R3 Secret
--   a3a3…03 r3-viewer@example.com  Vera Viewthree: Viewer of R3 P; Viewer of R3 Side until removed
--   a3a3…04 r3-admin@example.com   Ada Adminthree: workspace admin; Viewer of R3 P until removed
--   a3a3…05 r3-gone@example.com    Gus Gonethree: removed from the workspace

\set ON_ERROR_STOP 1

create temporary table r3_ids (name text primary key, id uuid) on commit preserve rows;
grant all on r3_ids to authenticated, anon, service_role;
create temporary table r3_vals (name text primary key, val text) on commit preserve rows;
grant all on r3_vals to authenticated, anon, service_role;

-- The digest window ends two minutes back (so a long transaction's items aren't missed). This suite runs
-- in seconds, so before each queue run it moves this suite's Inbox items and digest send times ten
-- minutes into the past together: their order is kept, and everything is old enough to be listed.
create function pg_temp.r3_shift() returns void language sql as $$
  update public.inbox_items set created_at = created_at - interval '10 minutes'
  where recipient_id::text like 'a3a3a3a3-%';
  update public.email_preferences set digest_last_sent_at = digest_last_sent_at - interval '10 minutes'
  where profile_id::text like 'a3a3a3a3-%' and digest_last_sent_at is not null;
$$;

insert into public.allowed_emails (email, note) values
  ('r3-owner@example.com', 'real 3 suite'),
  ('r3-mate@example.com', 'real 3 suite'),
  ('r3-viewer@example.com', 'real 3 suite'),
  ('r3-admin@example.com', 'real 3 suite'),
  ('r3-gone@example.com', 'real 3 suite');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a3a3a3a3-0000-4000-8000-000000000001', 'r3-owner@example.com', now(), '{"full_name":"Rhona Realthree"}'),
  ('a3a3a3a3-0000-4000-8000-000000000002', 'r3-mate@example.com', now(), '{"full_name":"Theo Tripleby"}'),
  ('a3a3a3a3-0000-4000-8000-000000000003', 'r3-viewer@example.com', now(), '{"full_name":"Vera Viewthree"}'),
  ('a3a3a3a3-0000-4000-8000-000000000004', 'r3-admin@example.com', now(), '{"full_name":"Ada Adminthree"}'),
  ('a3a3a3a3-0000-4000-8000-000000000005', 'r3-gone@example.com', now(), '{"full_name":"Gus Gonethree"}');
insert into public.workspace_admins (workspace_id, profile_id)
values ('00000000-0000-4000-8000-000000000001', 'a3a3a3a3-0000-4000-8000-000000000004');

-- EXECUTE surface, grants, and the job ---------------------------------------------------------------

do $$
begin
  assert has_function_privilege('anon', 'public.email_unsubscribe(text, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.email_unsubscribe(text, text)', 'execute')
    and (select prosecdef from pg_proc where oid = 'public.email_unsubscribe(text, text)'::regprocedure),
    'email_unsubscribe: the one-click links, anon only';
  assert has_function_privilege('authenticated', 'public.list_workspace_email_deliveries(integer)', 'execute')
    and has_function_privilege('authenticated', 'public.workspace_email_summary(integer)', 'execute')
    and not has_function_privilege('anon', 'public.list_workspace_email_deliveries(integer)', 'execute')
    and not has_function_privilege('anon', 'public.workspace_email_summary(integer)', 'execute'),
    'the Admin console reads: signed-in callers (workspace admins, checked inside)';
  assert has_function_privilege('service_role', 'public.record_email_event(text, text, timestamptz, text, text)', 'execute')
    and has_function_privilege('service_role', 'public.digest_email_items(uuid)', 'execute')
    and has_function_privilege('service_role', 'public.claim_scheduled_emails(integer, uuid)', 'execute')
    and has_function_privilege('service_role', 'public.alhc_queue_scheduled_emails()', 'execute')
    and not has_function_privilege('authenticated', 'public.record_email_event(text, text, timestamptz, text, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.digest_email_items(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.claim_scheduled_emails(integer, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.alhc_queue_scheduled_emails()', 'execute')
    and not has_function_privilege('anon', 'public.record_email_event(text, text, timestamptz, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.alhc_queue_scheduled_emails()', 'execute'),
    'the webhook, the drain, and the queue: service_role only';
  assert not has_function_privilege('authenticated', 'public.queue_digest_emails()', 'execute')
    and not has_function_privilege('authenticated', 'public.queue_report_emails()', 'execute')
    and not has_function_privilege('authenticated', 'public.report_email_payload(public.report_schedules, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.inbox_item_readable(public.inbox_items)', 'execute')
    and not has_function_privilege('authenticated', 'public.inbox_item_email_parts(public.inbox_items, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.scheduled_email_block_reason(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.fail_suppressed_emails(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.email_suppression_reason(text)', 'execute')
    and not has_function_privilege('authenticated', 'public.ensure_email_preferences(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.report_filter_summary(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.mask_email(text)', 'execute')
    and not has_function_privilege('anon', 'public.queue_digest_emails()', 'execute'),
    'internal helpers are revoked';
  assert has_function_privilege('authenticated', 'public.set_email_digest(text, integer, integer, text)', 'execute')
    and has_function_privilege('authenticated', 'public.set_report_emails(boolean)', 'execute')
    and not (select prosecdef from pg_proc where oid = 'public.set_email_digest(text, integer, integer, text)'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.set_report_emails(boolean)'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.guard_email_preferences()'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.guard_report_schedule()'::regprocedure)
    and not has_function_privilege('anon', 'public.set_email_digest(text, integer, integer, text)', 'execute'),
    'what signed-in people call is invoker';
  assert (select relrowsecurity from pg_class where oid = 'public.email_preferences'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.report_schedules'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.email_suppressions'::regclass), 'RLS is on';
  assert not has_table_privilege('anon', 'public.email_preferences', 'select')
    and not has_table_privilege('anon', 'public.report_schedules', 'select')
    and not has_table_privilege('anon', 'public.email_suppressions', 'select'), 'anon reads nothing';
  assert not has_column_privilege('authenticated', 'public.email_preferences', 'unsubscribe_token', 'update')
    and not has_column_privilege('authenticated', 'public.email_preferences', 'unsubscribe_token', 'insert')
    and not has_column_privilege('authenticated', 'public.email_preferences', 'digest_last_sent_at', 'update')
    and not has_column_privilege('authenticated', 'public.email_preferences', 'digest_next_at', 'update')
    and not has_table_privilege('authenticated', 'public.email_preferences', 'delete')
    and not has_column_privilege('authenticated', 'public.report_schedules', 'owner_id', 'insert')
    and not has_column_privilege('authenticated', 'public.report_schedules', 'next_run_at', 'update')
    and not has_column_privilege('authenticated', 'public.report_schedules', 'last_sent_at', 'update')
    and not has_table_privilege('authenticated', 'public.report_schedules', 'delete')
    and not has_table_privilege('authenticated', 'public.email_suppressions', 'select')
    and not has_table_privilege('authenticated', 'public.email_suppressions', 'insert')
    and not has_any_column_privilege('authenticated', 'public.email_suppressions', 'update'),
    'narrow column grants; the suppression list has no client access at all';
  assert has_function_privilege('authenticated', 'public.list_email_suppressions()', 'execute')
    and has_function_privilege('authenticated', 'public.clear_email_suppression(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.list_email_suppressions()', 'execute')
    and not has_function_privilege('anon', 'public.clear_email_suppression(uuid)', 'execute')
    and (select prosecdef from pg_proc where oid = 'public.list_email_suppressions()'::regprocedure)
    and (select prosecdef from pg_proc where oid = 'public.clear_email_suppression(uuid)'::regprocedure),
    'the suppression list: two workspace-admin functions';
  assert not has_function_privilege('authenticated', 'public.digest_has_items(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.report_copy_still_readable(uuid)', 'execute'),
    'the send-time checks are internal';
  assert exists (select 1 from cron.job where jobname = 'alhc-scheduled-emails' and schedule = '*/5 * * * *'
                   and command = 'select public.alhc_queue_scheduled_emails()'), 'the queue runs every 5 minutes';
end $$;

-- The next send time ------------------------------------------------------------------------------------

do $$
begin
  -- Tuesday Oct 13 2026, 09:00 in New York (EDT, UTC−4).
  assert public.email_schedule_next_at('daily', 8, 1, 1, 'America/New_York', '2026-10-13 13:00+00') = '2026-10-14 12:00+00',
    'daily: tomorrow at 8 local';
  assert public.email_schedule_next_at('daily', 8, 1, 1, 'America/New_York', '2026-10-13 11:00+00') = '2026-10-13 12:00+00',
    'daily: later today when the hour hasn''t come yet';
  assert public.email_schedule_next_at('weekly', 8, 1, 1, 'America/New_York', '2026-10-13 13:00+00') = '2026-10-19 12:00+00',
    'weekly: next Monday';
  assert public.email_schedule_next_at('weekly', 8, 2, 1, 'America/New_York', '2026-10-13 11:00+00') = '2026-10-13 12:00+00',
    'weekly: today when it''s that weekday and the hour is still ahead';
  assert public.email_schedule_next_at('monthly', 8, 1, 1, 'America/New_York', '2026-10-13 13:00+00') = '2026-11-01 13:00+00',
    'monthly: the 1st, at 8 local after the clocks change (EST, UTC−5)';
  assert public.email_schedule_next_at('off', 8, 1, 1, 'UTC', now()) is null, 'off: never';
  assert public.email_schedule_next_at('daily', 23, 1, 1, 'Not/AZone', '2026-10-13 13:00+00') = '2026-10-13 23:00+00',
    'an unknown zone falls back to UTC';
end $$;

-- Setup ------------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid;
  side uuid;
  t uuid;
  i integer;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'R3 P') returning id into p;
  perform public.add_project_member(p, 'r3-mate@example.com', 'editor');
  perform public.add_project_member(p, 'r3-viewer@example.com', 'viewer');
  perform public.add_project_member(p, 'r3-admin@example.com', 'viewer');
  insert into r3_ids values ('p', p);
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'R3 Side') returning id into side;
  perform public.add_project_member(side, 'r3-viewer@example.com', 'viewer');
  insert into r3_ids values ('side', side);
  for i in 1 .. 5 loop
    select public.create_task(p, null, 'R3 task ' || i) into t;
    insert into r3_ids values ('t' || i, t);
  end loop;
  select public.create_task(side, null, 'R3 side task') into t;
  insert into r3_ids values ('s1', t);
end $$;

select set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  p uuid;
  t uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'R3 Secret') returning id into p;
  insert into r3_ids values ('secret', p);
  select public.create_task(p, null, 'R3 secret task') into t;
  insert into r3_ids values ('sec1', t);
end $$;

-- Rhona assigns Vera five tasks (four in R3 P, one in R3 Side) and Ada one.
select set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000001', false) is not null as ok \gset
update public.tasks set assignee_id = 'a3a3a3a3-0000-4000-8000-000000000003'
where id in (select id from r3_ids where name in ('t1', 't2', 't3', 't4', 's1'));
update public.tasks set assignee_id = 'a3a3a3a3-0000-4000-8000-000000000004' where id = (select id from r3_ids where name = 't5');

-- Vera reads one item and archives another.
select set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000003', false) is not null as ok \gset
update public.inbox_items set read_at = now() where task_id = (select id from r3_ids where name = 't3');
update public.inbox_items set archived_at = now() where task_id = (select id from r3_ids where name = 't4');

-- Rhona takes Vera off R3 Side and Ada off R3 P.
select set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  perform public.remove_project_member((select id from r3_ids where name = 'side'), 'a3a3a3a3-0000-4000-8000-000000000003');
  perform public.remove_project_member((select id from r3_ids where name = 'p'), 'a3a3a3a3-0000-4000-8000-000000000004');
end $$;
reset role;

do $$
begin
  assert (select count(*) from public.inbox_items where recipient_id = 'a3a3a3a3-0000-4000-8000-000000000003' and kind = 'assigned') = 5,
    'setup: Vera has five assignment items';
  assert (select count(*) from public.inbox_items where recipient_id = 'a3a3a3a3-0000-4000-8000-000000000004' and kind = 'assigned') = 1,
    'setup: Ada has one';
end $$;

-- Email preferences --------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  next_at timestamptz;
  pref public.email_preferences;
begin
  next_at := public.set_email_digest('daily', 8, 1, 'America/New_York');
  assert next_at > now() and next_at <= now() + interval '25 hours', 'the next digest is within a day';
  select * into pref from public.email_preferences;
  assert found and pref.profile_id = 'a3a3a3a3-0000-4000-8000-000000000003' and pref.digest = 'daily'
    and pref.time_zone = 'America/New_York' and pref.unsubscribe_token ~ '^[0-9a-f]{64}$' and pref.report_emails
    and pref.digest_next_at = next_at, 'Vera''s own row, with a generated token';
  begin
    perform public.set_email_digest('hourly', 8, 1, 'UTC');
    assert false, 'only off / daily / weekly';
  exception when check_violation then null;
  end;
  begin
    perform public.set_email_digest('daily', 24, 1, 'UTC');
    assert false, 'hours are 0–23';
  exception when check_violation then null;
  end;
  begin
    update public.email_preferences set unsubscribe_token = repeat('a', 64);
    assert false, 'the token is never chosen';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  perform public.set_email_digest('daily', 8, 1, 'UTC');
  assert (select count(*) from public.email_preferences) = 1, 'a workspace admin sees only their own row';
end $$;
select set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$ begin perform public.set_email_digest('weekly', 9, 1, 'UTC'); end $$;
reset role;

insert into r3_vals select 'vera_token', unsubscribe_token from public.email_preferences
where profile_id = 'a3a3a3a3-0000-4000-8000-000000000003';

-- The digest -------------------------------------------------------------------------------------------

update public.email_preferences set digest_next_at = now() - interval '1 minute'
where profile_id in ('a3a3a3a3-0000-4000-8000-000000000002', 'a3a3a3a3-0000-4000-8000-000000000003', 'a3a3a3a3-0000-4000-8000-000000000004');

do $$
declare
  queued integer;
  e public.email_outbox;
begin
  perform pg_temp.r3_shift();
  queued := public.queue_digest_emails();
  assert queued = 1, format('one digest (Vera''s); Ada''s only item is in a project she left, Theo has none: %s', queued);
  select * into e from public.email_outbox where payload ->> 'kind' = 'digest' and to_profile_id = 'a3a3a3a3-0000-4000-8000-000000000003';
  assert found and e.task_id is null and e.template = 'custom' and e.status = 'pending' and e.to_email = 'r3-viewer@example.com'
    and (e.payload ->> 'total')::integer = 2 and jsonb_array_length(e.payload -> 'item_ids') = 2
    and e.payload ->> 'frequency' = 'daily' and e.payload ->> 'unsubscribe_token' ~ '^[0-9a-f]{64}$',
    'Vera''s digest lists her two unread, unarchived items she can still open';
  assert (e.payload -> 'item_ids') ? (select i.id::text from public.inbox_items i
                                      where i.task_id = (select id from r3_ids where name = 't1') and i.kind = 'assigned')
    and not (e.payload -> 'item_ids') ? (select i.id::text from public.inbox_items i
                                         where i.task_id = (select id from r3_ids where name = 's1') and i.kind = 'assigned'),
    'the item about R3 Side (she left it) is left out';
  insert into r3_ids values ('digest1', e.id);
  assert not exists (select 1 from public.email_outbox where payload ->> 'kind' = 'digest'
                       and to_profile_id in ('a3a3a3a3-0000-4000-8000-000000000004', 'a3a3a3a3-0000-4000-8000-000000000002')),
    'no digest for a workspace admin whose only item is in a project they can''t open, nor an empty one';
  assert (select digest_next_at > now() and digest_last_sent_at is null from public.email_preferences
          where profile_id = 'a3a3a3a3-0000-4000-8000-000000000004'), 'a skipped digest moves on without a sent time';
  assert (select digest_next_at > now() and digest_last_sent_at is not null from public.email_preferences
          where profile_id = 'a3a3a3a3-0000-4000-8000-000000000003'), 'a queued digest records its window end';
end $$;

-- Nothing new since → nothing sent twice.
update public.email_preferences set digest_next_at = now() - interval '1 minute' where profile_id = 'a3a3a3a3-0000-4000-8000-000000000003';
do $$
begin
  perform pg_temp.r3_shift();
  assert public.queue_digest_emails() = 0, 'the same items never go out twice';
end $$;

-- A new assignment → the next digest has only it.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  t uuid;
begin
  select public.create_task((select id from r3_ids where name = 'p'), null, 'R3 task six') into t;
  insert into r3_ids values ('t6', t);
  update public.tasks set assignee_id = 'a3a3a3a3-0000-4000-8000-000000000003' where id = t;
end $$;
reset role;
update public.email_preferences set digest_next_at = now() - interval '1 minute' where profile_id = 'a3a3a3a3-0000-4000-8000-000000000003';
do $$
declare
  e public.email_outbox;
begin
  perform pg_temp.r3_shift();
  assert public.queue_digest_emails() = 1, 'a second digest';
  select * into e from public.email_outbox
  where payload ->> 'kind' = 'digest' and to_profile_id = 'a3a3a3a3-0000-4000-8000-000000000003' and id <> (select id from r3_ids where name = 'digest1');
  assert (e.payload ->> 'total')::integer = 1, 'only the new item';
  insert into r3_ids values ('digest2', e.id);
end $$;

-- Sending: the existing claims never take a digest; digest_email_items re-reads the items as Vera.
set role service_role;
do $$
declare
  items integer;
  before text := coalesce(current_setting('request.jwt.claim.sub', true), '');
begin
  assert not exists (select 1 from public.claim_email_deliveries(100, (select id from r3_ids where name = 'digest1'))),
    'claim_email_deliveries leaves digests alone';
  assert not exists (select 1 from public.claim_email_outbox(100, (select id from r3_ids where name = 'digest1'))),
    'so does the legacy claim';
  assert not exists (select 1 from public.claim_notification_emails(100, (select id from r3_ids where name = 'digest1'))),
    'and the notification claim';
  select count(*) into items from public.digest_email_items((select id from r3_ids where name = 'digest1'));
  assert items = 2, format('two items to list, got %s', items);
  assert (select bool_and(d.kind = 'assigned' and d.parts ->> 'group_label' = 'R3 P' and d.parts ->> 'path' like '/projects/%?task=%'
                          and d.parts ->> 'actor_name' = 'Rhona Realthree' and d.parts ->> 'title' like 'R3 task %')
          from public.digest_email_items((select id from r3_ids where name = 'digest1')) d),
    'each item: who, what, under its project, with a link';
  assert (select count(*) from public.claim_scheduled_emails(100, (select id from r3_ids where name = 'digest1'))) = 1,
    'claim_scheduled_emails claims it';
  assert coalesce(current_setting('request.jwt.claim.sub', true), '') = before, 'the recipient setting is restored';
end $$;
reset role;

-- Vera reads the new item before the second digest goes out: nothing left, not sent.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000003', false) is not null as ok \gset
update public.inbox_items set read_at = now() where task_id = (select id from r3_ids where name = 't6');
do $$
begin
  assert not exists (select 1 from public.email_outbox where payload ->> 'kind' = 'digest'),
    'nobody reads digest rows through the API (the recipient included)';
end $$;
reset role;
set role service_role;
do $$
begin
  assert not exists (select 1 from public.claim_scheduled_emails(100, (select id from r3_ids where name = 'digest2'))),
    'an emptied digest isn''t sent';
end $$;
reset role;
do $$
begin
  assert (select status = 'failed' and last_error = 'Not sent: everything in it was read, archived, or can no longer be opened'
          from public.email_outbox where id = (select id from r3_ids where name = 'digest2')), 'failed with the reason';
end $$;

-- One-click unsubscribe (anon) -----------------------------------------------------------------------------

-- A third digest is queued, then Vera turns digests off from the email's link.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000001', false) is not null as ok \gset
update public.tasks set assignee_id = 'a3a3a3a3-0000-4000-8000-000000000003' where id = (select id from r3_ids where name = 't5');
reset role;
update public.email_preferences set digest_next_at = now() - interval '1 minute' where profile_id = 'a3a3a3a3-0000-4000-8000-000000000003';
do $$
begin
  perform pg_temp.r3_shift();
  assert public.queue_digest_emails() = 1, 'a third digest';
  insert into r3_ids select 'digest3', id from public.email_outbox
  where payload ->> 'kind' = 'digest' and status = 'pending' and to_profile_id = 'a3a3a3a3-0000-4000-8000-000000000003';
end $$;

set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
declare
  r jsonb;
  token text := (select val from r3_vals where name = 'vera_token');
begin
  r := public.email_unsubscribe(token, 'digest');
  assert r = '{"ok": true, "status": "off"}'::jsonb, format('digest off: %s', r);
  r := public.email_unsubscribe(token, 'digest');
  assert r ->> 'status' = 'already_off', 'twice is fine';
  r := public.email_unsubscribe(upper(token), 'reports');
  assert r ->> 'status' = 'off', 'report emails off (tokens are case-insensitive)';
  r := public.email_unsubscribe(repeat('0', 64), 'digest');
  assert r = '{"ok": false, "status": "unknown"}'::jsonb, 'an unknown token says nothing';
  r := public.email_unsubscribe('not a token', 'digest');
  assert r ->> 'status' = 'unknown', 'a malformed token too';
  r := public.email_unsubscribe(token, 'everything');
  assert r ->> 'status' = 'unknown', 'only digest or reports';
  begin
    perform 1 from public.email_preferences;
    assert false, 'anon reads no preferences';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$
begin
  assert (select digest = 'off' and digest_next_at is null and not report_emails from public.email_preferences
          where profile_id = 'a3a3a3a3-0000-4000-8000-000000000003'), 'Vera''s switches are off';
end $$;
set role service_role;
do $$
begin
  assert not exists (select 1 from public.claim_scheduled_emails(100, (select id from r3_ids where name = 'digest3'))),
    'a digest queued before turning it off isn''t sent';
end $$;
reset role;
do $$
begin
  assert (select last_error from public.email_outbox where id = (select id from r3_ids where name = 'digest3'))
    = 'Not sent: the recipient turned off the digest', 'failed with the reason';
end $$;

-- Vera turns report emails back on in Settings.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$ begin perform public.set_report_emails(true); end $$;
reset role;

-- Scheduled report emails ----------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  s public.report_schedules;
begin
  insert into public.report_schedules (name, report, filters, frequency, weekday, send_hour, time_zone, recipients)
  values ('  R3 everything  ', 'overview', '{}', 'weekly', 1, 8, 'America/New_York', array[
    'a3a3a3a3-0000-4000-8000-000000000002', 'a3a3a3a3-0000-4000-8000-000000000003',
    'a3a3a3a3-0000-4000-8000-000000000004', 'a3a3a3a3-0000-4000-8000-000000000003']::uuid[])
  returning * into s;
  assert s.owner_id = 'a3a3a3a3-0000-4000-8000-000000000002' and s.name = 'R3 everything'
    and s.workspace_id = '00000000-0000-4000-8000-000000000001' and cardinality(s.recipients) = 3
    and s.next_run_at > now() and s.next_run_at <= now() + interval '8 days', 'owned by Theo, deduped, scheduled';
  insert into r3_ids values ('s_all', s.id);

  insert into public.report_schedules (name, filters, frequency, send_hour, recipients)
  values ('R3 two projects', jsonb_build_object('projects', jsonb_build_array(
            (select id from r3_ids where name = 'secret'), (select id from r3_ids where name = 'p'))),
          'daily', 8, array['a3a3a3a3-0000-4000-8000-000000000003']::uuid[])
  returning * into s;
  insert into r3_ids values ('s_two', s.id);

  insert into public.report_schedules (name, filters, frequency, month_day, send_hour, recipients)
  values ('R3 mine', '{"assignees": ["me"]}', 'monthly', 3, 8, array['a3a3a3a3-0000-4000-8000-000000000003']::uuid[])
  returning * into s;
  assert s.filters = '{"assignees": ["a3a3a3a3-0000-4000-8000-000000000002"]}'::jsonb,
    '"me" means the owner, never each recipient';

  insert into public.report_schedules (name, report, filters, frequency, send_hour, recipients)
  values ('R3 all projects', 'projects', '{"status": "open"}', 'daily', 8, array['a3a3a3a3-0000-4000-8000-000000000002']::uuid[])
  returning * into s;
  assert s.filters = '{}'::jsonb, 'the All projects report takes no filter';
  insert into r3_ids values ('s_projects', s.id);

  begin
    insert into public.report_schedules (name, frequency, send_hour, recipients)
    values ('R3 stranger', 'daily', 8, array[gen_random_uuid()]);
    assert false, 'recipients are people in the workspace';
  exception when check_violation then null;
  end;
  begin
    insert into public.report_schedules (name, filters, frequency, send_hour, recipients)
    values ('R3 bad filter', '{"colour": "red"}', 'daily', 8, array['a3a3a3a3-0000-4000-8000-000000000002']::uuid[]);
    assert false, 'the filter is a report filter';
  exception when check_violation then null;
  end;
  begin
    insert into public.report_schedules (name, filters, frequency, send_hour, recipients)
    values ('R3 probe', jsonb_build_object('projects', jsonb_build_array((select id from r3_ids where name = 'side'))),
            'daily', 8, array['a3a3a3a3-0000-4000-8000-000000000003']::uuid[]);
    assert false, 'only projects the owner can open (no probing who can open the rest)';
  exception when no_data_found then null;
  end;
  -- At most 25 active schedules per person (4 so far; 21 more fit, the 26th doesn't).
  begin
    insert into public.report_schedules (name, frequency, send_hour, recipients)
    select 'R3 filler ' || i, 'daily', 8, array['a3a3a3a3-0000-4000-8000-000000000002']::uuid[] from generate_series(1, 22) i;
    assert false, 'up to 25 per person';
  exception when check_violation then null;
  end;
end $$;

-- Nobody else reads or changes Theo's schedules (workspace admins included).
select set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.report_schedules), 'a workspace admin reads no one else''s schedules';
  update public.report_schedules set name = 'Hijacked';
end $$;
select set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.report_schedules), 'a recipient doesn''t read the schedule either';
end $$;
reset role;

-- Gus leaves the workspace: he can't be added as a recipient.
do $$
begin
  perform set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000004', true);
  perform public.remove_workspace_member('r3-gone@example.com');
  perform set_config('request.jwt.claim.sub', '', true);
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  update public.report_schedules set recipients = recipients || 'a3a3a3a3-0000-4000-8000-000000000005'::uuid
  where id = (select id from r3_ids where name = 's_all');
  assert false, 'someone removed from the workspace can''t be a recipient';
exception when check_violation then null;
end $$;
reset role;

do $$
begin
  assert not exists (select 1 from public.report_schedules where name = 'Hijacked'), 'nobody else changed one';
end $$;

-- Run them now.
update public.report_schedules set next_run_at = now() - interval '1 minute'
where id in (select id from r3_ids where name in ('s_all', 's_two', 's_projects'));

do $$
declare
  queued integer;
  e public.email_outbox;
  before text := coalesce(current_setting('request.jwt.claim.sub', true), '');
begin
  queued := public.queue_report_emails();
  assert queued = 4, format('Theo and Vera (everything), Vera (two projects), Theo (all projects); Ada can open none: %s', queued);
  assert not exists (select 1 from public.email_outbox where payload ->> 'kind' = 'report'
                       and to_profile_id = 'a3a3a3a3-0000-4000-8000-000000000004'),
    'a workspace admin who can open none of the projects gets nothing';

  select * into e from public.email_outbox
  where payload ->> 'kind' = 'report' and payload ->> 'schedule_id' = (select id::text from r3_ids where name = 's_all')
    and to_profile_id = 'a3a3a3a3-0000-4000-8000-000000000003';
  assert e.task_id is null and e.payload ->> 'name' = 'R3 everything' and e.payload ->> 'owner_name' = 'Theo Tripleby'
    and e.payload ->> 'unsubscribe_token' ~ '^[0-9a-f]{64}$', 'Vera''s copy';
  assert (e.payload #>> '{totals,tasks}')::integer = 6 and (e.payload #>> '{totals,open}')::integer = 6,
    format('Vera''s numbers count only R3 P: %s', e.payload -> 'totals');
  assert jsonb_array_length(e.payload -> 'projects') = 1 and e.payload #>> '{projects,0,name}' = 'R3 P'
    and position('R3 Secret' in e.payload::text) = 0 and position('R3 secret task' in e.payload::text) = 0,
    'nothing of Theo''s private project in Vera''s copy';
  insert into r3_ids values ('vera_report', e.id);

  select * into e from public.email_outbox
  where payload ->> 'kind' = 'report' and payload ->> 'schedule_id' = (select id::text from r3_ids where name = 's_all')
    and to_profile_id = 'a3a3a3a3-0000-4000-8000-000000000002';
  assert (e.payload #>> '{totals,tasks}')::integer = 7 and jsonb_array_length(e.payload -> 'projects') = 2
    and position('R3 Secret' in e.payload::text) > 0, 'Theo''s copy has his private project';

  select * into e from public.email_outbox
  where payload ->> 'kind' = 'report' and payload ->> 'schedule_id' = (select id::text from r3_ids where name = 's_two');
  assert e.payload -> 'filters_summary' = '["Projects: R3 P, 1 you can’t open"]'::jsonb,
    format('the filter in Vera''s words never names R3 Secret: %s', e.payload -> 'filters_summary');

  select * into e from public.email_outbox
  where payload ->> 'kind' = 'report' and payload ->> 'schedule_id' = (select id::text from r3_ids where name = 's_projects');
  assert e.payload ->> 'report' = 'projects' and (e.payload ->> 'project_count')::integer = 2
    and (select bool_and(p ? 'status') from jsonb_array_elements(e.payload -> 'projects') p), 'the All projects report';

  assert (select last_sent_count = 2 and last_sent_at is not null and last_run_at is not null and next_run_at > now()
          from public.report_schedules where id = (select id from r3_ids where name = 's_all')), 'last sent and the next run';
  assert coalesce(current_setting('request.jwt.claim.sub', true), '') = before, 'the recipient setting is restored';
end $$;

-- Pause and resume; a paused schedule's queued copies aren't sent.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000002', false) is not null as ok \gset
update public.report_schedules set paused_at = now() where id = (select id from r3_ids where name = 's_all');
do $$
begin
  assert (select paused_at is not null and next_run_at is null from public.report_schedules
          where id = (select id from r3_ids where name = 's_all')), 'paused: no next run';
end $$;
reset role;
set role service_role;
do $$
begin
  assert not exists (select 1 from public.claim_scheduled_emails(100, (select id from r3_ids where name = 'vera_report'))),
    'a paused schedule''s copy isn''t sent';
end $$;
reset role;
do $$
begin
  assert (select last_error from public.email_outbox where id = (select id from r3_ids where name = 'vera_report'))
    = 'Not sent: the schedule is paused', 'failed with the reason';
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000002', false) is not null as ok \gset
update public.report_schedules set paused_at = null where id = (select id from r3_ids where name = 's_all');
do $$
begin
  assert (select paused_at is null and next_run_at > now() from public.report_schedules
          where id = (select id from r3_ids where name = 's_all')), 'resumed: scheduled again';
end $$;
reset role;

-- Vera turns report emails off: her copy is skipped from then on.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$ begin perform public.set_report_emails(false); end $$;
reset role;
update public.report_schedules set next_run_at = now() - interval '1 minute' where id = (select id from r3_ids where name = 's_two');
do $$
begin
  assert public.queue_report_emails() = 0, 'nobody left who wants it';
  assert (select last_sent_count = 0 and next_run_at > now() from public.report_schedules
          where id = (select id from r3_ids where name = 's_two')), 'the run is recorded with nobody sent to';
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$ begin perform public.set_report_emails(true); end $$;
reset role;

-- A copy is checked again at send time: one naming a project Vera can't open (here, Theo's private R3
-- Secret) isn't sent; one naming only R3 P is.
insert into public.email_outbox (to_email, template, payload, to_profile_id)
values ('r3-viewer@example.com', 'custom', jsonb_build_object(
          'kind', 'report', 'schedule_id', (select id from r3_ids where name = 's_all'), 'name', 'R3 crafted bad',
          'projects', jsonb_build_array(jsonb_build_object('id', (select id from r3_ids where name = 'secret'))), 'overdue', '[]'::jsonb),
        'a3a3a3a3-0000-4000-8000-000000000003'),
       ('r3-viewer@example.com', 'custom', jsonb_build_object(
          'kind', 'report', 'schedule_id', (select id from r3_ids where name = 's_all'), 'name', 'R3 crafted good',
          'projects', jsonb_build_array(jsonb_build_object('id', (select id from r3_ids where name = 'p'))),
          'overdue', jsonb_build_array(jsonb_build_object('project_id', (select id from r3_ids where name = 'p')))),
        'a3a3a3a3-0000-4000-8000-000000000003');
set role service_role;
do $$
begin
  assert not exists (select 1 from public.claim_scheduled_emails(10, (select id from public.email_outbox where payload ->> 'name' = 'R3 crafted bad'))),
    'a copy naming a project the recipient can''t open isn''t sent';
  assert (select count(*) from public.claim_scheduled_emails(10, (select id from public.email_outbox where payload ->> 'name' = 'R3 crafted good'))) = 1,
    'one naming only projects they can open is';
end $$;
reset role;
do $$
begin
  assert (select last_error from public.email_outbox where payload ->> 'name' = 'R3 crafted bad')
    = 'Not sent: the recipient can no longer open a project in it', 'failed with the reason';
end $$;

-- Removing a schedule is final.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000002', false) is not null as ok \gset
update public.report_schedules set deleted_at = now() where id = (select id from r3_ids where name = 's_projects');
do $$
begin
  update public.report_schedules set paused_at = null, deleted_at = null where id = (select id from r3_ids where name = 's_projects');
  assert false, 'a removed schedule stays removed';
exception when check_violation then null;
end $$;
reset role;

-- Delivery events and the suppression list -------------------------------------------------------------------

insert into public.email_outbox (task_id, to_email, template, payload, status, sent_at, provider_message_id, to_profile_id)
values ((select id from r3_ids where name = 't1'), 'r3-viewer@example.com', 'custom', '{"message": "hi"}', 'sent', now(),
        're_r3_one', 'a3a3a3a3-0000-4000-8000-000000000003');
insert into public.email_outbox (to_email, template, payload, status, sent_at, provider_message_id, last_error)
values ('someone@outside.test', 'form_confirmation', '{}', 'sent', now(), 're_r3_outside', 'Resend responded 422: someone@outside.test');

set role service_role;
do $$
declare
  r jsonb;
begin
  r := public.record_email_event('re_r3_one', 'email.delivered', now() - interval '5 minutes');
  assert r ->> 'status' = 'delivered', format('delivered: %s', r);
  r := public.record_email_event('re_r3_one', 'email.delivery_delayed', now());
  assert r ->> 'status' = 'delayed', 'recorded as an event';
  r := public.record_email_event('re_r3_one', 'email.opened', now());
  assert r ->> 'status' = 'ignored', 'other event types are ignored';
  r := public.record_email_event('re_nobody_sent_this', 'email.bounced', now(), 'Permanent', 'General');
  assert r ->> 'status' = 'unknown', 'an email we never sent is ignored';
  r := public.record_email_event('bad id!', 'email.bounced', now(), 'Permanent', 'General');
  assert r ->> 'status' = 'unknown', 'a malformed id too';
end $$;
reset role;
do $$
begin
  assert (select delivery_status = 'delivered' from public.email_outbox where provider_message_id = 're_r3_one'),
    'a late "delayed" never replaces "delivered"';
  assert not exists (select 1 from public.email_suppressions where email = 'r3-viewer@example.com'), 'nothing suppressed yet';
end $$;

set role service_role;
do $$
declare
  r jsonb;
begin
  r := public.record_email_event('re_r3_one', 'email.bounced', now(), 'Transient', 'MailboxFull');
  assert r ->> 'suppressed' = 'false', 'a temporary bounce doesn''t suppress';
end $$;
reset role;
do $$
begin
  assert (select delivery_status = 'bounced' and delivery_detail = 'Transient · MailboxFull'
          from public.email_outbox where provider_message_id = 're_r3_one'), 'bounced, with its type';
  assert not exists (select 1 from public.email_suppressions where email = 'r3-viewer@example.com'), 'still not suppressed';
end $$;

set role service_role;
do $$
declare
  r jsonb;
begin
  r := public.record_email_event('re_r3_one', 'email.bounced', now(), 'Permanent', 'General');
  assert r ->> 'suppressed' = 'true', 'a permanent bounce suppresses the address';
  r := public.record_email_event('re_r3_outside', 'email.bounced', now(), 'Permanent', 'NoEmail');
  assert r ->> 'suppressed' = 'true', 'an outside address too';
  r := public.record_email_event('re_r3_one', 'email.bounced', now(), 'Permanent', 'General');
  assert r ->> 'status' = 'bounced', 'a retried webhook is harmless';
end $$;
reset role;
do $$
begin
  assert (select count(*) from public.email_suppressions where email = 'r3-viewer@example.com' and cleared_at is null) = 1,
    'one active entry';
  assert (select reason = 'bounced' and email_kind = 'custom' from public.email_suppressions
          where email = 'r3-viewer@example.com' and cleared_at is null), 'why and what kind of email';
end $$;

-- Every claim now fails due email to Vera's address; the Inbox is unaffected.
insert into public.email_outbox (task_id, to_email, template, payload, to_profile_id)
values ((select id from r3_ids where name = 't1'), 'R3-Viewer@example.com', 'custom', '{"message": "again"}', 'a3a3a3a3-0000-4000-8000-000000000003');
insert into r3_ids select 'blocked_custom', id from public.email_outbox where payload ->> 'message' = 'again';
insert into public.email_outbox (to_email, template, payload, to_profile_id)
values ('r3-viewer@example.com', 'custom', '{"kind": "notification", "category": "assigned"}', 'a3a3a3a3-0000-4000-8000-000000000003');
insert into r3_ids select 'blocked_notification', id from public.email_outbox
where payload ->> 'kind' = 'notification' and to_profile_id = 'a3a3a3a3-0000-4000-8000-000000000003';

set role service_role;
do $$
begin
  assert not exists (select 1 from public.claim_email_outbox(100, (select id from r3_ids where name = 'blocked_custom'))),
    'the legacy claim skips a suppressed address';
  assert not exists (select 1 from public.claim_email_deliveries(100, (select id from r3_ids where name = 'blocked_custom'))),
    'the current claim fails it instead of sending';
  assert not exists (select 1 from public.claim_notification_emails(100, (select id from r3_ids where name = 'blocked_notification'))),
    'notification emails too';
end $$;
reset role;
do $$
begin
  assert (select status = 'failed' and last_error = 'Not sent: this address bounced (Admin console → Email)'
          from public.email_outbox where id = (select id from r3_ids where name = 'blocked_custom')), 'failed with the reason';
  assert (select status = 'failed' and last_error like 'Not sent: this address bounced%'
          from public.email_outbox where id = (select id from r3_ids where name = 'blocked_notification')), 'the same reason';
end $$;

-- A suppressed recipient gets no report copy.
update public.report_schedules set next_run_at = now() - interval '1 minute' where id = (select id from r3_ids where name = 's_two');
do $$
begin
  assert public.queue_report_emails() = 0, 'Vera''s address is suppressed';
end $$;

-- The Admin console: workspace admins see the list and statuses, never content; nobody else does.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  begin
    perform 1 from public.email_suppressions;
    assert false, 'members don''t read the suppression table';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.list_email_suppressions();
    assert false, 'or list it';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.clear_email_suppression(gen_random_uuid());
    assert false, 'or clear an address';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.list_workspace_email_deliveries(50);
    assert false, 'members don''t list deliveries';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.workspace_email_summary(30);
    assert false, 'or the summary';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
do $$
begin
  assert exists (select 1 from public.email_suppressions where email = 'r3-viewer@example.com' and cleared_at is null),
    'a member can''t clear it';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'a3a3a3a3-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
declare
  d record;
  s record;
begin
  assert (select count(*) from public.list_email_suppressions() x where x.email = 'r3-viewer@example.com' and x.in_workspace
          and x.reason = 'bounced' and x.email_kind = 'custom') = 1,
    'workspace admins read the suppression list';
  assert exists (select 1 from public.list_email_suppressions() x where x.email = 's•••@outside.test' and not x.in_workspace)
    and not exists (select 1 from public.list_email_suppressions() x where x.email = 'someone@outside.test'),
    'an outside address on the list is masked too';
  begin
    perform 1 from public.email_suppressions;
    assert false, 'not even workspace admins read the table directly';
  exception when insufficient_privilege then null;
  end;
  select * into d from public.list_workspace_email_deliveries(200) x where x.recipient = 'r3-viewer@example.com' and x.delivery_status = 'bounced';
  assert found and d.in_workspace and d.suppressed and d.status = 'sent' and d.kind = 'custom', 'a workspace address with its status';
  select * into d from public.list_workspace_email_deliveries(200) x where x.recipient like 's•••@outside.test';
  assert found and not d.in_workspace and d.last_error is null and d.kind = 'form_confirmation',
    'an outside address is masked, and so is its provider error';
  assert not exists (select 1 from public.list_workspace_email_deliveries(200) x where x.recipient = 'someone@outside.test'),
    'never in full';
  assert (select count(*) from public.list_workspace_email_deliveries(200) x where x.kind = 'digest') >= 1,
    'digests show up as a kind';
  select * into s from public.workspace_email_summary(30);
  assert s.bounced >= 1 and s.suppressed_addresses >= 1 and s.failed >= 1, format('the summary counts: %s', s);
  begin
    insert into public.email_suppressions (email, reason) values ('nobody@example.com', 'bounced');
    assert false, 'nobody adds entries by hand';
  exception when insufficient_privilege then null;
  end;
  perform public.clear_email_suppression((select x.id from public.list_email_suppressions() x where x.email = 'r3-viewer@example.com'));
  begin
    perform public.clear_email_suppression(gen_random_uuid());
    assert false, 'nothing to clear';
  exception when no_data_found then null;
  end;
end $$;
reset role;

do $$
begin
  assert (select proargnames from pg_proc where oid = 'public.list_workspace_email_deliveries(integer)'::regprocedure)
    = array['max_results', 'id', 'kind', 'recipient', 'in_workspace', 'status', 'delivery_status', 'delivery_detail',
            'attempts', 'max_attempts', 'last_error', 'created_at', 'sent_at', 'delivery_event_at', 'suppressed'],
    'no subject, body, payload, task, or project in the overview';
  assert (select cleared_at > now() - interval '1 minute' and cleared_by = 'a3a3a3a3-0000-4000-8000-000000000004'
          from public.email_suppressions where email = 'r3-viewer@example.com'), 'cleared now, by Ada';
  assert not exists (select 1 from public.email_suppressions where email = 'r3-viewer@example.com' and cleared_at is null),
    'no longer active';
end $$;

-- A late retry of the old bounce doesn't put it back; a new complaint does.
set role service_role;
do $$
declare
  r jsonb;
begin
  r := public.record_email_event('re_r3_one', 'email.bounced', now() - interval '1 hour', 'Permanent', 'General');
  assert not exists (select 1 from public.email_suppressions where email = 'r3-viewer@example.com' and cleared_at is null),
    'an event from before the clear doesn''t suppress again';
  r := public.record_email_event('re_r3_one', 'email.complained', now());
  assert r ->> 'suppressed' = 'true', 'a spam complaint suppresses';
end $$;
reset role;
do $$
begin
  assert (select reason from public.email_suppressions where email = 'r3-viewer@example.com' and cleared_at is null) = 'complained',
    'listed as a complaint';
  assert (select delivery_status from public.email_outbox where provider_message_id = 're_r3_one') = 'complained',
    'the strongest event wins';
end $$;

-- The queue entry point --------------------------------------------------------------------------------------

set role service_role;
do $$
declare
  r jsonb;
begin
  r := public.alhc_queue_scheduled_emails();
  assert r ? 'digests' and r ? 'reports', format('counts: %s', r);
end $$;
reset role;
