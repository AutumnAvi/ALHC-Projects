-- ALHC Projects — workflows phase.
-- Request numbers (Req #), approvals, intake forms with branching, a rules engine with installable
-- presets, and an email outbox. Everything stays generic: a "request type" is a project + fields +
-- form + rules, never a table of its own.
--
-- Same rules as earlier phases: RLS on every table, soft delete, no DELETE policies. Tables that only
-- the system writes (approval_requests, form_submissions, rule_runs, scheduled_rule_actions,
-- email_outbox, rule_presets) have a SELECT policy only; their writes go through SECURITY DEFINER
-- functions, like task_stories in the collaboration phase.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- True when the statement runs directly as an API role (not inside a SECURITY DEFINER function).
-- Guards use this to keep system-managed columns out of reach of direct client writes.
create or replace function public.is_client_role()
returns boolean
language sql
stable
set search_path = ''
as $$
  select current_user in ('anon', 'authenticated');
$$;

revoke all on function public.is_client_role() from public, anon;
grant execute on function public.is_client_role() to authenticated;

-- Rule execution marks the transaction with the running rule so that stories, comments, and inbox
-- items it causes are attributed to the rule rather than to the person who triggered it.
create or replace function public.rule_context_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('alhc.rule_id', true), '')::uuid;
$$;

revoke all on function public.rule_context_id() from public, anon, authenticated;

create or replace function public.current_actor_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.rule_context_id() is null then public.current_profile_id() end;
$$;

revoke all on function public.current_actor_id() from public, anon, authenticated;

