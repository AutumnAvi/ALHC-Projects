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
-- 5. Personal sidebar folders: each person groups their sidebar projects into folders they name,
--    collapse, reorder, and remove (sidebar_folders, sidebar_folder_projects). Own rows only — nobody
--    else, workspace admins included, sees or changes them. Putting a project in a folder needs Viewer+
--    (like starring). Removing a folder puts its projects back under Projects.
--
-- 6. Images in emailed replies: the inbound route now reads Resend's attachments list (app code); the
--    database learns one more reason a reply's file wasn't saved, "blocked_type" (programs, scripts, web
--    pages, SVG are never saved from an email): note_reply_skipped_files, asserted patch.
--
-- 7. Review checks: an Editor sends a task's files to someone (by default the form's submitter) for
--    review. They get an email with Approve / Leave feedback; a public page (no sign-in) shows the files
--    in full quality, takes pinned comments (a point on an image or PDF page, a moment in a video), takes
--    files back, and posts the outcome on the task as a comment (with the pins summarized), tells the
--    assignee, and fires the task's "approval decided" rules (and "comment added", like any comment).
--      * review_checks (one row per round: v1, v2, …; a new round supersedes an open one), with
--        review_check_assets (the task's attachments picked), review_check_pins, review_check_files (the
--        reviewer's uploads, stored in the task's folder). Task Viewers+ read them (RLS); nobody writes
--        them directly.
--      * Tokens: alhc_rev_ + 64 hex, generated here, handed back once (the email link), stored only as a
--        sha256 hash; 30 days, then dead; a new link (Send again) replaces the old one.
--      * Editors: create_review_check, rotate_review_check_token, cancel_review_check (definer, Editor+
--        on the task by the caller's own role; pinned in suite 60).
--      * The public page (anon, token only; pinned in suites 50, 60, zz06, zz07): review_check_view,
--        review_check_file, review_check_upload_start, review_check_upload_finish, review_check_decide.
--        Each checks the token's hash and expiry, and counts toward 600 requests an hour per link; uploads
--        take at most 20 files / 500 MB a round, 25 MB each, never programs, scripts, web pages, or SVG.
--      * comments.review_check_id marks the outcome comment (clients can't set it).
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

-- ---------------------------------------------------------------------------
-- 5. Personal sidebar folders
-- ---------------------------------------------------------------------------

create table if not exists public.sidebar_folders (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null default auth.uid() references public.profiles (id),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  sort_order double precision not null default 0,
  collapsed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists sidebar_folders_profile_idx on public.sidebar_folders (profile_id) where deleted_at is null;

-- One row per person and project; folder_id null = not in a folder (rows move, they aren't removed).
create table if not exists public.sidebar_folder_projects (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null default auth.uid() references public.profiles (id),
  folder_id uuid references public.sidebar_folders (id),
  project_id uuid not null references public.projects (id),
  sort_order double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, project_id)
);

create index if not exists sidebar_folder_projects_folder_idx on public.sidebar_folder_projects (folder_id) where folder_id is not null;
create index if not exists sidebar_folder_projects_project_idx on public.sidebar_folder_projects (project_id);

alter table public.sidebar_folders enable row level security;
alter table public.sidebar_folder_projects enable row level security;
revoke all on public.sidebar_folders from anon, authenticated;
revoke all on public.sidebar_folder_projects from anon, authenticated;
select public.alhc_revoke_anon_grants(array['sidebar_folders', 'sidebar_folder_projects']);
select public.alhc_revoke_client_truncate(array['sidebar_folders', 'sidebar_folder_projects']);
grant select on public.sidebar_folders to authenticated;
grant insert (name, sort_order, collapsed) on public.sidebar_folders to authenticated;
grant update (name, sort_order, collapsed, deleted_at) on public.sidebar_folders to authenticated;
grant select on public.sidebar_folder_projects to authenticated;
grant insert (folder_id, project_id, sort_order) on public.sidebar_folder_projects to authenticated;
grant update (folder_id, sort_order) on public.sidebar_folder_projects to authenticated;

comment on table public.sidebar_folders is
  'Oct 26 notes (batch 3): a person''s own sidebar folders. Own rows only (RLS); never shared.';
comment on table public.sidebar_folder_projects is
  'Oct 26 notes (batch 3): which of a person''s sidebar folders a project sits in (folder_id null = none). '
  'Own rows only; adding a project needs Viewer+ on it.';

create policy sidebar_folders_select_own on public.sidebar_folders
  for select to authenticated
  using (profile_id = (select auth.uid()) and (select public.is_allowlisted()));
create policy sidebar_folders_insert_own on public.sidebar_folders
  for insert to authenticated
  with check (profile_id = (select auth.uid()) and (select public.is_allowlisted()));
create policy sidebar_folders_update_own on public.sidebar_folders
  for update to authenticated
  using (profile_id = (select auth.uid()) and (select public.is_allowlisted()))
  with check (profile_id = (select auth.uid()));

create policy sidebar_folder_projects_select_own on public.sidebar_folder_projects
  for select to authenticated
  using (profile_id = (select auth.uid()) and (select public.is_allowlisted()));
create policy sidebar_folder_projects_insert_own_viewer on public.sidebar_folder_projects
  for insert to authenticated
  with check (
    profile_id = (select auth.uid())
    and (select public.is_allowlisted())
    and (select public.has_project_role(project_id, 'viewer'))
  );
create policy sidebar_folder_projects_update_own on public.sidebar_folder_projects
  for update to authenticated
  using (profile_id = (select auth.uid()) and (select public.is_allowlisted()))
  with check (profile_id = (select auth.uid()));

-- Folders: the owner is the caller, at most 50 live ones, a removed folder stays removed (and its
-- projects go back under Projects), names are trimmed.
create or replace function public.guard_sidebar_folder()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.name := btrim(new.name);
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.profile_id := auth.uid();
    end if;
    new.created_at := now();
    new.deleted_at := null;
    if (select count(*) from public.sidebar_folders f where f.profile_id = new.profile_id and f.deleted_at is null) >= 50 then
      raise exception 'You can have up to 50 sidebar folders' using errcode = 'check_violation';
    end if;
  else
    if new.profile_id is distinct from old.profile_id or new.created_at is distinct from old.created_at then
      raise exception 'A folder can''t be moved to someone else' using errcode = 'insufficient_privilege';
    end if;
    if old.deleted_at is not null then
      raise exception 'This folder was removed' using errcode = 'check_violation';
    end if;
    if new.deleted_at is not null then
      new.deleted_at := now();
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

select public.alhc_revoke_anon_execute(array['guard_sidebar_folder()']);
grant execute on function public.guard_sidebar_folder() to authenticated;

create trigger sidebar_folders_05_guard
  before insert or update on public.sidebar_folders
  for each row execute function public.guard_sidebar_folder();

-- A removed folder's projects go back under Projects (own rows, so invoker is enough).
create or replace function public.on_sidebar_folder_removed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    update public.sidebar_folder_projects fp set folder_id = null
    where fp.folder_id = new.id and fp.profile_id = new.profile_id;
  end if;
  return new;
end;
$$;

select public.alhc_revoke_anon_execute(array['on_sidebar_folder_removed()']);
grant execute on function public.on_sidebar_folder_removed() to authenticated;

create trigger sidebar_folders_after_removed
  after update of deleted_at on public.sidebar_folders
  for each row execute function public.on_sidebar_folder_removed();

-- Placements: the owner is the caller and never changes, the project never changes, and a folder must
-- be the owner's own live folder (so nobody files into someone else's folder, even knowing its id).
create or replace function public.guard_sidebar_folder_project()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.profile_id := auth.uid();
    end if;
    new.created_at := now();
  elsif new.profile_id is distinct from old.profile_id or new.project_id is distinct from old.project_id
        or new.created_at is distinct from old.created_at then
    raise exception 'A sidebar placement can''t be moved to someone else' using errcode = 'insufficient_privilege';
  end if;
  if new.folder_id is not null and not exists (
    select 1 from public.sidebar_folders f
    where f.id = new.folder_id and f.profile_id = new.profile_id and f.deleted_at is null
  ) then
    raise exception 'Folder not found' using errcode = 'no_data_found';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

select public.alhc_revoke_anon_execute(array['guard_sidebar_folder_project()']);
grant execute on function public.guard_sidebar_folder_project() to authenticated;

create trigger sidebar_folder_projects_05_guard
  before insert or update on public.sidebar_folder_projects
  for each row execute function public.guard_sidebar_folder_project();

-- ---------------------------------------------------------------------------
-- 6. Reply attachments: files of a blocked type are noted, not saved
-- ---------------------------------------------------------------------------

select public.alhc_patch_function('public.note_reply_skipped_files(uuid, jsonb)'::regprocedure,
$p$when f ->> 'reason' in ('too_large', 'too_many', 'failed') then$p$,
$p$when f ->> 'reason' in ('too_large', 'too_many', 'failed', 'blocked_type') then$p$);

-- ---------------------------------------------------------------------------
-- 7. Review checks
-- ---------------------------------------------------------------------------

create table if not exists public.review_checks (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id),
  round integer not null check (round between 1 and 999),
  recipient_email text not null check (char_length(recipient_email) <= 320 and recipient_email ~ '^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$'),
  recipient_name text check (recipient_name is null or char_length(recipient_name) between 1 and 200),
  message text check (message is null or char_length(message) <= 2000),
  token_hash text not null unique,
  token_hint text not null,
  expires_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'changes_requested', 'superseded', 'cancelled')),
  decided_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 5000),
  comment_id uuid references public.comments (id),
  hits integer not null default 0,
  hits_window_started_at timestamptz,
  last_viewed_at timestamptz,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (task_id, round)
);

