-- ALHC Projects — Oct 26 notes, batch 3.
--
-- 3. Not a member of a project: instead of "Not found", someone allowlisted who opens a project link
--    they can't open sees "You're not part of this project" with Request to be added. The project's
--    owners (and older Admins) get an Inbox item they can approve or decline.
--      * project_access_requests (the requester and the project's admins+ read; written only by the
--        definer functions below).
--      * project_access_status(project): member | can_request | requested | archived | missing — a
--        deleted or unknown project stays "missing" (a real Not found). Says nothing else about it.
--      * request_project_access(project): one open request per person and project, at most 10 requests
--        an hour per person and 3 per project a week; notifies owners / admins (kind rule, project item).
--      * decide_project_access_request(request, decision, role): Admin+ of the project; approving goes
--        through add_project_member (its own checks), and tells the requester.
--      * Joining by any other way closes the open request (trigger on project_members).
--
-- 4. Tags can be switched off for the whole workspace (workspaces.tags_enabled, off by default; workspace
--    admins turn it on in Admin console → Tags). Off hides tags in the app; nothing is removed: tags,
--    task links, rules, and views keep their data and come back when it's turned on. Search stops
--    matching tag names while it's off (search_tasks, asserted patch).
--
-- Additive: no tail.

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

-- ---------------------------------------------------------------------------
-- 3. Requests to be added to a project
-- ---------------------------------------------------------------------------

create table if not exists public.project_access_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  requester_id uuid not null references public.profiles (id),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  granted_role text check (granted_role is null or granted_role in ('owner', 'admin', 'editor', 'commenter', 'viewer')),
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists project_access_requests_open_idx
  on public.project_access_requests (project_id, requester_id) where status = 'pending';
create index if not exists project_access_requests_requester_idx
  on public.project_access_requests (requester_id, created_at desc);
create index if not exists project_access_requests_project_idx
  on public.project_access_requests (project_id, created_at desc);
create index if not exists project_access_requests_decided_by_idx
  on public.project_access_requests (decided_by) where decided_by is not null;

alter table public.project_access_requests enable row level security;
revoke all on public.project_access_requests from anon, authenticated;
select public.alhc_revoke_anon_grants(array['project_access_requests']);
select public.alhc_revoke_client_truncate(array['project_access_requests']);
grant select on public.project_access_requests to authenticated;

comment on table public.project_access_requests is
  'Oct 26 notes (batch 3): someone asking to be added to a project they opened a link to. Read by the '
  'requester and the project''s admins+; written only by request_project_access / '
  'decide_project_access_request and the project_members trigger.';

create policy project_access_requests_select_own_or_admin on public.project_access_requests
  for select to authenticated
  using (
    (select public.is_allowlisted())
    and (requester_id = (select auth.uid()) or (select public.has_project_role(project_id, 'admin')))
  );

create trigger project_access_requests_set_updated_at
  before update on public.project_access_requests
  for each row execute function public.set_updated_at();