create or replace function public.is_email(value text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select value is not null and length(value) <= 320 and value ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$';
$$;

revoke all on function public.is_email(text) from public, anon;
grant execute on function public.is_email(text) to authenticated;

create or replace function public.profile_handle(target_profile uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select '@' || coalesce(nullif(trim(p.full_name), ''), split_part(p.email, '@', 1))
  from public.profiles p
  where p.id = target_profile;
$$;

revoke all on function public.profile_handle(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Story + inbox vocabulary
-- ---------------------------------------------------------------------------

alter table public.task_stories drop constraint task_stories_kind_check;
alter table public.task_stories add constraint task_stories_kind_check check (kind in (
  'created', 'completed', 'reopened', 'renamed', 'assigned', 'unassigned', 'due_changed',
  'section_changed', 'project_added', 'project_removed', 'attachment_added', 'field_changed',
  'deleted', 'approval_requested', 'approval_decided', 'approval_cancelled', 'approval_resubmitted',
  'form_submitted', 'request_number_assigned', 'email_queued'
));

alter table public.inbox_items drop constraint inbox_items_kind_check;
alter table public.inbox_items add constraint inbox_items_kind_check check (kind in (
  'assigned', 'comment', 'mention', 'completed', 'approval_requested', 'approval_decided', 'rule'
));
alter table public.inbox_items add column data jsonb not null default '{}'::jsonb;

-- Stories written while a rule runs carry the rule's id and name, and have no human actor.
create or replace function public.add_story(target_task uuid, story_kind text, story_data jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  rule uuid := public.rule_context_id();
  extra jsonb := '{}'::jsonb;
begin
  if rule is not null then
    extra := jsonb_build_object(
      'rule_id', rule,
      'rule_name', (select r.name from public.rules r where r.id = rule)
    );
  end if;
  insert into public.task_stories (task_id, actor_id, kind, data)
  values (target_task, public.current_actor_id(), story_kind, coalesce(story_data, '{}'::jsonb) || extra);
end;
$$;

revoke all on function public.add_story(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.notify_with(
  recipient uuid,
  target_task uuid,
  item_kind text,
  source_comment uuid,
  item_data jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := public.current_actor_id();
  rule uuid := public.rule_context_id();
begin
  if recipient is null or recipient is not distinct from actor then
    return;
  end if;
  if not exists (select 1 from public.profiles p where p.id = recipient) then
    return;
  end if;
  insert into public.inbox_items (recipient_id, actor_id, task_id, comment_id, kind, data)
  values (
    recipient, actor, target_task, source_comment, item_kind,
    coalesce(item_data, '{}'::jsonb) || case
      when rule is null then '{}'::jsonb
      else jsonb_build_object('rule_id', rule, 'rule_name', (select r.name from public.rules r where r.id = rule))
    end
  );
end;
$$;

revoke all on function public.notify_with(uuid, uuid, text, uuid, jsonb) from public, anon, authenticated;

create or replace function public.notify(
  recipient uuid,
  target_task uuid,
  item_kind text,
  source_comment uuid default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  select public.notify_with(recipient, target_task, item_kind, source_comment, '{}'::jsonb);
$$;

revoke all on function public.notify(uuid, uuid, text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Request numbers (Req #)
-- One sequence row per project. Numbers are dedicated task columns, not a custom field, so they are
-- unique per project, can't be edited from the client, and survive title edits.
-- ---------------------------------------------------------------------------

create table public.request_sequences (
  project_id uuid primary key references public.projects (id),
  enabled boolean not null default true,
  prefix text not null default 'Req #' check (length(prefix) <= 20),
  pad_width smallint not null default 0 check (pad_width between 0 and 8),
  add_to_title boolean not null default true,
  assign_to text not null default 'form_submissions' check (assign_to in ('all_tasks', 'form_submissions')),
  -- The last number handed out. Set it once to continue an existing numbering; it can only grow.
  last_number bigint not null default 0 check (last_number >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create trigger request_sequences_set_updated_at
  before update on public.request_sequences
  for each row execute function public.set_updated_at();

create or replace function public.guard_request_sequence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.last_number < old.last_number then
    raise exception 'Request numbers can only move forward (last issued: %)', old.last_number
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger request_sequences_guard
  before update of last_number on public.request_sequences
  for each row execute function public.guard_request_sequence();

alter table public.tasks
  add column source text not null default 'manual' check (source in ('manual', 'form', 'import')),
  add column req_project_id uuid references public.projects (id),
  add column req_number bigint check (req_number > 0),
  add constraint tasks_req_pair check ((req_project_id is null) = (req_number is null));

create unique index tasks_req_number_idx
  on public.tasks (req_project_id, req_number)
  where req_number is not null;

alter table public.projects
  add column approval_completes_task boolean not null default false;

create or replace function public.format_request_label(target_project uuid, number bigint)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when number is null then null else
    coalesce((select s.prefix from public.request_sequences s where s.project_id = target_project), '#')
    || case
      when length(number::text) >= coalesce((select s.pad_width from public.request_sequences s where s.project_id = target_project), 0)
        then number::text
      else lpad(number::text, (select s.pad_width from public.request_sequences s where s.project_id = target_project), '0')
    end
  end;
$$;

revoke all on function public.format_request_label(uuid, bigint) from public, anon;
grant execute on function public.format_request_label(uuid, bigint) to authenticated;

create or replace function public.task_request_label(target_task uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select public.format_request_label(t.req_project_id, t.req_number)
  from public.tasks t
  where t.id = target_task;
$$;

revoke all on function public.task_request_label(uuid) from public, anon;
grant execute on function public.task_request_label(uuid) to authenticated;

-- Atomic: the UPDATE row-locks the sequence, so concurrent submissions get distinct numbers.
create or replace function public.next_request_number(target_project uuid)
returns bigint
language sql
security definer
set search_path = ''
as $$
  update public.request_sequences
  set last_number = last_number + 1
  where project_id = target_project and enabled and deleted_at is null
  returning last_number;
$$;

revoke all on function public.next_request_number(uuid) from public, anon, authenticated;

-- Clients may not set source or Req # themselves (runs as the caller, so this sees the API role).
create or replace function public.guard_task_system_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.is_client_role() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.source <> 'manual' or new.req_number is not null or new.req_project_id is not null then
      raise exception 'Task source and request numbers are managed by the system'
        using errcode = 'insufficient_privilege';
    end if;
  elsif new.source is distinct from old.source
     or new.req_number is distinct from old.req_number
     or new.req_project_id is distinct from old.req_project_id then
    raise exception 'Task source and request numbers are managed by the system'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger tasks_10_guard_system_columns
  before insert or update on public.tasks
  for each row execute function public.guard_task_system_columns();

create or replace function public.assign_request_number_on_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  seq public.request_sequences;
  number bigint;
  label text;
begin
  if new.req_number is not null then
    return new;
  end if;
  select * into seq from public.request_sequences s
  where s.project_id = new.home_project_id and s.enabled and s.deleted_at is null;
  if not found or (seq.assign_to = 'form_submissions' and new.source <> 'form') then
    return new;
  end if;
  number := public.next_request_number(new.home_project_id);
  label := public.format_request_label(new.home_project_id, number);
  new.req_project_id := new.home_project_id;
  new.req_number := number;
  if seq.add_to_title then
    new.title := '[' || label || '] ' || new.title;
  end if;
  return new;
end;
$$;

create trigger tasks_20_assign_request_number
  before insert on public.tasks
  for each row execute function public.assign_request_number_on_insert();

-- Numbers an existing task from its home project's sequence (e.g. tasks created before numbering).
create or replace function public.assign_request_number(target_task uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tasks;
  seq public.request_sequences;
  number bigint;
  label text;
begin
  if not public.is_allowlisted() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  select * into t from public.tasks where id = target_task and deleted_at is null for update;
  if not found then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if t.req_number is not null then
    return public.format_request_label(t.req_project_id, t.req_number);
  end if;
  select * into seq from public.request_sequences s
  where s.project_id = t.home_project_id and s.enabled and s.deleted_at is null;
  if not found then
    raise exception 'Request numbers are not enabled for this task''s home project'
      using errcode = 'check_violation';
  end if;
  number := public.next_request_number(t.home_project_id);
  label := public.format_request_label(t.home_project_id, number);
  update public.tasks
  set req_project_id = t.home_project_id,
      req_number = number,
      title = case when seq.add_to_title then '[' || label || '] ' || t.title else t.title end
  where id = target_task;
  perform public.add_story(target_task, 'request_number_assigned', jsonb_build_object('label', label));
  return label;
end;
$$;

revoke all on function public.assign_request_number(uuid) from public, anon;
grant execute on function public.assign_request_number(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Rules (definitions first: comments, approvals, and stories reference them)
-- ---------------------------------------------------------------------------

create table public.rules (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  name text not null check (length(trim(name)) > 0 and length(name) <= 200),
  -- New and installed rules start disabled so nothing fires until someone turns it on.
  enabled boolean not null default false,
  trigger_type text not null check (trigger_type in (
    'task_created', 'section_changed', 'field_changed', 'assignee_changed', 'due_approaching',
    'approval_decided', 'form_submitted'
  )),
  trigger_config jsonb not null default '{}'::jsonb check (jsonb_typeof(trigger_config) = 'object'),
  conditions jsonb not null default '[]'::jsonb check (jsonb_typeof(conditions) = 'array'),
  actions jsonb not null default '[]'::jsonb check (jsonb_typeof(actions) = 'array'),
  preset_key text,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  sort_order double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index rules_project_trigger_idx
  on public.rules (project_id, trigger_type)
  where deleted_at is null and enabled;
create index rules_project_idx on public.rules (project_id, sort_order) where deleted_at is null;
create index rules_created_by_idx on public.rules (created_by);

create trigger rules_set_updated_at
  before update on public.rules
  for each row execute function public.set_updated_at();

-- Rule-authored comments have no human author.
alter table public.comments
  alter column author_id drop not null,
  add column rule_id uuid references public.rules (id),
  add constraint comments_author_or_rule check (author_id is not null or rule_id is not null);

create index comments_rule_idx on public.comments (rule_id);

-- Same behaviour as before, but null-safe for rule-authored comments.
create or replace function public.on_comment_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  perform public.follow_task(new.task_id, new.author_id);

  insert into public.comment_mentions (comment_id, profile_id)
  select new.id, p.id
  from public.profiles p
  where p.id is distinct from new.author_id
    and (
      (nullif(trim(p.full_name), '') is not null
        and new.body ~* ('@' || public.regex_escape(trim(p.full_name)) || '([^[:alnum:]_]|$)'))
      or new.body ~* ('@' || public.regex_escape(split_part(p.email, '@', 1)) || '([^[:alnum:]_]|$)')
    )
  on conflict do nothing;

  for r in select m.profile_id from public.comment_mentions m where m.comment_id = new.id loop
    perform public.follow_task(new.task_id, r.profile_id);
    perform public.notify(r.profile_id, new.task_id, 'mention', new.id);
  end loop;

  for r in
    select f.profile_id
    from public.task_followers f
    where f.task_id = new.task_id
      and f.deleted_at is null
      and f.profile_id is distinct from new.author_id
      and not exists (
        select 1 from public.comment_mentions m
        where m.comment_id = new.id and m.profile_id = f.profile_id
      )
  loop
    perform public.notify(r.profile_id, new.task_id, 'comment', new.id);
  end loop;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Approvals
-- An approval request belongs to a task and may be linked to a subtask (the "approval subtask").
-- Status changes only through the RPCs below; triggers write stories, inbox items, and fire rules.
-- ---------------------------------------------------------------------------

create table public.approval_requests (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id),
  subtask_id uuid references public.subtasks (id),
  approver_id uuid not null references public.profiles (id),
  requested_by uuid references public.profiles (id) on delete set null,
  rule_id uuid references public.rules (id),
  note text check (length(note) <= 2000),
  status text not null default 'pending' check (status in (
    'pending', 'approved', 'changes_requested', 'rejected', 'cancelled'
  )),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  decision_note text check (length(decision_note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index approval_requests_task_idx on public.approval_requests (task_id, created_at) where deleted_at is null;
create index approval_requests_approver_idx on public.approval_requests (approver_id) where deleted_at is null;
create index approval_requests_subtask_idx on public.approval_requests (subtask_id);
create index approval_requests_requested_by_idx on public.approval_requests (requested_by);
create index approval_requests_decided_by_idx on public.approval_requests (decided_by);
create index approval_requests_rule_idx on public.approval_requests (rule_id);

create trigger approval_requests_set_updated_at
  before update on public.approval_requests
  for each row execute function public.set_updated_at();

-- A linked approval subtask is completed by deciding, not by ticking its checkbox.
create or replace function public.guard_approval_subtask()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_client_role()
     and new.completed_at is distinct from old.completed_at
     and exists (
       select 1 from public.approval_requests a
       where a.subtask_id = new.id and a.deleted_at is null
         and a.status in ('pending', 'changes_requested')
     ) then
    raise exception 'This subtask is an approval; approve, request changes, or reject it instead'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger subtasks_guard_approval
  before update of completed_at on public.subtasks
  for each row execute function public.guard_approval_subtask();

create or replace function public.create_approval(
  target_task uuid,
  approver uuid,
  approval_note text,
  as_subtask boolean,
  subtask_title text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  linked_subtask uuid;
  new_id uuid;
begin
  if not exists (select 1 from public.profiles p where p.id = approver) then
    raise exception 'Choose an approver' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.tasks t where t.id = target_task and t.deleted_at is null) then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if as_subtask then
    insert into public.subtasks (task_id, title, sort_order)
    values (
      target_task,
      left(coalesce(nullif(trim(subtask_title), ''), 'Approval'), 500),
      coalesce((select max(s.sort_order) + 1024 from public.subtasks s
                where s.task_id = target_task and s.deleted_at is null), 1024)
    )
    returning id into linked_subtask;
  end if;
  insert into public.approval_requests (task_id, subtask_id, approver_id, requested_by, rule_id, note)
  values (
    target_task, linked_subtask, approver, public.current_actor_id(), public.rule_context_id(),
    nullif(trim(approval_note), '')
  )
  returning id into new_id;
  return new_id;
end;
$$;

revoke all on function public.create_approval(uuid, uuid, text, boolean, text) from public, anon, authenticated;

create or replace function public.request_approval(
  target_task uuid,
  approver uuid,
  approval_note text default null,
  as_subtask boolean default true,
  subtask_title text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_allowlisted() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  return public.create_approval(target_task, approver, approval_note, as_subtask, subtask_title);
end;
$$;

revoke all on function public.request_approval(uuid, uuid, text, boolean, text) from public, anon;
grant execute on function public.request_approval(uuid, uuid, text, boolean, text) to authenticated;

-- Only the approver decides. Deciding sets the status; it never deletes anything.
create or replace function public.decide_approval(
  target_approval uuid,
  decision text,
  decision_note text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.approval_requests;
begin
  if not public.is_allowlisted() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  if decision not in ('approved', 'changes_requested', 'rejected') then
    raise exception 'Unknown decision' using errcode = 'check_violation';
  end if;
  select * into a from public.approval_requests where id = target_approval and deleted_at is null for update;
  if not found then
    raise exception 'Approval not found' using errcode = 'no_data_found';
  end if;
  if a.approver_id is distinct from auth.uid() then
    raise exception 'Only the approver can decide this approval' using errcode = 'insufficient_privilege';
  end if;
  if a.status <> 'pending' then
    raise exception 'This approval is already %', replace(a.status, '_', ' ') using errcode = 'check_violation';
  end if;
  update public.approval_requests
  set status = decision,
      decided_by = auth.uid(),
      decided_at = now(),
      decision_note = nullif(trim(decide_approval.decision_note), '')
  where id = target_approval;
end;
$$;

revoke all on function public.decide_approval(uuid, text, text) from public, anon;
grant execute on function public.decide_approval(uuid, text, text) to authenticated;

create or replace function public.cancel_approval(target_approval uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_allowlisted() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  update public.approval_requests
  set status = 'cancelled'
  where id = target_approval and deleted_at is null and status in ('pending', 'changes_requested');
  if not found then
    raise exception 'Only open approvals can be cancelled' using errcode = 'check_violation';
  end if;
end;
$$;

revoke all on function public.cancel_approval(uuid) from public, anon;
grant execute on function public.cancel_approval(uuid) to authenticated;

-- After changes were requested, send the same approval back to the approver.
create or replace function public.resubmit_approval(target_approval uuid, approval_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_allowlisted() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  update public.approval_requests
  set status = 'pending',
      note = coalesce(nullif(trim(approval_note), ''), note),
      decided_by = null,
      decided_at = null,
      decision_note = null
  where id = target_approval and deleted_at is null and status = 'changes_requested';
  if not found then
    raise exception 'Only approvals with requested changes can be resubmitted' using errcode = 'check_violation';
  end if;
end;
$$;

revoke all on function public.resubmit_approval(uuid, text) from public, anon;
grant execute on function public.resubmit_approval(uuid, text) to authenticated;

create or replace function public.on_approval_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.follow_task(new.task_id, new.approver_id);
  perform public.add_story(new.task_id, 'approval_requested', jsonb_build_object(
    'approval_id', new.id, 'approver_id', new.approver_id, 'note', new.note, 'subtask_id', new.subtask_id
  ));
  perform public.notify_with(new.approver_id, new.task_id, 'approval_requested', null,
    jsonb_build_object('approval_id', new.id, 'note', new.note));
  return new;
end;
$$;

create trigger approval_requests_after_insert
  after insert on public.approval_requests
  for each row execute function public.on_approval_insert();

create or replace function public.on_approval_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  completes_task boolean;
begin
  if new.status = old.status then
    return new;
  end if;

  if new.status = 'cancelled' then
    perform public.add_story(new.task_id, 'approval_cancelled', jsonb_build_object(
      'approval_id', new.id, 'approver_id', new.approver_id
    ));
    return new;
  end if;

  if new.status = 'pending' then
    perform public.add_story(new.task_id, 'approval_resubmitted', jsonb_build_object(
      'approval_id', new.id, 'approver_id', new.approver_id, 'note', new.note
    ));
    perform public.notify_with(new.approver_id, new.task_id, 'approval_requested', null,
      jsonb_build_object('approval_id', new.id, 'note', new.note, 'resubmitted', true));
    return new;
  end if;

  perform public.add_story(new.task_id, 'approval_decided', jsonb_build_object(
    'approval_id', new.id, 'status', new.status, 'approver_id', new.approver_id, 'note', new.decision_note
  ));

  for r in
    select distinct recipient from (
      select new.requested_by as recipient
      union all
      select t.assignee_id from public.tasks t where t.id = new.task_id
      union all
      select f.profile_id from public.task_followers f where f.task_id = new.task_id and f.deleted_at is null
    ) recipients
    where recipient is not null
  loop
    perform public.notify_with(r.recipient, new.task_id, 'approval_decided', null,
      jsonb_build_object('approval_id', new.id, 'status', new.status, 'note', new.decision_note));
  end loop;

  if new.subtask_id is not null and new.status in ('approved', 'rejected') then
    update public.subtasks set completed_at = now()
    where id = new.subtask_id and completed_at is null;
  end if;

  if new.status = 'approved' then
    select p.approval_completes_task into completes_task
    from public.tasks t join public.projects p on p.id = t.home_project_id
    where t.id = new.task_id;
    if completes_task then
      update public.tasks set completed_at = now() where id = new.task_id and completed_at is null;
    end if;
  end if;

  perform public.fire_rules('approval_decided', new.task_id, null, jsonb_build_object(
    'approval_id', new.id, 'status', new.status, 'note', new.decision_note
  ));
  return new;
end;
$$;

create trigger approval_requests_after_status
  after update of status on public.approval_requests
  for each row execute function public.on_approval_status_change();

-- ---------------------------------------------------------------------------
-- Email outbox
-- Rows are queued by forms and rules and delivered by the app (Resend). The database never sends mail.
-- ---------------------------------------------------------------------------

create table public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.tasks (id),
  rule_id uuid references public.rules (id),
  to_email text not null check (public.is_email(to_email)),
  template text not null check (template in ('form_confirmation', 'requester_update', 'due_tomorrow', 'custom')),
  subject text check (length(subject) <= 300),
  payload jsonb not null default '{}'::jsonb,
  -- mocked = no email provider configured; logged instead of sent.
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'mocked', 'failed')),
  attempts integer not null default 0,
  last_error text,
  provider_message_id text,
  send_after timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index email_outbox_pending_idx on public.email_outbox (send_after) where status in ('pending', 'sending');
create index email_outbox_task_idx on public.email_outbox (task_id);
create index email_outbox_rule_idx on public.email_outbox (rule_id);

create trigger email_outbox_set_updated_at
  before update on public.email_outbox
  for each row execute function public.set_updated_at();

create or replace function public.enqueue_email(
  recipient text,
  email_template text,
  email_subject text,
  email_payload jsonb,
  target_task uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  address text := lower(trim(recipient));
  new_id uuid;
begin
  if not public.is_email(address) then
    return null;
  end if;
  insert into public.email_outbox (task_id, rule_id, to_email, template, subject, payload)
  values (target_task, public.rule_context_id(), address, email_template, left(email_subject, 300),
    coalesce(email_payload, '{}'::jsonb))
  returning id into new_id;
  if target_task is not null then
    perform public.add_story(target_task, 'email_queued', jsonb_build_object(
      'email_id', new_id, 'to', address, 'template', email_template
    ));
  end if;
  return new_id;
end;
$$;

revoke all on function public.enqueue_email(text, text, text, jsonb, uuid) from public, anon, authenticated;

-- Delivery workers (the app's /api/cron route, using the service role) claim and complete rows.
create or replace function public.claim_email_outbox(max_items integer default 20, only_id uuid default null)
returns setof public.email_outbox
language sql
security definer
set search_path = ''
as $$
  update public.email_outbox o
  set status = 'sending', attempts = o.attempts + 1
  where o.id in (
    select c.id from public.email_outbox c
    where c.deleted_at is null
      and (only_id is null or c.id = only_id)
      and c.attempts < 5
      and c.send_after <= now()
      and (c.status = 'pending' or (c.status = 'sending' and c.updated_at < now() - interval '10 minutes'))
    order by c.created_at
    limit least(greatest(coalesce(max_items, 20), 1), 100)
    for update skip locked
  )
  returning o.*;
$$;

revoke all on function public.claim_email_outbox(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_email_outbox(integer, uuid) to service_role;

create or replace function public.complete_email_outbox(
  target_email uuid,
  outcome text,
  message_id text default null,
  error_message text default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.email_outbox
  set status = case
        when outcome in ('sent', 'mocked') then outcome
        when attempts >= 5 then 'failed'
        else 'pending'
      end,
      sent_at = case when outcome in ('sent', 'mocked') then now() end,
      provider_message_id = message_id,
      last_error = left(error_message, 2000),
      send_after = case when outcome in ('sent', 'mocked') then send_after else now() + interval '5 minutes' end
  where id = target_email and status = 'sending';
$$;

revoke all on function public.complete_email_outbox(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.complete_email_outbox(uuid, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Forms
-- questions: [{ id, type, label, help?, required?, options?: [{ id, label }],
--               maps_to?: { target: "title"|"notes"|"due_on"|"section"|"field", field_id? },
--               show_if?: { question_id, option_ids: [...] } }]
-- show_if may only reference an earlier select/checkbox question (checkbox uses option id "true").
-- ---------------------------------------------------------------------------

create table public.forms (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  title text not null check (length(trim(title)) > 0 and length(title) <= 200),
  description text check (length(description) <= 5000),
  questions jsonb not null default '[]'::jsonb check (jsonb_typeof(questions) = 'array'),
  destination_section_id uuid,
  accepting_responses boolean not null default false,
  send_confirmation boolean not null default true,
  confirmation_message text check (length(confirmation_message) <= 2000),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (destination_section_id, project_id) references public.sections (id, project_id)
);

create index forms_project_idx on public.forms (project_id, created_at) where deleted_at is null;
create index forms_created_by_idx on public.forms (created_by);
create index forms_destination_section_idx on public.forms (destination_section_id);

create trigger forms_set_updated_at
  before update on public.forms
  for each row execute function public.set_updated_at();

create or replace function public.validate_form()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  q jsonb;
  seen jsonb := '{}'::jsonb;
  qtype text;
  target text;
  dep text;
  option_ids jsonb;
begin
  if jsonb_array_length(new.questions) > 100 then
    raise exception 'Forms are limited to 100 questions' using errcode = 'check_violation';
  end if;
  for q in select value from jsonb_array_elements(new.questions) loop
    if coalesce(jsonb_typeof(q), 'missing') <> 'object'
       or coalesce(jsonb_typeof(q -> 'id'), 'missing') <> 'string' or length(q ->> 'id') not between 1 and 64
       or coalesce(jsonb_typeof(q -> 'label'), 'missing') <> 'string' or length(trim(q ->> 'label')) not between 1 and 500 then
      raise exception 'Every question needs an id and a label' using errcode = 'check_violation';
    end if;
    if seen ? (q ->> 'id') then
      raise exception 'Question ids must be unique' using errcode = 'check_violation';
    end if;
    qtype := q ->> 'type';
    if qtype is null or qtype not in (
      'short_text', 'long_text', 'number', 'date', 'single_select', 'multi_select', 'checkbox'
    ) then
      raise exception 'Unknown question type %', coalesce(qtype, '(none)') using errcode = 'check_violation';
    end if;
    if q ? 'required' and coalesce(jsonb_typeof(q -> 'required'), 'missing') <> 'boolean' then
      raise exception 'required must be true or false' using errcode = 'check_violation';
    end if;
    option_ids := '[]'::jsonb;
    if qtype in ('single_select', 'multi_select') then
      if coalesce(jsonb_typeof(q -> 'options'), 'missing') <> 'array' or jsonb_array_length(q -> 'options') not between 1 and 200
         or exists (
           select 1 from jsonb_array_elements(q -> 'options') o
           where coalesce(jsonb_typeof(o -> 'id'), 'missing') <> 'string' or coalesce(jsonb_typeof(o -> 'label'), 'missing') <> 'string'
             or length(trim(o ->> 'label')) = 0
         )
         or (select count(distinct o ->> 'id') from jsonb_array_elements(q -> 'options') o)
            <> jsonb_array_length(q -> 'options') then
        raise exception 'Question “%” needs options with unique ids and labels', q ->> 'label'
          using errcode = 'check_violation';
      end if;
      select jsonb_agg(o -> 'id') into option_ids from jsonb_array_elements(q -> 'options') o;
    elsif qtype = 'checkbox' then
      option_ids := '["true"]'::jsonb;
    end if;
    if jsonb_typeof(q -> 'maps_to') = 'object' then
      target := q -> 'maps_to' ->> 'target';
      if target is null or target not in ('title', 'notes', 'due_on', 'section', 'field') then
        raise exception 'Unknown mapping for “%”', q ->> 'label' using errcode = 'check_violation';
      end if;
      if target = 'due_on' and qtype <> 'date' then
        raise exception 'Only date questions can set the due date' using errcode = 'check_violation';
      end if;
      if target = 'section' and qtype <> 'single_select' then
        raise exception 'Only single-select questions can choose the section' using errcode = 'check_violation';
      end if;
      if target = 'field' and not exists (
        select 1 from public.custom_fields f
        where f.id::text = q -> 'maps_to' ->> 'field_id' and f.project_id = new.project_id and f.deleted_at is null
      ) then
        raise exception 'Question “%” maps to a field that is not in this project', q ->> 'label'
          using errcode = 'check_violation';
      end if;
    end if;
    if jsonb_typeof(q -> 'show_if') = 'object' then
      dep := q -> 'show_if' ->> 'question_id';
      if dep is null or not seen ? dep or coalesce(jsonb_typeof(q -> 'show_if' -> 'option_ids'), 'missing') <> 'array'
         or jsonb_array_length(q -> 'show_if' -> 'option_ids') = 0
         or not (seen -> dep) @> (q -> 'show_if' -> 'option_ids') then
        raise exception 'Question “%” can only depend on options of an earlier choice question', q ->> 'label'
          using errcode = 'check_violation';
      end if;
    end if;
    seen := seen || jsonb_build_object(q ->> 'id', option_ids);
  end loop;
  return new;
end;
$$;

create trigger forms_validate
  before insert or update of questions, project_id on public.forms
  for each row execute function public.validate_form();

create table public.form_submissions (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.forms (id),
  task_id uuid not null references public.tasks (id),
  submitter_email text not null check (public.is_email(submitter_email)),
  submitter_id uuid references public.profiles (id) on delete set null,
  answers jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index form_submissions_form_idx on public.form_submissions (form_id, created_at);
create index form_submissions_task_idx on public.form_submissions (task_id);
create index form_submissions_submitter_idx on public.form_submissions (submitter_id);
create index form_submissions_email_idx on public.form_submissions (form_id, submitter_email, created_at);

-- Public, pre-submit view of a form. Mapping details are omitted for anonymous visitors.
create or replace function public.get_public_form(target_form uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  f public.forms;
  member boolean := public.is_allowlisted();
begin
  select fo.* into f from public.forms fo
  join public.projects p on p.id = fo.project_id and p.deleted_at is null
  where fo.id = target_form and fo.deleted_at is null;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'id', f.id,
    'title', f.title,
    'description', f.description,
    'accepting_responses', f.accepting_responses,
    'questions', case when f.accepting_responses or member then (
      select coalesce(jsonb_agg(q - 'maps_to' order by i), '[]'::jsonb)
      from jsonb_array_elements(f.questions) with ordinality as x(q, i)
    ) else '[]'::jsonb end,
    'viewer_email', (select p.email from public.profiles p where p.id = public.current_profile_id())
  );
end;
$$;

revoke all on function public.get_public_form(uuid) from public;
grant execute on function public.get_public_form(uuid) to anon, authenticated;

-- Normalises one answer for its question; null means "not answered". Raises on malformed input.
create or replace function public.normalize_form_answer(q jsonb, raw jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  qtype text := q ->> 'type';
  label text := q ->> 'label';
  value text;
  option_ids jsonb;
begin
  if raw is null or raw = 'null'::jsonb then
    return null;
  end if;
  select coalesce(jsonb_agg(o -> 'id'), '[]'::jsonb) into option_ids from jsonb_array_elements(
    case when jsonb_typeof(q -> 'options') = 'array' then q -> 'options' else '[]'::jsonb end
  ) o;
  case qtype
    when 'short_text', 'long_text' then
      if coalesce(jsonb_typeof(raw), 'missing') <> 'string' then
        raise exception 'Invalid answer for “%”', label using errcode = 'check_violation';
      end if;
      value := trim(raw #>> '{}');
      if value = '' then return null; end if;
      if length(value) > (case when qtype = 'short_text' then 500 else 10000 end) then
        raise exception 'The answer for “%” is too long', label using errcode = 'check_violation';
      end if;
      return to_jsonb(value);
    when 'number' then
      if jsonb_typeof(raw) = 'number' then return raw; end if;
      value := trim(coalesce(raw #>> '{}', ''));
      if value = '' then return null; end if;
      if value !~ '^-?\d+(\.\d+)?$' then
        raise exception 'Enter a number for “%”', label using errcode = 'check_violation';
      end if;
      return to_jsonb(value::numeric);
    when 'date' then
      value := trim(coalesce(raw #>> '{}', ''));
      if value = '' then return null; end if;
      if value !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'Enter a date for “%”', label using errcode = 'check_violation';
      end if;
      perform value::date;
      return to_jsonb(value);
    when 'single_select' then
      if coalesce(jsonb_typeof(raw), 'missing') <> 'string' or (raw #>> '{}') = '' then return null; end if;
      if not option_ids @> jsonb_build_array(raw) then
        raise exception 'Choose one of the options for “%”', label using errcode = 'check_violation';
      end if;
      return raw;
    when 'multi_select' then
      if coalesce(jsonb_typeof(raw), 'missing') <> 'array' then
        raise exception 'Invalid answer for “%”', label using errcode = 'check_violation';
      end if;
      if jsonb_array_length(raw) = 0 then return null; end if;
      if not option_ids @> raw then
        raise exception 'Choose from the options for “%”', label using errcode = 'check_violation';
      end if;
      return raw;
    when 'checkbox' then
      return case when raw = 'true'::jsonb then 'true'::jsonb end;
    else
      return null;
  end case;
end;
$$;

revoke all on function public.normalize_form_answer(jsonb, jsonb) from public, anon, authenticated;

create or replace function public.form_option_label(q jsonb, option_id text)
returns text
language sql
immutable
set search_path = ''
as $$
  select o ->> 'label' from jsonb_array_elements(
    case when jsonb_typeof(q -> 'options') = 'array' then q -> 'options' else '[]'::jsonb end
  ) o where o ->> 'id' = option_id limit 1;
$$;

revoke all on function public.form_option_label(jsonb, text) from public, anon, authenticated;

create or replace function public.form_answer_text(q jsonb, answer jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case q ->> 'type'
    when 'single_select' then public.form_option_label(q, answer #>> '{}')
    when 'multi_select' then (
      select string_agg(public.form_option_label(q, a), ', ' order by i)
      from jsonb_array_elements_text(answer) with ordinality x(a, i)
    )
    when 'checkbox' then 'Yes'
    else answer #>> '{}'
  end;
$$;

revoke all on function public.form_answer_text(jsonb, jsonb) from public, anon, authenticated;

-- Field options match by id first, then by (case-insensitive) name, so a form question can either
-- copy a field's options or simply use the same labels.
create or replace function public.match_field_option(field_options jsonb, option_id text, option_label text)
returns text
language sql
immutable
set search_path = ''
as $$
  select o ->> 'id' from jsonb_array_elements(field_options) o
  where o ->> 'id' = option_id or lower(trim(o ->> 'name')) = lower(trim(option_label))
  order by (o ->> 'id' = option_id) desc
  limit 1;
$$;

revoke all on function public.match_field_option(jsonb, text, text) from public, anon, authenticated;

create or replace function public.match_section(target_project uuid, option_id text, option_label text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id from public.sections s
  where s.project_id = target_project and s.deleted_at is null
    and (s.id::text = option_id or lower(trim(s.name)) = lower(trim(option_label)))
  order by (s.id::text = option_id) desc
  limit 1;
$$;

revoke all on function public.match_section(uuid, text, text) from public, anon, authenticated;

create or replace function public.submit_form(target_form uuid, submitter_email text, answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.forms;
  q jsonb;
  qid text;
  raw jsonb;
  dep text;
  dep_answer jsonb;
  shown boolean;
  visible jsonb := '{}'::jsonb;
  clean jsonb := '{}'::jsonb;
  summary jsonb := '[]'::jsonb;
  field_answers jsonb := '[]'::jsonb;
  display text;
  email text := lower(trim(coalesce(submitter_email, '')));
  viewer uuid := public.current_profile_id();
  task_title text;
  notes_parts text[] := '{}';
  task_due date;
  target_section uuid;
  new_task uuid;
  submission uuid;
  label text;
  email_id uuid;
  fa jsonb;
  field public.custom_fields;
  field_value jsonb;
  first_option text;
begin
  if answers is null or coalesce(jsonb_typeof(answers), 'missing') <> 'object' then
    answers := '{}'::jsonb;
  end if;

  select fo.* into f from public.forms fo
  join public.projects p on p.id = fo.project_id and p.deleted_at is null
  where fo.id = target_form and fo.deleted_at is null;
  if not found then
    raise exception 'This form does not exist' using errcode = 'no_data_found';
  end if;
  if not f.accepting_responses then
    raise exception 'This form is not accepting responses right now' using errcode = 'check_violation';
  end if;

  if email = '' and viewer is not null then
    select p.email into email from public.profiles p where p.id = viewer;
  end if;
  if not public.is_email(email) then
    raise exception 'Enter a valid email address' using errcode = 'check_violation';
  end if;
  if (
    select count(*) from public.form_submissions s
    where s.form_id = f.id and s.submitter_email = email and s.created_at > now() - interval '1 minute'
  ) >= 5 then
    raise exception 'Too many submissions. Try again in a minute.' using errcode = 'check_violation';
  end if;

  -- Walk questions in order; a question is visible when its show_if parent is visible and answered
  -- with one of the listed options. Answers to hidden questions are discarded.
  for q in select value from jsonb_array_elements(f.questions) loop
    qid := q ->> 'id';
    shown := true;
    if jsonb_typeof(q -> 'show_if') = 'object' then
      dep := q -> 'show_if' ->> 'question_id';
      dep_answer := clean -> dep;
      shown := visible ? dep and dep_answer is not null and case jsonb_typeof(dep_answer)
        when 'array' then exists (
          select 1 from jsonb_array_elements_text(dep_answer) a where (q -> 'show_if' -> 'option_ids') ? a
        )
        else (q -> 'show_if' -> 'option_ids') ? (dep_answer #>> '{}')
      end;
    end if;
    continue when not shown;
    visible := visible || jsonb_build_object(qid, true);

    raw := public.normalize_form_answer(q, answers -> qid);
    if raw is null then
      if coalesce(q -> 'required' = 'true'::jsonb, false) then
        raise exception 'Please answer “%”', q ->> 'label' using errcode = 'check_violation';
      end if;
      continue;
    end if;

    clean := clean || jsonb_build_object(qid, raw);
    display := public.form_answer_text(q, raw);
    summary := summary || jsonb_build_array(jsonb_build_object('label', q ->> 'label', 'value', display));

    case q -> 'maps_to' ->> 'target'
      when 'title' then
        task_title := coalesce(task_title || ' ', '') || display;
      when 'notes' then
        notes_parts := notes_parts || display;
      when 'due_on' then
        task_due := (raw #>> '{}')::date;
      when 'section' then
        target_section := public.match_section(f.project_id, raw #>> '{}', display);
      when 'field' then
        field_answers := field_answers || jsonb_build_array(jsonb_build_object(
          'field_id', q -> 'maps_to' ->> 'field_id', 'q', q, 'raw', raw, 'display', display
        ));
      else
        null;
    end case;
  end loop;

  task_title := left(coalesce(nullif(trim(task_title), ''), f.title || ' — ' || email), 450);

  insert into public.tasks (home_project_id, title, notes, due_on, source, created_by)
  values (
    f.project_id,
    task_title,
    left(
      array_to_string(notes_parts, E'\n\n')
      || case when cardinality(notes_parts) > 0 then E'\n\n' else '' end
      || '— Submitted via “' || f.title || '” by ' || email || ' —'
      || coalesce((
        select string_agg(E'\n' || (s ->> 'label') || ': ' || (s ->> 'value'), '' order by i)
        from jsonb_array_elements(summary) with ordinality x(s, i)
      ), ''),
      20000
    ),
    task_due,
    'form',
    viewer
  )
  returning id into new_task;

  for fa in select value from jsonb_array_elements(field_answers) loop
    select * into field from public.custom_fields cf
    where cf.id::text = fa ->> 'field_id' and cf.project_id = f.project_id and cf.deleted_at is null;
    continue when not found;
    first_option := case jsonb_typeof(fa -> 'raw')
      when 'array' then fa -> 'raw' ->> 0
      else fa -> 'raw' #>> '{}'
    end;
    if field.bound_to_sections then
      target_section := coalesce(public.match_section(
        f.project_id, first_option, public.form_option_label(fa -> 'q', first_option)
      ), target_section);
      continue;
    end if;
    field_value := case field.field_type
      when 'text' then to_jsonb(fa ->> 'display')
      when 'number' then case when jsonb_typeof(fa -> 'raw') = 'number' then fa -> 'raw' end
      when 'date' then case when fa -> 'q' ->> 'type' = 'date' then fa -> 'raw' end
      when 'boolean' then case when fa -> 'raw' = 'true'::jsonb then 'true'::jsonb end
      when 'single_select' then to_jsonb(public.match_field_option(
        field.options, first_option, public.form_option_label(fa -> 'q', first_option)
      ))
      when 'multi_select' then (
        select jsonb_agg(distinct m) from (
          select public.match_field_option(field.options, a, public.form_option_label(fa -> 'q', a)) as m
          from jsonb_array_elements_text(
            case when jsonb_typeof(fa -> 'raw') = 'array' then fa -> 'raw' else jsonb_build_array(fa -> 'raw') end
          ) a
        ) matched where m is not null
      )
    end;
    continue when field_value is null or field_value = 'null'::jsonb;
    insert into public.task_field_values (task_id, field_id, value)
    values (new_task, field.id, field_value)
    on conflict (task_id, field_id) do update set value = excluded.value;
  end loop;

  target_section := coalesce(target_section, (
    select s.id from public.sections s
    where s.id = f.destination_section_id and s.deleted_at is null
  ));
  if target_section is not null then
    update public.task_projects set section_id = target_section
    where task_id = new_task and project_id = f.project_id;
  end if;

  insert into public.form_submissions (form_id, task_id, submitter_email, submitter_id, answers)
  values (f.id, new_task, email, viewer, clean)
  returning id into submission;

  perform public.add_story(new_task, 'form_submitted', jsonb_build_object(
    'form_id', f.id, 'form_title', f.title, 'submitter_email', email, 'submission_id', submission
  ));

  label := public.task_request_label(new_task);
  if f.send_confirmation then
    email_id := public.enqueue_email(
      email,
      'form_confirmation',
      coalesce(label || ' · ', '') || 'We received your ' || f.title,
      jsonb_build_object(
        'form_title', f.title,
        'request_label', label,
        'task_title', (select t.title from public.tasks t where t.id = new_task),
        'message', f.confirmation_message,
        'answers', summary
      ),
      new_task
    );
  end if;

  perform public.fire_rules('form_submitted', new_task, f.project_id, jsonb_build_object(
    'form_id', f.id, 'submission_id', submission
  ));

  return jsonb_build_object(
    'task_id', new_task,
    'submission_id', submission,
    'request_label', label,
    'email_id', email_id,
    'message', f.confirmation_message
  );
end;
$$;

revoke all on function public.submit_form(uuid, text, jsonb) from public;
grant execute on function public.submit_form(uuid, text, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Rules engine
--
-- trigger_type + trigger_config:
--   task_created      {}
--   section_changed   { section_id }                 task enters that section (in the rule's project)
--   field_changed     { field_id, option_id? }       value changes (optionally: to/including that option)
--   assignee_changed  {}
--   due_approaching   { days (0-30, default 1), timezone? }   evaluated by workflow_tick()
--   approval_decided  { statuses?: [approved|changes_requested|rejected] }
--   form_submitted    { form_id? }
-- conditions (all must hold): section_is / section_is_not { section_id }, field_equals { field_id, value },
--   field_is_set / field_is_empty { field_id }, assignee_is_set, assignee_is_empty, is_complete,
--   is_incomplete, source_is { source }
-- actions (in order): move_section { section_id }, set_field { field_id, value }, set_assignee
--   { assignee }, add_comment { body }, add_followers { people }, notify { people, message },
--   request_approval { approver, title?, note? }, send_email { to, template, subject?, message?,
--   field_id?, address? }, delay { hours } (remaining actions run later via workflow_tick()).
-- People may be profile ids or the roles "assignee" / "creator". Text supports {assignee}, {creator},
-- {task}, {section}, {req}, {due}, {approval_note}.
--
-- Loop safety: a rule never re-enters itself within one chain of rule-caused changes, chains stop at
-- depth 5, and one rule runs at most 20 times per task per hour. A section-bound Status field has no
-- stored values, so set_field on it is a section move and field_changed cannot target it.
-- ---------------------------------------------------------------------------

create table public.rule_runs (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references public.rules (id),
  task_id uuid references public.tasks (id),
  trigger_type text not null,
  status text not null check (status in ('succeeded', 'failed', 'skipped', 'scheduled')),
  detail jsonb not null default '{}'::jsonb,
  dedupe_key text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index rule_runs_rule_idx on public.rule_runs (rule_id, created_at desc);
create index rule_runs_task_idx on public.rule_runs (task_id, created_at desc);
create unique index rule_runs_dedupe_idx on public.rule_runs (rule_id, task_id, dedupe_key)
  where dedupe_key is not null;

create table public.scheduled_rule_actions (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references public.rules (id),
  task_id uuid not null references public.tasks (id),
  actions jsonb not null check (jsonb_typeof(actions) = 'array'),
  event jsonb not null default '{}'::jsonb,
  run_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'done', 'cancelled', 'failed')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index scheduled_rule_actions_due_idx on public.scheduled_rule_actions (run_at) where status = 'pending';
create index scheduled_rule_actions_rule_idx on public.scheduled_rule_actions (rule_id);
create index scheduled_rule_actions_task_idx on public.scheduled_rule_actions (task_id);

create or replace function public.rule_section_ok(target_project uuid, section_id text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.sections s
    where s.id::text = section_id and s.project_id = target_project and s.deleted_at is null
  );
$$;

revoke all on function public.rule_section_ok(uuid, text) from public, anon;
grant execute on function public.rule_section_ok(uuid, text) to authenticated;

create or replace function public.rule_field(target_project uuid, field_id text)
returns public.custom_fields
language sql
stable
set search_path = ''
as $$
  select f.* from public.custom_fields f
  where f.id::text = field_id and f.project_id = target_project and f.deleted_at is null;
$$;

revoke all on function public.rule_field(uuid, text) from public, anon;
grant execute on function public.rule_field(uuid, text) to authenticated;

create or replace function public.rule_person_ok(person jsonb)
returns boolean
language sql
stable
set search_path = ''
as $$
  select person is not null and jsonb_typeof(person) = 'string' and (
    person #>> '{}' in ('assignee', 'creator')
    or exists (select 1 from public.profiles p where p.id::text = person #>> '{}')
  );
$$;

revoke all on function public.rule_person_ok(jsonb) from public, anon;
grant execute on function public.rule_person_ok(jsonb) to authenticated;

create or replace function public.validate_rule()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  cfg jsonb := new.trigger_config;
  item jsonb;
  kind text;
  field public.custom_fields;
begin
  case new.trigger_type
    when 'section_changed' then
      if not public.rule_section_ok(new.project_id, cfg ->> 'section_id') then
        raise exception 'Choose a section in this project for the trigger' using errcode = 'check_violation';
      end if;
    when 'field_changed' then
      field := public.rule_field(new.project_id, cfg ->> 'field_id');
      if field.id is null then
        raise exception 'Choose a field in this project for the trigger' using errcode = 'check_violation';
      end if;
      if field.bound_to_sections then
        raise exception 'The section-bound Status field changes with sections: use the “Section changed” trigger'
          using errcode = 'check_violation';
      end if;
    when 'due_approaching' then
      if cfg ? 'days' and (coalesce(jsonb_typeof(cfg -> 'days'), 'missing') <> 'number' or (cfg ->> 'days')::numeric not between 0 and 30) then
        raise exception 'Days before due must be between 0 and 30' using errcode = 'check_violation';
      end if;
    when 'approval_decided' then
      if cfg ? 'statuses' and (
        coalesce(jsonb_typeof(cfg -> 'statuses'), 'missing') <> 'array'
        or not '["approved", "changes_requested", "rejected"]'::jsonb @> (cfg -> 'statuses')
      ) then
        raise exception 'Unknown approval status in trigger' using errcode = 'check_violation';
      end if;
    when 'form_submitted' then
      if cfg ? 'form_id' and not exists (
        select 1 from public.forms fo where fo.id::text = cfg ->> 'form_id' and fo.project_id = new.project_id
      ) then
        raise exception 'Choose a form in this project for the trigger' using errcode = 'check_violation';
      end if;
    else
      null;
  end case;

  if jsonb_array_length(new.conditions) > 20 then
    raise exception 'Rules are limited to 20 conditions' using errcode = 'check_violation';
  end if;
  for item in select value from jsonb_array_elements(new.conditions) loop
    kind := item ->> 'type';
    if kind in ('section_is', 'section_is_not') then
      if not public.rule_section_ok(new.project_id, item ->> 'section_id') then
        raise exception 'A condition refers to a section outside this project' using errcode = 'check_violation';
      end if;
    elsif kind in ('field_equals', 'field_is_set', 'field_is_empty') then
      if public.rule_field(new.project_id, item ->> 'field_id') is null then
        raise exception 'A condition refers to a field outside this project' using errcode = 'check_violation';
      end if;
    elsif kind = 'source_is' then
      if item ->> 'source' not in ('manual', 'form', 'import') then
        raise exception 'Unknown task source in condition' using errcode = 'check_violation';
      end if;
    elsif kind is null or kind not in ('assignee_is_set', 'assignee_is_empty', 'is_complete', 'is_incomplete') then
      raise exception 'Unknown condition %', coalesce(kind, '(none)') using errcode = 'check_violation';
    end if;
  end loop;

  if jsonb_array_length(new.actions) not between 1 and 10 then
    raise exception 'Rules need between 1 and 10 actions' using errcode = 'check_violation';
  end if;
  for item in select value from jsonb_array_elements(new.actions) loop
    kind := item ->> 'type';
    case kind
      when 'move_section' then
        if not public.rule_section_ok(new.project_id, item ->> 'section_id') then
          raise exception 'Move to section: choose a section in this project' using errcode = 'check_violation';
        end if;
      when 'set_field' then
        field := public.rule_field(new.project_id, item ->> 'field_id');
        if field.id is null then
          raise exception 'Set field: choose a field in this project' using errcode = 'check_violation';
        end if;
        if field.bound_to_sections and not public.rule_section_ok(new.project_id, item -> 'value' #>> '{}') then
          raise exception 'Set Status: choose one of this project''s sections' using errcode = 'check_violation';
        end if;
      when 'set_assignee' then
        if item -> 'assignee' <> 'null'::jsonb and not public.rule_person_ok(item -> 'assignee') then
          raise exception 'Set assignee: choose a person' using errcode = 'check_violation';
        end if;
      when 'add_comment' then
        if length(trim(coalesce(item ->> 'body', ''))) not between 1 and 5000 then
          raise exception 'Add comment: write the comment text' using errcode = 'check_violation';
        end if;
      when 'add_followers', 'notify' then
        if coalesce(jsonb_typeof(item -> 'people'), 'missing') <> 'array' or jsonb_array_length(item -> 'people') = 0
           or exists (select 1 from jsonb_array_elements(item -> 'people') p where not public.rule_person_ok(p)) then
          raise exception 'Choose at least one person for %', replace(kind, '_', ' ') using errcode = 'check_violation';
        end if;
        if kind = 'notify' and length(trim(coalesce(item ->> 'message', ''))) not between 1 and 1000 then
          raise exception 'Notify: write a message' using errcode = 'check_violation';
        end if;
      when 'request_approval' then
        if not public.rule_person_ok(item -> 'approver') then
          raise exception 'Request approval: choose an approver' using errcode = 'check_violation';
        end if;
      when 'send_email' then
        if item ->> 'to' is null or item ->> 'to' not in ('submitter', 'assignee', 'field', 'address') then
          raise exception 'Send email: choose a recipient' using errcode = 'check_violation';
        end if;
        if item ->> 'to' = 'field' and public.rule_field(new.project_id, item ->> 'field_id') is null then
          raise exception 'Send email: choose the field that holds the email address' using errcode = 'check_violation';
        end if;
        if item ->> 'to' = 'address' and not public.is_email(lower(trim(item ->> 'address'))) then
          raise exception 'Send email: enter a valid address' using errcode = 'check_violation';
        end if;
        if coalesce(item ->> 'template', 'requester_update') not in ('requester_update', 'due_tomorrow', 'custom') then
          raise exception 'Send email: unknown template' using errcode = 'check_violation';
        end if;
        if item ? 'include_field_id' and public.rule_field(new.project_id, item ->> 'include_field_id') is null then
          raise exception 'Send email: the included field is not in this project' using errcode = 'check_violation';
        end if;
      when 'delay' then
        if coalesce(jsonb_typeof(item -> 'hours'), 'missing') <> 'number' or (item ->> 'hours')::numeric not between 0.1 and 720 then
          raise exception 'Delay must be between 0.1 and 720 hours' using errcode = 'check_violation';
        end if;
      else
        raise exception 'Unknown action %', coalesce(kind, '(none)') using errcode = 'check_violation';
    end case;
  end loop;
  return new;
end;
$$;

create trigger rules_validate
  before insert or update of trigger_type, trigger_config, conditions, actions, project_id on public.rules
  for each row execute function public.validate_rule();

create or replace function public.resolve_rule_person(person jsonb, target_task uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case person #>> '{}'
    when 'assignee' then (select t.assignee_id from public.tasks t where t.id = target_task)
    when 'creator' then (select t.created_by from public.tasks t where t.id = target_task)
    else (select p.id from public.profiles p where p.id::text = person #>> '{}')
  end;
$$;

revoke all on function public.resolve_rule_person(jsonb, uuid) from public, anon, authenticated;

create or replace function public.task_field_text(target_task uuid, target_field uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case f.field_type
    when 'single_select' then (select o ->> 'name' from jsonb_array_elements(f.options) o where o -> 'id' = v.value)
    when 'multi_select' then (
      select string_agg(o ->> 'name', ', ') from jsonb_array_elements(f.options) o
      where v.value @> jsonb_build_array(o -> 'id')
    )
    when 'boolean' then case when v.value = 'true'::jsonb then 'Yes' end
    when 'people' then (
      select string_agg(coalesce(p.full_name, p.email), ', ') from public.profiles p
      where v.value @> jsonb_build_array(p.id::text)
    )
    else v.value #>> '{}'
  end
  from public.custom_fields f
  join public.task_field_values v on v.field_id = f.id and v.task_id = target_task
  where f.id = target_field;
$$;

revoke all on function public.task_field_text(uuid, uuid) from public, anon, authenticated;

create or replace function public.render_rule_text(
  template text,
  target_task uuid,
  target_project uuid,
  event jsonb
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t public.tasks;
  result text := coalesce(template, '');
begin
  select * into t from public.tasks where id = target_task;
  result := replace(result, '{assignee}', coalesce(public.profile_handle(t.assignee_id), ''));
  result := replace(result, '{creator}', coalesce(public.profile_handle(t.created_by), ''));
  result := replace(result, '{task}', coalesce(t.title, ''));
  result := replace(result, '{req}', coalesce(public.task_request_label(target_task), ''));
  result := replace(result, '{due}', coalesce(to_char(t.due_on, 'Mon FMDD'), 'no due date'));
  result := replace(result, '{approval_note}', coalesce(event ->> 'note', ''));
  result := replace(result, '{section}', coalesce((
    select s.name from public.task_projects tp join public.sections s on s.id = tp.section_id
    where tp.task_id = target_task and tp.project_id = target_project
  ), 'No section'));
  return trim(result);
end;
$$;

revoke all on function public.render_rule_text(text, uuid, uuid, jsonb) from public, anon, authenticated;

create or replace function public.rule_conditions_pass(r public.rules, target_task uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c jsonb;
  t public.tasks;
  section uuid;
  field public.custom_fields;
  current_value jsonb;
  ok boolean;
begin
  select * into t from public.tasks where id = target_task and deleted_at is null;
  if not found then
    return false;
  end if;
  select tp.section_id into section from public.task_projects tp
  where tp.task_id = target_task and tp.project_id = r.project_id and tp.deleted_at is null;
  if not found then
    return false;
  end if;

  for c in select value from jsonb_array_elements(r.conditions) loop
    ok := case c ->> 'type'
      when 'section_is' then section::text is not distinct from c ->> 'section_id'
      when 'section_is_not' then section::text is distinct from c ->> 'section_id'
      when 'assignee_is_set' then t.assignee_id is not null
      when 'assignee_is_empty' then t.assignee_id is null
      when 'is_complete' then t.completed_at is not null
      when 'is_incomplete' then t.completed_at is null
      when 'source_is' then t.source = c ->> 'source'
      else null
    end;
    if ok is null then
      field := public.rule_field(r.project_id, c ->> 'field_id');
      if field.bound_to_sections then
        current_value := to_jsonb(section::text);
      else
        select v.value into current_value from public.task_field_values v
        where v.task_id = target_task and v.field_id = field.id;
      end if;
      if current_value = 'null'::jsonb then
        current_value := null;
      end if;
      ok := case c ->> 'type'
        when 'field_is_set' then current_value is not null and current_value not in ('""'::jsonb, '[]'::jsonb)
        when 'field_is_empty' then current_value is null or current_value in ('""'::jsonb, '[]'::jsonb)
        when 'field_equals' then case
          when jsonb_typeof(current_value) = 'array' and coalesce(jsonb_typeof(c -> 'value'), 'missing') <> 'array'
            then current_value @> jsonb_build_array(c -> 'value')
          else current_value = c -> 'value'
        end
        else false
      end;
    end if;
    if not coalesce(ok, false) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

revoke all on function public.rule_conditions_pass(public.rules, uuid) from public, anon, authenticated;

create or replace function public.move_task_to_section(target_task uuid, target_project uuid, target_section uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.task_projects
  set section_id = target_section,
      sort_order = coalesce((
        select max(tp.sort_order) + 1024 from public.task_projects tp
        where tp.project_id = target_project and tp.section_id = target_section and tp.deleted_at is null
      ), 1024)
  where task_id = target_task and project_id = target_project and deleted_at is null
    and section_id is distinct from target_section;
  return found;
end;
$$;

revoke all on function public.move_task_to_section(uuid, uuid, uuid) from public, anon, authenticated;

-- Runs actions in order for one task. Returns a per-action log. A delay schedules the rest and stops.
create or replace function public.execute_rule_actions(
  r public.rules,
  target_task uuid,
  rule_actions jsonb,
  event jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a jsonb;
  idx bigint;
  log jsonb := '[]'::jsonb;
  outcome text;
  t public.tasks;
  field public.custom_fields;
  person uuid;
  body text;
  recipient text;
  p jsonb;
  submission public.form_submissions;
begin
  for a, idx in select value, ordinality from jsonb_array_elements(rule_actions) with ordinality loop
    select * into t from public.tasks where id = target_task;
    outcome := 'done';
    case a ->> 'type'
      when 'delay' then
        insert into public.scheduled_rule_actions (rule_id, task_id, actions, event, run_at)
        values (
          r.id, target_task,
          coalesce((select jsonb_agg(x.value order by x.ordinality) from jsonb_array_elements(rule_actions)
            with ordinality x where x.ordinality > idx), '[]'::jsonb),
          coalesce(event, '{}'::jsonb),
          now() + make_interval(secs => ((a ->> 'hours')::numeric * 3600)::double precision)
        );
        log := log || jsonb_build_array(jsonb_build_object('type', 'delay', 'outcome', 'scheduled', 'hours', a -> 'hours'));
        return log;

      when 'move_section' then
        if not public.move_task_to_section(target_task, r.project_id, (a ->> 'section_id')::uuid) then
          outcome := 'unchanged';
        end if;

      when 'set_field' then
        field := public.rule_field(r.project_id, a ->> 'field_id');
        if field.id is null then
          outcome := 'missing_field';
        elsif field.bound_to_sections then
          -- The section-bound Status field IS the section: setting it moves the task, nothing is stored.
          if not public.move_task_to_section(target_task, r.project_id, (a -> 'value' #>> '{}')::uuid) then
            outcome := 'unchanged';
          end if;
        else
          insert into public.task_field_values (task_id, field_id, value)
          values (target_task, field.id, a -> 'value')
          on conflict (task_id, field_id) do update set value = excluded.value
          where public.task_field_values.value is distinct from excluded.value;
          if not found then outcome := 'unchanged'; end if;
        end if;

      when 'set_assignee' then
        person := case when a -> 'assignee' = 'null'::jsonb or a -> 'assignee' is null then null
          else public.resolve_rule_person(a -> 'assignee', target_task) end;
        update public.tasks set assignee_id = person
        where id = target_task and assignee_id is distinct from person;
        if not found then outcome := 'unchanged'; end if;

      when 'add_comment' then
        body := left(public.render_rule_text(a ->> 'body', target_task, r.project_id, event), 10000);
        if body = '' then
          outcome := 'empty';
        else
          insert into public.comments (task_id, author_id, rule_id, body) values (target_task, null, r.id, body);
        end if;

      when 'add_followers' then
        for p in select value from jsonb_array_elements(a -> 'people') loop
          perform public.follow_task(target_task, public.resolve_rule_person(p, target_task));
        end loop;

      when 'notify' then
        body := left(public.render_rule_text(a ->> 'message', target_task, r.project_id, event), 1000);
        for person in
          select distinct public.resolve_rule_person(x.value, target_task)
          from jsonb_array_elements(a -> 'people') x
        loop
          perform public.notify_with(person, target_task, 'rule', null, jsonb_build_object('message', body));
        end loop;

      when 'request_approval' then
        person := public.resolve_rule_person(a -> 'approver', target_task);
        if person is null then
          outcome := 'no_approver';
        elsif exists (
          select 1 from public.approval_requests ar
          where ar.task_id = target_task and ar.approver_id = person and ar.deleted_at is null
            and ar.status in ('pending', 'changes_requested')
        ) then
          outcome := 'already_open';
        else
          perform public.create_approval(
            target_task, person,
            public.render_rule_text(a ->> 'note', target_task, r.project_id, event),
            true,
            coalesce(nullif(public.render_rule_text(a ->> 'title', target_task, r.project_id, event), ''), 'Approve this work')
          );
        end if;

      when 'send_email' then
        recipient := case a ->> 'to'
          when 'submitter' then (
            select s.submitter_email from public.form_submissions s
            where s.task_id = target_task and s.deleted_at is null order by s.created_at desc limit 1
          )
          when 'assignee' then (select pr.email from public.profiles pr where pr.id = t.assignee_id)
          when 'field' then public.task_field_text(target_task, (a ->> 'field_id')::uuid)
          when 'address' then a ->> 'address'
        end;
        if not public.is_email(lower(trim(coalesce(recipient, '')))) then
          outcome := 'no_recipient';
        else
          perform public.enqueue_email(
            recipient,
            coalesce(a ->> 'template', 'requester_update'),
            nullif(public.render_rule_text(a ->> 'subject', target_task, r.project_id, event), ''),
            jsonb_build_object(
              'task_title', t.title,
              'request_label', public.task_request_label(target_task),
              'project_name', (select pj.name from public.projects pj where pj.id = r.project_id),
              'section_name', public.render_rule_text('{section}', target_task, r.project_id, event),
              'due_on', t.due_on,
              'message', nullif(public.render_rule_text(a ->> 'message', target_task, r.project_id, event), ''),
              'field', case when a ? 'include_field_id' then jsonb_build_object(
                'name', (select f.name from public.custom_fields f where f.id::text = a ->> 'include_field_id'),
                'value', public.task_field_text(target_task, (a ->> 'include_field_id')::uuid)
              ) end
            ),
            target_task
          );
        end if;
    end case;
    log := log || jsonb_build_array(jsonb_build_object('type', a ->> 'type', 'outcome', outcome));
  end loop;
  return log;
end;
$$;

revoke all on function public.execute_rule_actions(public.rules, uuid, jsonb, jsonb) from public, anon, authenticated;

create or replace function public.run_rule(
  r public.rules,
  target_task uuid,
  event jsonb,
  rule_actions jsonb default null,
  dedupe text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  chain text := coalesce(current_setting('alhc.rule_chain', true), '');
  previous_rule text := coalesce(current_setting('alhc.rule_id', true), '');
  depth integer := case when chain = '' then 0 else array_length(string_to_array(chain, ','), 1) end;
  log jsonb;
  run_status text;
begin
  if dedupe is not null and exists (
    select 1 from public.rule_runs rr where rr.rule_id = r.id and rr.task_id = target_task and rr.dedupe_key = dedupe
  ) then
    return 'duplicate';
  end if;

  if position(r.id::text in chain) > 0 or depth >= 5 then
    insert into public.rule_runs (rule_id, task_id, trigger_type, status, detail)
    values (r.id, target_task, r.trigger_type, 'skipped', jsonb_build_object(
      'reason', case when depth >= 5 then 'depth_limit' else 'loop' end, 'chain', chain
    ));
    return 'skipped';
  end if;

  if (
    select count(*) from public.rule_runs rr
    where rr.rule_id = r.id and rr.task_id = target_task
      and rr.status in ('succeeded', 'scheduled') and rr.created_at > now() - interval '1 hour'
  ) >= 20 then
    insert into public.rule_runs (rule_id, task_id, trigger_type, status, detail)
    values (r.id, target_task, r.trigger_type, 'skipped', jsonb_build_object('reason', 'throttled'));
    return 'skipped';
  end if;

  if not public.rule_conditions_pass(r, target_task) then
    return 'conditions';
  end if;

  perform set_config('alhc.rule_chain', case when chain = '' then r.id::text else chain || ',' || r.id::text end, true);
  perform set_config('alhc.rule_id', r.id::text, true);
  begin
    log := public.execute_rule_actions(r, target_task, coalesce(rule_actions, r.actions), event);
    run_status := case when log @> '[{"outcome": "scheduled"}]'::jsonb then 'scheduled' else 'succeeded' end;
  exception when others then
    log := jsonb_build_object('error', sqlerrm);
    run_status := 'failed';
  end;
  perform set_config('alhc.rule_chain', chain, true);
  perform set_config('alhc.rule_id', previous_rule, true);

  insert into public.rule_runs (rule_id, task_id, trigger_type, status, detail, dedupe_key)
  values (r.id, target_task, r.trigger_type, run_status,
    jsonb_build_object('actions', log, 'event', coalesce(event, '{}'::jsonb)), dedupe);
  return run_status;
end;
$$;

revoke all on function public.run_rule(public.rules, uuid, jsonb, jsonb, text) from public, anon, authenticated;

create or replace function public.fire_rules(
  trigger_kind text,
  target_task uuid,
  target_project uuid,
  event jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rules;
  cfg jsonb;
begin
  for r in
    select ru.* from public.rules ru
    join public.projects p on p.id = ru.project_id and p.deleted_at is null
    join public.task_projects tp on tp.project_id = ru.project_id and tp.task_id = target_task and tp.deleted_at is null
    where ru.enabled and ru.deleted_at is null and ru.trigger_type = trigger_kind
      and (target_project is null or ru.project_id = target_project)
    order by ru.sort_order, ru.created_at
  loop
    cfg := r.trigger_config;
    continue when trigger_kind = 'section_changed' and cfg ->> 'section_id' is distinct from event ->> 'section_id';
    continue when trigger_kind = 'field_changed' and (
      cfg ->> 'field_id' is distinct from event ->> 'field_id'
      or (cfg ? 'option_id' and not coalesce(
        event -> 'value' = cfg -> 'option_id' or event -> 'value' @> jsonb_build_array(cfg -> 'option_id'), false
      ))
    );
    continue when trigger_kind = 'approval_decided' and cfg ? 'statuses'
      and not (cfg -> 'statuses') ? (event ->> 'status');
    continue when trigger_kind = 'form_submitted' and cfg ? 'form_id' and cfg ->> 'form_id' is distinct from event ->> 'form_id';
    perform public.run_rule(r, target_task, event);
  end loop;
end;
$$;

revoke all on function public.fire_rules(text, uuid, uuid, jsonb) from public, anon, authenticated;

-- Event wiring. Changes made in the transaction that created the task only fire rules when a rule
-- caused them (matching how stories treat creation).
create or replace function public.rules_on_task_project_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.section_id is not null
     and new.section_id is distinct from old.section_id
     and new.deleted_at is null
     and (public.rule_context_id() is not null
          or not exists (select 1 from public.tasks t where t.id = new.task_id and t.created_at = now())) then
    perform public.fire_rules('section_changed', new.task_id, new.project_id, jsonb_build_object(
      'section_id', new.section_id, 'from_section_id', old.section_id
    ));
  end if;
  return new;
end;
$$;

create trigger task_projects_rules
  after update of section_id on public.task_projects
  for each row execute function public.rules_on_task_project_update();

create or replace function public.rules_on_field_value_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.value is not distinct from old.value then
    return new;
  end if;
  if public.rule_context_id() is null
     and exists (select 1 from public.tasks t where t.id = new.task_id and t.created_at = now()) then
    return new;
  end if;
  perform public.fire_rules('field_changed', new.task_id,
    (select f.project_id from public.custom_fields f where f.id = new.field_id),
    jsonb_build_object('field_id', new.field_id, 'value', new.value));
  return new;
end;
$$;

create trigger task_field_values_rules
  after insert or update on public.task_field_values
  for each row execute function public.rules_on_field_value_change();

create or replace function public.rules_on_task_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.assignee_id is distinct from old.assignee_id and new.deleted_at is null then
    perform public.fire_rules('assignee_changed', new.id, null, jsonb_build_object('assignee_id', new.assignee_id));
  end if;
  return new;
end;
$$;

create trigger tasks_rules
  after update of assignee_id on public.tasks
  for each row execute function public.rules_on_task_update();

-- Deferred to commit so the new task's section, fields, and form answers are all in place.
create or replace function public.rules_on_task_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.tasks t where t.id = new.id and t.deleted_at is null) then
    perform public.fire_rules('task_created', new.id, null, '{}'::jsonb);
  end if;
  return null;
end;
$$;

create constraint trigger tasks_rules_created
  after insert on public.tasks
  deferrable initially deferred
  for each row execute function public.rules_on_task_created();

-- Scheduled work: delayed actions and due-date triggers. Run every few minutes (pg_cron below, or
-- the app's /api/cron/workflows route).
create or replace function public.workflow_tick()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  job public.scheduled_rule_actions;
  r public.rules;
  t record;
  days integer;
  local_today date;
  delayed integer := 0;
  due integer := 0;
  outcome text;
begin
  for job in
    select * from public.scheduled_rule_actions
    where status = 'pending' and run_at <= now() and deleted_at is null
    order by run_at
    limit 500
    for update skip locked
  loop
    select * into r from public.rules where id = job.rule_id;
    if not r.enabled or r.deleted_at is not null
       or not exists (select 1 from public.tasks tk where tk.id = job.task_id and tk.deleted_at is null) then
      update public.scheduled_rule_actions set status = 'cancelled', completed_at = now() where id = job.id;
      continue;
    end if;
    outcome := public.run_rule(r, job.task_id, job.event, job.actions);
    update public.scheduled_rule_actions
    set status = case when outcome = 'failed' then 'failed' when outcome = 'conditions' then 'cancelled' else 'done' end,
        completed_at = now()
    where id = job.id;
    delayed := delayed + 1;
  end loop;

  for r in
    select ru.* from public.rules ru
    join public.projects p on p.id = ru.project_id and p.deleted_at is null
    where ru.enabled and ru.deleted_at is null and ru.trigger_type = 'due_approaching'
  loop
    days := coalesce((r.trigger_config ->> 'days')::integer, 1);
    local_today := (now() at time zone coalesce(nullif(r.trigger_config ->> 'timezone', ''), 'UTC'))::date;
    for t in
      select tk.id, tk.due_on from public.tasks tk
      join public.task_projects tp on tp.task_id = tk.id and tp.project_id = r.project_id and tp.deleted_at is null
      where tk.deleted_at is null and tk.completed_at is null and tk.due_on = local_today + days
    loop
      outcome := public.run_rule(r, t.id, jsonb_build_object('due_on', t.due_on), null, 'due:' || t.due_on::text);
      if outcome in ('succeeded', 'scheduled') then
        due := due + 1;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('delayed_actions', delayed, 'due_rules', due);
end;
$$;

revoke all on function public.workflow_tick() from public, anon, authenticated;
grant execute on function public.workflow_tick() to service_role;

-- ---------------------------------------------------------------------------
-- Rule presets: installable templates. Inputs are referenced as {"slot": "<key>"} and filled at
-- install time, so presets never contain project, section, field, or people ids.
-- ---------------------------------------------------------------------------

create table public.rule_presets (
  key text primary key,
  name text not null,
  description text not null,
  -- [{ key, label, kind: section|field|person|text|number, default? }]
  inputs jsonb not null default '[]'::jsonb,
  -- [{ name, trigger_type, trigger_config, conditions, actions }]
  rules jsonb not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create or replace function public.fill_slots(template jsonb, bindings jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
begin
  case jsonb_typeof(template)
    when 'object' then
      if template ? 'slot' and (select count(*) from jsonb_object_keys(template)) = 1 then
        if not bindings ? (template ->> 'slot') then
          raise exception 'Missing preset input “%”', template ->> 'slot' using errcode = 'check_violation';
        end if;
        return bindings -> (template ->> 'slot');
      end if;
      return (select coalesce(jsonb_object_agg(e.key, public.fill_slots(e.value, bindings)), '{}'::jsonb)
              from jsonb_each(template) e);
    when 'array' then
      return (select coalesce(jsonb_agg(public.fill_slots(x.value, bindings) order by x.ordinality), '[]'::jsonb)
              from jsonb_array_elements(template) with ordinality x);
    else
      return template;
  end case;
end;
$$;

revoke all on function public.fill_slots(jsonb, jsonb) from public, anon;
grant execute on function public.fill_slots(jsonb, jsonb) to authenticated;

-- Runs as the caller, so RLS on rules applies. Installed rules are disabled unless enable is true.
create or replace function public.install_rule_preset(
  target_project uuid,
  preset text,
  inputs jsonb default '{}'::jsonb,
  enable boolean default false
)
returns setof uuid
language plpgsql
set search_path = ''
as $$
declare
  p public.rule_presets;
  bindings jsonb := '{}'::jsonb;
  input jsonb;
  tpl jsonb;
  base_order double precision;
  new_rule uuid;
begin
  select * into p from public.rule_presets where key = preset and deleted_at is null;
  if not found then
    raise exception 'Unknown preset' using errcode = 'no_data_found';
  end if;
  for input in select value from jsonb_array_elements(p.inputs) loop
    if coalesce(inputs, '{}'::jsonb) ? (input ->> 'key') and coalesce(inputs -> (input ->> 'key'), 'null'::jsonb) <> 'null'::jsonb then
      bindings := bindings || jsonb_build_object(input ->> 'key', inputs -> (input ->> 'key'));
    elsif input ? 'default' then
      bindings := bindings || jsonb_build_object(input ->> 'key', input -> 'default');
    else
      raise exception 'Fill in “%”', input ->> 'label' using errcode = 'check_violation';
    end if;
  end loop;
  select coalesce(max(ru.sort_order), 0) into base_order from public.rules ru
  where ru.project_id = target_project and ru.deleted_at is null;
  for tpl in select value from jsonb_array_elements(p.rules) loop
    base_order := base_order + 1024;
    insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, conditions, actions, preset_key, sort_order)
    values (
      target_project,
      tpl ->> 'name',
      coalesce(enable, false),
      tpl ->> 'trigger_type',
      public.fill_slots(coalesce(tpl -> 'trigger_config', '{}'::jsonb), bindings),
      public.fill_slots(coalesce(tpl -> 'conditions', '[]'::jsonb), bindings),
      public.fill_slots(coalesce(tpl -> 'actions', '[]'::jsonb), bindings),
      p.key,
      base_order
    )
    returning id into new_rule;
    return next new_rule;
  end loop;
end;
$$;

revoke all on function public.install_rule_preset(uuid, text, jsonb, boolean) from public, anon;
grant execute on function public.install_rule_preset(uuid, text, jsonb, boolean) to authenticated;

-- Generic templates modelled on common request-team workflows. No ids, names, or teams baked in.
insert into public.rule_presets (key, name, description, inputs, rules, sort_order) values
(
  'due_tomorrow_reminder',
  'Due tomorrow reminder',
  'The day before an open task is due, @mention the assignee in a comment and email them.',
  '[]',
  '[{
    "name": "Due tomorrow reminder",
    "trigger_type": "due_approaching",
    "trigger_config": {"days": 1},
    "conditions": [{"type": "is_incomplete"}, {"type": "assignee_is_set"}],
    "actions": [
      {"type": "add_comment", "body": "{assignee} heads up: this is due tomorrow ({due})."},
      {"type": "send_email", "to": "assignee", "template": "due_tomorrow"}
    ]
  }]',
  10
),
(
  'requester_update_on_section',
  'Email the requester when work reaches a section',
  'When a task moves into the chosen section, email the person who submitted the request.',
  '[{"key": "section", "label": "Section", "kind": "section"},
    {"key": "message", "label": "Message", "kind": "text", "default": "Your request is now in {section}."}]',
  '[{
    "name": "Requester update",
    "trigger_type": "section_changed",
    "trigger_config": {"section_id": {"slot": "section"}},
    "actions": [
      {"type": "send_email", "to": "submitter", "template": "requester_update", "message": {"slot": "message"}}
    ]
  }]',
  20
),
(
  'stale_section_nudge',
  'Nudge when work sits in a section',
  'If a task is still in the chosen section after a delay, @mention the assignee.',
  '[{"key": "section", "label": "Section", "kind": "section"},
    {"key": "hours", "label": "Hours to wait", "kind": "number", "default": 24}]',
  '[{
    "name": "Stale task nudge",
    "trigger_type": "section_changed",
    "trigger_config": {"section_id": {"slot": "section"}},
    "conditions": [{"type": "section_is", "section_id": {"slot": "section"}}, {"type": "is_incomplete"}],
    "actions": [
      {"type": "delay", "hours": {"slot": "hours"}},
      {"type": "add_comment", "body": "{assignee} friendly nudge: this is still in {section}."}
    ]
  }]',
  30
),
(
  'tracking_update_email',
  'Email tracking details to the requester',
  'When a tracking (or any text) field is filled in, email its value to the requester.',
  '[{"key": "field", "label": "Tracking field", "kind": "field"},
    {"key": "message", "label": "Message", "kind": "text", "default": "Your order is on its way. Details below."}]',
  '[{
    "name": "Tracking update email",
    "trigger_type": "field_changed",
    "trigger_config": {"field_id": {"slot": "field"}},
    "conditions": [{"type": "field_is_set", "field_id": {"slot": "field"}}],
    "actions": [
      {"type": "send_email", "to": "submitter", "template": "requester_update",
       "message": {"slot": "message"}, "include_field_id": {"slot": "field"}}
    ]
  }]',
  40
),
(
  'approval_routing',
  'Approval routing',
  'Entering a review section requests approval; approval moves the task forward, and changes or rejection send it back.',
  '[{"key": "review_section", "label": "Review section", "kind": "section"},
    {"key": "approver", "label": "Approver", "kind": "person"},
    {"key": "approved_section", "label": "Move here when approved", "kind": "section"},
    {"key": "changes_section", "label": "Move here when changes are requested", "kind": "section"}]',
  '[{
    "name": "Request approval on review",
    "trigger_type": "section_changed",
    "trigger_config": {"section_id": {"slot": "review_section"}},
    "actions": [{"type": "request_approval", "approver": {"slot": "approver"}, "title": "Review and approve"}]
  }, {
    "name": "Move approved work",
    "trigger_type": "approval_decided",
    "trigger_config": {"statuses": ["approved"]},
    "actions": [{"type": "move_section", "section_id": {"slot": "approved_section"}}]
  }, {
    "name": "Send back for changes",
    "trigger_type": "approval_decided",
    "trigger_config": {"statuses": ["changes_requested", "rejected"]},
    "actions": [
      {"type": "move_section", "section_id": {"slot": "changes_section"}},
      {"type": "add_comment", "body": "{assignee} changes requested: {approval_note}"}
    ]
  }]',
  50
),
(
  'intake_triage',
  'Route new form submissions',
  'When a form is submitted, assign a triage owner and let them know.',
  '[{"key": "owner", "label": "Triage owner", "kind": "person"}]',
  '[{
    "name": "Route new submissions",
    "trigger_type": "form_submitted",
    "actions": [
      {"type": "set_assignee", "assignee": {"slot": "owner"}},
      {"type": "notify", "people": [{"slot": "owner"}], "message": "New request: {task}"}
    ]
  }]',
  60
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.request_sequences enable row level security;
alter table public.approval_requests enable row level security;
alter table public.email_outbox enable row level security;
alter table public.forms enable row level security;
alter table public.form_submissions enable row level security;
alter table public.rules enable row level security;
alter table public.rule_runs enable row level security;
alter table public.scheduled_rule_actions enable row level security;
alter table public.rule_presets enable row level security;

create policy request_sequences_select_allowlisted on public.request_sequences
  for select to authenticated using ((select public.is_allowlisted()));
create policy request_sequences_insert_allowlisted on public.request_sequences
  for insert to authenticated with check ((select public.is_allowlisted()));
create policy request_sequences_update_allowlisted on public.request_sequences
  for update to authenticated
  using ((select public.is_allowlisted()))
  with check ((select public.is_allowlisted()));

create policy forms_select_allowlisted on public.forms
  for select to authenticated using ((select public.is_allowlisted()));
create policy forms_insert_allowlisted on public.forms
  for insert to authenticated with check ((select public.is_allowlisted()));
create policy forms_update_allowlisted on public.forms
  for update to authenticated
  using ((select public.is_allowlisted()))
  with check ((select public.is_allowlisted()));

create policy rules_select_allowlisted on public.rules
  for select to authenticated using ((select public.is_allowlisted()));
create policy rules_insert_allowlisted on public.rules
  for insert to authenticated with check ((select public.is_allowlisted()));
create policy rules_update_allowlisted on public.rules
  for update to authenticated
  using ((select public.is_allowlisted()))
  with check ((select public.is_allowlisted()));

-- System-written: readable by members, written only through SECURITY DEFINER functions.
create policy approval_requests_select_allowlisted on public.approval_requests
  for select to authenticated using ((select public.is_allowlisted()));
create policy email_outbox_select_allowlisted on public.email_outbox
  for select to authenticated using ((select public.is_allowlisted()));
create policy form_submissions_select_allowlisted on public.form_submissions
  for select to authenticated using ((select public.is_allowlisted()));
create policy rule_runs_select_allowlisted on public.rule_runs
  for select to authenticated using ((select public.is_allowlisted()));
create policy scheduled_rule_actions_select_allowlisted on public.scheduled_rule_actions
  for select to authenticated using ((select public.is_allowlisted()));
create policy rule_presets_select_allowlisted on public.rule_presets
  for select to authenticated using ((select public.is_allowlisted()));

-- ---------------------------------------------------------------------------
-- Realtime + scheduling (each a no-op where the extension/publication is missing)
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.approval_requests;
  end if;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('alhc-workflow-tick', '*/5 * * * *', 'select public.workflow_tick()');
  end if;
end;
$$;