create index if not exists review_checks_created_by_idx on public.review_checks (created_by);
create index if not exists review_checks_comment_idx on public.review_checks (comment_id) where comment_id is not null;

create table if not exists public.review_check_assets (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.review_checks (id),
  task_id uuid not null references public.tasks (id),
  attachment_id uuid not null references public.task_attachments (id),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (review_id, attachment_id)
);

create index if not exists review_check_assets_task_idx on public.review_check_assets (task_id);
create index if not exists review_check_assets_attachment_idx on public.review_check_assets (attachment_id);

create table if not exists public.review_check_pins (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.review_checks (id),
  task_id uuid not null references public.tasks (id),
  asset_id uuid not null references public.review_check_assets (id),
  number integer not null check (number between 1 and 500),
  page integer check (page is null or page between 1 and 5000),
  x double precision check (x is null or (x >= 0 and x <= 1)),
  y double precision check (y is null or (y >= 0 and y <= 1)),
  time_seconds double precision check (time_seconds is null or (time_seconds >= 0 and time_seconds <= 86400)),
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  check ((x is null) = (y is null)),
  check (x is not null or time_seconds is not null),
  unique (review_id, number)
);

create index if not exists review_check_pins_task_idx on public.review_check_pins (task_id);
create index if not exists review_check_pins_asset_idx on public.review_check_pins (asset_id);

