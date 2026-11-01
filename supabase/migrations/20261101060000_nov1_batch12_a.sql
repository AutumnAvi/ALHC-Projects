-- Nov 1 notes, batch 12 (items 83–84): email-in activity and how automation comments read. Additive:
-- one new table (with a one-time backfill), one new trigger, two small new helpers, and asserted patches
-- of existing functions; nothing is renamed or taken away, and there is no tail.
--
-- What the database gains (the app does the rest):
--   * 83 Email-in activity: task_email_activity records each task that came in by email (a forwarded
--     email turned into a task: post_email_forward) and each comment that came in by email (a form
--     submitter's emailed reply: post_submitter_reply), with the sender, the subject, and the project the
--     task was in. The pane's activity says "Created by email from <sender> · <subject>" / "Comment added
--     by email from <sender>", and the project's Overview lists them too. Read with the task (task Viewers+
--     through has_task_role), so nobody learns about a task they can't open; nobody writes it but the
--     database. Existing forwards and emailed replies were added once (the backfill below).
--   * 84 Person placeholders in an automation's comment: {{task.assignee}}, {{task.creator}} (and the
--     old {assignee} / {creator}), and People fields render as an @mention of the person (their name, else
--     the part of their email before the @) — never their email address — so the comment shows a mention
--     chip and the person hears about it like any mention. {{task.assignee.name}} / {{task.creator.name}}
--     give the plain name (same rule, no @). Other places that render automation text (emails, Slack,
--     Inbox notifications, task names) are unchanged.
--   * profile_handle (the @token of the old {assignee} / {creator}) no longer turns a name that is really
--     an email address into "@someone@example.com": such a person is "@someone", which the mention
--     matcher already recognises.
-- The automation run markers in a task's activity come from rule_runs (already readable by the project's
-- Viewers+); nothing new is needed for them. No new client function (suite 60 unchanged); nothing for
-- anon. fire_rules, notify_with, notify_message, and add_story are untouched.

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
-- 1. task_email_activity (83)
-- =================================================================================================

create table if not exists public.task_email_activity (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id),
  -- The project the task was in when the email came (the forward's project; a reply's request's
  -- project); null for a private task. Where the project's Overview lists it.
  project_id uuid references public.projects (id),
  kind text not null check (kind in ('task_created', 'comment_added')),
  sender_email text not null check (length(sender_email) between 1 and 320),
  -- The workspace person with that address, when there is one (the forwarder always is).
  sender_profile_id uuid references public.profiles (id),
  subject text check (length(subject) <= 500),
  comment_id uuid unique references public.comments (id),
  created_at timestamptz not null default now()
);

alter table public.task_email_activity enable row level security;

create index if not exists task_email_activity_task_idx on public.task_email_activity (task_id, created_at);
create index if not exists task_email_activity_project_idx on public.task_email_activity (project_id, created_at desc);
create index if not exists task_email_activity_sender_idx on public.task_email_activity (sender_profile_id);
create unique index if not exists task_email_activity_created_once on public.task_email_activity (task_id)
  where kind = 'task_created';

comment on table public.task_email_activity is
  'Nov 1 notes, batch 12 (83): tasks created by email (a forwarded email) and comments added by email (a '
  'form submitter''s emailed reply), with the sender and subject, for the task''s activity and the project '
  'Overview. Read with the task (has_task_role viewer); written only by SECURITY DEFINER code.';

create policy task_email_activity_select_viewer on public.task_email_activity
  for select to authenticated
  using ((select public.has_task_role(task_id, 'viewer')));

select public.alhc_revoke_anon_grants(array['task_email_activity']);
select public.alhc_revoke_client_truncate(array['task_email_activity']);
revoke all on public.task_email_activity from authenticated;
grant select on public.task_email_activity to authenticated;

-- The forwarded email's task: one row next to the "created" story (inside the creating subtransaction,
-- so a failed forward leaves nothing behind).
select public.alhc_patch_function(
  'public.post_email_forward(text, text, boolean, text, text, text)'::regprocedure,
  $old$    update public.task_stories set data = data || '{"via": "email"}'::jsonb
    where task_id = new_task and kind = 'created';$old$,
  $new$    update public.task_stories set data = data || '{"via": "email"}'::jsonb
    where task_id = new_task and kind = 'created';
    -- Nov 1 notes, batch 12 (83): "Created by email from <sender> · <subject>" in the task's activity and
    -- the project's Overview.
    insert into public.task_email_activity (task_id, project_id, kind, sender_email, sender_profile_id, subject)
    values (
      new_task, project, 'task_created', left(sender, 320), person.id,
      nullif(left(btrim(coalesce(email_subject, '')), 500), '')
    );$new$);

-- A comment that came in by email: a form submitter's emailed reply (an authorless "received" comment).
-- A review's outcome is a "received" comment too, but it comes from the review page, not by email.
create or replace function public.on_comment_email_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  project uuid;
  sender text := lower(btrim(coalesce(new.email_address, '')));
begin
  if new.email_direction is distinct from 'received' or new.review_check_id is not null or sender = '' then
    return null;
  end if;
  select root.home_project_id into project
  from public.tasks t
  join public.tasks root on root.id = coalesce(t.root_task_id, t.id)
  where t.id = new.task_id;
  insert into public.task_email_activity (task_id, project_id, kind, sender_email, sender_profile_id, subject, comment_id, created_at)
  values (
    new.task_id, project, 'comment_added', left(sender, 320),
    (select p.id from public.profiles p where lower(p.email) = sender order by p.created_at limit 1),
    nullif(left(btrim(coalesce(new.email_subject, '')), 500), ''),
    new.id, new.created_at
  )
  on conflict do nothing;
  return null;
