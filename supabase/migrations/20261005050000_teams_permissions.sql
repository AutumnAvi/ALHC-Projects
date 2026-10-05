-- ALHC Projects — Phase: Teams & permissions.
-- Per-project membership with roles, membership-aware RLS for every project-scoped table, and
-- membership RPCs. The workspace allowlist (allowed_emails + is_allowlisted()) stays the outer gate:
-- you still need an allowlisted, confirmed session to read anything. Membership is the inner gate:
-- you must be an active member of a project, with a sufficient role, to read or write its data.
--
-- Roles, lowest to highest (a role includes everything below it):
--   viewer < commenter < editor < admin < owner
--   viewer     read the project, its tasks, views, dashboard, timeline, forms, and rules
--   commenter  + comment, follow, @mention, decide approvals they are the named approver of
--   editor     + create/edit/complete/move/multi-home tasks, subtasks, fields, values, attachments,
--                sections, saved views, dashboard widgets; request/cancel/resubmit approvals
--   admin      + rules, forms, request numbers, project settings; invite, change roles, remove
--   owner      + add/promote owners, transfer ownership, soft-delete the project
-- A guest is not a separate account type: it is an allowlisted person invited to a project with a
-- lower role (usually viewer or commenter). Tasks in several projects use the caller's highest role
-- across the projects the task belongs to.
--
-- Same rules as earlier phases: soft delete only, no DELETE policies, SECURITY DEFINER helpers with
-- search_path = '' and EXECUTE revoked from client roles unless they are intentional RPCs.

-- ---------------------------------------------------------------------------
-- Project members
-- ---------------------------------------------------------------------------

create table public.project_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'editor', 'commenter', 'viewer')),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- One active membership per person per project. Removed memberships stay as history.
create unique index project_members_active_idx
  on public.project_members (project_id, profile_id)
  where deleted_at is null;
create index project_members_profile_idx
  on public.project_members (profile_id, project_id)
  where deleted_at is null;
create index project_members_created_by_idx on public.project_members (created_by);

create trigger project_members_set_updated_at
  before update on public.project_members
  for each row execute function public.set_updated_at();

comment on table public.project_members is
  'Per-project membership and role. Written only by SECURITY DEFINER RPCs/triggers; soft-deleted on removal.';

-- ---------------------------------------------------------------------------
-- Role helpers
-- ---------------------------------------------------------------------------