create table if not exists public.review_check_files (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.review_checks (id),
  task_id uuid not null references public.tasks (id),
  storage_path text not null unique,
  file_name text not null check (char_length(file_name) between 1 and 255),
  content_type text check (content_type is null or char_length(content_type) <= 255),
  size_bytes bigint check (size_bytes is null or (size_bytes >= 0 and size_bytes <= 26214400)),
  status text not null default 'pending' check (status in ('pending', 'ready')),
  created_at timestamptz not null default now(),
  ready_at timestamptz
);

create index if not exists review_check_files_review_idx on public.review_check_files (review_id);
create index if not exists review_check_files_task_idx on public.review_check_files (task_id);

alter table public.comments add column if not exists review_check_id uuid references public.review_checks (id);
create index if not exists comments_review_check_idx on public.comments (review_check_id) where review_check_id is not null;

comment on table public.review_checks is
  'Oct 26 notes (batch 3): a review check (one round of a task''s files sent to someone outside for '
  'approval or feedback). Task Viewers+ read; written only by the review functions. The link''s token is '
  'only ever a hash here (token_hash is not readable by clients).';
comment on column public.comments.review_check_id is
  'Oct 26 notes (batch 3): the review check whose outcome this comment reports (set only by '
  'review_check_decide).';

alter table public.review_checks enable row level security;
alter table public.review_check_assets enable row level security;
alter table public.review_check_pins enable row level security;
alter table public.review_check_files enable row level security;
revoke all on public.review_checks from anon, authenticated;
revoke all on public.review_check_assets from anon, authenticated;
revoke all on public.review_check_pins from anon, authenticated;
revoke all on public.review_check_files from anon, authenticated;
select public.alhc_revoke_anon_grants(array['review_checks', 'review_check_assets', 'review_check_pins', 'review_check_files']);
select public.alhc_revoke_client_truncate(array['review_checks', 'review_check_assets', 'review_check_pins', 'review_check_files']);
grant select (
  id, task_id, round, recipient_email, recipient_name, message, token_hint, expires_at, status, decided_at,
  decision_note, comment_id, last_viewed_at, created_by, created_at, updated_at
) on public.review_checks to authenticated;
grant select on public.review_check_assets to authenticated;
grant select on public.review_check_pins to authenticated;
grant select on public.review_check_files to authenticated;

create policy review_checks_select_viewer on public.review_checks
  for select to authenticated using ((select public.has_task_role(task_id, 'viewer')));
create policy review_check_assets_select_viewer on public.review_check_assets
  for select to authenticated using ((select public.has_task_role(task_id, 'viewer')));
create policy review_check_pins_select_viewer on public.review_check_pins
  for select to authenticated using ((select public.has_task_role(task_id, 'viewer')));
create policy review_check_files_select_viewer on public.review_check_files
  for select to authenticated using (status = 'ready' and (select public.has_task_role(task_id, 'viewer')));

-- Clients never set or change comments.review_check_id (the review functions run as the owner).
create or replace function public.guard_comment_review_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_client_role() and (
    (tg_op = 'INSERT' and new.review_check_id is not null)
    or (tg_op = 'UPDATE' and new.review_check_id is distinct from old.review_check_id)
  ) then
    raise exception 'A review''s comment is written by the review itself' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

select public.alhc_revoke_anon_execute(array['guard_comment_review_check()']);
grant execute on function public.guard_comment_review_check() to authenticated;

create trigger comments_04c_guard_review_check
  before insert or update on public.comments
  for each row execute function public.guard_comment_review_check();

