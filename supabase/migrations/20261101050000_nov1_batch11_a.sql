-- Nov 1 notes, batch 11 (notes 73–75, carried over from batch 9b). Additive: new helper functions and
-- asserted patches of existing ones; nothing is renamed or taken away, and there is no tail.
--
-- What the database gains (the app does the rest):
--   * 75 Personal email digest (Settings → Notifications → Email digest; off by default, opt-in): the
--     Real features 3 Inbox digest now also lists the person's open tasks that are overdue or due today
--     (a weekly digest: due in the next seven days), and it only ever goes out on the workspace's
--     workdays (workspaces.work_week, Sunday–Thursday: never on a Friday or Saturday in the person's time
--     zone). digest_next_at() picks the next workday send time; queue_digest_emails() skips a non-workday
--     (the next digest covers everything since the last one), queues a digest when there are unread
--     Inbox items or such tasks, and lists the tasks (≤ 50, all counted) read as the recipient;
--     digest_email_tasks() (service_role) re-reads them at send time; the send-time check refuses a
--     digest on a non-workday and one with nothing left. A weekly digest's day must be a workday
--     (set_email_digest). The digest is still an email_outbox row sent by the app's drain through Resend
--     from the no-reply sender with its "Do not reply" footnote (batch 8); nothing new sends anything.
--   * 73 Emails are hard-coded: the Admin console's and projects' email design editors are gone from the
--     app (the email_designs rows are kept, unused), so a response to a form's submitter no longer takes
--     its subject from a stored requester design (submitter_response_subject): it is Asana's
--     'Re: "<form>" submission received' (or the conversation's existing subject).
-- No new client SECURITY DEFINER function (suite 60 unchanged); nothing for anon. fire_rules,
-- notify_with, notify_message, and add_story are untouched.

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

-- =================================================================================================
-- 1. Workdays (75)
-- =================================================================================================

-- The workspace's workweek (0 = Sunday … 6 = Saturday; Sunday–Thursday unless a workspace admin changed
-- it in Admin console → Organization). Invoker: workspaces are readable by everyone allowlisted, and the
-- definer queue reads it as the owner.
create or replace function public.digest_work_week()
returns smallint[]
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    (select case when cardinality(w.work_week) between 1 and 7 then w.work_week end
     from public.workspaces w
     where w.deleted_at is null
     order by w.created_at
     limit 1),
    '{0,1,2,3,4}'::smallint[]
  );
$$;

revoke all on function public.digest_work_week() from public, anon;
grant execute on function public.digest_work_week() to authenticated, service_role;