-- What the not-a-member page should say. Only ever "missing" for a project that's gone (or never was),
-- so nothing about a deleted project leaks; anything else says only whether the caller can ask.
create or replace function public.project_access_status(target_project uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  p public.projects;
begin
  if me is null or not public.is_allowlisted() then
    return 'missing';
  end if;
  select * into p from public.projects x where x.id = target_project and x.deleted_at is null;
  if not found then
    return 'missing';
  end if;
  if public.profile_project_role(me, p.id) is not null then
    return 'member';
  end if;
  if p.archived_at is not null then
    return 'archived';
  end if;
  if exists (
    select 1 from public.project_access_requests r
    where r.project_id = p.id and r.requester_id = me and r.status = 'pending'
  ) then
    return 'requested';
  end if;
  return 'can_request';
end;
$$;

revoke all on function public.project_access_status(uuid) from public, anon;
grant execute on function public.project_access_status(uuid) to authenticated;

-- Marks every Inbox item about a request with what became of it (the card shows it instead of buttons).
create or replace function public.mark_access_request_items(target_request uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.inbox_items i
  set data = i.data || jsonb_build_object(
    'access_request_status', r.status,
    'granted_role', r.granted_role
  )
  from public.project_access_requests r
  where r.id = target_request
    and i.project_id = r.project_id
    and i.kind = 'rule'
    and i.data ->> 'access_request_id' = r.id::text;
$$;

revoke all on function public.mark_access_request_items(uuid) from public, anon, authenticated;

create or replace function public.request_project_access(target_project uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  p public.projects;
  requester public.profiles;
  req public.project_access_requests;
  who text;
  recipient record;
begin
  if me is null or not public.is_allowlisted() then
    raise exception 'Sign in to ask for access' using errcode = 'insufficient_privilege';
  end if;
  -- One request at a time per person (the limits below count rows).
  perform pg_advisory_xact_lock(hashtext('alhc_access_request:' || me::text));
  select * into p from public.projects x where x.id = target_project and x.deleted_at is null;
  if not found then
    raise exception 'Project not found' using errcode = 'no_data_found';
  end if;
  if public.profile_project_role(me, p.id) is not null then
    return 'member';
  end if;
  if p.archived_at is not null then
    raise exception 'This project is archived, so nobody can be added to it right now' using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from public.project_access_requests r
    where r.project_id = p.id and r.requester_id = me and r.status = 'pending'
  ) then
    return 'requested';
  end if;
  if (select count(*) from public.project_access_requests r
      where r.requester_id = me and r.created_at > now() - interval '1 hour') >= 10 then
    raise exception 'You''ve asked to join a lot of projects in the last hour. Try again later.'
      using errcode = 'check_violation';
  end if;
  if (select count(*) from public.project_access_requests r
      where r.requester_id = me and r.project_id = p.id and r.created_at > now() - interval '7 days') >= 3 then
    raise exception 'You''ve already asked to join this project several times this week.'
      using errcode = 'check_violation', hint = 'Ask one of its owners directly.';
  end if;

  insert into public.project_access_requests (project_id, requester_id)
  values (p.id, me)
  returning * into req;

  select * into requester from public.profiles x where x.id = me;
  who := coalesce(nullif(btrim(requester.full_name), ''), requester.email);
  -- Owners and Admins of the project who can still sign in, each told once (Inbox; their notification
  -- settings decide email, like any notification). Before Automations V3's tail the old target CHECK
  -- refuses project items; the request is kept and they see it in Share.
  for recipient in
    select m.profile_id
    from public.project_members m
    where m.project_id = p.id and m.deleted_at is null and m.role in ('owner', 'admin')
      and public.profile_is_allowlisted(m.profile_id)
  loop
    begin
      insert into public.inbox_items (recipient_id, actor_id, task_id, project_id, kind, data)
      values (
        recipient.profile_id, me, null, p.id, 'rule',
        jsonb_build_object(
          'access_request', true,
          'access_request_id', req.id,
          'access_request_status', 'pending',
          'requester_id', me,
          'requester_name', who,
          'requester_email', requester.email,
          'project_id', p.id,
          'project_name', p.name,
          'message', who || ' asked to be added to this project'
        )
      );
    exception when check_violation then
      null;
    end;
  end loop;
  return 'requested';
end;
$$;

revoke all on function public.request_project_access(uuid) from public, anon;
grant execute on function public.request_project_access(uuid) to authenticated;

-- Approve (with a role, "default" = the person's own default) or decline. Admin+ of the project by the
-- caller's own role; approving goes through add_project_member, which checks everything again.
create or replace function public.decide_project_access_request(
  target_request uuid,
  decision text,
  member_role text default 'default'
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  req public.project_access_requests;
  requester public.profiles;
  p public.projects;
  granted text;
  me_name text;
begin
  if decision not in ('approve', 'decline') then
    raise exception 'Approve or decline the request' using errcode = 'check_violation';
  end if;
  if coalesce(member_role, 'default') not in ('default', 'editor', 'commenter', 'viewer') then
    raise exception 'Choose Editor, Commenter, Viewer, or their default role' using errcode = 'check_violation';
  end if;
  select * into req from public.project_access_requests r where r.id = target_request for update;
  if not found or me is null or not public.has_project_role(req.project_id, 'admin') then
    raise exception 'Request not found' using errcode = 'no_data_found';
  end if;
  if req.status <> 'pending' then
    return req.status;
  end if;
  select * into p from public.projects x where x.id = req.project_id;
  select * into requester from public.profiles x where x.id = req.requester_id;

  if decision = 'approve' then
    if public.profile_project_role(req.requester_id, req.project_id) is null then
      perform public.add_project_member(req.project_id, requester.email, coalesce(member_role, 'default'));
    end if;
    granted := public.profile_project_role(req.requester_id, req.project_id);
    -- add_project_member may have closed it already (the project_members trigger below).
    update public.project_access_requests r
    set status = 'approved', granted_role = coalesce(r.granted_role, granted), decided_by = coalesce(r.decided_by, me),
        decided_at = coalesce(r.decided_at, now())
    where r.id = req.id;
    select coalesce(nullif(btrim(x.full_name), ''), x.email) into me_name from public.profiles x where x.id = me;
    -- The requester can open the project now: tell them.
    begin
      insert into public.inbox_items (recipient_id, actor_id, task_id, project_id, kind, data)
      values (
        req.requester_id, me, null, req.project_id, 'rule',
        jsonb_build_object(
          'access_granted', true,
          'access_request_id', req.id,
          'granted_role', granted,
          'project_id', p.id,
          'project_name', p.name,
          'message', coalesce(me_name, 'An owner') || ' added you to this project'
        )
      );
    exception when check_violation then
      null;
    end;
  else
    update public.project_access_requests r
    set status = 'declined', decided_by = me, decided_at = now()
    where r.id = req.id;
  end if;
  perform public.mark_access_request_items(req.id);
  return (select r.status from public.project_access_requests r where r.id = req.id);
end;
$$;

revoke all on function public.decide_project_access_request(uuid, text, text) from public, anon;
grant execute on function public.decide_project_access_request(uuid, text, text) to authenticated;

-- Joining a project any other way (an invite, a team, Join) closes that person's open request.
create or replace function public.on_project_member_close_access_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  closed uuid;
begin
  if new.deleted_at is not null then
    return new;
  end if;
  update public.project_access_requests r
  set status = 'approved', granted_role = new.role, decided_by = coalesce(new.created_by, auth.uid()), decided_at = now()
  where r.project_id = new.project_id and r.requester_id = new.profile_id and r.status = 'pending'
  returning r.id into closed;
  if closed is not null then
    perform public.mark_access_request_items(closed);
  end if;
  return new;
end;
$$;

revoke all on function public.on_project_member_close_access_request() from public, anon, authenticated;

create trigger project_members_after_insert_close_access_request
  after insert on public.project_members
  for each row execute function public.on_project_member_close_access_request();

-- ---------------------------------------------------------------------------
-- 4. The workspace's Tags switch
-- ---------------------------------------------------------------------------

alter table public.workspaces add column if not exists tags_enabled boolean not null default false;
-- workspaces_update_admin (workspace admins only) decides who; this column is theirs to change too.
grant update (tags_enabled) on public.workspaces to authenticated;

comment on column public.workspaces.tags_enabled is
  'Oct 26 notes (batch 3): whether the app shows tags (off by default). Off hides them everywhere; the '
  'tags, their task links, and rules / views that use them are kept.';

-- Search matches a tag's name only while the tag's workspace uses tags.
select public.alhc_patch_function('public.search_tasks(text, integer)'::regprocedure,
$p$        join public.tags g on g.id = tt.tag_id and g.deleted_at is null
        where tt.task_id = t.id$p$,
$p$        join public.tags g on g.id = tt.tag_id and g.deleted_at is null
        join public.workspaces tw on tw.id = g.workspace_id and tw.tags_enabled
        where tt.task_id = t.id$p$);