-- Files a reviewer can't send back (and an email never saves): programs, scripts, installers, shortcuts,
-- web pages, SVG. Mirrors unsafeReceivedFile() in src/lib/reply-attachments.ts.
create or replace function public.review_file_name_ok(file_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(lower(substring(btrim(file_name) from '\.([A-Za-z0-9]{1,10})$')), '') not in (
    'exe', 'msi', 'msp', 'dll', 'com', 'scr', 'pif', 'cpl', 'bat', 'cmd', 'vb', 'vbs', 'vbe', 'js', 'jse', 'mjs',
    'wsf', 'wsh', 'hta', 'ps1', 'psm1', 'psd1', 'sh', 'bash', 'zsh', 'csh', 'ksh', 'command', 'jar', 'apk', 'app',
    'dmg', 'pkg', 'deb', 'rpm', 'iso', 'img', 'vhd', 'lnk', 'url', 'reg', 'inf', 'scf', 'msc', 'gadget', 'html',
    'htm', 'xhtml', 'shtml', 'mht', 'mhtml', 'svg', 'svgz', 'php', 'py', 'pl', 'rb', 'appx', 'msix', 'xll', 'chm'
  );
$$;

revoke all on function public.review_file_name_ok(text) from public, anon, authenticated;

create or replace function public.review_check_token_ok(review_token text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(review_token ~ '^alhc_rev_[0-9a-f]{64}$', false);
$$;

revoke all on function public.review_check_token_ok(text) from public, anon, authenticated;

-- The review behind a link, or nothing (a malformed or unknown token, or one that was replaced).
create or replace function public.review_check_by_token(review_token text)
returns public.review_checks
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.review_checks;
begin
  if not public.review_check_token_ok(review_token) then
    return null;
  end if;
  select * into r from public.review_checks x where x.token_hash = public.inbound_token_hash(review_token);
  return r;
end;
$$;

revoke all on function public.review_check_by_token(text) from public, anon, authenticated;

-- One public request against a link: false past 600 an hour.
create or replace function public.review_check_hit(target_review uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  update public.review_checks r
  set hits = case when r.hits_window_started_at is null or r.hits_window_started_at < now() - interval '1 hour' then 1 else r.hits + 1 end,
      hits_window_started_at = case
        when r.hits_window_started_at is null or r.hits_window_started_at < now() - interval '1 hour' then now()
        else r.hits_window_started_at end,
      last_viewed_at = now()
  where r.id = target_review
  returning r.hits into n;
  return coalesce(n, 0) <= 600;
end;
$$;

revoke all on function public.review_check_hit(uuid) from public, anon, authenticated;

-- Why a link can't be used: null = fine. Unknown and expired links (and a task that's gone) say nothing
-- more; a decided, replaced, or withdrawn round can still be looked at but not changed.
create or replace function public.review_check_gate(r public.review_checks)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if r.id is null then
    return 'unknown';
  end if;
  if r.expires_at <= now() then
    return 'expired';
  end if;
  if not exists (select 1 from public.tasks t where t.id = r.task_id and t.deleted_at is null) then
    return 'unknown';
  end if;
  if not public.review_check_hit(r.id) then
    return 'rate_limited';
  end if;
  return null;
end;
$$;

revoke all on function public.review_check_gate(public.review_checks) from public, anon, authenticated;

-- An Editor sends a round: the task's attachments to show, who reviews, an optional message. Returns the
-- round and its link's token (once; the app emails it and forgets it). An open earlier round is
-- superseded. At most 30 rounds a day per task and 50 an hour per sender.
create or replace function public.create_review_check(
  target_task uuid,
  attachment_ids uuid[],
  recipient text,
  recipient_display text default null,
  review_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  t public.tasks;
  address text := lower(btrim(coalesce(recipient, '')));
  picked uuid[];
  next_round integer;
  token text;
  r public.review_checks;
begin
  if me is null or not public.is_allowlisted() then
    raise exception 'Sign in first' using errcode = 'insufficient_privilege';
  end if;
  select * into t from public.tasks x where x.id = target_task and x.deleted_at is null;
  if not found or not public.has_task_role(t.id, 'viewer') then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if not public.has_task_role(t.id, 'editor') then
    raise exception 'Only editors can send a review check' using errcode = 'insufficient_privilege';
  end if;
  if not public.is_email(address) or address ~ '[<>",;\s]' then
    raise exception 'Enter the reviewer''s email address' using errcode = 'check_violation';
  end if;
  select array_agg(distinct a) into picked from unnest(coalesce(attachment_ids, '{}'::uuid[])) a where a is not null;
  if coalesce(array_length(picked, 1), 0) = 0 then
    raise exception 'Pick at least one file to review' using errcode = 'check_violation';
  end if;
  if array_length(picked, 1) > 20 then
    raise exception 'Pick at most 20 files' using errcode = 'check_violation';
  end if;
  if (select count(*) from public.task_attachments a
      where a.id = any(picked) and a.task_id = t.id and a.deleted_at is null) <> array_length(picked, 1) then
    raise exception 'Pick files attached to this task' using errcode = 'check_violation';
  end if;

  perform pg_advisory_xact_lock(hashtext('alhc_review_check:' || t.id::text));
  if (select count(*) from public.review_checks x where x.task_id = t.id and x.created_at > now() - interval '1 day') >= 30
     or (select count(*) from public.review_checks x where x.created_by = me and x.created_at > now() - interval '1 hour') >= 50 then
    raise exception 'Too many review checks just now. Try again later.' using errcode = 'check_violation';
  end if;
  select coalesce(max(x.round), 0) + 1 into next_round from public.review_checks x where x.task_id = t.id;
  if next_round > 999 then
    raise exception 'This task has had too many review rounds' using errcode = 'check_violation';
  end if;

  update public.review_checks x set status = 'superseded', updated_at = now()
  where x.task_id = t.id and x.status = 'pending';

  token := 'alhc_rev_' || public.inbound_random_hex();
  insert into public.review_checks (
    task_id, round, recipient_email, recipient_name, message, token_hash, token_hint, expires_at, created_by
  ) values (
    t.id, next_round, address, nullif(left(btrim(coalesce(recipient_display, '')), 200), ''),
    nullif(left(btrim(coalesce(review_message, '')), 2000), ''), public.inbound_token_hash(token),
    '…' || right(token, 4), now() + interval '30 days', me
  )
  returning * into r;

  insert into public.review_check_assets (review_id, task_id, attachment_id, sort_order)
  select r.id, t.id, a.id, coalesce(array_position(attachment_ids, a.id), 0)
  from public.task_attachments a
  where a.id = any(picked);

  return jsonb_build_object('id', r.id, 'round', r.round, 'token', token, 'expires_at', r.expires_at);
end;
$$;

revoke all on function public.create_review_check(uuid, uuid[], text, text, text) from public, anon;
grant execute on function public.create_review_check(uuid, uuid[], text, text, text) to authenticated;

-- "Send again": a new link for an open round (the old one stops working), good for 30 more days.
create or replace function public.rotate_review_check_token(target_review uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.review_checks;
  token text;
begin
  select * into r from public.review_checks x where x.id = target_review for update;
  if not found or not public.has_task_role(r.task_id, 'viewer') then
    raise exception 'Review check not found' using errcode = 'no_data_found';
  end if;
  if not public.has_task_role(r.task_id, 'editor') then
    raise exception 'Only editors can send a review check' using errcode = 'insufficient_privilege';
  end if;
  if r.status <> 'pending' then
    raise exception 'This review check is closed' using errcode = 'check_violation';
  end if;
  token := 'alhc_rev_' || public.inbound_random_hex();
  update public.review_checks x
  set token_hash = public.inbound_token_hash(token), token_hint = '…' || right(token, 4),
      expires_at = now() + interval '30 days', hits = 0, hits_window_started_at = null, updated_at = now()
  where x.id = r.id;
  return jsonb_build_object('id', r.id, 'round', r.round, 'token', token, 'expires_at', now() + interval '30 days');
end;
$$;

revoke all on function public.rotate_review_check_token(uuid) from public, anon;
grant execute on function public.rotate_review_check_token(uuid) to authenticated;

-- "Withdraw": an open round can't be answered any more (the link shows that it was withdrawn).
create or replace function public.cancel_review_check(target_review uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.review_checks;
begin
  select * into r from public.review_checks x where x.id = target_review for update;
  if not found or not public.has_task_role(r.task_id, 'viewer') then
    raise exception 'Review check not found' using errcode = 'no_data_found';
  end if;
  if not public.has_task_role(r.task_id, 'editor') then
    raise exception 'Only editors can withdraw a review check' using errcode = 'insufficient_privilege';
  end if;
  if r.status = 'pending' then
    update public.review_checks x set status = 'cancelled', updated_at = now() where x.id = r.id;
    return 'cancelled';
  end if;
  return r.status;
end;
$$;

revoke all on function public.cancel_review_check(uuid) from public, anon;
grant execute on function public.cancel_review_check(uuid) to authenticated;

-- The public review page's data: the round, who asked, the files (ids of this round's assets and the
-- reviewer's finished uploads), and the pins. Nothing else about the task or the project.
create or replace function public.review_check_view(review_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.review_checks := public.review_check_by_token(review_token);
  gate text := public.review_check_gate(r);
  t public.tasks;
  sender text;
  project_name text;
  ws public.workspaces;
begin
  if gate is not null then
    return jsonb_build_object('status', gate);
  end if;
  select * into t from public.tasks x where x.id = r.task_id;
  select coalesce(nullif(btrim(p.full_name), ''), p.email) into sender from public.profiles p where p.id = r.created_by;
  select p.name into project_name from public.projects p
  where p.id = coalesce((select root.home_project_id from public.tasks root where root.id = coalesce(t.root_task_id, t.id)), t.home_project_id);
  select * into ws from public.workspaces w where w.id = t.workspace_id;
  return jsonb_build_object(
    'status', 'ok',
    'review', jsonb_build_object(
      'id', r.id, 'round', r.round, 'status', r.status, 'recipient_name', r.recipient_name,
      'recipient_email', r.recipient_email, 'message', r.message, 'sender_name', sender,
      'task_title', t.title, 'project_name', project_name, 'workspace_name', ws.name,
      'workspace_logo_path', ws.logo_path, 'expires_at', r.expires_at, 'decided_at', r.decided_at,
      'decision_note', r.decision_note, 'created_at', r.created_at
    ),
    'assets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'name', ta.file_name, 'content_type', ta.content_type, 'size', ta.size_bytes
      ) order by a.sort_order, a.created_at)
      from public.review_check_assets a
      join public.task_attachments ta on ta.id = a.attachment_id and ta.deleted_at is null
      where a.review_id = r.id
    ), '[]'::jsonb),
    'pins', coalesce((
      select jsonb_agg(jsonb_build_object(
        'number', p.number, 'asset_id', p.asset_id, 'page', p.page, 'x', p.x, 'y', p.y,
        'time', p.time_seconds, 'body', p.body
      ) order by p.number)
      from public.review_check_pins p where p.review_id = r.id
    ), '[]'::jsonb),
    'files', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', f.id, 'name', f.file_name, 'content_type', f.content_type, 'size', f.size_bytes
      ) order by f.created_at)
      from public.review_check_files f where f.review_id = r.id and f.status = 'ready'
    ), '[]'::jsonb)
  );