end;
$$;

revoke all on function public.on_comment_email_activity() from public, anon, authenticated;

create trigger comments_after_insert_zz_email_activity
  after insert on public.comments
  for each row execute function public.on_comment_email_activity();

-- Once: what came in by email before this release. A forward keeps no subject, so the task's name (the
-- subject without its Re: / Fwd:) stands in for it.
insert into public.task_email_activity (task_id, project_id, kind, sender_email, sender_profile_id, subject, created_at)
select f.task_id, f.project_id, 'task_created', left(lower(p.email), 320), p.id, left(t.title, 500), f.created_at
from public.email_forwards f
join public.tasks t on t.id = f.task_id
join public.profiles p on p.id = f.profile_id
where f.status = 'created'
  and not exists (
    select 1 from public.task_email_activity a where a.task_id = f.task_id and a.kind = 'task_created'
  );

insert into public.task_email_activity (task_id, project_id, kind, sender_email, sender_profile_id, subject, comment_id, created_at)
select c.task_id,
  (select root.home_project_id from public.tasks t join public.tasks root on root.id = coalesce(t.root_task_id, t.id) where t.id = c.task_id),
  'comment_added', left(lower(btrim(c.email_address)), 320),
  (select p.id from public.profiles p where lower(p.email) = lower(btrim(c.email_address)) order by p.created_at limit 1),
  nullif(left(btrim(coalesce(c.email_subject, '')), 500), ''),
  c.id, c.created_at
from public.comments c
where c.email_direction = 'received'
  and c.review_check_id is null
  and nullif(btrim(coalesce(c.email_address, '')), '') is not null
  and not exists (select 1 from public.task_email_activity a where a.comment_id = c.id);

-- =================================================================================================
-- 2. People in an automation's comment (84)
-- =================================================================================================

-- The name a person is mentioned by: their name, unless it is empty or really an email address, else
-- the part of their email before the @ (both are what comment_mention_ids() matches). Internal.
create or replace function public.profile_mention_name(target_profile uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when nullif(trim(p.full_name), '') is not null and position('@' in p.full_name) = 0 then trim(p.full_name)
    else split_part(p.email, '@', 1)
  end
  from public.profiles p
  where p.id = target_profile;
$$;

revoke all on function public.profile_mention_name(uuid) from public, anon, authenticated;

-- The @token of the old {assignee} / {creator}: same signature and grants, never an email address.
create or replace function public.profile_handle(target_profile uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select '@' || public.profile_mention_name(target_profile);
$$;

revoke all on function public.profile_handle(uuid) from public, anon, authenticated;

-- A People field's people as @mentions (an automation's comment). Internal.
create or replace function public.rule_comment_people(target_task uuid, target_field uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select string_agg(public.profile_handle(p.id), ', ' order by public.profile_mention_name(p.id))
  from public.task_field_values v
  join public.profiles p on v.value @> jsonb_build_array(p.id::text)
  where v.task_id = target_task and v.field_id = target_field;
$$;

revoke all on function public.rule_comment_people(uuid, uuid) from public, anon, authenticated;

-- 'comment' is the format of an automation's Add comment step: like plain text, but people become
-- @mentions (the comment trigger records them, so the comment shows a chip and the person is told).
select public.alhc_patch_function(
  'public.rule_placeholder_value(text, public.tasks, uuid, jsonb, text)'::regprocedure,
  $old$  elsif k in ('task.assignee', 'task.assignee.name', 'assignee') then
    v := public.rule_profile_name(t.assignee_id);
  elsif k in ('task.creator', 'task.creator.name', 'creator') then
    v := public.rule_profile_name(t.created_by);$old$,
  $new$  elsif k in ('task.assignee', 'task.assignee.name', 'assignee') then
    -- Nov 1 notes, batch 12 (84): in an automation's comment a person is an @mention (or, for .name,
    -- their name), never their email address.
    v := case
      when text_format = 'comment' and k = 'task.assignee.name' then public.profile_mention_name(t.assignee_id)
      when text_format = 'comment' then public.profile_handle(t.assignee_id)
      else public.rule_profile_name(t.assignee_id)
    end;
  elsif k in ('task.creator', 'task.creator.name', 'creator') then
    v := case
      when text_format = 'comment' and k = 'task.creator.name' then public.profile_mention_name(t.created_by)
      when text_format = 'comment' then public.profile_handle(t.created_by)
      else public.rule_profile_name(t.created_by)
    end;$new$,
  $old$      ) else public.task_field_text(t.id, f.id) end;$old$,
  $new$      ) when text_format = 'comment' and f.field_type = 'people' then public.rule_comment_people(t.id, f.id)
      else public.task_field_text(t.id, f.id) end;$new$);

select public.alhc_patch_function(
  'public.execute_rule_actions(public.rules, uuid, jsonb, jsonb)'::regprocedure,
  $old$left(public.render_rule_text(a ->> 'body', target_task, r.project_id, event), 10000)$old$,
  $new$left(public.render_rule_text_as(a ->> 'body', target_task, r.project_id, event, 'comment'), 10000)$new$);

-- Last: the app's probe for this release's database features (the email-in activity) reads this table.
grant select on public.task_email_activity to authenticated;