-- Total order used by every check. Unknown roles rank 0 (no access).
create or replace function public.project_role_rank(role text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case role
    when 'viewer' then 1
    when 'commenter' then 2
    when 'editor' then 3
    when 'admin' then 4
    when 'owner' then 5
    else 0
  end;
$$;

revoke all on function public.project_role_rank(text) from public, anon;
grant execute on function public.project_role_rank(text) to authenticated;

-- A profile counts as allowlisted when its auth user is confirmed and its email is on the allowlist.
create or replace function public.profile_is_allowlisted(target_profile uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.users u
    join public.allowed_emails a on a.email = lower(u.email)
    where u.id = target_profile
      and u.email_confirmed_at is not null
  );
$$;

revoke all on function public.profile_is_allowlisted(uuid) from public, anon, authenticated;

-- Internal: a given profile's active role in a project (no allowlist check).
create or replace function public.profile_project_role(target_profile uuid, target_project uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.project_members m
  where m.project_id = target_project
    and m.profile_id = target_profile
    and m.deleted_at is null;
$$;

revoke all on function public.profile_project_role(uuid, uuid) from public, anon, authenticated;

-- Internal: a given profile's highest active role across the projects a task belongs to
-- (its active memberships plus its home project).
create or replace function public.profile_task_role(target_profile uuid, target_task uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.project_members m
  where m.profile_id = target_profile
    and m.deleted_at is null
    and m.project_id in (
      select tp.project_id from public.task_projects tp
      where tp.task_id = target_task and tp.deleted_at is null
      union all
      select t.home_project_id from public.tasks t where t.id = target_task
    )
  order by public.project_role_rank(m.role) desc
  limit 1;
$$;

revoke all on function public.profile_task_role(uuid, uuid) from public, anon, authenticated;

-- The caller's role in a project, or null. Null for callers who are not allowlisted.
create or replace function public.project_role(target_project uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.is_allowlisted() then public.profile_project_role(auth.uid(), target_project) end;
$$;

revoke all on function public.project_role(uuid) from public, anon;
grant execute on function public.project_role(uuid) to authenticated;

create or replace function public.has_project_role(target_project uuid, min_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.project_role_rank(min_role) > 0
    and coalesce(public.project_role_rank(public.project_role(target_project)) >= public.project_role_rank(min_role), false);
$$;

revoke all on function public.has_project_role(uuid, text) from public, anon;
grant execute on function public.has_project_role(uuid, text) to authenticated;

-- The caller's highest role on a task (across the task's projects), or null.
create or replace function public.task_role(target_task uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.is_allowlisted() then public.profile_task_role(auth.uid(), target_task) end;
$$;

revoke all on function public.task_role(uuid) from public, anon;
grant execute on function public.task_role(uuid) to authenticated;

create or replace function public.has_task_role(target_task uuid, min_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.project_role_rank(min_role) > 0
    and coalesce(public.project_role_rank(public.task_role(target_task)) >= public.project_role_rank(min_role), false);
$$;

revoke all on function public.has_task_role(uuid, text) from public, anon;
grant execute on function public.has_task_role(uuid, text) to authenticated;

-- Whether another person can read a task. Only answers for tasks the caller can read themselves,
-- so it can't be used to probe other projects' membership.
create or replace function public.profile_can_read_task(target_profile uuid, target_task uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.task_role(target_task) is not null
    and public.profile_task_role(target_profile, target_task) is not null;
$$;

revoke all on function public.profile_can_read_task(uuid, uuid) from public, anon;
grant execute on function public.profile_can_read_task(uuid, uuid) to authenticated;

-- Owning project of a custom field / rule, for policies on rows that only reference those.
create or replace function public.custom_field_project(target_field uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select f.project_id from public.custom_fields f where f.id = target_field;
$$;

revoke all on function public.custom_field_project(uuid) from public, anon;
grant execute on function public.custom_field_project(uuid) to authenticated;

create or replace function public.rule_project(target_rule uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.project_id from public.rules r where r.id = target_rule;
$$;

revoke all on function public.rule_project(uuid) from public, anon;
grant execute on function public.rule_project(uuid) to authenticated;

-- Storage object names are "<task_id>/<file>"; returns the task id, or null for anything else.
create or replace function public.attachment_object_task(object_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(object_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(object_name, '/', 1)::uuid
  end;
$$;

revoke all on function public.attachment_object_task(text) from public, anon;
grant execute on function public.attachment_object_task(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Invariants
-- ---------------------------------------------------------------------------

-- Memberships never move between projects/people, and a project always keeps an active owner.
create or replace function public.guard_project_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.project_id is distinct from old.project_id or new.profile_id is distinct from old.profile_id then
    raise exception 'A membership cannot move to another project or person' using errcode = 'check_violation';
  end if;
  if old.deleted_at is null and old.role = 'owner'
     and (new.deleted_at is not null or new.role <> 'owner') then
    -- Serialise owner changes per project so two concurrent demotions can't both pass.
    perform 1 from public.projects p where p.id = old.project_id for update;
    if not exists (
      select 1 from public.project_members m
      where m.project_id = old.project_id
        and m.id <> old.id
        and m.role = 'owner'
        and m.deleted_at is null
    ) then
      raise exception 'A project needs at least one owner. Make someone else an owner first.'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger project_members_guard
  before update on public.project_members
  for each row execute function public.guard_project_member();

-- Clients can't spoof who created a project or when; only an owner can soft-delete or restore one.
create or replace function public.guard_project_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.is_client_role() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    return new;
  end if;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  if new.deleted_at is distinct from old.deleted_at and not public.has_project_role(old.id, 'owner') then
    raise exception 'Only a project owner can delete this project' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_project_columns() from public, anon, authenticated;

create trigger projects_05_guard_columns
  before insert or update on public.projects
  for each row execute function public.guard_project_columns();

-- The creator of a project becomes its owner.
create or replace function public.add_project_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := coalesce(public.current_profile_id(), new.created_by);
begin
  if owner_id is not null then
    insert into public.project_members (project_id, profile_id, role, created_by)
    values (new.id, owner_id, 'owner', owner_id);
  end if;
  return new;
end;
$$;

create trigger projects_add_owner
  after insert on public.projects
  for each row execute function public.add_project_owner();

-- ---------------------------------------------------------------------------
-- Backfill
-- Every project gets an owner: its creator when set, otherwise the oldest allowlisted profile.
-- Every other currently allowlisted profile becomes an editor, so the single team using the app
-- today keeps working; owners/admins can then narrow access per project. Idempotent.
-- ---------------------------------------------------------------------------

create or replace function public.backfill_project_members()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  p record;
  owner_id uuid;
  added integer := 0;
  n integer;
begin
  for p in
    select pr.id, pr.created_by from public.projects pr
    where not exists (
      select 1 from public.project_members m
      where m.project_id = pr.id and m.role = 'owner' and m.deleted_at is null
    )
    order by pr.created_at, pr.id
  loop
    owner_id := coalesce(
      (select x.id from public.profiles x where x.id = p.created_by),
      (select x.id from public.profiles x where public.profile_is_allowlisted(x.id) order by x.created_at, x.id limit 1)
    );
    continue when owner_id is null;
    update public.project_members set role = 'owner'
    where project_id = p.id and profile_id = owner_id and deleted_at is null;
    if not found then
      insert into public.project_members (project_id, profile_id, role, created_by)
      values (p.id, owner_id, 'owner', null);
    end if;
    added := added + 1;
  end loop;

  insert into public.project_members (project_id, profile_id, role, created_by)
  select pr.id, x.id, 'editor', null
  from public.projects pr
  cross join public.profiles x
  where public.profile_is_allowlisted(x.id)
    and not exists (
      select 1 from public.project_members m
      where m.project_id = pr.id and m.profile_id = x.id and m.deleted_at is null
    );
  get diagnostics n = row_count;
  return added + n;
end;
$$;

revoke all on function public.backfill_project_members() from public, anon, authenticated;

select public.backfill_project_members();

-- ---------------------------------------------------------------------------
-- Membership RPCs (the only write path for project_members)
-- ---------------------------------------------------------------------------

create or replace function public.update_project_member_role(
  target_project uuid,
  target_profile uuid,
  new_role text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_role text := public.project_role(target_project);
  m public.project_members;
begin
  if public.project_role_rank(caller_role) < public.project_role_rank('admin') then
    raise exception 'Only project owners and admins can change roles' using errcode = 'insufficient_privilege';
  end if;
  if public.project_role_rank(new_role) = 0 then
    raise exception 'Unknown role' using errcode = 'check_violation';
  end if;
  select * into m from public.project_members
  where project_id = target_project and profile_id = target_profile and deleted_at is null
  for update;
  if not found then
    raise exception 'That person is not a member of this project' using errcode = 'no_data_found';
  end if;
  if (m.role = 'owner' or new_role = 'owner') and caller_role <> 'owner' then
    raise exception 'Only an owner can add or change owners' using errcode = 'insufficient_privilege';
  end if;
  if m.role <> new_role then
    update public.project_members set role = new_role where id = m.id;
  end if;
end;
$$;

revoke all on function public.update_project_member_role(uuid, uuid, text) from public, anon;
grant execute on function public.update_project_member_role(uuid, uuid, text) to authenticated;

-- Invite by email. The address must be on the workspace allowlist and its owner must have signed in
-- at least once (so a profile exists). Re-inviting an active member changes their role instead.
create or replace function public.add_project_member(
  target_project uuid,
  member_email text,
  member_role text default 'editor'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_role text := public.project_role(target_project);
  address text := lower(trim(coalesce(member_email, '')));
  target uuid;
begin
  if public.project_role_rank(caller_role) < public.project_role_rank('admin') then
    raise exception 'Only project owners and admins can invite people' using errcode = 'insufficient_privilege';
  end if;
  if public.project_role_rank(member_role) = 0 then
    raise exception 'Unknown role' using errcode = 'check_violation';
  end if;
  if member_role = 'owner' and caller_role <> 'owner' then
    raise exception 'Only an owner can add another owner' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.allowed_emails a where a.email = address) then
    raise exception '% is not on the workspace allowlist', coalesce(nullif(address, ''), 'That address')
      using errcode = 'check_violation',
            hint = 'Workspace access is managed in SQL (allowed_emails). Ask whoever manages it to add them first.';
  end if;
  select x.id into target from public.profiles x
  where x.email = address and public.profile_is_allowlisted(x.id);
  if target is null then
    raise exception '% is allowlisted but has not signed in yet', address
      using errcode = 'check_violation',
            hint = 'They can be added after their first sign-in.';
  end if;

  if exists (
    select 1 from public.project_members m
    where m.project_id = target_project and m.profile_id = target and m.deleted_at is null
  ) then
    perform public.update_project_member_role(target_project, target, member_role);
  else
    insert into public.project_members (project_id, profile_id, role, created_by)
    values (target_project, target, member_role, auth.uid());
  end if;
  return target;
end;
$$;

revoke all on function public.add_project_member(uuid, text, text) from public, anon;
grant execute on function public.add_project_member(uuid, text, text) to authenticated;

-- Soft-removes a membership. Anyone may leave; removing others needs admin (owners need an owner).
create or replace function public.remove_project_member(target_project uuid, target_profile uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_role text := public.project_role(target_project);
  m public.project_members;
begin
  if caller_role is null then
    raise exception 'You are not a member of this project' using errcode = 'insufficient_privilege';
  end if;
  select * into m from public.project_members
  where project_id = target_project and profile_id = target_profile and deleted_at is null
  for update;
  if not found then
    raise exception 'That person is not a member of this project' using errcode = 'no_data_found';
  end if;
  if target_profile is distinct from auth.uid() then
    if public.project_role_rank(caller_role) < public.project_role_rank('admin') then
      raise exception 'Only project owners and admins can remove people' using errcode = 'insufficient_privilege';
    end if;
    if m.role = 'owner' and caller_role <> 'owner' then
      raise exception 'Only an owner can remove another owner' using errcode = 'insufficient_privilege';
    end if;
  end if;
  update public.project_members set deleted_at = now() where id = m.id;
end;
$$;

revoke all on function public.remove_project_member(uuid, uuid) from public, anon;
grant execute on function public.remove_project_member(uuid, uuid) to authenticated;

-- Makes another member an owner and steps the caller down to admin.
create or replace function public.transfer_project_ownership(target_project uuid, target_profile uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.project_role(target_project) is distinct from 'owner' then
    raise exception 'Only an owner can transfer ownership' using errcode = 'insufficient_privilege';
  end if;
  if target_profile is not distinct from auth.uid() then
    raise exception 'Choose another member' using errcode = 'check_violation';
  end if;
  update public.project_members set role = 'owner'
  where project_id = target_project and profile_id = target_profile and deleted_at is null;
  if not found then
    raise exception 'That person is not a member of this project' using errcode = 'no_data_found';
  end if;
  update public.project_members set role = 'admin'
  where project_id = target_project and profile_id = auth.uid() and deleted_at is null;
end;
$$;

revoke all on function public.transfer_project_ownership(uuid, uuid) from public, anon;
grant execute on function public.transfer_project_ownership(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Notifications, followers, and mentions only reach people who can read the task
-- ---------------------------------------------------------------------------

create or replace function public.follow_task(target_task uuid, target_profile uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if target_profile is null
     or not exists (select 1 from public.profiles p where p.id = target_profile)
     or public.profile_task_role(target_profile, target_task) is null then
    return;
  end if;
  insert into public.task_followers (task_id, profile_id)
  values (target_task, target_profile)
  on conflict (task_id, profile_id) do update
    set deleted_at = null
    where public.task_followers.deleted_at is not null;
end;
$$;

revoke all on function public.follow_task(uuid, uuid) from public, anon, authenticated;

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
  if not exists (select 1 from public.profiles p where p.id = recipient)
     or public.profile_task_role(recipient, target_task) is null then
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

-- Same as the workflows version, but only people who can read the task can be @mentioned.
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
    and public.profile_task_role(p.id, new.task_id) is not null
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
-- RPCs that act on a task or project check the caller's role
-- ---------------------------------------------------------------------------

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
  if not public.has_task_role(target_task, 'editor') then
    raise exception 'You need Editor access to number this task' using errcode = 'insufficient_privilege';
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

-- Requesting needs Editor; the approver must be able to comment on the task (or they couldn't decide).
-- Rule-created approvals go through create_approval directly and are not checked here.
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
  if not public.has_task_role(target_task, 'editor') then
    raise exception 'You need Editor access to request approvals on this task' using errcode = 'insufficient_privilege';
  end if;
  if public.project_role_rank(public.profile_task_role(approver, target_task)) < public.project_role_rank('commenter') then
    raise exception 'The approver needs at least Commenter access to this task''s project'
      using errcode = 'check_violation';
  end if;
  return public.create_approval(target_task, approver, approval_note, as_subtask, subtask_title);
end;
$$;

revoke all on function public.request_approval(uuid, uuid, text, boolean, text) from public, anon;
grant execute on function public.request_approval(uuid, uuid, text, boolean, text) to authenticated;

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
  if not public.has_task_role(a.task_id, 'commenter') then
    raise exception 'You need at least Commenter access to this task''s project to decide'
      using errcode = 'insufficient_privilege';
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
  if not public.has_task_role(
    (select a.task_id from public.approval_requests a where a.id = target_approval), 'editor'
  ) then
    raise exception 'You need Editor access to cancel approvals on this task' using errcode = 'insufficient_privilege';
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

create or replace function public.resubmit_approval(target_approval uuid, approval_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_task_role(
    (select a.task_id from public.approval_requests a where a.id = target_approval), 'editor'
  ) then
    raise exception 'You need Editor access to resubmit approvals on this task' using errcode = 'insufficient_privilege';
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

-- Public form stays public. Only members of the form's project preview a closed form's questions.
create or replace function public.get_public_form(target_form uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  f public.forms;
  member boolean;
begin
  select fo.* into f from public.forms fo
  join public.projects p on p.id = fo.project_id and p.deleted_at is null
  where fo.id = target_form and fo.deleted_at is null;
  if not found then
    return null;
  end if;
  member := public.has_project_role(f.project_id, 'viewer');
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

-- SECURITY INVOKER (RLS applies). Labels each hit with its home project when the caller can see it,
-- otherwise with the first project of the task the caller can see; tasks in no visible project are
-- never returned.
create or replace function public.search_tasks(query text, max_results integer default 50)
returns table (
  id uuid,
  title text,
  notes text,
  completed_at timestamptz,
  due_on date,
  assignee_id uuid,
  home_project_id uuid,
  home_project_name text
)
language sql
stable
set search_path = ''
as $$
  with pattern as (
    select '%' || replace(replace(replace(trim(query), '\', '\\'), '%', '\%'), '_', '\_') || '%' as value
  )
  select t.id, t.title, t.notes, t.completed_at, t.due_on, t.assignee_id, shown.id, shown.name
  from public.tasks t
  cross join pattern
  cross join lateral (
    select p.id, p.name
    from public.task_projects tp
    join public.projects p on p.id = tp.project_id
    where tp.task_id = t.id and tp.deleted_at is null and p.deleted_at is null
    order by (tp.project_id = t.home_project_id) desc, tp.created_at
    limit 1
  ) shown
  where length(trim(query)) > 0
    and t.deleted_at is null
    and (t.title ilike pattern.value or t.notes ilike pattern.value)
  order by t.completed_at is not null, t.title ilike pattern.value desc, t.updated_at desc
  limit least(greatest(coalesce(max_results, 50), 1), 100);
$$;

revoke all on function public.search_tasks(text, integer) from public, anon;
grant execute on function public.search_tasks(text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security: replace "any allowlisted user" with membership + role
-- Policy names follow <table>_<command>_<minimum role>; author/recipient-owned rows add _own.
-- Every role check also requires an allowlisted caller (inside project_role / task_role).
-- ---------------------------------------------------------------------------

alter table public.project_members enable row level security;

create policy project_members_select_viewer on public.project_members
  for select to authenticated
  using ((select public.has_project_role(project_id, 'viewer')));
-- No insert/update policies: memberships change only through the RPCs above.

-- Projects ---------------------------------------------------------------------------------------
drop policy projects_select_allowlisted on public.projects;
drop policy projects_update_allowlisted on public.projects;

-- The second branch lets a creator read the row back in the transaction that inserts it (the
-- owner membership is written by an AFTER trigger, after INSERT ... RETURNING is checked).
-- created_by/created_at are forced by projects_05_guard_columns, so it can't be replayed later.
create policy projects_select_viewer on public.projects
  for select to authenticated
  using (
    (select public.has_project_role(id, 'viewer'))
    or (created_by = (select auth.uid()) and created_at = now() and (select public.is_allowlisted()))
  );
-- projects_insert_allowlisted stays: any allowlisted person can create a project and owns it.
create policy projects_update_admin on public.projects
  for update to authenticated
  using ((select public.has_project_role(id, 'admin')))
  with check ((select public.has_project_role(id, 'admin')));

-- Sections ---------------------------------------------------------------------------------------
drop policy sections_select_allowlisted on public.sections;
drop policy sections_insert_allowlisted on public.sections;
drop policy sections_update_allowlisted on public.sections;

create policy sections_select_viewer on public.sections
  for select to authenticated using ((select public.has_project_role(project_id, 'viewer')));
create policy sections_insert_editor on public.sections
  for insert to authenticated with check ((select public.has_project_role(project_id, 'editor')));
create policy sections_update_editor on public.sections
  for update to authenticated
  using ((select public.has_project_role(project_id, 'editor')))
  with check ((select public.has_project_role(project_id, 'editor')));

-- Tasks ------------------------------------------------------------------------------------------
drop policy tasks_select_allowlisted on public.tasks;
drop policy tasks_insert_allowlisted on public.tasks;
drop policy tasks_update_allowlisted on public.tasks;

-- home_project_id is checked directly too, so INSERT ... RETURNING passes before the home
-- membership row (written by an AFTER trigger) exists.
create policy tasks_select_viewer on public.tasks
  for select to authenticated
  using (
    (select public.has_project_role(home_project_id, 'viewer'))
    or (select public.has_task_role(id, 'viewer'))
  );
create policy tasks_insert_editor on public.tasks
  for insert to authenticated
  with check ((select public.has_project_role(home_project_id, 'editor')));
create policy tasks_update_editor on public.tasks
  for update to authenticated
  using ((select public.has_task_role(id, 'editor')))
  with check ((select public.has_task_role(id, 'editor')));

-- Task memberships: visible per project; adding a task to a project needs Editor there and on the task.
drop policy task_projects_select_allowlisted on public.task_projects;
drop policy task_projects_insert_allowlisted on public.task_projects;
drop policy task_projects_update_allowlisted on public.task_projects;

create policy task_projects_select_viewer on public.task_projects
  for select to authenticated using ((select public.has_project_role(project_id, 'viewer')));
create policy task_projects_insert_editor on public.task_projects
  for insert to authenticated
  with check (
    (select public.has_project_role(project_id, 'editor'))
    and (select public.has_task_role(task_id, 'editor'))
  );
create policy task_projects_update_editor on public.task_projects
  for update to authenticated
  using ((select public.has_project_role(project_id, 'editor')))
  with check ((select public.has_project_role(project_id, 'editor')));

-- Subtasks ---------------------------------------------------------------------------------------
drop policy subtasks_select_allowlisted on public.subtasks;
drop policy subtasks_insert_allowlisted on public.subtasks;
drop policy subtasks_update_allowlisted on public.subtasks;

create policy subtasks_select_viewer on public.subtasks
  for select to authenticated using ((select public.has_task_role(task_id, 'viewer')));
create policy subtasks_insert_editor on public.subtasks
  for insert to authenticated with check ((select public.has_task_role(task_id, 'editor')));
create policy subtasks_update_editor on public.subtasks
  for update to authenticated
  using ((select public.has_task_role(task_id, 'editor')))
  with check ((select public.has_task_role(task_id, 'editor')));

-- Followers: commenters can follow; the followed person must be able to read the task.
drop policy task_followers_select_allowlisted on public.task_followers;
drop policy task_followers_insert_allowlisted on public.task_followers;
drop policy task_followers_update_allowlisted on public.task_followers;

create policy task_followers_select_viewer on public.task_followers
  for select to authenticated using ((select public.has_task_role(task_id, 'viewer')));
create policy task_followers_insert_commenter on public.task_followers
  for insert to authenticated
  with check (
    (select public.has_task_role(task_id, 'commenter'))
    and (deleted_at is not null or public.profile_can_read_task(profile_id, task_id))
  );
create policy task_followers_update_commenter on public.task_followers
  for update to authenticated
  using ((select public.has_task_role(task_id, 'commenter')))
  with check (
    (select public.has_task_role(task_id, 'commenter'))
    and (deleted_at is not null or public.profile_can_read_task(profile_id, task_id))
  );

-- Stories ----------------------------------------------------------------------------------------
drop policy task_stories_select_allowlisted on public.task_stories;
create policy task_stories_select_viewer on public.task_stories
  for select to authenticated using ((select public.has_task_role(task_id, 'viewer')));

-- Comments ---------------------------------------------------------------------------------------
drop policy comments_select_allowlisted on public.comments;
drop policy comments_insert_own on public.comments;
drop policy comments_update_own on public.comments;

create policy comments_select_viewer on public.comments
  for select to authenticated using ((select public.has_task_role(task_id, 'viewer')));
create policy comments_insert_own_commenter on public.comments
  for insert to authenticated
  with check (author_id = (select auth.uid()) and (select public.has_task_role(task_id, 'commenter')));
create policy comments_update_own_commenter on public.comments
  for update to authenticated
  using (author_id = (select auth.uid()) and (select public.has_task_role(task_id, 'commenter')))
  with check (author_id = (select auth.uid()) and (select public.has_task_role(task_id, 'commenter')));

drop policy comment_mentions_select_allowlisted on public.comment_mentions;
create policy comment_mentions_select_viewer on public.comment_mentions
  for select to authenticated
  using (exists (
    select 1 from public.comments c
    where c.id = comment_id and (select public.has_task_role(c.task_id, 'viewer'))
  ));

-- Inbox: still own rows only, and only for tasks the recipient can still read.
drop policy inbox_items_select_own on public.inbox_items;
drop policy inbox_items_update_own on public.inbox_items;

create policy inbox_items_select_own_viewer on public.inbox_items
  for select to authenticated
  using (recipient_id = (select auth.uid()) and (select public.has_task_role(task_id, 'viewer')));
create policy inbox_items_update_own_viewer on public.inbox_items
  for update to authenticated
  using (recipient_id = (select auth.uid()) and (select public.has_task_role(task_id, 'viewer')))
  with check (recipient_id = (select auth.uid()) and (select public.has_task_role(task_id, 'viewer')));

-- Custom fields + values -------------------------------------------------------------------------
drop policy custom_fields_select_allowlisted on public.custom_fields;
drop policy custom_fields_insert_allowlisted on public.custom_fields;
drop policy custom_fields_update_allowlisted on public.custom_fields;

create policy custom_fields_select_viewer on public.custom_fields
  for select to authenticated using ((select public.has_project_role(project_id, 'viewer')));
create policy custom_fields_insert_editor on public.custom_fields
  for insert to authenticated with check ((select public.has_project_role(project_id, 'editor')));
create policy custom_fields_update_editor on public.custom_fields
  for update to authenticated
  using ((select public.has_project_role(project_id, 'editor')))
  with check ((select public.has_project_role(project_id, 'editor')));

-- A value belongs to its field's project, so it is gated by that project (not by other homes).
drop policy task_field_values_select_allowlisted on public.task_field_values;
drop policy task_field_values_insert_allowlisted on public.task_field_values;
drop policy task_field_values_update_allowlisted on public.task_field_values;

create policy task_field_values_select_viewer on public.task_field_values
  for select to authenticated
  using ((select public.has_project_role(public.custom_field_project(field_id), 'viewer')));
create policy task_field_values_insert_editor on public.task_field_values
  for insert to authenticated
  with check ((select public.has_project_role(public.custom_field_project(field_id), 'editor')));
create policy task_field_values_update_editor on public.task_field_values
  for update to authenticated
  using ((select public.has_project_role(public.custom_field_project(field_id), 'editor')))
  with check ((select public.has_project_role(public.custom_field_project(field_id), 'editor')));

-- Attachments (metadata + Storage objects) -------------------------------------------------------
drop policy task_attachments_select_allowlisted on public.task_attachments;
drop policy task_attachments_insert_own on public.task_attachments;
drop policy task_attachments_update_allowlisted on public.task_attachments;

create policy task_attachments_select_viewer on public.task_attachments
  for select to authenticated using ((select public.has_task_role(task_id, 'viewer')));
create policy task_attachments_insert_own_editor on public.task_attachments
  for insert to authenticated
  with check (uploaded_by = (select auth.uid()) and (select public.has_task_role(task_id, 'editor')));
create policy task_attachments_update_editor on public.task_attachments
  for update to authenticated
  using ((select public.has_task_role(task_id, 'editor')))
  with check ((select public.has_task_role(task_id, 'editor')));

drop policy task_attachments_objects_select_allowlisted on storage.objects;
drop policy task_attachments_objects_insert_allowlisted on storage.objects;

create policy task_attachments_objects_select_viewer on storage.objects
  for select to authenticated
  using (
    bucket_id = 'task-attachments'
    and (select public.has_task_role(public.attachment_object_task(name), 'viewer'))
  );
create policy task_attachments_objects_insert_editor on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'task-attachments'
    and (select public.has_task_role(public.attachment_object_task(name), 'editor'))
  );

-- Workflows --------------------------------------------------------------------------------------
drop policy request_sequences_select_allowlisted on public.request_sequences;
drop policy request_sequences_insert_allowlisted on public.request_sequences;
drop policy request_sequences_update_allowlisted on public.request_sequences;

create policy request_sequences_select_viewer on public.request_sequences
  for select to authenticated using ((select public.has_project_role(project_id, 'viewer')));
create policy request_sequences_insert_admin on public.request_sequences
  for insert to authenticated with check ((select public.has_project_role(project_id, 'admin')));
create policy request_sequences_update_admin on public.request_sequences
  for update to authenticated
  using ((select public.has_project_role(project_id, 'admin')))
  with check ((select public.has_project_role(project_id, 'admin')));

drop policy forms_select_allowlisted on public.forms;
drop policy forms_insert_allowlisted on public.forms;
drop policy forms_update_allowlisted on public.forms;

create policy forms_select_viewer on public.forms
  for select to authenticated using ((select public.has_project_role(project_id, 'viewer')));
create policy forms_insert_admin on public.forms
  for insert to authenticated with check ((select public.has_project_role(project_id, 'admin')));
create policy forms_update_admin on public.forms
  for update to authenticated
  using ((select public.has_project_role(project_id, 'admin')))
  with check ((select public.has_project_role(project_id, 'admin')));

drop policy rules_select_allowlisted on public.rules;
drop policy rules_insert_allowlisted on public.rules;
drop policy rules_update_allowlisted on public.rules;

create policy rules_select_viewer on public.rules
  for select to authenticated using ((select public.has_project_role(project_id, 'viewer')));
create policy rules_insert_admin on public.rules
  for insert to authenticated with check ((select public.has_project_role(project_id, 'admin')));
create policy rules_update_admin on public.rules
  for update to authenticated
  using ((select public.has_project_role(project_id, 'admin')))
  with check ((select public.has_project_role(project_id, 'admin')));

drop policy approval_requests_select_allowlisted on public.approval_requests;
create policy approval_requests_select_viewer on public.approval_requests
  for select to authenticated using ((select public.has_task_role(task_id, 'viewer')));

drop policy form_submissions_select_allowlisted on public.form_submissions;
create policy form_submissions_select_viewer on public.form_submissions
  for select to authenticated using ((select public.has_task_role(task_id, 'viewer')));

-- Outbox rows about a task follow the task; rows without one (none are queued today) stay hidden.
drop policy email_outbox_select_allowlisted on public.email_outbox;
create policy email_outbox_select_viewer on public.email_outbox
  for select to authenticated
  using (task_id is not null and (select public.has_task_role(task_id, 'viewer')));

drop policy rule_runs_select_allowlisted on public.rule_runs;
create policy rule_runs_select_viewer on public.rule_runs
  for select to authenticated
  using ((select public.has_project_role(public.rule_project(rule_id), 'viewer')));

drop policy scheduled_rule_actions_select_allowlisted on public.scheduled_rule_actions;
create policy scheduled_rule_actions_select_viewer on public.scheduled_rule_actions
  for select to authenticated
  using ((select public.has_project_role(public.rule_project(rule_id), 'viewer')));

-- rule_presets stay readable by every allowlisted user (global templates with no project data).

-- Views & dashboards -----------------------------------------------------------------------------
drop policy project_views_select_allowlisted on public.project_views;
drop policy project_views_insert_allowlisted on public.project_views;
drop policy project_views_update_allowlisted on public.project_views;

create policy project_views_select_viewer on public.project_views
  for select to authenticated using ((select public.has_project_role(project_id, 'viewer')));
create policy project_views_insert_editor on public.project_views
  for insert to authenticated with check ((select public.has_project_role(project_id, 'editor')));
create policy project_views_update_editor on public.project_views
  for update to authenticated
  using ((select public.has_project_role(project_id, 'editor')))
  with check ((select public.has_project_role(project_id, 'editor')));

drop policy dashboard_widgets_select_allowlisted on public.dashboard_widgets;
drop policy dashboard_widgets_insert_allowlisted on public.dashboard_widgets;
drop policy dashboard_widgets_update_allowlisted on public.dashboard_widgets;

create policy dashboard_widgets_select_viewer on public.dashboard_widgets
  for select to authenticated using ((select public.has_project_role(project_id, 'viewer')));
create policy dashboard_widgets_insert_editor on public.dashboard_widgets
  for insert to authenticated with check ((select public.has_project_role(project_id, 'editor')));
create policy dashboard_widgets_update_editor on public.dashboard_widgets
  for update to authenticated
  using ((select public.has_project_role(project_id, 'editor')))
  with check ((select public.has_project_role(project_id, 'editor')));

-- ---------------------------------------------------------------------------
-- Hardening: EXECUTE on SECURITY DEFINER functions
-- ---------------------------------------------------------------------------
-- New trigger functions are never client RPCs (same sweep as the timeline migration).

do $$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and p.prorettype = 'trigger'::regtype
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
  end loop;
end;
$$;