end;
$$;

-- One file of a round (one of its assets, or a finished upload): where it's stored, for the page's file
-- route to sign a short-lived link to exactly that object.
create or replace function public.review_check_file(review_token text, target_file uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.review_checks := public.review_check_by_token(review_token);
  gate text := public.review_check_gate(r);
  found_file record;
begin
  if gate is not null then
    return jsonb_build_object('status', gate);
  end if;
  select ta.storage_path as path, ta.file_name as name, ta.content_type into found_file
  from public.review_check_assets a
  join public.task_attachments ta on ta.id = a.attachment_id and ta.deleted_at is null
  where a.review_id = r.id and a.id = target_file;
  if not found then
    select f.storage_path as path, f.file_name as name, f.content_type into found_file
    from public.review_check_files f
    where f.review_id = r.id and f.id = target_file and f.status = 'ready';
  end if;
  if found_file.path is null then
    return jsonb_build_object('status', 'unknown');
  end if;
  return jsonb_build_object('status', 'ok', 'path', found_file.path, 'name', found_file.name, 'content_type', found_file.content_type);
end;
$$;

-- The reviewer sends a file back: a place for it in the task's folder (the app hands the browser a
-- one-time upload link for exactly that path). Only while the round is open.
create or replace function public.review_check_upload_start(
  review_token text,
  file_name text,
  file_type text,
  file_size bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.review_checks := public.review_check_by_token(review_token);
  gate text := public.review_check_gate(r);
  clean text := left(btrim(coalesce(file_name, '')), 255);
  safe text;
  path text;
  f public.review_check_files;
begin
  if gate is not null then
    return jsonb_build_object('status', gate);
  end if;
  if r.status <> 'pending' then
    return jsonb_build_object('status', 'closed');
  end if;
  if clean = '' then
    return jsonb_build_object('status', 'invalid');
  end if;
  if not public.review_file_name_ok(clean)
     or lower(coalesce(file_type, '')) ~ '^(text/html|image/svg\+xml|application/(x-msdownload|x-msdos-program|x-dosexec|x-executable|x-sh|javascript|x-javascript|hta|java-archive))' then
    return jsonb_build_object('status', 'blocked_type');
  end if;
  if file_size is null or file_size <= 0 then
    return jsonb_build_object('status', 'invalid');
  end if;
  if file_size > 26214400 then
    return jsonb_build_object('status', 'too_large');
  end if;
  if (select count(*) from public.review_check_files x where x.review_id = r.id) >= 20
     or (select coalesce(sum(coalesce(x.size_bytes, 26214400)), 0) from public.review_check_files x where x.review_id = r.id) + file_size > 524288000 then
    return jsonb_build_object('status', 'too_many');
  end if;
  safe := right(regexp_replace(clean, '[^A-Za-z0-9._-]+', '_', 'g'), 100);
  path := r.task_id::text || '/' || gen_random_uuid()::text || '-review-' || coalesce(nullif(safe, ''), 'file');
  insert into public.review_check_files (review_id, task_id, storage_path, file_name, content_type, size_bytes)
  values (r.id, r.task_id, path, clean, nullif(left(lower(btrim(coalesce(file_type, ''))), 255), ''), file_size)
  returning * into f;
  return jsonb_build_object('status', 'ok', 'file_id', f.id, 'path', f.storage_path);
end;
$$;

-- The upload arrived: the file is now part of the round (and readable by the task's Viewers+). Its size
-- and type come from Storage, not from the browser.
create or replace function public.review_check_upload_finish(review_token text, target_file uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.review_checks := public.review_check_by_token(review_token);
  gate text := public.review_check_gate(r);
  f public.review_check_files;
  stored record;
  stored_size bigint;
begin
  if gate is not null then
    return jsonb_build_object('status', gate);
  end if;
  select * into f from public.review_check_files x where x.id = target_file and x.review_id = r.id for update;
  if not found then
    return jsonb_build_object('status', 'unknown');
  end if;
  if f.status = 'ready' then
    return jsonb_build_object('status', 'ok', 'file', jsonb_build_object('id', f.id, 'name', f.file_name, 'content_type', f.content_type, 'size', f.size_bytes));
  end if;
  select o.metadata into stored from storage.objects o where o.bucket_id = 'task-attachments' and o.name = f.storage_path;
  if not found then
    return jsonb_build_object('status', 'missing', 'path', f.storage_path);
  end if;
  stored_size := case when coalesce(stored.metadata ->> 'size', '') ~ '^[0-9]{1,12}$' then (stored.metadata ->> 'size')::bigint else f.size_bytes end;
  if stored_size > 26214400 then
    return jsonb_build_object('status', 'too_large', 'path', f.storage_path);
  end if;
  update public.review_check_files x
  set status = 'ready', ready_at = now(), size_bytes = stored_size,
      content_type = coalesce(nullif(left(lower(btrim(coalesce(stored.metadata ->> 'mimetype', ''))), 255), ''), x.content_type)
  where x.id = f.id
  returning * into f;
  return jsonb_build_object('status', 'ok', 'file', jsonb_build_object('id', f.id, 'name', f.file_name, 'content_type', f.content_type, 'size', f.size_bytes));
end;
$$;

-- m:ss / h:mm:ss for a video pin.
create or replace function public.review_time_label(seconds double precision)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when seconds >= 3600 then to_char(make_interval(secs => floor(seconds)), 'FMHH24:MI:SS')
    else (floor(seconds) / 60)::integer::text || ':' || lpad((floor(seconds)::integer % 60)::text, 2, '0')
  end;
$$;

revoke all on function public.review_time_label(double precision) from public, anon, authenticated;

-- Approve, or send feedback (a note and / or pins). Closes the round, posts the outcome on the task as a
-- comment from the reviewer's address (pins and files summarized), tells the assignee, and fires the
-- task's "approval decided" rules ("comment added" ones fire from the comment, as for any comment).
create or replace function public.review_check_decide(
  review_token text,
  decision text,
  note text default null,
  pins jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.review_checks := public.review_check_by_token(review_token);
  gate text;
  t public.tasks;
  clean_note text := nullif(left(btrim(coalesce(note, '')), 5000), '');
  pin jsonb;
  n integer := 0;
  asset_name text;
  lines text[] := '{}';
  where_text text;
  files_text text;
  body text;
  subject text;
  new_comment uuid;
  previous_sub text;
  assignee uuid;
begin
  -- Lock the round so a double click decides once.
  if r.id is not null then
    perform 1 from public.review_checks x where x.id = r.id for update;
    select * into r from public.review_checks x where x.id = r.id;
  end if;
  gate := public.review_check_gate(r);
  if gate is not null then
    return jsonb_build_object('status', gate);
  end if;
  if r.status <> 'pending' then
    return jsonb_build_object('status', 'closed', 'review_status', r.status);
  end if;
  if decision not in ('approved', 'changes_requested') then
    return jsonb_build_object('status', 'invalid');
  end if;
  if jsonb_typeof(coalesce(pins, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(pins, '[]'::jsonb)) > 200 then
    return jsonb_build_object('status', 'invalid');
  end if;
  if decision = 'changes_requested' and clean_note is null and jsonb_array_length(coalesce(pins, '[]'::jsonb)) = 0 then
    return jsonb_build_object('status', 'empty');
  end if;
  select * into t from public.tasks x where x.id = r.task_id;

  for pin in select value from jsonb_array_elements(coalesce(pins, '[]'::jsonb))
  loop
    if jsonb_typeof(pin) <> 'object' or coalesce(pin ->> 'asset_id', '') !~ '^[0-9a-f-]{36}$'
       or nullif(btrim(coalesce(pin ->> 'body', '')), '') is null then
      return jsonb_build_object('status', 'invalid');
    end if;
    select ta.file_name into asset_name
    from public.review_check_assets a
    join public.task_attachments ta on ta.id = a.attachment_id
    where a.id = (pin ->> 'asset_id')::uuid and a.review_id = r.id;
    if not found then
      return jsonb_build_object('status', 'invalid');
    end if;
    n := n + 1;
    begin
      insert into public.review_check_pins (review_id, task_id, asset_id, number, page, x, y, time_seconds, body)
      values (
        r.id, r.task_id, (pin ->> 'asset_id')::uuid, n,
        case when jsonb_typeof(pin -> 'page') = 'number' then (pin ->> 'page')::numeric::integer end,
        case when jsonb_typeof(pin -> 'x') = 'number' then (pin ->> 'x')::double precision end,
        case when jsonb_typeof(pin -> 'y') = 'number' then (pin ->> 'y')::double precision end,
        case when jsonb_typeof(pin -> 'time') = 'number' then (pin ->> 'time')::double precision end,
        left(btrim(pin ->> 'body'), 2000)
      );
    exception when check_violation or numeric_value_out_of_range or invalid_text_representation then
      return jsonb_build_object('status', 'invalid');
    end;
    where_text := asset_name
      || case when jsonb_typeof(pin -> 'page') = 'number' then ', page ' || (pin ->> 'page')::numeric::integer::text else '' end
      || case when jsonb_typeof(pin -> 'time') = 'number' then ' at ' || public.review_time_label((pin ->> 'time')::double precision) else '' end;
    lines := lines || (n::text || '. ' || where_text || ': ' || left(btrim(pin ->> 'body'), 2000));
  end loop;

  update public.review_checks x
  set status = decision, decided_at = now(), decision_note = clean_note, updated_at = now()
  where x.id = r.id;

  select string_agg(f.file_name, ', ' order by f.created_at) into files_text
  from public.review_check_files f where f.review_id = r.id and f.status = 'ready';
  subject := 'Review v' || r.round || ': ' || case when decision = 'approved' then 'Approved' else 'Changes requested' end;
  body := case when decision = 'approved' then 'Approved' else 'Requested changes' end
    || ' (review v' || r.round || ')'
    || coalesce(E'\n\n' || clean_note, '')
    || case when n > 0 then E'\n\nFeedback:\n' || array_to_string(lines, E'\n') else '' end
    || case when files_text is not null then E'\n\nFiles sent back: ' || files_text else '' end;

  -- Nobody is signed in: the comment and its Inbox items have no actor (like an emailed reply).
  previous_sub := current_setting('request.jwt.claim.sub', true);
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    insert into public.comments (task_id, author_id, body, email_direction, email_address, email_subject, review_check_id)
    values (r.task_id, null, left(body, 10000), 'received', r.recipient_email, subject, r.id)
    returning id into new_comment;
  exception when check_violation then
    -- Before Comments and reply by email's tail, a comment needs an author: the person who sent the check.
    insert into public.comments (task_id, author_id, body, review_check_id)
    values (r.task_id, r.created_by, left('Review from ' || r.recipient_email || E':\n' || body, 10000), r.id)
    returning id into new_comment;
  end;
  update public.review_checks x set comment_id = new_comment where x.id = r.id;

  assignee := t.assignee_id;
  if assignee is not null then
    perform public.notify_with(assignee, r.task_id, 'approval_decided', new_comment, jsonb_build_object(
      'review_check_id', r.id, 'round', r.round, 'status', decision, 'note', clean_note,
      'reviewer_email', r.recipient_email, 'pins', n
    ));
  end if;
  perform set_config('request.jwt.claim.sub', coalesce(previous_sub, ''), true);

  -- Rules skip subtasks, as for every approval.
  if t.parent_task_id is null then
    perform public.fire_rules('approval_decided', r.task_id, null, jsonb_build_object(
      'review_check_id', r.id, 'status', decision, 'note', clean_note, 'reviewer_email', r.recipient_email
    ));
  end if;
  return jsonb_build_object('status', 'ok', 'review_status', decision);
end;
$$;

revoke all on function public.review_check_view(text) from public;
revoke all on function public.review_check_file(text, uuid) from public;
revoke all on function public.review_check_upload_start(text, text, text, bigint) from public;
revoke all on function public.review_check_upload_finish(text, uuid) from public;
revoke all on function public.review_check_decide(text, text, text, jsonb) from public;
revoke all on function public.review_check_view(text) from authenticated;
revoke all on function public.review_check_file(text, uuid) from authenticated;
revoke all on function public.review_check_upload_start(text, text, text, bigint) from authenticated;
revoke all on function public.review_check_upload_finish(text, uuid) from authenticated;
revoke all on function public.review_check_decide(text, text, text, jsonb) from authenticated;
grant execute on function public.review_check_view(text) to anon;
grant execute on function public.review_check_file(text, uuid) to anon;
grant execute on function public.review_check_upload_start(text, text, text, bigint) to anon;
grant execute on function public.review_check_upload_finish(text, uuid) to anon;
grant execute on function public.review_check_decide(text, text, text, jsonb) to anon;
