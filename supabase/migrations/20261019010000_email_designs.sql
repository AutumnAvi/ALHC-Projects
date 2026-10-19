-- ALHC Projects — Email designs, reply-by-email follow-ups, roles, and importer attachments.
--
-- 1. Email designs (email_designs): two kinds of email, each with its own design — 'internal'
--    (no-reply notifications to workspace people) and 'requester' (emails to a form's submitter:
--    form confirmations, responses sent from the comment box, rule emails to the submitter). A
--    design is a logo, accent color, header text, intro message, sign-off / footer, and a button
--    label and color. Workspace admins set the workspace default of each kind; project admins set a
--    project override, and (requester only) a form override. Each setting resolves form → project →
--    workspace (resolve_email_design, invoker), and the drain asks email_design_context (service
--    role) which kind an outbox row is and which project / form it belongs to.
-- 2. Reply-by-email follow-ups: a submitter's emailed reply keeps its attachments (attach_reply_file,
--    service role; task_attachments.comment_id links them to the reply; files left out are noted in
--    comments.email_skipped_files); "Send response to submitter" works from subtasks of a form task
--    (the top-level task's submitter and thread); a reply thread can be closed and reopened
--    (submitter_reply_threads.closed_at; set_submitter_thread_closed / submitter_thread_status) —
--    replies to a closed thread are refused and logged ('thread_closed').
-- 3. Roles: sending a response to the submitter needs Editor or above (send_submitter_response and
--    the comment guard). workspaces.allow_commenter_role (off by default): while it's off nobody can
--    be given the Commenter role (add_project_member, update_project_member_role, pending invites);
--    existing Commenters keep their role. Workspace admins list them (list_commenter_members) and can
--    move them to Viewer or Editor in one click (convert_commenter_members); nothing changes on its
--    own.
-- 4. Asana importer: "Download attachments" copies each task's Asana attachment files into the
--    task-attachments bucket (task_attachments.import_external_id dedupes re-runs) through
--    import_attachment_targets / import_attachment_file (Admin+ of the run's project, import-muted).
--
-- New client SECURITY DEFINER functions (pinned in suite 60): set_submitter_thread_closed and
-- submitter_thread_status (Editor / Viewer of the task), list_commenter_members and
-- convert_commenter_members (workspace admins), import_attachment_targets and import_attachment_file
-- (Admin+ of the import run's project). attach_reply_file, note_reply_skipped_files, and
-- email_design_context are service_role only. Nothing for anon. fire_rules, notify_with,
-- notify_message, and add_story are untouched.
--
-- The storage.objects insert policy that lets project admins upload a project email logo is in
-- supabase/manual/20261019010000_email_logo_policy.sql (run by hand as the storage owner).
--
-- Additive: the release on main never reads the new table or columns; its drain keeps its built-in
-- look; its route posts replies without attachments.

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

-- =============================================================================================
-- 1. Email designs
-- =============================================================================================

create table public.email_designs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  kind text not null constraint email_designs_kind_check check (kind in ('internal', 'requester')),
  project_id uuid references public.projects (id),
  form_id uuid references public.forms (id),
  -- Null = inherit from the next scope; '' = explicitly empty (no logo, no header text, …).
  logo_path text constraint email_designs_logo_path_check check (
    logo_path is null or logo_path = ''
    or (char_length(logo_path) <= 300 and logo_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._/-]+$' and position('..' in logo_path) = 0)
  ),
  accent_color text constraint email_designs_accent_color_check check (accent_color is null or accent_color ~ '^#[0-9a-fA-F]{6}$'),
  header_text text constraint email_designs_header_text_check check (header_text is null or char_length(header_text) <= 200),
  intro_message text constraint email_designs_intro_message_check check (intro_message is null or char_length(intro_message) <= 2000),
  footer_text text constraint email_designs_footer_text_check check (footer_text is null or char_length(footer_text) <= 1000),
  button_label text constraint email_designs_button_label_check check (button_label is null or char_length(button_label) <= 60),
  button_color text constraint email_designs_button_color_check check (button_color is null or button_color ~ '^#[0-9a-fA-F]{6}$'),
  created_by uuid references public.profiles (id) default auth.uid(),
  updated_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint email_designs_scope_check check (form_id is null or (project_id is not null and kind = 'requester'))
);
alter table public.email_designs enable row level security;
revoke all on public.email_designs from public, anon, authenticated;

comment on table public.email_designs is
  'Email designs: one row per scope (workspace default, project, or — requester emails only — form) '
  'and kind (internal | requester). Null settings inherit; resolved form → project → workspace by '
  'resolve_email_design(). Workspace rows: workspace admins; project / form rows: project Admins+.';

create unique index email_designs_scope_idx on public.email_designs (
  workspace_id, kind,
  coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(form_id, '00000000-0000-0000-0000-000000000000'::uuid)
) where deleted_at is null;
create index email_designs_project_idx on public.email_designs (project_id);
create index email_designs_form_idx on public.email_designs (form_id);
create index email_designs_created_by_idx on public.email_designs (created_by);
create index email_designs_updated_by_idx on public.email_designs (updated_by);

create trigger email_designs_set_updated_at
  before update on public.email_designs
  for each row execute function public.set_updated_at();

-- Who may change a design of this scope: workspace admins for workspace defaults, the project's
-- Admins+ for project and form overrides (workspace admins get nothing extra there).
create or replace function public.can_edit_email_design(target_workspace uuid, target_project uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case
    when target_project is null then public.is_workspace_admin(target_workspace)
    else public.has_project_role(target_project, 'admin')
  end;
$$;

revoke all on function public.can_edit_email_design(uuid, uuid) from public, anon;
grant execute on function public.can_edit_email_design(uuid, uuid) to authenticated, service_role;

-- Invoker guard: forces the author, fills the workspace from the project, checks the form belongs to
-- the project, keeps the scope fixed, keeps a reset (removed) row removed, and keeps logos inside the
-- workspace's folder of the logo bucket.
create or replace function public.guard_email_design()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  ws uuid;
begin
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.created_by := auth.uid();
    end if;
    new.updated_by := auth.uid();
    new.deleted_at := null;
    if new.project_id is not null then
      select p.workspace_id into ws from public.projects p where p.id = new.project_id and p.deleted_at is null;
      if ws is null then
        raise exception 'Project not found' using errcode = 'no_data_found';
      end if;
      new.workspace_id := ws;
    end if;
    if new.form_id is not null and not exists (
      select 1 from public.forms f
      where f.id = new.form_id and f.project_id = new.project_id and f.deleted_at is null
    ) then
      raise exception 'Form not found' using errcode = 'no_data_found';
    end if;
  else
    if new.workspace_id is distinct from old.workspace_id or new.kind is distinct from old.kind
       or new.project_id is distinct from old.project_id or new.form_id is distinct from old.form_id
       or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
      raise exception 'An email design can''t move' using errcode = 'insufficient_privilege';
    end if;
    if old.deleted_at is not null then
      raise exception 'This design was reset' using errcode = 'check_violation';
    end if;
    if new.deleted_at is not null then
      new.deleted_at := now();
    end if;
    new.updated_by := auth.uid();
  end if;
  if coalesce(new.logo_path, '') <> '' and split_part(new.logo_path, '/', 1) <> new.workspace_id::text then
    raise exception 'The logo must be uploaded to this workspace' using errcode = 'check_violation';
  end if;
  new.header_text := case when new.header_text is null then null else btrim(new.header_text) end;
  new.button_label := case when new.button_label is null then null else btrim(new.button_label) end;
  new.accent_color := lower(new.accent_color);
  new.button_color := lower(new.button_color);
  return new;
end;
$$;

revoke all on function public.guard_email_design() from public, anon;
grant execute on function public.guard_email_design() to authenticated, service_role;

create trigger email_designs_05_guard
  before insert or update on public.email_designs
  for each row execute function public.guard_email_design();

create policy email_designs_select_reader on public.email_designs
  for select to authenticated
  using (
    case when project_id is null then (select public.is_allowlisted())
    else (select public.has_project_role(project_id, 'viewer')) end
  );

create policy email_designs_insert_editor on public.email_designs
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (select public.can_edit_email_design(workspace_id, project_id))
  );

create policy email_designs_update_editor on public.email_designs
  for update to authenticated
  using ((select public.can_edit_email_design(workspace_id, project_id)))
  with check ((select public.can_edit_email_design(workspace_id, project_id)));

grant select on public.email_designs to authenticated;
grant insert (workspace_id, kind, project_id, form_id, logo_path, accent_color, header_text, intro_message,
  footer_text, button_label, button_color, created_by)
  on public.email_designs to authenticated;
grant update (logo_path, accent_color, header_text, intro_message, footer_text, button_label, button_color, deleted_at)
  on public.email_designs to authenticated;

-- The resolved design of a kind for a project and form: each setting from the form override, else the
-- project override, else the workspace default (null = the app's built-in default). Invoker: a person
-- only resolves what they can read; the drain calls it inside email_design_context.
create or replace function public.resolve_email_design(
  design_kind text,
  target_project uuid default null,
  target_form uuid default null
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with ws as (
    select coalesce(
      (select p.workspace_id from public.projects p where p.id = target_project),
      (select w.id from public.workspaces w where w.deleted_at is null order by w.created_at limit 1)
    ) as id
  ),
  scopes as (
    select d.*,
      case when d.form_id is not null then 1 when d.project_id is not null then 2 else 3 end as rank
    from public.email_designs d, ws
    where d.deleted_at is null
      and d.kind = design_kind
      and d.workspace_id = ws.id
      and (
        (d.project_id is null and d.form_id is null)
        or (target_project is not null and d.project_id = target_project and d.form_id is null)
        or (design_kind = 'requester' and target_form is not null
            and d.project_id = target_project and d.form_id = target_form)
      )
  )
  select jsonb_build_object(
    'kind', design_kind,
    'logo_path', (select s.logo_path from scopes s where s.logo_path is not null order by s.rank limit 1),
    'accent_color', (select s.accent_color from scopes s where s.accent_color is not null order by s.rank limit 1),
    'header_text', (select s.header_text from scopes s where s.header_text is not null order by s.rank limit 1),
    'intro_message', (select s.intro_message from scopes s where s.intro_message is not null order by s.rank limit 1),
    'footer_text', (select s.footer_text from scopes s where s.footer_text is not null order by s.rank limit 1),
    'button_label', (select s.button_label from scopes s where s.button_label is not null order by s.rank limit 1),
    'button_color', (select s.button_color from scopes s where s.button_color is not null order by s.rank limit 1)
  );
$$;

revoke all on function public.resolve_email_design(text, uuid, uuid) from public, anon;
grant execute on function public.resolve_email_design(text, uuid, uuid) to authenticated, service_role;

-- A form's requester name: the submitter's profile name, else the answer to a short "Name" question.
create or replace function public.submission_requester_name(target_submission uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select nullif(btrim(p.full_name), '') from public.profiles p where p.id = fs.submitter_id),
    (select nullif(btrim(a.value #>> '{}'), '')
     from jsonb_each(fs.answers) a
     join jsonb_array_elements(coalesce(f.questions, '[]'::jsonb)) q on q ->> 'id' = a.key
     where q ->> 'type' = 'short_text'
       and jsonb_typeof(a.value) = 'string'
       and lower(btrim(q ->> 'label')) in ('name', 'your name', 'full name', 'first name', 'requester',
         'requester name', 'requested by', 'contact name')
     limit 1)
  )
  from public.form_submissions fs
  left join public.forms f on f.id = fs.form_id
  where fs.id = target_submission;
$$;

revoke all on function public.submission_requester_name(uuid) from public, anon, authenticated;

-- For the drain (service role): which design an outbox email uses — its kind (requester when it goes
-- to the task's form submitter, a form confirmation, or a response sent from the comment box; else
-- internal), its project and form — the resolved design, and the fill-in values.
create or replace function public.email_design_context(target_email uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  o public.email_outbox;
  t public.tasks;
  r public.tasks;
  sub public.form_submissions;
  task uuid;
  project uuid;
  form uuid;
  design_kind text := 'internal';
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  select * into o from public.email_outbox where id = target_email;
  if not found then
    return null;
  end if;
  task := coalesce(o.task_id, case when coalesce(o.payload ->> 'task_id', '') ~ uuid_pattern then (o.payload ->> 'task_id')::uuid end);
  if task is not null then
    select * into t from public.tasks where id = task;
    select * into r from public.tasks where id = coalesce(t.root_task_id, t.id);
  end if;
  if r.id is not null then
    select * into sub from public.form_submissions fs
    where fs.task_id = r.id and fs.deleted_at is null
    order by fs.created_at desc, fs.id limit 1;
  end if;
  if coalesce(o.payload ->> 'kind', '') not in ('invite', 'notification', 'digest', 'report') and (
    o.payload ->> 'kind' = 'submitter_response'
    or o.template = 'form_confirmation'
    or (sub.id is not null and o.comment_id is null and o.to_profile_id is null
        and lower(btrim(o.to_email)) = lower(btrim(sub.submitter_email)))
  ) then
    design_kind := 'requester';
  end if;
  project := case
    when coalesce(o.payload ->> 'project_id', '') ~ uuid_pattern then (o.payload ->> 'project_id')::uuid
    else r.home_project_id
  end;
  if design_kind = 'requester' then
    form := sub.form_id;
  end if;
  return jsonb_build_object(
    'kind', design_kind,
    'project_id', project,
    'form_id', form,
    'design', public.resolve_email_design(design_kind, project, form),
    'values', jsonb_build_object(
      'requester_name', case when sub.id is not null then public.submission_requester_name(sub.id) end,
      'request_number', case when r.id is not null then public.task_request_label(r.id) end,
      'task_name', case when design_kind = 'requester' then r.title else t.title end,
      'project_name', (select p.name from public.projects p where p.id = project),
      'form_name', (select f.title from public.forms f where f.id = coalesce(form, sub.form_id)),
      'commenter_name', o.payload ->> 'author_name',
      'due_date', coalesce(t.due_on, r.due_on),
      'task_id', t.id,
      'task_project_id', project
    )
  );
end;
$$;

revoke all on function public.email_design_context(uuid) from public, anon, authenticated;
grant execute on function public.email_design_context(uuid) to service_role;

-- A project's email logo: <workspace id>/email/<project id>/<file> in the public logo bucket. Used by
-- the Storage insert policy in supabase/manual/20261019010000_email_logo_policy.sql.
create or replace function public.workspace_asset_email_project(object_name text)
returns uuid
language sql
stable
set search_path = ''
as $$
  select p.id
  from public.projects p
  where split_part(object_name, '/', 2) = 'email'
    and split_part(object_name, '/', 3) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and split_part(object_name, '/', 4) <> ''
    and split_part(object_name, '/', 5) = ''
    and p.id = split_part(object_name, '/', 3)::uuid
    and p.workspace_id = public.workspace_asset_workspace(object_name);
$$;

revoke all on function public.workspace_asset_email_project(text) from public, anon;
grant execute on function public.workspace_asset_email_project(text) to authenticated;

-- =============================================================================================
-- 2. Reply-by-email follow-ups
-- =============================================================================================

-- 2a. Subtasks of a form task respond to the top-level task's submitter (same signature and grants).
create or replace function public.task_submitter(target_task uuid)
returns table (submission_id uuid, form_id uuid, submitter_email text, subject text)
language sql
stable
security definer
set search_path = ''
as $$
  select fs.id, fs.form_id, lower(btrim(fs.submitter_email)),
    left('Re: "' || coalesce(nullif(btrim(f.title), ''), 'Your request') || '" submission received', 300)
  from public.tasks t
  join public.tasks r on r.id = coalesce(t.root_task_id, t.id)
  join public.form_submissions fs on fs.task_id = r.id and fs.deleted_at is null
  left join public.forms f on f.id = fs.form_id
  where t.id = target_task
    and r.source = 'form'
    and public.is_email(lower(btrim(fs.submitter_email)))
  order by fs.created_at desc, fs.id
  limit 1;
$$;

-- 2b. Closing a reply thread.
alter table public.submitter_reply_threads
  add column closed_at timestamptz,
  add column closed_by uuid references public.profiles (id);
create index submitter_reply_threads_closed_by_idx on public.submitter_reply_threads (closed_by);

comment on column public.submitter_reply_threads.closed_at is
  'Set by "Close reply thread": the submitter''s later replies are refused and logged (thread_closed), '
  'and responses go out without a Reply-To. Cleared by "Reopen reply thread".';

-- A response always uses the top-level task's thread (one per task and submitter); the email is still
-- about the task the comment is on.
create or replace function public.on_comment_submitter_response()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tasks;
  root public.tasks;
  s record;
  thread uuid;
  author_name text;
begin
  if new.email_direction is distinct from 'sent' or new.deleted_at is not null
     or public.import_context_id() is not null or public.copy_context_id() is not null then
    return new;
  end if;
  select * into t from public.tasks where id = new.task_id;
  select * into root from public.tasks where id = coalesce(t.root_task_id, t.id);
  select * into s from public.task_submitter(new.task_id);
  if t.id is null or root.id is null or s.submitter_email is null then
    return new;
  end if;

  insert into public.submitter_reply_threads (task_id, submission_id, submitter_email, subject, token, created_by)
  values (root.id, s.submission_id, s.submitter_email, s.subject, left(public.inbound_random_hex(), 40), new.author_id)
  on conflict (task_id, submitter_email) where revoked_at is null do nothing;
  select k.id into thread from public.submitter_reply_threads k
  where k.task_id = root.id and k.submitter_email = s.submitter_email and k.revoked_at is null;

  author_name := coalesce(
    (select coalesce(nullif(btrim(p.full_name), ''), p.email) from public.profiles p where p.id = new.author_id),
    'The team'
  );
  insert into public.email_outbox (task_id, to_email, template, subject, payload)
  values (
    t.id,
    new.email_address,
    'custom',
    new.email_subject,
    jsonb_build_object(
      'kind', 'submitter_response',
      'comment_id', new.id,
      'thread_id', thread,
      'author_name', author_name,
      'task_title', root.title,
      'request_label', public.task_request_label(root.id),
      'message', left(new.body, 10000)
    )
  );
  return new;
end;
$$;

-- No Reply-To while a thread is closed.
select public.alhc_patch_function('public.submitter_reply_token(uuid)'::regprocedure,
$p$    and k.revoked_at is null
$p$,
$p$    and k.revoked_at is null
    and k.closed_at is null
$p$);

-- Replies to a closed thread are refused and logged.
select public.alhc_patch_function('public.post_submitter_reply(text,text,text,text)'::regprocedure,
$p$  select * into t from public.tasks x where x.id = k.task_id;
$p$,
$p$  if k.closed_at is not null then
    perform public.log_submitter_reply(provider, k.id, k.task_id, null, 'rejected', 'thread_closed');
    return jsonb_build_object('ok', false, 'status', 'rejected', 'reason', 'thread_closed');
  end if;

  select * into t from public.tasks x where x.id = k.task_id;
$p$);

-- Close or reopen the reply threads of a task (its top-level task's). Editor+ of the task.
create or replace function public.set_submitter_thread_closed(target_task uuid, closed boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  root uuid;
  changed integer;
begin
  if not public.has_task_role(target_task, 'viewer') then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if not public.has_task_role(target_task, 'editor') then
    raise exception 'Only Editors and above can close or reopen a reply thread' using errcode = 'insufficient_privilege';
  end if;
  select coalesce(t.root_task_id, t.id) into root from public.tasks t where t.id = target_task;
  update public.submitter_reply_threads k
  set closed_at = case when closed then coalesce(k.closed_at, now()) end,
      closed_by = case when closed then coalesce(k.closed_by, auth.uid()) end
  where k.task_id = root and k.revoked_at is null;
  get diagnostics changed = row_count;
  if changed = 0 then
    raise exception 'No response has been sent to the submitter yet' using errcode = 'no_data_found';
  end if;
  return public.submitter_thread_status(target_task);
end;
$$;

revoke all on function public.set_submitter_thread_closed(uuid, boolean) from public, anon;
grant execute on function public.set_submitter_thread_closed(uuid, boolean) to authenticated;

-- Whether the task (its top-level task) has a reply thread and whether it's closed. Viewer+; null for
-- tasks the caller can't read. Never the token.
create or replace function public.submitter_thread_status(target_task uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.has_task_role(target_task, 'viewer') then (
    select jsonb_build_object(
      'submitter_email', k.submitter_email,
      'closed', k.closed_at is not null,
      'closed_at', k.closed_at,
      'closed_by_name', (select coalesce(nullif(btrim(p.full_name), ''), p.email) from public.profiles p where p.id = k.closed_by),
      'last_reply_at', k.last_used_at
    )
    from public.tasks t
    join public.submitter_reply_threads k on k.task_id = coalesce(t.root_task_id, t.id) and k.revoked_at is null
    where t.id = target_task
    order by k.created_at desc
    limit 1
  ) end;
$$;

revoke all on function public.submitter_thread_status(uuid) from public, anon;
grant execute on function public.submitter_thread_status(uuid) to authenticated;

-- 2c. Responses need Editor or above (the composer's checkbox and the database agree).
select public.alhc_patch_function('public.send_submitter_response(uuid,text)'::regprocedure,
$p$  perform set_config('alhc.submitter_response', target_task::text, true);
$p$,
$p$  if not public.has_task_role(target_task, 'editor') then
    raise exception 'Only Editors and above can send a response to the submitter' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('alhc.submitter_response', target_task::text, true);
$p$);

select public.alhc_patch_function('public.guard_comment_email()'::regprocedure,
$p$        raise exception 'Use “Send response to submitter” to email a comment' using errcode = 'insufficient_privilege';
      end if;
$p$,
$p$        raise exception 'Use “Send response to submitter” to email a comment' using errcode = 'insufficient_privilege';
      end if;
      if not public.has_task_role(new.task_id, 'editor') then
        raise exception 'Only Editors and above can send a response to the submitter' using errcode = 'insufficient_privilege';
      end if;
$p$);

-- 2d. Attachments of a submitter's reply.
alter table public.task_attachments
  add column comment_id uuid references public.comments (id),
  add column import_external_id text constraint task_attachments_import_external_id_check
    check (import_external_id is null or char_length(import_external_id) between 1 and 100);
create index task_attachments_comment_idx on public.task_attachments (comment_id) where comment_id is not null;
create unique index task_attachments_import_idx on public.task_attachments (task_id, import_external_id)
  where import_external_id is not null and deleted_at is null;

comment on column public.task_attachments.comment_id is
  'The emailed reply (a received email comment) this file came with. Set only by attach_reply_file.';
comment on column public.task_attachments.import_external_id is
  'The Asana attachment gid of a file the importer downloaded (dedupes re-runs). Set only by import_attachment_file.';

alter table public.comments
  add column email_skipped_files jsonb constraint comments_email_skipped_files_check
    check (email_skipped_files is null or (jsonb_typeof(email_skipped_files) = 'array' and jsonb_array_length(email_skipped_files) <= 50));

comment on column public.comments.email_skipped_files is
  'Attachments of an emailed reply that weren''t saved: [{name, reason: too_large | too_many | failed}]. '
  'Set only by note_reply_skipped_files.';

-- Clients never set the reply / import links of an attachment (same pattern as the source column).
create or replace function public.guard_task_attachment_source()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_client_role() then
    if tg_op = 'INSERT' then
      new.source := 'upload';
      new.comment_id := null;
      new.import_external_id := null;
    else
      new.source := old.source;
      new.comment_id := old.comment_id;
      new.import_external_id := old.import_external_id;
    end if;
  end if;
  return new;
end;
$$;

-- Clients never set which reply files were skipped.
create or replace function public.guard_comment_skipped_files()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_client_role() then
    if tg_op = 'INSERT' then
      new.email_skipped_files := null;
    else
      new.email_skipped_files := old.email_skipped_files;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_comment_skipped_files() from public, anon;
grant execute on function public.guard_comment_skipped_files() to authenticated, service_role;

create trigger comments_04c_guard_skipped_files
  before insert or update on public.comments
  for each row execute function public.guard_comment_skipped_files();

-- Records one file of a submitter's emailed reply (the route uploaded it to the task's folder with the
-- service role). service_role only: within an hour of the reply, at most 10 per reply, inside the
-- task's folder. Credited to whoever started the thread (else the project's owner): the column needs a
-- person.
create or replace function public.attach_reply_file(
  target_comment uuid, file_path text, file_name text, file_type text, file_size bigint
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.comments;
  uploader uuid;
  attachment uuid;
  previous_sub text;
begin
  select * into c from public.comments x where x.id = target_comment for update;
  if not found or c.email_direction is distinct from 'received' or c.deleted_at is not null
     or c.created_at < now() - interval '1 hour' then
    raise exception 'Reply not found' using errcode = 'no_data_found';
  end if;
  if (select count(*) from public.task_attachments a where a.comment_id = c.id) >= 10 then
    raise exception 'At most 10 attachments per reply' using errcode = 'check_violation';
  end if;
  if file_path is null or file_path not like c.task_id::text || '/%' or position('..' in file_path) > 0 then
    raise exception 'Invalid attachment path' using errcode = 'check_violation';
  end if;
  uploader := coalesce(
    (select k.created_by from public.email_replies er
     join public.submitter_reply_threads k on k.id = er.thread_id
     where er.comment_id = c.id and k.created_by is not null limit 1),
    (select m.profile_id from public.tasks t
     join public.project_members m on m.project_id = t.home_project_id and m.role = 'owner' and m.deleted_at is null
     where t.id = c.task_id order by m.created_at limit 1)
  );
  if uploader is null then
    raise exception 'Nobody to credit the file to' using errcode = 'check_violation';
  end if;
  previous_sub := current_setting('request.jwt.claim.sub', true);
  perform set_config('request.jwt.claim.sub', '', true);
  insert into public.task_attachments (task_id, storage_path, file_name, content_type, size_bytes, uploaded_by, source, comment_id)
  values (
    c.task_id, file_path,
    left(coalesce(nullif(btrim(file_name), ''), 'attachment'), 255),
    nullif(left(btrim(coalesce(file_type, '')), 255), ''),
    greatest(coalesce(file_size, 0), 0),
    uploader, 'email', c.id
  )
  returning id into attachment;
  perform set_config('request.jwt.claim.sub', coalesce(previous_sub, ''), true);
  return attachment;
end;
$$;

revoke all on function public.attach_reply_file(uuid, text, text, text, bigint) from public, anon, authenticated;
grant execute on function public.attach_reply_file(uuid, text, text, text, bigint) to service_role;

-- Notes the files of a reply that weren't saved (names and why). service_role only.
create or replace function public.note_reply_skipped_files(target_comment uuid, files jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  cleaned jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
    'name', left(coalesce(nullif(btrim(f ->> 'name'), ''), 'attachment'), 255),
    'reason', case when f ->> 'reason' in ('too_large', 'too_many', 'failed') then f ->> 'reason' else 'failed' end
  )), '[]'::jsonb)
  into cleaned
  from (select f from jsonb_array_elements(case when jsonb_typeof(files) = 'array' then files else '[]'::jsonb end) f limit 50) x;
  update public.comments c
  set email_skipped_files = case when jsonb_array_length(cleaned) = 0 then null else cleaned end
  where c.id = target_comment and c.email_direction = 'received';
end;
$$;

revoke all on function public.note_reply_skipped_files(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.note_reply_skipped_files(uuid, jsonb) to service_role;

-- =============================================================================================
-- 3. Roles: the Commenter switch
-- =============================================================================================

alter table public.workspaces add column allow_commenter_role boolean not null default false;
comment on column public.workspaces.allow_commenter_role is
  'Whether the Commenter project role is offered (off by default). While off, nobody can be given '
  'Commenter; people who already have it keep it.';
grant update (allow_commenter_role) on public.workspaces to authenticated;

create or replace function public.commenter_role_allowed(target_workspace uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select w.allow_commenter_role from public.workspaces w where w.id = target_workspace), false);
$$;

revoke all on function public.commenter_role_allowed(uuid) from public, anon;
grant execute on function public.commenter_role_allowed(uuid) to authenticated, service_role;

select public.alhc_patch_function('public.add_project_member(uuid,text,text)'::regprocedure,
$p$  if member_role = 'owner' and caller_role <> 'owner' then
$p$,
$p$  if member_role = 'commenter' and not public.commenter_role_allowed(
    (select p.workspace_id from public.projects p where p.id = target_project)
  ) then
    raise exception 'The Commenter role is turned off in this workspace' using errcode = 'check_violation',
      hint = 'Choose Viewer or Editor, or ask a workspace admin to allow the Commenter role.';
  end if;
  if member_role = 'owner' and caller_role <> 'owner' then
$p$);

select public.alhc_patch_function('public.update_project_member_role(uuid,uuid,text)'::regprocedure,
$p$  if (m.role = 'owner' or new_role = 'owner') and caller_role <> 'owner' then
$p$,
$p$  if new_role = 'commenter' and m.role <> 'commenter' and not public.commenter_role_allowed(
    (select p.workspace_id from public.projects p where p.id = target_project)
  ) then
    raise exception 'The Commenter role is turned off in this workspace' using errcode = 'check_violation',
      hint = 'Choose Viewer or Editor, or ask a workspace admin to allow the Commenter role.';
  end if;
  if (m.role = 'owner' or new_role = 'owner') and caller_role <> 'owner' then
$p$);

-- Pending project invites can't newly carry Commenter either (the guard sees every path to them).
create or replace function public.guard_pending_commenter()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.project_id is not null and new.role = 'commenter'
     and (tg_op = 'INSERT' or old.role is distinct from 'commenter')
     and not public.commenter_role_allowed(new.workspace_id) then
    raise exception 'The Commenter role is turned off in this workspace' using errcode = 'check_violation',
      hint = 'Choose Viewer or Editor, or ask a workspace admin to allow the Commenter role.';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_pending_commenter() from public, anon;
grant execute on function public.guard_pending_commenter() to authenticated, service_role;

create trigger pending_memberships_04_commenter
  before insert or update of role on public.pending_memberships
  for each row execute function public.guard_pending_commenter();

-- Workspace admins: everyone who holds the Commenter role in a live project, with how many projects.
-- Project names only for projects the caller can open (a private project stays private).
create or replace function public.list_commenter_members()
returns table (profile_id uuid, full_name text, email text, project_count integer, projects jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_workspace_admin(null) then
    raise exception 'Only workspace admins can see this' using errcode = 'insufficient_privilege';
  end if;
  return query
  select pr.id, pr.full_name, pr.email, count(*)::integer,
    coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.name)
      filter (where public.has_project_role(p.id, 'viewer')), '[]'::jsonb)
  from public.project_members m
  join public.projects p on p.id = m.project_id and p.deleted_at is null
  join public.profiles pr on pr.id = m.profile_id
  where m.role = 'commenter' and m.deleted_at is null
  group by pr.id, pr.full_name, pr.email
  order by coalesce(nullif(btrim(pr.full_name), ''), pr.email);
end;
$$;

revoke all on function public.list_commenter_members() from public, anon;
grant execute on function public.list_commenter_members() to authenticated;

-- Workspace admins: move one person's Commenter memberships to Viewer or Editor (their choice, one
-- click; never automatic). Returns how many memberships changed.
create or replace function public.convert_commenter_members(target_profile uuid, new_role text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  if not public.is_workspace_admin(null) then
    raise exception 'Only workspace admins can change this' using errcode = 'insufficient_privilege';
  end if;
  if new_role not in ('viewer', 'editor') then
    raise exception 'Choose Viewer or Editor' using errcode = 'check_violation';
  end if;
  update public.project_members m
  set role = new_role
  where m.profile_id = target_profile and m.role = 'commenter' and m.deleted_at is null;
  get diagnostics changed = row_count;
  return changed;
end;
$$;

revoke all on function public.convert_commenter_members(uuid, text) from public, anon;
grant execute on function public.convert_commenter_members(uuid, text) to authenticated;

-- =============================================================================================
-- 4. Asana importer: attachment files
-- =============================================================================================

-- For a batch of (task gid, attachment gid) pairs of a running import: the imported task's id and
-- whether that file is already there. Admin+ of the run's project.
create or replace function public.import_attachment_targets(target_run uuid, attachment_refs jsonb)
returns table (attachment_gid text, task_id uuid, present boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  run public.import_runs;
begin
  select * into run from public.import_runs where id = target_run and deleted_at is null;
  if not found or not public.has_project_role(run.project_id, 'viewer') then
    raise exception 'Import not found' using errcode = 'no_data_found';
  end if;
  if not public.has_project_role(run.project_id, 'admin') then
    raise exception 'You need Admin access to import into this project' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(attachment_refs) <> 'array' or jsonb_array_length(attachment_refs) > 200 then
    raise exception 'Pass up to 200 attachments' using errcode = 'check_violation';
  end if;
  return query
  select ref ->> 'attachment', x.local_id,
    exists (
      select 1 from public.task_attachments a
      where a.task_id = x.local_id and a.import_external_id = ref ->> 'attachment' and a.deleted_at is null
    )
  from jsonb_array_elements(attachment_refs) ref
  join public.import_external_ids x
    on x.project_id = run.project_id and x.source = run.source and x.kind = 'task' and x.external_id = ref ->> 'task'
  join public.tasks t on t.id = x.local_id and t.deleted_at is null;
end;
$$;

revoke all on function public.import_attachment_targets(uuid, jsonb) from public, anon;
grant execute on function public.import_attachment_targets(uuid, jsonb) to authenticated;

-- Records a downloaded Asana attachment file (already uploaded by the importer to the task's folder).
-- Admin+ of a running import's project, a task that import mapped, the path inside its folder. Quiet like
-- the rest of an import (no story). 'exists' when that file is already there.
create or replace function public.import_attachment_file(
  target_run uuid, target_task uuid, attachment_gid text,
  file_path text, file_name text, file_type text, file_size bigint
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  run public.import_runs;
  added uuid;
begin
  select * into run from public.import_runs where id = target_run and deleted_at is null;
  if not found or not public.has_project_role(run.project_id, 'viewer') then
    raise exception 'Import not found' using errcode = 'no_data_found';
  end if;
  if not public.has_project_role(run.project_id, 'admin') then
    raise exception 'You need Admin access to import into this project' using errcode = 'insufficient_privilege';
  end if;
  if run.status <> 'running' then
    raise exception 'This import is finished' using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.import_external_ids x
    join public.tasks t on t.id = x.local_id and t.deleted_at is null
    where x.project_id = run.project_id and x.source = run.source and x.kind = 'task' and x.local_id = target_task
  ) then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if coalesce(attachment_gid, '') !~ '^[\w-]{1,100}$' then
    raise exception 'Invalid attachment id' using errcode = 'check_violation';
  end if;
  if file_path is null or file_path not like target_task::text || '/%' or position('..' in file_path) > 0 then
    raise exception 'Invalid attachment path' using errcode = 'check_violation';
  end if;
  perform set_config('alhc.import_run_id', target_run::text, true);
  insert into public.task_attachments (task_id, storage_path, file_name, content_type, size_bytes, uploaded_by, source, import_external_id)
  values (
    target_task, file_path,
    left(coalesce(nullif(btrim(file_name), ''), 'attachment'), 255),
    nullif(left(btrim(coalesce(file_type, '')), 255), ''),
    greatest(coalesce(file_size, 0), 0),
    auth.uid(), 'upload', attachment_gid
  )
  on conflict (task_id, import_external_id) where import_external_id is not null and deleted_at is null do nothing
  returning id into added;
  perform set_config('alhc.import_run_id', '', true);
  return case when added is null then 'exists' else 'added' end;
end;
$$;

revoke all on function public.import_attachment_file(uuid, uuid, text, text, text, text, bigint) from public, anon;
grant execute on function public.import_attachment_file(uuid, uuid, text, text, text, text, bigint) to authenticated;

-- =============================================================================================
-- Grants housekeeping
-- =============================================================================================

select public.alhc_revoke_anon_grants(array['email_designs']);
select public.alhc_revoke_client_truncate(array['email_designs']);
select public.alhc_revoke_anon_execute(array[
  'can_edit_email_design(uuid,uuid)', 'guard_email_design()', 'resolve_email_design(text,uuid,uuid)',
  'submission_requester_name(uuid)', 'email_design_context(uuid)', 'workspace_asset_email_project(text)',
  'set_submitter_thread_closed(uuid,boolean)', 'submitter_thread_status(uuid)',
  'guard_comment_skipped_files()', 'attach_reply_file(uuid,text,text,text,bigint)',
  'note_reply_skipped_files(uuid,jsonb)', 'commenter_role_allowed(uuid)', 'guard_pending_commenter()',
  'list_commenter_members()', 'convert_commenter_members(uuid,text)',
  'import_attachment_targets(uuid,jsonb)', 'import_attachment_file(uuid,uuid,text,text,text,text,bigint)'
]);

-- TAIL
-- (Nothing: this migration needs no hand-applied statements. The Storage policy for project email
-- logos is supabase/manual/20261019010000_email_logo_policy.sql.)
