-- Nov 2 notes, batch 14 (items 92–105): views, project roles, search by number, and Slack. Additive: new
-- tables, columns, and functions plus asserted patches; nothing is renamed or taken away, and there is no
-- tail. The release still on main never reads the new tables or keys, and every patched function keeps
-- its signature, its grants, and what it did before for every input that release can send.
--
-- What the database gains (the app does the rest):
--   * 94 Personal views: project_view_personal_configs (each person's own version of a shared view: own
--     rows only, Viewer+ of the project) written by set_view_personal_config (invoker); "Save as default
--     for everyone" is the existing Owner-only update of project_views. A view's config may carry
--     section_order (this view's order of the project's sections; validate_view_config patched), so
--     dragging a section is a view change like a sort, never a silent reorder for everyone.
--   * 100 Search by number: request_number_query also reads "task 5", "request 7", "Task #5" (generic
--     words before the number), and search_tasks also matches a number written with any project's own
--     prefix ("DES-0042" = "des 42"; normalized_task_label), and lists exact number matches first. Numbers
--     still match only for projects the caller can read (the numbers table's RLS / has_project_role).
--   * 95 Project roles: project_roles (named roles per project — Approver, Designer, Lead — each with the
--     person who fills it; Viewers read, Editors+ manage) and task_role_links (a task's assignee, approver,
--     or follower given by a role; read with the task, Editors+ write). set_project_role_person (invoker)
--     changes who fills a role and, when asked, updates the open tasks linked to it; set_task_role_link
--     (invoker) links a role to a task and applies its person. Templates and Duplicate project carry the
--     roles and the links (project_snapshot / instantiate_project_snapshot patched; the rules' references
--     are remapped like sections), and create_project_from_template_custom (definer, the one new client
--     definer for templates) creates a project from a template after the "Customize before creating"
--     step: renamed / left-out sections, tasks, and fields, added tasks, and the person for each role.
--     Automations can name "the person in role X" (project_role:<id>) wherever they take a person
--     (assignee, approver, followers, notify, conditions) and Send email can go to a role's person.
--   * 105 Slack, connected once per workspace: slack_connections (a Slack app's bot token; no client
--     access) and slack_destinations (the channels the bot can post to, plus Slack incoming webhooks
--     saved at workspace level; no client access). Workspace admins manage both through
--     manage_slack_workspace (definer); anyone signed in reads the destinations' names through
--     slack_settings (definer; never a token or URL); project Admins pick a project's channel through
--     set_project_slack_destination (definer). Send Slack message takes a destination_id. Every
--     project's existing Slack webhook was copied once into a workspace destination and chosen for that
--     project, so nothing has to be reconnected. slack_bot_token is service_role only (the app's
--     channel refresh).
-- New client SECURITY DEFINER functions (pinned in suite 60): create_project_from_template_custom,
-- slack_settings, manage_slack_workspace, set_project_slack_destination. Nothing for anon. fire_rules,
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
-- 1. Views: a view's own section order, and each person's own version of a view (94)
-- =================================================================================================

-- config.section_order = [section ids of this project] (≤ 500, no repeats). Mirrored by src/lib/views.ts.
select public.alhc_patch_function('public.validate_view_config(uuid, jsonb)'::regprocedure,
$p$k not in ('filters', 'sort', 'group_by', 'columns', 'show_subtasks')$p$,
$p$k not in ('filters', 'sort', 'group_by', 'columns', 'show_subtasks', 'section_order')$p$,
$p$  if config ? 'show_subtasks' and jsonb_typeof(config -> 'show_subtasks') <> 'boolean' then
    raise exception 'Show subtasks is on or off' using errcode = 'check_violation';
  end if;
$p$,
$p$  if config ? 'show_subtasks' and jsonb_typeof(config -> 'show_subtasks') <> 'boolean' then
    raise exception 'Show subtasks is on or off' using errcode = 'check_violation';
  end if;

  -- Nov 2 notes (batch 14): this view's own order of the project's sections.
  if config ? 'section_order' then
    if jsonb_typeof(config -> 'section_order') <> 'array' or jsonb_array_length(config -> 'section_order') > 500
       or exists (
         select 1 from jsonb_array_elements(config -> 'section_order') e
         where jsonb_typeof(e) <> 'string'
           or (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           or not exists (
             select 1 from public.sections s where s.id = (e #>> '{}')::uuid and s.project_id = target_project
           )
       )
       or (select count(*) from jsonb_array_elements_text(config -> 'section_order'))
          <> (select count(distinct x) from jsonb_array_elements_text(config -> 'section_order') x) then
      raise exception 'A view''s section order lists this project''s sections once each' using errcode = 'check_violation';
    end if;
  end if;
$p$);

create table if not exists public.project_view_personal_configs (
  profile_id uuid not null default auth.uid() references public.profiles (id),
  view_id uuid not null references public.project_views (id),
  project_id uuid not null references public.projects (id),
  -- Null = no version of their own (the view as everyone sees it).
  config jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (profile_id, view_id),
  constraint project_view_personal_configs_config_check check (config is null or jsonb_typeof(config) = 'object')
);

create index if not exists project_view_personal_configs_view_idx on public.project_view_personal_configs (view_id);
create index if not exists project_view_personal_configs_project_idx on public.project_view_personal_configs (project_id);

alter table public.project_view_personal_configs enable row level security;
revoke all on public.project_view_personal_configs from anon, authenticated;
select public.alhc_revoke_anon_grants(array['project_view_personal_configs']);
select public.alhc_revoke_client_truncate(array['project_view_personal_configs']);
grant select on public.project_view_personal_configs to authenticated;
grant insert (view_id, project_id, config) on public.project_view_personal_configs to authenticated;
grant update (config) on public.project_view_personal_configs to authenticated;

comment on table public.project_view_personal_configs is
  'Nov 2 notes (batch 14): a person''s own version of a shared project view ("Save for me"): what they see '
  'instead of the view''s config until they reset it. Own rows only (Viewer+ of the project). "Save as '
  'default for everyone" updates project_views itself (Owners only).';

create trigger project_view_personal_configs_set_updated_at
  before update on public.project_view_personal_configs
  for each row execute function public.set_updated_at();

create or replace function public.guard_project_view_personal_config()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v public.project_views;
begin
  if public.is_client_role() then
    if tg_op = 'INSERT' then
      new.profile_id := auth.uid();
    elsif new.profile_id is distinct from old.profile_id or new.view_id is distinct from old.view_id then
      raise exception 'A personal view version can''t move' using errcode = 'insufficient_privilege';
    end if;
  end if;
  select * into v from public.project_views where id = new.view_id and deleted_at is null;
  if not found then
    raise exception 'View not found' using errcode = 'no_data_found';
  end if;
  -- Only a shared tab has a "for me" version; the person's own view is simply saved.
  if v.owner_id is not null then
    raise exception 'Your own view saves in place' using errcode = 'check_violation';
  end if;
  new.project_id := v.project_id;
  if new.config is not null then
    perform public.validate_view_config(v.project_id, new.config);
  end if;
  return new;
end;
$$;

select public.alhc_revoke_anon_execute(array['guard_project_view_personal_config()']);

create trigger project_view_personal_configs_05_guard
  before insert or update on public.project_view_personal_configs
  for each row execute function public.guard_project_view_personal_config();

create policy project_view_personal_configs_select_own on public.project_view_personal_configs
  for select to authenticated using (profile_id = (select auth.uid()));
create policy project_view_personal_configs_insert_own_viewer on public.project_view_personal_configs
  for insert to authenticated
  with check (profile_id = (select auth.uid()) and (select public.has_project_role(project_id, 'viewer')));
create policy project_view_personal_configs_update_own_viewer on public.project_view_personal_configs
  for update to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()) and (select public.has_project_role(project_id, 'viewer')));

-- Saves (or, with null, clears) the caller's own version of a shared view. Invoker: RLS decides.
create or replace function public.set_view_personal_config(target_view uuid, new_config jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v public.project_views;
  stored jsonb;
begin
  select * into v from public.project_views where id = target_view and deleted_at is null;
  if not found or not public.has_project_role(v.project_id, 'viewer') then
    raise exception 'View not found' using errcode = 'no_data_found';
  end if;
  insert into public.project_view_personal_configs as c (view_id, project_id, config)
  values (target_view, v.project_id, new_config)
  on conflict (profile_id, view_id) do update set config = excluded.config
  returning c.config into stored;
  return stored;
end;
$$;

select public.alhc_revoke_anon_execute(array['set_view_personal_config(uuid, jsonb)']);
grant execute on function public.set_view_personal_config(uuid, jsonb) to authenticated;

-- =================================================================================================
-- 2. Search by number with any project's prefix (100)
-- =================================================================================================

-- "task 5", "Task #5", "request 7", "Req #7", "no. 12", "#5", "5", "[Req #484.1]" → the number (or path).
select public.alhc_patch_function('public.request_number_query(text)'::regprocedure,
$p$'^\[?(?:req[[:space:]]*)?#?[[:space:]]*([0-9]+(?:\.[0-9]+)*)\]?$'$p$,
$p$'^\[?(?:(?:req(?:uest)?s?|tasks?|numbers?|num|no\.?|items?|tickets?|cards?)[[:space:]]*)?(?:#|:|-)?[[:space:]]*([0-9]+(?:\.[0-9]+)*)\]?$'$p$);

-- A task label as people type it: lower case, letters and digits only, no leading zeros in a number.
-- "DES-0042" = "des 42" = "Des #42"; "Design 2026-14" = "design 2026 14". Empty when there are no digits.
create or replace function public.normalized_task_label(raw text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when coalesce(raw, '') ~ '[0-9]' then
    regexp_replace(regexp_replace(lower(raw), '[^a-z0-9]+', '', 'g'), '(^|[^0-9])0+([0-9])', '\1\2', 'g')
  else '' end;
$$;

select public.alhc_revoke_anon_execute(array['normalized_task_label(text)']);
grant execute on function public.normalized_task_label(text) to authenticated;

select public.alhc_patch_function('public.search_tasks(text, integer)'::regprocedure,
$p$        coalesce(t.req_label, '') ilike pattern.value
        and public.has_project_role(coalesce(t.req_project_id, t.home_project_id), 'viewer')$p$,
$p$        (
          coalesce(t.req_label, '') ilike pattern.value
          or (public.normalized_task_label(t.req_label) <> ''
            and public.normalized_task_label(t.req_label) = public.normalized_task_label(query))
        )
        and public.has_project_role(coalesce(t.req_project_id, t.home_project_id), 'viewer')$p$,
$p$            coalesce(x.req_label, '') ilike pattern.value
            or x.req_number::text = ltrim(coalesce(public.request_number_query(trim(query)), '-'), '0')$p$,
$p$            coalesce(x.req_label, '') ilike pattern.value
            or x.req_number::text = ltrim(coalesce(public.request_number_query(trim(query)), '-'), '0')
            or (public.normalized_task_label(x.req_label) <> ''
              and public.normalized_task_label(x.req_label) = public.normalized_task_label(query))$p$,
$p$  order by t.completed_at is not null, t.title ilike pattern.value desc,$p$,
$p$  -- Nov 2 notes (batch 14): a number typed with its prefix (or alone) lists that task first.
  order by (
      exists (
        select 1 from public.task_project_numbers x
        where x.task_id = t.id
          and (
            x.req_number::text = ltrim(coalesce(public.request_number_query(trim(query)), '-'), '0')
            or (public.normalized_task_label(x.req_label) <> ''
              and public.normalized_task_label(x.req_label) = public.normalized_task_label(query))
          )
      )
      or (
        public.request_number_query(trim(query)) is not null
        and t.req_number::text = ltrim(public.request_number_query(trim(query)), '0')
        and public.has_project_role(coalesce(t.req_project_id, t.home_project_id), 'viewer')
      )
    ) desc,
    t.completed_at is not null, t.title ilike pattern.value desc,$p$);

-- =================================================================================================
-- 3. Project roles (95)
-- =================================================================================================

create table if not exists public.project_roles (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  name text not null,
  -- Who fills the role (a member of the project); null = nobody yet.
  profile_id uuid references public.profiles (id),
  sort_order double precision not null default 0,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint project_roles_name_check check (char_length(btrim(name)) between 1 and 60)
);

create index if not exists project_roles_project_idx on public.project_roles (project_id) where deleted_at is null;
create index if not exists project_roles_profile_idx on public.project_roles (profile_id);
create index if not exists project_roles_created_by_idx on public.project_roles (created_by);
create unique index if not exists project_roles_one_name on public.project_roles (project_id, lower(btrim(name)))
  where deleted_at is null;

alter table public.project_roles enable row level security;
revoke all on public.project_roles from anon, authenticated;
select public.alhc_revoke_anon_grants(array['project_roles']);
select public.alhc_revoke_client_truncate(array['project_roles']);
grant select on public.project_roles to authenticated;
grant insert (project_id, name, profile_id, sort_order) on public.project_roles to authenticated;
grant update (name, profile_id, sort_order, deleted_at) on public.project_roles to authenticated;

comment on table public.project_roles is
  'Nov 2 notes (batch 14): named roles of a project (Approver, Designer, Lead) and who fills each. Tasks can '
  'take their assignee, approver, or followers from a role (task_role_links), automations can name "the '
  'person in role X" (project_role:<id>), and templates carry the roles so whoever creates a project '
  'from one picks the people. Viewers read; Editors+ manage.';

create trigger project_roles_set_updated_at
  before update on public.project_roles
  for each row execute function public.set_updated_at();

create or replace function public.guard_project_role()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.name := btrim(new.name);
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.created_by := auth.uid();
      new.created_at := now();
    end if;
    if new.sort_order = 0 then
      new.sort_order := coalesce((select max(r.sort_order) from public.project_roles r
        where r.project_id = new.project_id and r.deleted_at is null), 0) + 1024;
    end if;
  else
    if new.project_id is distinct from old.project_id then
      raise exception 'A role stays in its project' using errcode = 'check_violation';
    end if;
    if old.deleted_at is not null and new.deleted_at is null then
      raise exception 'A removed role stays removed' using errcode = 'check_violation';
    end if;
  end if;
  -- The person filling a role is someone in the project (they'll be assigned its tasks).
  if new.profile_id is not null and (tg_op = 'INSERT' or new.profile_id is distinct from old.profile_id)
     and not exists (
       select 1 from public.project_members m
       where m.project_id = new.project_id and m.profile_id = new.profile_id and m.deleted_at is null
     ) then
    raise exception 'Add % to this project first: a role is filled by a project member',
      coalesce((select coalesce(nullif(p.full_name, ''), p.email) from public.profiles p where p.id = new.profile_id), 'that person')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

select public.alhc_revoke_anon_execute(array['guard_project_role()']);

create trigger project_roles_05_guard
  before insert or update on public.project_roles
  for each row execute function public.guard_project_role();

create policy project_roles_select_viewer on public.project_roles
  for select to authenticated using ((select public.has_project_role(project_id, 'viewer')));
create policy project_roles_insert_editor on public.project_roles
  for insert to authenticated with check ((select public.has_project_role(project_id, 'editor')));
create policy project_roles_update_editor on public.project_roles
  for update to authenticated
  using ((select public.has_project_role(project_id, 'editor')))
  with check ((select public.has_project_role(project_id, 'editor')));

create table if not exists public.task_role_links (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id),
  project_role_id uuid not null references public.project_roles (id),
  slot text not null,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint task_role_links_slot_check check (slot in ('assignee', 'approver', 'follower'))
);

create unique index if not exists task_role_links_one_active on public.task_role_links (task_id, project_role_id, slot)
  where deleted_at is null;
create index if not exists task_role_links_role_idx on public.task_role_links (project_role_id) where deleted_at is null;
create index if not exists task_role_links_created_by_idx on public.task_role_links (created_by);

alter table public.task_role_links enable row level security;
revoke all on public.task_role_links from anon, authenticated;
select public.alhc_revoke_anon_grants(array['task_role_links']);
select public.alhc_revoke_client_truncate(array['task_role_links']);
grant select on public.task_role_links to authenticated;
grant insert (task_id, project_role_id, slot) on public.task_role_links to authenticated;
grant update (deleted_at) on public.task_role_links to authenticated;

comment on table public.task_role_links is
  'Nov 2 notes (batch 14): a task whose assignee, approver, or follower comes from a project role. Changing '
  'the role''s person can update the open tasks linked to it (set_project_role_person). Read with the '
  'task (Viewer+); Editors+ link and unlink.';

create trigger task_role_links_set_updated_at
  before update on public.task_role_links
  for each row execute function public.set_updated_at();

create or replace function public.guard_task_role_link()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  role_project uuid;
begin
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.created_by := auth.uid();
      new.created_at := now();
    end if;
    select r.project_id into role_project from public.project_roles r
    where r.id = new.project_role_id and r.deleted_at is null;
    -- The role belongs to one of the task's (its top-level task's) projects.
    if role_project is null or not exists (
      select 1 from public.tasks t
      join public.task_projects tp on tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null
      where t.id = new.task_id and tp.project_id = role_project
    ) then
      raise exception 'That role isn''t one of this task''s projects'' roles' using errcode = 'check_violation';
    end if;
  else
    if new.task_id is distinct from old.task_id or new.project_role_id is distinct from old.project_role_id
       or new.slot is distinct from old.slot then
      raise exception 'A role link can''t move' using errcode = 'check_violation';
    end if;
    if old.deleted_at is not null and new.deleted_at is null then
      raise exception 'Link the role again instead' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

select public.alhc_revoke_anon_execute(array['guard_task_role_link()']);

create trigger task_role_links_05_guard
  before insert or update on public.task_role_links
  for each row execute function public.guard_task_role_link();

create policy task_role_links_select_viewer on public.task_role_links
  for select to authenticated using ((select public.has_task_role(task_id, 'viewer')));
create policy task_role_links_insert_editor on public.task_role_links
  for insert to authenticated with check ((select public.has_task_role(task_id, 'editor')));
create policy task_role_links_update_editor on public.task_role_links
  for update to authenticated
  using ((select public.has_task_role(task_id, 'editor')))
  with check ((select public.has_task_role(task_id, 'editor')));

-- Someone assigns a role-linked task to a different person by hand: the task no longer follows the role.
-- (Definer: a rule or approval path may make the change; it only ever touches this task's links.)
create or replace function public.on_task_assignee_role_unlink()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.task_role_links l
  set deleted_at = now()
  from public.project_roles r
  where l.task_id = new.id and l.slot = 'assignee' and l.deleted_at is null
    and r.id = l.project_role_id and r.profile_id is distinct from new.assignee_id;
  return null;
end;
$$;

revoke all on function public.on_task_assignee_role_unlink() from public, anon, authenticated;

create trigger tasks_zz_role_assignee_unlink
  after update of assignee_id on public.tasks
  for each row when (old.assignee_id is distinct from new.assignee_id)
  execute function public.on_task_assignee_role_unlink();

-- Puts a role's person on one task's slot as the caller (RLS and the approver rules decide). Internal to
-- the two RPCs below; returns false when the task couldn't take them (e.g. not an approval task).
create or replace function public.apply_role_person(target_task uuid, link_slot text, person uuid, previous uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  t public.tasks;
  current_ids uuid[];
  s public.task_approval_settings;
begin
  select * into t from public.tasks where id = target_task and deleted_at is null;
  if not found then
    return false;
  end if;
  if link_slot = 'assignee' then
    -- Only a task still with the role's previous person (or nobody) moves to the new one.
    if t.assignee_id is distinct from person and (t.assignee_id is null or t.assignee_id is not distinct from previous) then
      update public.tasks set assignee_id = person where id = target_task;
    end if;
    return true;
  elsif link_slot = 'approver' then
    if t.kind <> 'approval' then
      return false;
    end if;
    select coalesce(array_agg(a.profile_id), '{}') into current_ids
    from public.task_approvers a where a.task_id = target_task and a.deleted_at is null;
    current_ids := array_remove(current_ids, previous);
    if person is not null and not (person = any (current_ids)) then
      current_ids := current_ids || person;
    end if;
    select * into s from public.task_approval_settings where task_id = target_task;
    perform public.set_task_approvers(target_task, current_ids, coalesce(s.mode, 'any'), s.due_on);
    return true;
  elsif link_slot = 'follower' then
    if person is not null then
      insert into public.task_followers (task_id, profile_id) values (target_task, person)
      on conflict (task_id, profile_id) do update set deleted_at = null
        where public.task_followers.deleted_at is not null;
    end if;
    return true;
  end if;
  return false;
end;
$$;

revoke all on function public.apply_role_person(uuid, text, uuid, uuid) from public, anon;
grant execute on function public.apply_role_person(uuid, text, uuid, uuid) to authenticated;

-- Changes who fills a role. With update_open_tasks, every open task linked to the role follows: its
-- assignee (when it still had the role's previous person or nobody), approvers, and followers. Invoker:
-- each change is an ordinary edit through RLS; a task the caller can't change is counted as skipped.
create or replace function public.set_project_role_person(target_role uuid, person uuid, update_open_tasks boolean default false)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r public.project_roles;
  link record;
  updated integer := 0;
  skipped integer := 0;
begin
  select * into r from public.project_roles where id = target_role and deleted_at is null;
  if not found then
    raise exception 'Role not found' using errcode = 'no_data_found';
  end if;
  if not public.has_project_role(r.project_id, 'editor') then
    raise exception 'Only Editors and above change project roles' using errcode = 'insufficient_privilege';
  end if;
  update public.project_roles set profile_id = person where id = r.id;
  if coalesce(update_open_tasks, false) then
    for link in
      select l.task_id, l.slot
      from public.task_role_links l
      join public.tasks t on t.id = l.task_id and t.deleted_at is null and t.completed_at is null
      where l.project_role_id = r.id and l.deleted_at is null
      order by t.created_at
    loop
      begin
        if public.apply_role_person(link.task_id, link.slot, person, r.profile_id) then
          updated := updated + 1;
        else
          skipped := skipped + 1;
        end if;
      exception when others then
        skipped := skipped + 1;
      end;
    end loop;
  end if;
  return jsonb_build_object('updated', updated, 'skipped', skipped);
end;
$$;

select public.alhc_revoke_anon_execute(array['set_project_role_person(uuid, uuid, boolean)']);
grant execute on function public.set_project_role_person(uuid, uuid, boolean) to authenticated;

-- Links (or unlinks) a role to a task's assignee / approver / follower slot and applies its person.
-- A task has one assignee role at a time. Invoker: RLS decides.
create or replace function public.set_task_role_link(target_task uuid, target_role uuid, link_slot text, linked boolean)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r public.project_roles;
  applied boolean := false;
begin
  if coalesce(link_slot, '') not in ('assignee', 'approver', 'follower') then
    raise exception 'Choose assignee, approver, or follower' using errcode = 'check_violation';
  end if;
  if not public.has_task_role(target_task, 'editor') then
    raise exception 'Only Editors and above change who a task goes to' using errcode = 'insufficient_privilege';
  end if;
  select * into r from public.project_roles where id = target_role and deleted_at is null;
  if not found then
    raise exception 'Role not found' using errcode = 'no_data_found';
  end if;
  if coalesce(linked, false) then
    if link_slot = 'assignee' then
      update public.task_role_links set deleted_at = now()
      where task_id = target_task and slot = 'assignee' and deleted_at is null and project_role_id <> target_role;
    end if;
    insert into public.task_role_links (task_id, project_role_id, slot)
    select target_task, target_role, link_slot
    where not exists (
      select 1 from public.task_role_links l
      where l.task_id = target_task and l.project_role_id = target_role and l.slot = link_slot and l.deleted_at is null
    );
    if r.profile_id is not null then
      if link_slot = 'assignee' then
        -- Linking says "this task goes to whoever fills the role", whoever it was assigned to.
        update public.tasks set assignee_id = r.profile_id where id = target_task and assignee_id is distinct from r.profile_id;
        applied := true;
      else
        applied := public.apply_role_person(target_task, link_slot, r.profile_id, null);
      end if;
    end if;
  else
    update public.task_role_links set deleted_at = now()
    where task_id = target_task and project_role_id = target_role and slot = link_slot and deleted_at is null;
  end if;
  return jsonb_build_object('linked', coalesce(linked, false), 'applied', applied, 'person', r.profile_id);
end;
$$;

select public.alhc_revoke_anon_execute(array['set_task_role_link(uuid, uuid, text, boolean)']);
grant execute on function public.set_task_role_link(uuid, uuid, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Roles in templates and Duplicate project
-- ---------------------------------------------------------------------------------------------------

-- The project's roles for a snapshot: [{ id, name, profile_id? }] (people only when the copy keeps
-- assignees, i.e. Duplicate project with assignees; templates never carry people).
create or replace function public.project_roles_snapshot(source_project uuid, with_people boolean)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'name', r.name, 'profile_id', case when with_people then r.profile_id end
    ) order by r.sort_order, r.created_at), '[]'::jsonb)
  from public.project_roles r
  where r.project_id = source_project and r.deleted_at is null;
$$;

revoke all on function public.project_roles_snapshot(uuid, boolean) from public, anon, authenticated;

-- A task's role links for a snapshot: [{ role_id, slot }] (roles of that project only).
create or replace function public.task_roles_snapshot(source_task uuid, source_project uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('role_id', l.project_role_id, 'slot', l.slot) order by l.created_at), '[]'::jsonb)
  from public.task_role_links l
  join public.project_roles r on r.id = l.project_role_id and r.deleted_at is null and r.project_id = source_project
  where l.task_id = source_task and l.deleted_at is null;
$$;

revoke all on function public.task_roles_snapshot(uuid, uuid) from public, anon, authenticated;

-- Who fills a copied role: the person picked when creating from a template (`chosen`; they join the
-- project as an Editor if they aren't in it), else the source's person when they're in the copy.
create or replace function public.template_role_person(target_project uuid, person jsonb, chosen boolean, actor uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  found_id uuid;
begin
  if person is null or jsonb_typeof(person) <> 'string'
     or (person #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  found_id := (person #>> '{}')::uuid;
  if not public.profile_is_allowlisted(found_id) then
    return null;
  end if;
  if exists (select 1 from public.project_members m where m.project_id = target_project and m.profile_id = found_id and m.deleted_at is null) then
    return found_id;
  end if;
  if not coalesce(chosen, false) then
    return null;
  end if;
  insert into public.project_members (project_id, profile_id, role, created_by)
  values (target_project, found_id, 'editor', actor);
  return found_id;
end;
$$;

revoke all on function public.template_role_person(uuid, jsonb, boolean, uuid) from public, anon, authenticated;

-- Links a copied task to its copied roles and applies their people (quietly: the copy mutes stories and
-- notifications). Approver slots only on approval tasks.
create or replace function public.apply_task_role_links(target_task uuid, links jsonb, id_map jsonb, actor uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  link jsonb;
  new_role uuid;
  person uuid;
  t public.tasks;
begin
  for link in select * from jsonb_array_elements(case when jsonb_typeof(links) = 'array' then links else '[]' end) loop
    continue when not (id_map ? coalesce(link ->> 'role_id', '')) or coalesce(link ->> 'slot', '') not in ('assignee', 'approver', 'follower');
    new_role := (id_map ->> (link ->> 'role_id'))::uuid;
    insert into public.task_role_links (task_id, project_role_id, slot, created_by)
    values (target_task, new_role, link ->> 'slot', actor)
    on conflict do nothing;
    select r.profile_id into person from public.project_roles r where r.id = new_role;
    continue when person is null;
    select * into t from public.tasks where id = target_task;
    if link ->> 'slot' = 'assignee' and t.assignee_id is null then
      update public.tasks set assignee_id = person where id = target_task;
    elsif link ->> 'slot' = 'approver' and t.kind = 'approval' then
      insert into public.task_approvers (task_id, profile_id, added_by)
      select target_task, person, actor
      where not exists (
        select 1 from public.task_approvers a where a.task_id = target_task and a.profile_id = person and a.deleted_at is null
      );
    elsif link ->> 'slot' = 'follower' then
      perform public.follow_task(target_task, person);
    end if;
  end loop;
end;
$$;

revoke all on function public.apply_task_role_links(uuid, jsonb, jsonb, uuid) from public, anon, authenticated;

select public.alhc_patch_function('public.project_snapshot(uuid, jsonb)'::regprocedure,
$p$        'subtasks', public.snapshot_subtasks(st.id, p.id, anchor, want_assignees, want_dates, keep_completion)$p$,
$p$        'roles', public.task_roles_snapshot(st.id, p.id),
        'subtasks', public.snapshot_subtasks(st.id, p.id, anchor, want_assignees, want_dates, keep_completion)$p$,
$p$    'members', case when want_members then coalesce(($p$,
$p$    'roles', public.project_roles_snapshot(p.id, want_assignees),
    'members', case when want_members then coalesce(($p$);

select public.alhc_patch_function('public.instantiate_project_snapshot(jsonb, text, date, uuid, text, jsonb)'::regprocedure,
$p$  sub_result jsonb;
begin$p$,
$p$  sub_result jsonb;
  role_item jsonb;
  role_person uuid;
begin$p$,
$p$  -- Forms (closed until someone opens them; ones that no longer validate are skipped) --------------$p$,
$p$  -- Project roles (Nov 2 notes, batch 14): before forms and rules, whose references to a role
  -- (project_role:<id>) are remapped like sections. People: the ones picked when creating from a
  -- template (snapshot.role_people), else the source's person when they're in the copy.
  i := 0;
  for role_item in select * from jsonb_array_elements(case when jsonb_typeof(snapshot -> 'roles') = 'array' then snapshot -> 'roles' else '[]' end) loop
    continue when nullif(trim(coalesce(role_item ->> 'name', '')), '') is null;
    i := i + 1;
    role_person := public.template_role_person(
      new_project,
      case when jsonb_typeof(snapshot -> 'role_people') = 'object' and (snapshot -> 'role_people') ? (role_item ->> 'id')
        then snapshot -> 'role_people' -> (role_item ->> 'id') else role_item -> 'profile_id' end,
      coalesce(jsonb_typeof(snapshot -> 'role_people') = 'object' and (snapshot -> 'role_people') ? (role_item ->> 'id'), false),
      me
    );
    begin
      insert into public.project_roles (project_id, name, profile_id, sort_order, created_by)
      values (new_project, left(trim(role_item ->> 'name'), 60), role_person, i * 1024, me)
      returning id into found_id;
      if nullif(role_item ->> 'id', '') is not null then
        id_map := id_map || jsonb_build_object(role_item ->> 'id', found_id);
      end if;
    exception when unique_violation or check_violation then
      null; -- a repeated or unusable role name is left out
    end;
  end loop;

  -- Forms (closed until someone opens them; ones that no longer validate are skipped) --------------$p$,
$p$    perform public.apply_task_tags(new_task, item -> 'tags');$p$,
$p$    perform public.apply_task_tags(new_task, item -> 'tags');
    perform public.apply_task_role_links(new_task, item -> 'roles', id_map, me);$p$);

-- The "Customize before creating" step applied to a template's snapshot (pure JSON; nothing is written):
--   { name?, sections: { "<id>": { name?, skip? } }, tasks: { "<id>": { title?, skip? } },
--     fields: { "<id>": { name?, skip? } }, added_tasks: [{ section_id, title }] (≤ 200),
--     roles: { "<role id>": "<profile id>" | null } }
-- A left-out section takes its tasks with it; automations and forms that need a left-out field are left
-- out by the copy (counted), like any reference that no longer validates.
create or replace function public.customize_template_snapshot(snapshot jsonb, customization jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  c jsonb := case when jsonb_typeof(customization) = 'object' then customization else '{}'::jsonb end;
  secs jsonb := case when jsonb_typeof(c -> 'sections') = 'object' then c -> 'sections' else '{}'::jsonb end;
  tsks jsonb := case when jsonb_typeof(c -> 'tasks') = 'object' then c -> 'tasks' else '{}'::jsonb end;
  flds jsonb := case when jsonb_typeof(c -> 'fields') = 'object' then c -> 'fields' else '{}'::jsonb end;
  skipped_sections text[];
  out jsonb := snapshot;
  added jsonb;
  max_order double precision;
begin
  if jsonb_typeof(snapshot) <> 'object' then
    return snapshot;
  end if;
  select coalesce(array_agg(k), '{}') into skipped_sections
  from jsonb_each(secs) e(k, v) where v ->> 'skip' = 'true';

  out := jsonb_set(out, '{sections}', coalesce((
    select jsonb_agg(case when nullif(btrim(coalesce(secs -> (s ->> 'id') ->> 'name', '')), '') is not null
      then jsonb_set(s, '{name}', to_jsonb(left(btrim(secs -> (s ->> 'id') ->> 'name'), 200))) else s end order by o)
    from jsonb_array_elements(coalesce(snapshot -> 'sections', '[]')) with ordinality x(s, o)
    where not (coalesce(s ->> 'id', '') = any (skipped_sections))
  ), '[]'::jsonb));

  out := jsonb_set(out, '{fields}', coalesce((
    select jsonb_agg(case when nullif(btrim(coalesce(flds -> (f ->> 'id') ->> 'name', '')), '') is not null
      then jsonb_set(f, '{name}', to_jsonb(left(btrim(flds -> (f ->> 'id') ->> 'name'), 100))) else f end order by o)
    from jsonb_array_elements(coalesce(snapshot -> 'fields', '[]')) with ordinality x(f, o)
    where coalesce(flds -> (f ->> 'id') ->> 'skip', 'false') <> 'true'
  ), '[]'::jsonb));

  out := jsonb_set(out, '{tasks}', coalesce((
    select jsonb_agg(case when nullif(btrim(coalesce(tsks -> (t ->> 'id') ->> 'title', '')), '') is not null
      then jsonb_set(t, '{title}', to_jsonb(left(btrim(tsks -> (t ->> 'id') ->> 'title'), 1000))) else t end order by o)
    from jsonb_array_elements(coalesce(snapshot -> 'tasks', '[]')) with ordinality x(t, o)
    where coalesce(tsks -> (t ->> 'id') ->> 'skip', 'false') <> 'true'
      and not (coalesce(t ->> 'section_id', '') = any (skipped_sections))
  ), '[]'::jsonb));

  if jsonb_typeof(c -> 'added_tasks') = 'array' then
    select coalesce(max((t ->> 'sort_order')::double precision), 0) into max_order
    from jsonb_array_elements(out -> 'tasks') t where jsonb_typeof(t -> 'sort_order') = 'number';
    select coalesce(jsonb_agg(jsonb_build_object(
        'title', left(btrim(a ->> 'title'), 1000),
        'section_id', nullif(a ->> 'section_id', ''),
        'sort_order', max_order + o * 1024,
        'kind', 'task'
      ) order by o), '[]'::jsonb) into added
    from jsonb_array_elements(c -> 'added_tasks') with ordinality x(a, o)
    where o <= 200 and nullif(btrim(coalesce(a ->> 'title', '')), '') is not null
      and not (coalesce(a ->> 'section_id', '') = any (skipped_sections));
    out := jsonb_set(out, '{tasks}', (out -> 'tasks') || added);
  end if;

  if jsonb_typeof(c -> 'roles') = 'object' then
    out := out || jsonb_build_object('role_people', c -> 'roles');
  end if;
  return out;
end;
$$;

select public.alhc_revoke_anon_execute(array['customize_template_snapshot(jsonb, jsonb)']);
grant execute on function public.customize_template_snapshot(jsonb, jsonb) to authenticated;

-- Creates a project from a template after the "Customize before creating" step. Anyone signed in may
-- create projects from templates (like create_project_from_template); the caller owns the copy, and the
-- people picked for its roles join it as Editors.
create or replace function public.create_project_from_template_custom(
  target_template uuid,
  project_name text,
  start_on date default null,
  customization jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.project_templates;
begin
  select * into t from public.project_templates where id = target_template and deleted_at is null;
  if not found or not public.is_allowlisted() then
    raise exception 'Template not found' using errcode = 'no_data_found';
  end if;
  return public.instantiate_project_snapshot(
    public.customize_template_snapshot(t.content, customization),
    project_name, coalesce(start_on, current_date), t.workspace_id, 'created_from_template',
    jsonb_build_object('template_id', t.id, 'template_name', t.name, 'customized', true)
  );
end;
$$;

revoke all on function public.create_project_from_template_custom(uuid, text, date, jsonb) from public, anon;
grant execute on function public.create_project_from_template_custom(uuid, text, date, jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Automations: "the person in role X" (project_role:<id>)
-- ---------------------------------------------------------------------------------------------------

select public.alhc_patch_function('public.resolve_rule_person(jsonb, uuid)'::regprocedure,
$p$    when (person #>> '{}') ~* '^field:[0-9a-f-]{36}$' then (public.rule_field_people(target_task, person #>> '{}'))[1]$p$,
$p$    when (person #>> '{}') ~* '^field:[0-9a-f-]{36}$' then (public.rule_field_people(target_task, person #>> '{}'))[1]
    when (person #>> '{}') ~* '^project_role:[0-9a-f-]{36}$' then (
      select r.profile_id from public.project_roles r
      where r.id::text = substr(person #>> '{}', 14) and r.deleted_at is null
    )$p$);

select public.alhc_patch_function('public.rule_person_ok(jsonb)'::regprocedure,
$p$    or ((person #>> '{}') ~* '^field:[0-9a-f-]{36}$' and exists ($p$,
$p$    or ((person #>> '{}') ~* '^project_role:[0-9a-f-]{36}$' and exists (
      select 1 from public.project_roles r where r.id::text = substr(person #>> '{}', 14) and r.deleted_at is null
    ))
    or ((person #>> '{}') ~* '^field:[0-9a-f-]{36}$' and exists ($p$);

select public.alhc_patch_function('public.rule_person_in_project(uuid, jsonb)'::regprocedure,
$p$  select public.rule_person_ok(person) and ($p$,
$p$  select public.rule_person_ok(person) and (
    (person #>> '{}') !~* '^project_role:'
    or exists (
      select 1 from public.project_roles r
      where r.id::text = substr(person #>> '{}', 14) and r.project_id = target_project and r.deleted_at is null
    )
  ) and ($p$);

select public.alhc_patch_function('public.rule_side_people(text, uuid)'::regprocedure,
$p$    when side ~* '^field:[0-9a-f-]{36}$' then public.rule_field_people(target_task, side)$p$,
$p$    when side ~* '^field:[0-9a-f-]{36}$' then public.rule_field_people(target_task, side)
    when side ~* '^project_role:[0-9a-f-]{36}$' then (
      select array_remove(array[r.profile_id], null) from public.project_roles r
      where r.id::text = substr(side, 14) and r.deleted_at is null
    )$p$);

-- Send email to the person in a role ({ to: "role", role_id }).
select public.alhc_patch_function('public.execute_rule_actions(rules, uuid, jsonb, jsonb)'::regprocedure,
$p$            when 'address' then a ->> 'address'
          end;$p$,
$p$            when 'address' then a ->> 'address'
            when 'role' then (
              select pr.email from public.project_roles pro
              join public.profiles pr on pr.id = pro.profile_id
              where pro.id::text = a ->> 'role_id' and pro.deleted_at is null
            )
          end;$p$,
$p$            when 'field' then 'the address in a field' else 'a fixed address' end,$p$,
$p$            when 'field' then 'the address in a field' when 'role' then 'the person in a project role' else 'a fixed address' end,$p$);

select public.alhc_patch_function('public.validate_rule()'::regprocedure,
$p$        if item ->> 'to' is null or item ->> 'to' not in ('submitter', 'assignee', 'field', 'address') then
          raise exception 'Send email: choose a recipient' using errcode = 'check_violation';
        end if;$p$,
$p$        if item ->> 'to' is null or item ->> 'to' not in ('submitter', 'assignee', 'field', 'address', 'role') then
          raise exception 'Send email: choose a recipient' using errcode = 'check_violation';
        end if;
        if item ->> 'to' = 'role' and not exists (
          select 1 from public.project_roles r
          where r.id::text = item ->> 'role_id' and r.project_id = new.project_id and r.deleted_at is null
        ) then
          raise exception 'Send email: choose one of this project''s roles' using errcode = 'check_violation';
        end if;$p$,
$p$        if item ? 'webhook_url' then
          raise exception 'Send Slack message: webhook URLs are stored separately' using errcode = 'check_violation';
        end if;$p$,
$p$        if item ? 'webhook_url' then
          raise exception 'Send Slack message: webhook URLs are stored separately' using errcode = 'check_violation';
        end if;
        -- Nov 2 notes (batch 14): a Slack channel or webhook saved at workspace level.
        if item ? 'destination_id' and item -> 'destination_id' <> 'null'::jsonb
           and not public.slack_destination_usable(new.project_id, item ->> 'destination_id') then
          raise exception 'Send Slack message: choose a Slack channel connected in Admin console → Integrations'
            using errcode = 'check_violation';
        end if;$p$);

-- =================================================================================================
-- 4. Slack, connected once per workspace (105)
-- =================================================================================================

create table if not exists public.slack_connections (
  workspace_id uuid primary key references public.workspaces (id),
  bot_token text not null,
  team_id text,
  team_name text,
  bot_user_id text,
  connected_by uuid references public.profiles (id),
  connected_at timestamptz not null default now(),
  channels_refreshed_at timestamptz,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint slack_connections_token_check check (bot_token ~ '^xox[bp]-[A-Za-z0-9-]{10,250}$')
);

create index if not exists slack_connections_connected_by_idx on public.slack_connections (connected_by);

alter table public.slack_connections enable row level security;
revoke all on public.slack_connections from anon, authenticated;
select public.alhc_revoke_anon_grants(array['slack_connections']);
select public.alhc_revoke_client_truncate(array['slack_connections']);

comment on table public.slack_connections is
  'Nov 2 notes (batch 14): the workspace''s Slack app (its bot token), connected once by a workspace admin '
  '(Admin console → Integrations). No client access: the token never leaves the database except to the '
  'app''s own delivery drain and channel refresh (service role).';

create table if not exists public.slack_destinations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  -- channel = a channel the connected Slack app posts to; webhook = a Slack incoming webhook saved here.
  kind text not null,
  slack_channel_id text,
  name text not null,
  is_private boolean not null default false,
  webhook_url text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint slack_destinations_kind_check check (kind in ('channel', 'webhook')),
  constraint slack_destinations_shape_check check (
    (kind = 'channel' and slack_channel_id ~ '^[A-Z0-9]{6,30}$' and webhook_url is null)
    or (kind = 'webhook' and slack_channel_id is null and webhook_url is not null and public.integration_url_ok(webhook_url))
  ),
  constraint slack_destinations_name_check check (char_length(btrim(name)) between 1 and 100)
);

create unique index if not exists slack_destinations_one_channel on public.slack_destinations (workspace_id, slack_channel_id)
  where deleted_at is null and kind = 'channel';
create unique index if not exists slack_destinations_one_webhook on public.slack_destinations (workspace_id, webhook_url)
  where deleted_at is null and kind = 'webhook';
create index if not exists slack_destinations_created_by_idx on public.slack_destinations (created_by);

alter table public.slack_destinations enable row level security;
revoke all on public.slack_destinations from anon, authenticated;
select public.alhc_revoke_anon_grants(array['slack_destinations']);
select public.alhc_revoke_client_truncate(array['slack_destinations']);

comment on table public.slack_destinations is
  'Nov 2 notes (batch 14): where Slack messages can go, chosen per project (Settings → Integrations) or per '
  'automation action: channels of the workspace''s connected Slack app, and Slack incoming webhooks saved '
  'once at workspace level (every project''s old Slack webhook was copied here). No client access; names '
  'through slack_settings(), never a URL.';

create trigger slack_destinations_set_updated_at
  before update on public.slack_destinations
  for each row execute function public.set_updated_at();

create trigger slack_connections_set_updated_at
  before update on public.slack_connections
  for each row execute function public.set_updated_at();

alter table public.project_integrations add column if not exists slack_destination_id uuid references public.slack_destinations (id);
create index if not exists project_integrations_slack_destination_idx on public.project_integrations (slack_destination_id);

comment on column public.project_integrations.slack_destination_id is
  'Nov 2 notes (batch 14): the project''s Slack channel (a workspace destination). When set it wins over '
  'slack_webhook_url, which stays as it was for the release still on main.';

-- One-time: every project's own Slack webhook becomes a workspace destination (one per distinct URL)
-- chosen for that project, so nothing has to be reconnected.
insert into public.slack_destinations (workspace_id, kind, name, webhook_url, created_by)
select distinct on (p.workspace_id, pi.slack_webhook_url)
  p.workspace_id, 'webhook',
  left(p.name || ' (Slack webhook)', 100),
  pi.slack_webhook_url, pi.updated_by
from public.project_integrations pi
join public.projects p on p.id = pi.project_id
where pi.deleted_at is null and coalesce(pi.slack_webhook_url, '') <> ''
  and public.integration_url_ok(pi.slack_webhook_url)
  and not exists (
    select 1 from public.slack_destinations d
    where d.workspace_id = p.workspace_id and d.kind = 'webhook' and d.webhook_url = pi.slack_webhook_url and d.deleted_at is null
  )
order by p.workspace_id, pi.slack_webhook_url, p.created_at;

update public.project_integrations pi
set slack_destination_id = d.id
from public.projects p, public.slack_destinations d
where p.id = pi.project_id and d.workspace_id = p.workspace_id and d.kind = 'webhook'
  and d.webhook_url = pi.slack_webhook_url and d.deleted_at is null
  and pi.slack_destination_id is null and pi.deleted_at is null;

-- Whether a Slack destination id is a live one of the project's workspace (validate_rule runs as the
-- caller, who can't read slack_destinations). A yes / no only, about a project the caller can read.
create or replace function public.slack_destination_usable(target_project uuid, destination text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_project_role(target_project, 'viewer') and exists (
    select 1 from public.slack_destinations d
    join public.projects p on p.id = target_project and p.workspace_id = d.workspace_id
    where d.id::text = destination and d.deleted_at is null
  );
$$;

revoke all on function public.slack_destination_usable(uuid, text) from public, anon;
grant execute on function public.slack_destination_usable(uuid, text) to authenticated;

-- What anyone signed in may know: whether Slack is connected, and the destinations' names (never a
-- token or URL; a webhook shows its redacted hint).
create or replace function public.slack_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  ws uuid := public.default_workspace_id();
  conn public.slack_connections;
begin
  if not public.is_allowlisted() then
    raise exception 'Sign in first' using errcode = 'insufficient_privilege';
  end if;
  select * into conn from public.slack_connections c where c.workspace_id = ws and c.deleted_at is null;
  return jsonb_build_object(
    'connected', conn.workspace_id is not null,
    'team_name', conn.team_name,
    'connected_at', conn.connected_at,
    'channels_refreshed_at', conn.channels_refreshed_at,
    'destinations', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', d.id, 'kind', d.kind, 'name', d.name, 'is_private', d.is_private,
          'hint', case when d.kind = 'webhook' then public.integration_url_hint(d.webhook_url) end,
          -- A channel posts only while the app stays connected.
          'available', d.kind = 'webhook' or conn.workspace_id is not null
        ) order by d.kind, lower(d.name))
      from public.slack_destinations d where d.workspace_id = ws and d.deleted_at is null
    ), '[]'::jsonb),
    -- For workspace admins: how many projects still post through a webhook of their own.
    'legacy_projects', case when public.is_workspace_admin(ws) then (
      select count(*) from public.project_integrations pi
      join public.projects p on p.id = pi.project_id and p.workspace_id = ws and p.deleted_at is null
      where pi.deleted_at is null and pi.slack_destination_id is null and coalesce(pi.slack_webhook_url, '') <> ''
    ) end
  );
end;
$$;

revoke all on function public.slack_settings() from public, anon;
grant execute on function public.slack_settings() to authenticated;

-- Workspace admins manage the connection and the destinations:
--   connect        { token, team_id, team_name, bot_user_id, channels: [{ id, name, is_private }] }
--   sync_channels  { channels: [...] }   (the app read them from Slack with the stored token)
--   disconnect     {}                     (channels stay listed but can't post until connected again)
--   add_webhook    { name, url }
--   rename         { id, name }
--   remove         { id }
-- The token and channel lists come from the app's server action, which checks them with Slack first.
create or replace function public.manage_slack_workspace(slack_action text, payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws uuid := public.default_workspace_id();
  me uuid := auth.uid();
  ch jsonb;
  kept text[] := '{}';
  new_id uuid;
begin
  if not public.is_workspace_admin(ws) then
    raise exception 'Only workspace admins manage Slack' using errcode = 'insufficient_privilege';
  end if;
  payload := case when jsonb_typeof(payload) = 'object' then payload else '{}'::jsonb end;

  if slack_action in ('connect', 'sync_channels') then
    if slack_action = 'connect' then
      if coalesce(payload ->> 'token', '') !~ '^xox[bp]-[A-Za-z0-9-]{10,250}$' then
        raise exception 'That isn''t a Slack bot token (it starts with xoxb-)' using errcode = 'check_violation';
      end if;
      insert into public.slack_connections as c (workspace_id, bot_token, team_id, team_name, bot_user_id, connected_by,
        connected_at, channels_refreshed_at, deleted_at)
      values (ws, payload ->> 'token', left(payload ->> 'team_id', 40), left(payload ->> 'team_name', 200),
        left(payload ->> 'bot_user_id', 40), me, now(), now(), null)
      on conflict (workspace_id) do update set
        bot_token = excluded.bot_token, team_id = excluded.team_id, team_name = excluded.team_name,
        bot_user_id = excluded.bot_user_id, connected_by = excluded.connected_by, connected_at = now(),
        channels_refreshed_at = now(), deleted_at = null;
    else
      if not exists (select 1 from public.slack_connections c where c.workspace_id = ws and c.deleted_at is null) then
        raise exception 'Connect Slack first' using errcode = 'no_data_found';
      end if;
      update public.slack_connections set channels_refreshed_at = now() where workspace_id = ws;
    end if;
    for ch in select * from jsonb_array_elements(case when jsonb_typeof(payload -> 'channels') = 'array' then payload -> 'channels' else '[]' end) loop
      continue when coalesce(ch ->> 'id', '') !~ '^[A-Z0-9]{6,30}$' or nullif(btrim(coalesce(ch ->> 'name', '')), '') is null;
      kept := kept || (ch ->> 'id');
      update public.slack_destinations
      set name = left(btrim(ch ->> 'name'), 100), is_private = coalesce((ch ->> 'is_private')::boolean, false)
      where workspace_id = ws and kind = 'channel' and slack_channel_id = ch ->> 'id' and deleted_at is null;
      if not found then
        insert into public.slack_destinations (workspace_id, kind, slack_channel_id, name, is_private, created_by)
        values (ws, 'channel', ch ->> 'id', left(btrim(ch ->> 'name'), 100), coalesce((ch ->> 'is_private')::boolean, false), me);
      end if;
    end loop;
    -- Channels the app can no longer see are taken off the list (projects using one fall back to their
    -- old webhook, if any, and their automations report it).
    update public.slack_destinations set deleted_at = now()
    where workspace_id = ws and kind = 'channel' and deleted_at is null and not (slack_channel_id = any (kept));
    return jsonb_build_object('channels', cardinality(kept));
  elsif slack_action = 'disconnect' then
    update public.slack_connections set deleted_at = now() where workspace_id = ws and deleted_at is null;
    return jsonb_build_object('disconnected', found);
  elsif slack_action = 'add_webhook' then
    if nullif(btrim(coalesce(payload ->> 'name', '')), '') is null then
      raise exception 'Name the channel this webhook posts to' using errcode = 'check_violation';
    end if;
    if not public.integration_url_ok(payload ->> 'url') or (payload ->> 'url') !~* '^https://hooks\.slack\.com/' then
      raise exception 'Paste a Slack incoming webhook URL (https://hooks.slack.com/…)' using errcode = 'check_violation';
    end if;
    insert into public.slack_destinations (workspace_id, kind, name, webhook_url, created_by)
    values (ws, 'webhook', left(btrim(payload ->> 'name'), 100), payload ->> 'url', me)
    returning id into new_id;
    return jsonb_build_object('id', new_id);
  elsif slack_action = 'rename' then
    if nullif(btrim(coalesce(payload ->> 'name', '')), '') is null then
      raise exception 'Name can''t be empty' using errcode = 'check_violation';
    end if;
    update public.slack_destinations set name = left(btrim(payload ->> 'name'), 100)
    where id::text = payload ->> 'id' and workspace_id = ws and deleted_at is null;
    if not found then
      raise exception 'Not found' using errcode = 'no_data_found';
    end if;
    return jsonb_build_object('id', payload ->> 'id');
  elsif slack_action = 'remove' then
    update public.slack_destinations set deleted_at = now()
    where id::text = payload ->> 'id' and workspace_id = ws and deleted_at is null;
    if not found then
      raise exception 'Not found' using errcode = 'no_data_found';
    end if;
    return jsonb_build_object('id', payload ->> 'id');
  end if;
  raise exception 'Unknown Slack action' using errcode = 'check_violation';
end;
$$;

revoke all on function public.manage_slack_workspace(text, jsonb) from public, anon;
grant execute on function public.manage_slack_workspace(text, jsonb) to authenticated;

-- A project's Slack channel (Admin+ of the project, like the rest of its integration settings).
create or replace function public.set_project_slack_destination(target_project uuid, destination uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws uuid;
  d public.slack_destinations;
begin
  if not public.has_project_role(target_project, 'admin') then
    raise exception 'Only project admins change integration settings' using errcode = 'insufficient_privilege';
  end if;
  select p.workspace_id into ws from public.projects p where p.id = target_project and p.deleted_at is null;
  if destination is not null then
    select * into d from public.slack_destinations
    where id = destination and workspace_id = ws and deleted_at is null;
    if not found then
      raise exception 'That Slack channel isn''t connected' using errcode = 'no_data_found';
    end if;
  end if;
  insert into public.project_integrations as pi (project_id, slack_destination_id, updated_by)
  values (target_project, destination, auth.uid())
  on conflict (project_id) do update set slack_destination_id = excluded.slack_destination_id,
    updated_by = excluded.updated_by, updated_at = now(), deleted_at = null;
  return jsonb_build_object('id', d.id, 'name', d.name, 'kind', d.kind);
end;
$$;

revoke all on function public.set_project_slack_destination(uuid, uuid) from public, anon;
grant execute on function public.set_project_slack_destination(uuid, uuid) to authenticated;

-- The bot token for the app's channel refresh (service role only; checked as a workspace admin by the
-- app first). Never readable by clients.
create or replace function public.slack_bot_token(target_workspace uuid default null)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select c.bot_token from public.slack_connections c
  where c.workspace_id = coalesce(target_workspace, public.default_workspace_id()) and c.deleted_at is null;
$$;

revoke all on function public.slack_bot_token(uuid) from public, anon, authenticated;
grant execute on function public.slack_bot_token(uuid) to service_role;

select public.alhc_patch_function('public.get_project_integrations(uuid)'::regprocedure,
$p$    'slack_webhook', public.integration_url_hint(settings.slack_webhook_url),$p$,
$p$    'slack_webhook', public.integration_url_hint(settings.slack_webhook_url),
    'slack_destination', (
      select jsonb_build_object('id', d.id, 'name', d.name, 'kind', d.kind)
      from public.slack_destinations d where d.id = settings.slack_destination_id and d.deleted_at is null
    ),$p$);

-- Where a Slack message goes: the action's own channel (destination_id), else its own webhook, else the
-- project's channel, else the project's webhook. A channel posts through the connected app (Slack's
-- chat.postMessage with the bot token in the Authorization header; the outbox has no client access).
select public.alhc_patch_function('public.enqueue_integration(rules, uuid, jsonb, jsonb)'::regprocedure,
$p$  t public.tasks;
  new_id uuid;
begin$p$,
$p$  t public.tasks;
  new_id uuid;
  dest public.slack_destinations;
  dest_id uuid;
  bot text;
  slack_channel text;
  target_label text;
begin$p$,
$p$  if url is null then
    url := case ch when 'slack' then settings.slack_webhook_url else settings.webhook_url end;
  end if;$p$,
$p$  -- Nov 2 notes (batch 14): Slack channels and webhooks saved once at workspace level.
  if ch = 'slack' and url is null then
    dest_id := case
      when not use_project and coalesce(action ->> 'destination_id', '') ~* '^[0-9a-f-]{36}$' then (action ->> 'destination_id')::uuid
      else settings.slack_destination_id end;
    if dest_id is not null then
      select * into dest from public.slack_destinations d
      where d.id = dest_id and d.deleted_at is null
        and d.workspace_id = (select p.workspace_id from public.projects p where p.id = r.project_id);
      if found and dest.kind = 'webhook' then
        url := dest.webhook_url;
      elsif found then
        select c.bot_token into bot from public.slack_connections c where c.workspace_id = dest.workspace_id and c.deleted_at is null;
        if bot is null then
          raise exception 'Send Slack message: Slack isn''t connected any more (Admin console → Integrations)' using errcode = 'check_violation';
        end if;
        url := 'https://slack.com/api/chat.postMessage';
        slack_channel := dest.slack_channel_id;
        target_label := '#' || dest.name;
      end if;
    end if;
  end if;
  if url is null then
    url := case ch when 'slack' then settings.slack_webhook_url else settings.webhook_url end;
  end if;$p$,
$p$    body := case when action ->> 'format' = 'blocks'
      then public.slack_block_payload(message, target_task, r.project_id)
      else jsonb_build_object('text', message) end;$p$,
$p$    body := case when action ->> 'format' = 'blocks'
      then public.slack_block_payload(message, target_task, r.project_id)
      else jsonb_build_object('text', message) end;
    if slack_channel is not null then
      body := body || jsonb_build_object('channel', slack_channel, 'unfurl_links', false);
      secret := 'Bearer ' || bot;
      header := 'Authorization';
    end if;$p$,
$p$    url, public.integration_url_hint(url),$p$,
$p$    url, coalesce(target_label, public.integration_url_hint(url)),$p$,
$p$      'outbox_id', new_id, 'channel', ch, 'target', public.integration_url_hint(url)$p$,
$p$      'outbox_id', new_id, 'channel', ch, 'target', coalesce(target_label, public.integration_url_hint(url))$p$);