-- Is `at_time` a workday in `zone`? (The local test harness sets alhc.digest_every_day = 'on' so the
-- older digest suites don't depend on the day they run; nothing in the app sets it.)
create or replace function public.digest_is_workday(at_time timestamptz, zone text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(current_setting('alhc.digest_every_day', true), '') = 'on'
    or extract(dow from (at_time at time zone public.safe_timezone(zone)))::smallint = any (public.digest_work_week());
$$;

revoke all on function public.digest_is_workday(timestamptz, text) from public, anon;
grant execute on function public.digest_is_workday(timestamptz, text) to authenticated, service_role;

-- The next digest after `after_time`: daily at `send_hour`, or weekly on `send_weekday`, in `zone`, moved
-- on day by day to the next workday (a weekly digest on a day off goes out on the next workday). Null for
-- 'off'.
create or replace function public.digest_next_at(frequency text, send_hour integer, send_weekday integer, zone text, after_time timestamptz)
returns timestamptz
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  candidate timestamptz;
  steps integer := 0;
begin
  if frequency is null or frequency not in ('daily', 'weekly') then
    return null;
  end if;
  candidate := public.email_schedule_next_at(frequency, send_hour, send_weekday, 1, zone, after_time);
  while candidate is not null and not public.digest_is_workday(candidate, zone) and steps < 14 loop
    candidate := public.email_schedule_next_at('daily', send_hour, null, null, zone, candidate);
    steps := steps + 1;
  end loop;
  return candidate;
end;
$$;

revoke all on function public.digest_next_at(text, integer, integer, text, timestamptz) from public, anon;
grant execute on function public.digest_next_at(text, integer, integer, text, timestamptz) to authenticated, service_role;

-- The settings row's next send time follows the workdays.
select public.alhc_patch_function('public.guard_email_preferences()'::regprocedure,
  $old$      else public.email_schedule_next_at(new.digest, new.digest_hour, new.digest_weekday, 1, new.time_zone, now())$old$,
  $new$      else public.digest_next_at(new.digest, new.digest_hour, new.digest_weekday, new.time_zone, now())$new$);

-- A weekly digest's day is a workday.
select public.alhc_patch_function('public.set_email_digest(text, integer, integer, text)'::regprocedure,
  $old$    raise exception 'Choose a day of the week' using errcode = 'check_violation';
  end if;$old$,
  $new$    raise exception 'Choose a day of the week' using errcode = 'check_violation';
  end if;
  if frequency = 'weekly' and not (send_weekday::smallint = any (public.digest_work_week())) then
    raise exception 'Choose a workday: digests only go out on workdays' using errcode = 'check_violation';
  end if;$new$);

-- Every live digest gets a workday send time now (rows set up before this release may sit on a day off).
update public.email_preferences
set digest_next_at = public.digest_next_at(digest, digest_hour, digest_weekday, time_zone, now())
where digest <> 'off';

-- =================================================================================================
-- 2. Tasks in the digest (75)
-- =================================================================================================

-- The open tasks a digest lists: assigned to the person, readable by them (the caller must already be
-- running as them: request.jwt.claim.sub), not in the Trash, not only in an archived project, and due on
-- or before `due_until` (overdue ones included). Internal.
create or replace function public.digest_task_candidates(person uuid, due_until date)
returns table (task_id uuid, title text, due_on date, n bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.title, t.due_on, row_number() over (order by t.due_on, lower(t.title), t.id)
  from public.tasks t
  left join public.projects p on p.id = t.home_project_id
  where t.assignee_id = person
    and t.deleted_at is null
    and t.completed_at is null
    and t.due_on is not null
    and t.due_on <= due_until
    and (p.id is null or (p.deleted_at is null and p.archived_at is null))
    and public.has_task_role(t.id, 'viewer');
$$;

revoke all on function public.digest_task_candidates(uuid, date) from public, anon, authenticated;

-- The queue: workdays only, and a digest when there are unread Inbox items or tasks due / overdue.
select public.alhc_patch_function('public.queue_digest_emails()'::regprocedure,
  $old$  total integer;
  queued integer := 0;$old$,
  $new$  total integer;
  task_ids jsonb;
  task_total integer;
  local_today date;
  due_until date;
  queued integer := 0;$new$,
  $old$    next_at := public.email_schedule_next_at(pref.digest, pref.digest_hour, pref.digest_weekday, 1, pref.time_zone, now());$old$,
  $new$    next_at := public.digest_next_at(pref.digest, pref.digest_hour, pref.digest_weekday, pref.time_zone, now());
    -- Nov 1 notes, batch 11: never on a day off (Friday and Saturday by default). Nothing is marked sent,
    -- so the next workday's digest covers everything since the last one.
    if not public.digest_is_workday(now(), pref.time_zone) then
      update public.email_preferences set digest_next_at = next_at where profile_id = pref.profile_id;
      continue;
    end if;
    local_today := (now() at time zone public.safe_timezone(pref.time_zone))::date;
    due_until := local_today + case pref.digest when 'weekly' then 6 else 0 end;$new$,
  $old$      ) x;
      perform set_config('request.jwt.claim.sub', coalesce(previous_sub, ''), true);
    exception when others then
      total := 0;
    end;

    if total = 0 then$old$,
  $new$      ) x;
      -- Their open tasks that are overdue or due today (this week, for a weekly digest).
      select count(*)::integer, coalesce(jsonb_agg(c.task_id order by c.n) filter (where c.n <= 50), '[]'::jsonb)
        into task_total, task_ids
      from public.digest_task_candidates(person.id, due_until) c;
      perform set_config('request.jwt.claim.sub', coalesce(previous_sub, ''), true);
    exception when others then
      total := 0;
      task_total := 0;
    end;

    if total = 0 and coalesce(task_total, 0) = 0 then$new$,
  $old$        'total', total,$old$,
  $new$        'total', total,
        'task_ids', coalesce(task_ids, '[]'::jsonb),
        'task_total', coalesce(task_total, 0),
        'today', local_today,
        'due_until', due_until,$new$);

-- A queued digest's tasks as they stand now (service_role, for the drain): still open, still assigned to
-- the recipient, still readable by them, overdue first, each with its link (the recipient's project for
-- it, else My tasks) and the project's name. Read as the recipient.
create or replace function public.digest_email_tasks(target_email uuid)
returns table (task_id uuid, title text, due_on date, overdue boolean, project_name text, path text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  o public.email_outbox;
  previous_sub text;
  local_day date;
begin
  select * into o from public.email_outbox x where x.id = target_email and x.payload ->> 'kind' = 'digest';
  if not found or o.to_profile_id is null or jsonb_typeof(o.payload -> 'task_ids') <> 'array' then
    return;
  end if;
  local_day := coalesce(
    case when o.payload ->> 'today' ~ '^\d{4}-\d{2}-\d{2}$' then (o.payload ->> 'today')::date end,
    (now() at time zone public.safe_timezone(o.payload ->> 'time_zone'))::date
  );
  previous_sub := current_setting('request.jwt.claim.sub', true);
  perform set_config('request.jwt.claim.sub', o.to_profile_id::text, true);
  return query
  select t.id, t.title, t.due_on, t.due_on < local_day, p.name,
         case when p.id is not null then '/projects/' || p.id::text || '?task=' || t.id::text
              else '/my-tasks?task=' || t.id::text end
  from public.tasks t
  left join lateral (
    select pp.id, pp.name from public.projects pp
    where pp.id = public.comment_email_project(o.to_profile_id, t.id)
  ) p on true
  where (o.payload -> 'task_ids') ? t.id::text
    and t.assignee_id = o.to_profile_id
    and t.deleted_at is null
    and t.completed_at is null
    and public.has_task_role(t.id, 'viewer')
  order by t.due_on nulls last, lower(t.title), t.id;
  perform set_config('request.jwt.claim.sub', coalesce(previous_sub, ''), true);
end;
$$;

revoke all on function public.digest_email_tasks(uuid) from public, anon, authenticated;
grant execute on function public.digest_email_tasks(uuid) to service_role;

-- The send-time check's "anything left?": an unread Inbox item, or one of its tasks still open and
-- assigned to the recipient.
select public.alhc_patch_function('public.digest_has_items(uuid)'::regprocedure,
  $old$  if not found or o.to_profile_id is null or jsonb_typeof(o.payload -> 'item_ids') <> 'array' then
    return false;
  end if;$old$,
  $new$  if not found or o.to_profile_id is null or jsonb_typeof(o.payload -> 'item_ids') <> 'array' then
    return false;
  end if;
  -- Nov 1 notes, batch 11: tasks due or overdue count too.
  if jsonb_typeof(o.payload -> 'task_ids') = 'array' and jsonb_array_length(o.payload -> 'task_ids') > 0
     and exists (select 1 from public.digest_email_tasks(o.id)) then
    return true;
  end if;$new$);

-- Never sent on a day off, even when it was queued late on the day before.
select public.alhc_patch_function('public.scheduled_email_block_reason(uuid)'::regprocedure,
  $old$      return 'Not sent: the recipient turned off the digest';
    end if;$old$,
  $new$      return 'Not sent: the recipient turned off the digest';
    end if;
    if not public.digest_is_workday(now(), coalesce(o.payload ->> 'time_zone', pref.time_zone)) then
      return 'Not sent: digests only go out on workdays';
    end if;$new$);

-- =================================================================================================
-- 3. Hard-coded emails (73)
-- =================================================================================================

-- A response's subject no longer comes from a stored requester design: the conversation's subject, else
-- Asana's 'Re: "<form>" submission received'.
select public.alhc_patch_function('public.submitter_response_subject(uuid, uuid)'::regprocedure,
  $old$  tmpl := public.resolve_email_design('requester',
    coalesce((select f.project_id from public.forms f where f.id = s.form_id), r.home_project_id), s.form_id) ->> 'subject_template';$old$,
  $new$  -- Nov 1 notes, batch 11: emails are hard-coded; stored designs are no longer applied.
  tmpl := null;$new$);

comment on table public.email_designs is
  'Email designs (Oct 19). Since Nov 1 notes, batch 11 the app has no design editor and no email applies a '
  'stored design: emails are hard-coded in the app''s templates. Rows are kept.';
