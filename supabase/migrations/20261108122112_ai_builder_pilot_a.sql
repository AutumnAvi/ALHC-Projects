-- AI builder phase 1: an isolated, project-first pilot in a separate "Testing data" workspace.
-- EXPERIMENTAL (branch feat/ai-builder, draft PR "feat: AI builder phase 1 (do not merge)"). Additive:
-- nothing above the TAIL removes an object or a row. The TAIL (applied by hand, like every tail) holds the
-- one-command pilot cleanup, the only code here that removes rows.
--
-- What this adds:
--   * ai_pilot_workspaces: the registry of pilot workspaces. A workspace is a pilot only while it has a row
--     here with its marker (a uuid the operator keeps) and no cleaned_at. Nothing trusts a workspace name a
--     client sends: every AI path asks ai_pilot_admin(workspace id), which needs this row, a live workspace
--     that isn't the main (oldest) workspace, and the caller being a workspace admin of that workspace.
--     No client writes the registry; ai_pilot_ensure_workspace() (definer) creates the one pilot.
--   * ai_pilot_ensure_workspace(marker): run by the seed script as the signed-in operator (a workspace admin
--     of the main workspace). Idempotent: the same marker returns the same workspace; a different live
--     pilot, or an unregistered live workspace already named "Testing data", is refused (ambiguous).
--     Creates the workspace, registers it, makes the caller its workspace admin, and trims its default
--     team to the caller (the default-team trigger adds every allowlisted person to a new workspace's
--     default team; nobody else belongs in the pilot).
--   * ai_pilot_seed_items + ai_pilot_seed_comment / ai_pilot_seed_field_value (invoker): what the Asana
--     importer can't carry (subtask comments and field values, a multi-homed task's other project's
--     values), written once per source key in one transaction each, only inside a pilot workspace.
--   * ai_builder_runs: the AI builder's log (actor, workspace, status, model, token usage, the validated
--     proposal and its version, the created ids, a fingerprint of what was created). Pilot admins of the
--     workspace read it; each person writes only their own runs, through the guard below. Never the
--     brief's text, the prompt, the provider's raw answer, or any key — only the brief's length.
--     Rate limits live in the insert guard (so they hold across every server instance): 10 runs an hour
--     and 30 a day per person, 60 a day per pilot workspace, and at most 2 generating at once per person.
--   * ai_builder_apply(run, version, local_today) (invoker): creates the run's proposal — one new private
--     project with its sections, fields, starter tasks, values, and subtasks — in ONE transaction as the
--     signed-in person (RLS and every trigger as for their own edits), records what it created, and is
--     idempotent (a second call returns the first answer). New projects have no automations, members,
--     forms, or integrations, and nothing is assigned, so nothing notifies or sends anything.
--   * ai_builder_undo(run) (invoker): moves the run's project to the Trash (the project menu's own soft removal,
--     owners only) only while everything the run created is unchanged (ai_builder_project_fingerprint);
--     otherwise it records and reports what changed and touches nothing. Repeating it is harmless.
--
-- No new anon access. New client definers (suite 60): ai_pilot_ensure_workspace only.

-- ---------------------------------------------------------------------------------------------------
-- Registry
-- ---------------------------------------------------------------------------------------------------

create table public.ai_pilot_workspaces (
  -- No foreign key on purpose: the row outlives a cleaned-up workspace as its audit record.
  workspace_id uuid primary key,
  marker uuid not null unique,
  name text not null default 'Testing data' check (name = 'Testing data'),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  cleaned_at timestamptz,
  cleanup_report jsonb
);

create index ai_pilot_workspaces_created_by_idx on public.ai_pilot_workspaces (created_by);

alter table public.ai_pilot_workspaces enable row level security;
select public.alhc_revoke_anon_grants(array['ai_pilot_workspaces']);
select public.alhc_revoke_client_truncate(array['ai_pilot_workspaces']);
revoke insert, update on public.ai_pilot_workspaces from authenticated;

comment on table public.ai_pilot_workspaces is
  'AI builder pilot (experimental): the registry of isolated pilot workspaces. A workspace is a pilot only while it has a row here and cleaned_at is null. Written only by ai_pilot_ensure_workspace() and the hand-applied ai_pilot_cleanup().';

-- The main workspace: the oldest live one (what the app uses).
create or replace function public.ai_main_workspace_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select w.id from public.workspaces w where w.deleted_at is null order by w.created_at, w.id limit 1;
$$;

revoke all on function public.ai_main_workspace_id() from public, anon;
grant execute on function public.ai_main_workspace_id() to authenticated;

-- Is target_workspace a live, registered pilot workspace (never the main one) and is the caller one of its
-- workspace admins? Every AI builder path asks this; fail closed (null → false).
create or replace function public.ai_pilot_admin(target_workspace uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    target_workspace is not null
    and target_workspace is distinct from public.ai_main_workspace_id()
    and public.is_workspace_admin(target_workspace)
    and exists (
      select 1 from public.ai_pilot_workspaces r
      join public.workspaces w on w.id = r.workspace_id and w.deleted_at is null
      where r.workspace_id = target_workspace and r.cleaned_at is null
    ),
    false);
$$;

revoke all on function public.ai_pilot_admin(uuid) from public, anon;
grant execute on function public.ai_pilot_admin(uuid) to authenticated;

create policy ai_pilot_workspaces_select_admin on public.ai_pilot_workspaces
  for select to authenticated
  using ((select public.is_workspace_admin(workspace_id)) and cleaned_at is null);

-- Creates (once) or returns the pilot workspace for this marker. Only a workspace admin of the main
-- workspace. Serialized by an advisory lock so two seeds can't make two pilots.
create or replace function public.ai_pilot_ensure_workspace(pilot_marker uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  main uuid := public.ai_main_workspace_id();
  reg record;
  ws uuid;
  team uuid;
begin
  if me is null or not public.is_allowlisted() then
    raise exception 'Sign in first' using errcode = 'insufficient_privilege';
  end if;
  if main is null or not public.profile_is_workspace_admin(me, main) then
    raise exception 'Only workspace admins can set up the Testing data pilot' using errcode = 'insufficient_privilege';
  end if;
  if pilot_marker is null then
    raise exception 'A pilot marker is required' using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('alhc.ai_pilot', 0));

  select r.* into reg from public.ai_pilot_workspaces r where r.marker = pilot_marker;
  if found then
    if reg.cleaned_at is not null then
      raise exception 'That pilot was cleaned up; use a new marker' using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from public.workspaces w
      where w.id = reg.workspace_id and w.deleted_at is null and w.name = 'Testing data'
    ) then
      raise exception 'The pilot workspace for that marker is missing or renamed; refusing' using errcode = 'check_violation';
    end if;
    if not public.profile_is_workspace_admin(me, reg.workspace_id) then
      raise exception 'You aren''t an admin of the Testing data workspace' using errcode = 'insufficient_privilege';
    end if;
    return jsonb_build_object('workspace_id', reg.workspace_id, 'marker', reg.marker, 'created', false);
  end if;

  if exists (select 1 from public.ai_pilot_workspaces r where r.cleaned_at is null) then
    raise exception 'Another Testing data pilot already exists; pass its marker'
      using errcode = 'check_violation', hint = 'Its workspace admins can read the marker in ai_pilot_workspaces.';
  end if;
  if exists (
    select 1 from public.workspaces w where w.deleted_at is null and lower(btrim(w.name)) = 'testing data'
  ) then
    raise exception 'A workspace named Testing data already exists and isn''t a registered pilot; refusing (ambiguous)'
      using errcode = 'check_violation';
  end if;

  insert into public.workspaces (name) values ('Testing data') returning id into ws;
  insert into public.ai_pilot_workspaces (workspace_id, marker, created_by) values (ws, pilot_marker, me);
  insert into public.workspace_admins (workspace_id, profile_id, created_by) values (ws, me, me);

  -- The default-team trigger (ensure_default_team) made a team with every allowlisted person: keep only
  -- the operator, as its lead.
  select w.default_team_id into team from public.workspaces w where w.id = ws;
  if team is not null then
    update public.teams set name = 'Testing data', description = 'AI builder pilot. Practice data only.' where id = team;
    update public.team_members set role = 'lead'
    where team_id = team and profile_id = me and deleted_at is null and role <> 'lead';
    if not exists (select 1 from public.team_members m where m.team_id = team and m.profile_id = me and m.deleted_at is null) then
      insert into public.team_members (team_id, profile_id, role, created_by) values (team, me, 'lead', me);
    end if;
    update public.team_members set deleted_at = now()
    where team_id = team and profile_id <> me and deleted_at is null;
  end if;

  return jsonb_build_object('workspace_id', ws, 'marker', pilot_marker, 'created', true);
end;
$$;

revoke all on function public.ai_pilot_ensure_workspace(uuid) from public, anon;
grant execute on function public.ai_pilot_ensure_workspace(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Seed supplements (what the importer can't carry)
-- ---------------------------------------------------------------------------------------------------

create table public.ai_pilot_seed_items (
  workspace_id uuid not null references public.workspaces (id),
  kind text not null check (kind in ('comment', 'field_value')),
  source_key text not null check (char_length(source_key) between 1 and 200),
  local_id uuid,
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  primary key (workspace_id, kind, source_key)
);

create index ai_pilot_seed_items_created_by_idx on public.ai_pilot_seed_items (created_by);

alter table public.ai_pilot_seed_items enable row level security;
select public.alhc_revoke_anon_grants(array['ai_pilot_seed_items']);
select public.alhc_revoke_client_truncate(array['ai_pilot_seed_items']);
revoke insert, update on public.ai_pilot_seed_items from authenticated;
grant insert (workspace_id, kind, source_key, local_id) on public.ai_pilot_seed_items to authenticated;

create policy ai_pilot_seed_items_select_admin on public.ai_pilot_seed_items
  for select to authenticated using ((select public.ai_pilot_admin(workspace_id)));
create policy ai_pilot_seed_items_insert_admin on public.ai_pilot_seed_items
  for insert to authenticated
  with check (created_by = (select auth.uid()) and (select public.ai_pilot_admin(workspace_id)));

-- The task must be a live task of the pilot workspace the caller administers.
create or replace function public.ai_pilot_seed_task_ok(target_workspace uuid, target_task uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select public.ai_pilot_admin(target_workspace) and exists (
    select 1 from public.tasks t where t.id = target_task and t.workspace_id = target_workspace and t.deleted_at is null
  );
$$;

revoke all on function public.ai_pilot_seed_task_ok(uuid, uuid) from public, anon;
grant execute on function public.ai_pilot_seed_task_ok(uuid, uuid) to authenticated;

-- One comment per source key, posted as the caller (so RLS and the comment triggers apply). Returns the
-- comment id (the existing one when the key was already seeded).
create or replace function public.ai_pilot_seed_comment(target_workspace uuid, source_key text, target_task uuid, comment_body text)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  done uuid;
  made uuid;
begin
  if not public.ai_pilot_seed_task_ok(target_workspace, target_task) then
    raise exception 'Not a task of a pilot workspace you administer' using errcode = 'insufficient_privilege';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('alhc.ai_pilot_seed:' || target_workspace::text || ':' || source_key, 0));
  select i.local_id into done from public.ai_pilot_seed_items i
  where i.workspace_id = target_workspace and i.kind = 'comment' and i.source_key = ai_pilot_seed_comment.source_key;
  if found then
    return done;
  end if;
  if coalesce(btrim(comment_body), '') = '' or char_length(comment_body) > 10000 then
    raise exception 'Comment text must be 1–10,000 characters' using errcode = 'check_violation';
  end if;
  insert into public.comments (task_id, author_id, body) values (target_task, auth.uid(), comment_body) returning id into made;
  insert into public.ai_pilot_seed_items (workspace_id, kind, source_key, local_id)
  values (target_workspace, 'comment', ai_pilot_seed_comment.source_key, made);
  return made;
end;
$$;

revoke all on function public.ai_pilot_seed_comment(uuid, text, uuid, text) from public, anon;
grant execute on function public.ai_pilot_seed_comment(uuid, text, uuid, text) to authenticated;

-- One field value per source key. Never overwrites: a value already there (someone's later edit, or the
-- importer's) is kept and the key is recorded as done. Returns 'set', 'kept', or 'done'.
create or replace function public.ai_pilot_seed_field_value(target_workspace uuid, source_key text, target_task uuid, target_field uuid, new_value jsonb)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  outcome text := 'set';
begin
  if not public.ai_pilot_seed_task_ok(target_workspace, target_task) then
    raise exception 'Not a task of a pilot workspace you administer' using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1 from public.custom_fields f join public.projects p on p.id = f.project_id
    where f.id = target_field and f.deleted_at is null and p.workspace_id = target_workspace
  ) then
    raise exception 'Not a field of the pilot workspace' using errcode = 'insufficient_privilege';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('alhc.ai_pilot_seed:' || target_workspace::text || ':' || source_key, 0));
  if exists (
    select 1 from public.ai_pilot_seed_items i
    where i.workspace_id = target_workspace and i.kind = 'field_value' and i.source_key = ai_pilot_seed_field_value.source_key
  ) then
    return 'done';
  end if;
  if exists (
    select 1 from public.task_field_values v
    where v.task_id = target_task and v.field_id = target_field and v.value is not null and v.value <> 'null'::jsonb
  ) then
    outcome := 'kept';
  else
    insert into public.task_field_values (task_id, field_id, value) values (target_task, target_field, new_value)
    on conflict (task_id, field_id) do update set value = excluded.value;
  end if;
  insert into public.ai_pilot_seed_items (workspace_id, kind, source_key, local_id)
  values (target_workspace, 'field_value', ai_pilot_seed_field_value.source_key, target_task);
  return outcome;
end;
$$;

revoke all on function public.ai_pilot_seed_field_value(uuid, text, uuid, uuid, jsonb) from public, anon;
grant execute on function public.ai_pilot_seed_field_value(uuid, text, uuid, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- The AI builder's runs (log, rate limits, proposal versions)
-- ---------------------------------------------------------------------------------------------------

create table public.ai_builder_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  actor_id uuid not null default auth.uid() references public.profiles (id),
  request_key text not null check (request_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  status text not null default 'generating'
    check (status in ('generating', 'proposed', 'failed', 'cancelled', 'applied', 'undone')),
  brief_chars integer not null default 0 check (brief_chars between 0 and 4000),
  template_id uuid references public.project_templates (id),
  model text check (char_length(model) <= 100),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  proposal jsonb,
  proposal_version integer not null default 0 check (proposal_version between 0 and 1000),
  error_code text check (error_code ~ '^[a-z_]{1,40}$'),
  project_id uuid references public.projects (id),
  created_ids jsonb,
  fingerprint jsonb,
  undo_conflicts jsonb,
  generated_at timestamptz,
  applied_at timestamptz,
  undone_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (actor_id, request_key)
);

create index ai_builder_runs_workspace_created_idx on public.ai_builder_runs (workspace_id, created_at desc);
create index ai_builder_runs_actor_created_idx on public.ai_builder_runs (actor_id, created_at desc);
create index ai_builder_runs_template_idx on public.ai_builder_runs (template_id);
create index ai_builder_runs_project_idx on public.ai_builder_runs (project_id);

alter table public.ai_builder_runs enable row level security;
select public.alhc_revoke_anon_grants(array['ai_builder_runs']);
select public.alhc_revoke_client_truncate(array['ai_builder_runs']);
revoke insert, update on public.ai_builder_runs from authenticated;
grant insert (workspace_id, request_key, brief_chars, template_id) on public.ai_builder_runs to authenticated;
grant update (status, model, input_tokens, output_tokens, proposal, proposal_version, error_code, generated_at,
              project_id, created_ids, fingerprint, undo_conflicts, applied_at, undone_at)
  on public.ai_builder_runs to authenticated;

create policy ai_builder_runs_select_admin on public.ai_builder_runs
  for select to authenticated using ((select public.ai_pilot_admin(workspace_id)));
create policy ai_builder_runs_insert_own on public.ai_builder_runs
  for insert to authenticated
  with check (actor_id = (select auth.uid()) and (select public.ai_pilot_admin(workspace_id)));
create policy ai_builder_runs_update_own on public.ai_builder_runs
  for update to authenticated
  using (actor_id = (select auth.uid()) and (select public.ai_pilot_admin(workspace_id)))
  with check (actor_id = (select auth.uid()) and (select public.ai_pilot_admin(workspace_id)));

-- The run that ai_builder_apply / ai_builder_undo are writing (transaction-local), or null.
create or replace function public.ai_builder_writing_run()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('alhc.ai_builder_run', true), '')::uuid;
$$;

revoke all on function public.ai_builder_writing_run() from public, anon;
grant execute on function public.ai_builder_writing_run() to authenticated;

-- Limits (mirrored by AI_BUILDER_LIMITS in packages/core/src/ai-builder.ts).
create or replace function public.guard_ai_builder_run()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  writing boolean;
begin
  if tg_op = 'INSERT' then
    new.actor_id := auth.uid();
    new.status := 'generating';
    new.created_at := now();
    new.updated_at := now();
    new.model := null;
    new.input_tokens := null;
    new.output_tokens := null;
    new.proposal := null;
    new.proposal_version := 0;
    new.error_code := null;
    new.project_id := null;
    new.created_ids := null;
    new.fingerprint := null;
    new.undo_conflicts := null;
    new.generated_at := null;
    new.applied_at := null;
    new.undone_at := null;
    if new.actor_id is null or not public.ai_pilot_admin(new.workspace_id) then
      raise exception 'The AI builder is only for workspace admins of the Testing data pilot' using errcode = 'insufficient_privilege';
    end if;
    if new.template_id is not null and not exists (
      select 1 from public.project_templates t
      where t.id = new.template_id and t.workspace_id = new.workspace_id and t.deleted_at is null
    ) then
      raise exception 'Template not found in this workspace' using errcode = 'no_data_found';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('alhc.ai_builder:' || new.workspace_id::text, 0));
    if (select count(*) from public.ai_builder_runs r
        where r.actor_id = new.actor_id and r.status = 'generating' and r.created_at > now() - interval '5 minutes') >= 2
       or (select count(*) from public.ai_builder_runs r
           where r.actor_id = new.actor_id and r.created_at > now() - interval '1 hour') >= 10
       or (select count(*) from public.ai_builder_runs r
           where r.actor_id = new.actor_id and r.created_at > now() - interval '1 day') >= 30
       or (select count(*) from public.ai_builder_runs r
           where r.workspace_id = new.workspace_id and r.created_at > now() - interval '1 day') >= 60 then
      raise exception 'AI builder limit reached; try again later'
        using errcode = 'program_limit_exceeded', hint = 'ai_builder_rate_limited';
    end if;
    return new;
  end if;

  if new.id <> old.id or new.workspace_id <> old.workspace_id or new.actor_id <> old.actor_id
     or new.request_key <> old.request_key or new.created_at <> old.created_at
     or new.brief_chars <> old.brief_chars or new.template_id is distinct from old.template_id then
    raise exception 'A run''s identity can''t change' using errcode = 'insufficient_privilege';
  end if;
  -- Never null: outside ai_builder_apply / ai_builder_undo the setting is unset, and null would skip the
  -- checks below.
  writing := coalesce(public.ai_builder_writing_run() = old.id, false);
  if not writing and (
       new.project_id is distinct from old.project_id or new.created_ids is distinct from old.created_ids
       or new.fingerprint is distinct from old.fingerprint or new.applied_at is distinct from old.applied_at
       or new.undone_at is distinct from old.undone_at or new.undo_conflicts is distinct from old.undo_conflicts) then
    raise exception 'Only applying or undoing a run records what it created' using errcode = 'insufficient_privilege';
  end if;

  if old.status in ('failed', 'cancelled', 'undone') then
    raise exception 'This run is finished' using errcode = 'check_violation';
  end if;
  if old.status = 'generating' then
    if new.status not in ('generating', 'proposed', 'failed', 'cancelled') then
      raise exception 'A run must be proposed before it is applied' using errcode = 'check_violation';
    end if;
    if new.status = 'proposed' and (new.proposal is null or new.proposal_version <> 1) then
      raise exception 'A proposal starts at version 1' using errcode = 'check_violation';
    end if;
  elsif old.status = 'proposed' then
    if new.model is distinct from old.model or new.input_tokens is distinct from old.input_tokens
       or new.output_tokens is distinct from old.output_tokens or new.generated_at is distinct from old.generated_at then
      raise exception 'A run''s generation details can''t change' using errcode = 'check_violation';
    end if;
    if new.status not in ('proposed', 'cancelled', 'applied') or (new.status = 'applied' and not writing) then
      raise exception 'Only ai_builder_apply applies a proposal' using errcode = 'check_violation';
    end if;
    if new.proposal is distinct from old.proposal and (new.status <> 'proposed' or new.proposal_version <> old.proposal_version + 1) then
      raise exception 'Each edit of a proposal is a new version' using errcode = 'check_violation';
    end if;
    if new.proposal is not distinct from old.proposal and new.proposal_version <> old.proposal_version then
      raise exception 'Each edit of a proposal is a new version' using errcode = 'check_violation';
    end if;
  elsif old.status = 'applied' then
    if not writing or new.status not in ('applied', 'undone')
       or new.proposal is distinct from old.proposal or new.proposal_version <> old.proposal_version then
      raise exception 'Only ai_builder_undo changes an applied run' using errcode = 'check_violation';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.guard_ai_builder_run() from public, anon;
grant execute on function public.guard_ai_builder_run() to authenticated;

create trigger ai_builder_runs_05_guard
  before insert or update on public.ai_builder_runs
  for each row execute function public.guard_ai_builder_run();

comment on table public.ai_builder_runs is
  'AI builder pilot (experimental): one row per generation (actor, workspace, status, model, usage, the validated proposal and its version, the ids applying it created, and a fingerprint for Undo). Never the brief, the prompt, the raw model answer, or any key.';

-- ---------------------------------------------------------------------------------------------------
-- Proposal validation (mirrors parseProposal / AI_BUILDER_LIMITS in packages/core/src/ai-builder.ts)
-- ---------------------------------------------------------------------------------------------------

create or replace function public.ai_builder_is_date(value text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  return value ~ '^\d{4}-\d{2}-\d{2}$' and to_char(value::date, 'YYYY-MM-DD') = value;
exception when others then
  return false;
end;
$$;

revoke all on function public.ai_builder_is_date(text) from public, anon;
grant execute on function public.ai_builder_is_date(text) to authenticated;

create or replace function public.ai_builder_proposal_problem(p jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  s jsonb;
  f jsonb;
  t jsonb;
  v jsonb;
  o jsonb;
  section_names text[] := '{}';
  field_names text[] := '{}';
  option_names text[];
  ftype text;
  fld jsonb;
begin
  if coalesce(jsonb_typeof(p), 'missing') <> 'object' then return 'The proposal must be an object'; end if;
  if coalesce(jsonb_typeof(p -> 'name'), 'missing') <> 'string' or coalesce(char_length(btrim(p ->> 'name')), 0) not between 1 and 100 then
    return 'The project name must be 1–100 characters';
  end if;
  if p ? 'description' and coalesce(jsonb_typeof(p -> 'description'), 'missing') not in ('string', 'null') then return 'Bad description'; end if;
  if char_length(coalesce(p ->> 'description', '')) > 2000 then return 'The description is too long'; end if;

  if coalesce(jsonb_typeof(p -> 'sections'), 'missing') <> 'array' or jsonb_array_length(p -> 'sections') not between 1 and 20 then
    return 'A proposal has 1–20 sections';
  end if;
  for s in select * from jsonb_array_elements(p -> 'sections') loop
    if coalesce(jsonb_typeof(s -> 'name'), 'missing') <> 'string' or coalesce(char_length(btrim(s ->> 'name')), 0) not between 1 and 100 then
      return 'Each section name must be 1–100 characters';
    end if;
    if coalesce(lower(btrim(s ->> 'name')) = any (section_names), false) then return 'Section names must be different'; end if;
    section_names := section_names || lower(btrim(s ->> 'name'));
  end loop;

  if coalesce(jsonb_typeof(coalesce(p -> 'fields', '[]')), 'missing') <> 'array' or jsonb_array_length(coalesce(p -> 'fields', '[]')) > 10 then
    return 'A proposal has at most 10 fields';
  end if;
  for f in select * from jsonb_array_elements(coalesce(p -> 'fields', '[]')) loop
    if coalesce(jsonb_typeof(f -> 'name'), 'missing') <> 'string' or coalesce(char_length(btrim(f ->> 'name')), 0) not between 1 and 100 then
      return 'Each field name must be 1–100 characters';
    end if;
    if coalesce(lower(btrim(f ->> 'name')) = any (field_names), false) then return 'Field names must be different'; end if;
    field_names := field_names || lower(btrim(f ->> 'name'));
    ftype := f ->> 'type';
    if ftype is null or ftype not in ('text', 'number', 'date', 'single_select', 'multi_select') then
      return 'Unsupported field type';
    end if;
    if coalesce(jsonb_typeof(coalesce(f -> 'options', '[]')), 'missing') <> 'array' then return 'Bad options'; end if;
    if ftype in ('single_select', 'multi_select') then
      if jsonb_array_length(coalesce(f -> 'options', '[]')) not between 1 and 20 then
        return 'A choice field has 1–20 options';
      end if;
      option_names := '{}';
      for o in select * from jsonb_array_elements(f -> 'options') loop
        if coalesce(jsonb_typeof(o), 'missing') <> 'string' or coalesce(char_length(btrim(o #>> '{}')), 0) not between 1 and 100 then
          return 'Each option must be 1–100 characters';
        end if;
        if coalesce(lower(btrim(o #>> '{}')) = any (option_names), false) then return 'Option names must be different'; end if;
        option_names := option_names || lower(btrim(o #>> '{}'));
      end loop;
    elsif jsonb_array_length(coalesce(f -> 'options', '[]')) > 0 then
      return 'Only choice fields have options';
    end if;
  end loop;

  if coalesce(jsonb_typeof(coalesce(p -> 'tasks', '[]')), 'missing') <> 'array' or jsonb_array_length(coalesce(p -> 'tasks', '[]')) > 50 then
    return 'A proposal has at most 50 starter tasks';
  end if;
  for t in select * from jsonb_array_elements(coalesce(p -> 'tasks', '[]')) loop
    if coalesce(jsonb_typeof(t -> 'title'), 'missing') <> 'string' or coalesce(char_length(btrim(t ->> 'title')), 0) not between 1 and 200 then
      return 'Each task title must be 1–200 characters';
    end if;
    if coalesce(jsonb_typeof(t -> 'section'), 'missing') <> 'string' or not coalesce(lower(btrim(t ->> 'section')) = any (section_names), false) then
      return 'Each task must name one of the proposal''s sections';
    end if;
    if char_length(coalesce(t ->> 'notes', '')) > 2000 then return 'Task notes are too long'; end if;
    if t ? 'due_in_days' and coalesce(jsonb_typeof(t -> 'due_in_days'), 'missing') <> 'null' then
      if coalesce(jsonb_typeof(t -> 'due_in_days'), 'missing') <> 'number' then
        return 'A due date is 0–365 days from today';
      end if;
      if (t ->> 'due_in_days')::numeric not between 0 and 365
         or (t ->> 'due_in_days')::numeric <> trunc((t ->> 'due_in_days')::numeric) then
        return 'A due date is 0–365 days from today';
      end if;
    end if;
    if coalesce(jsonb_typeof(coalesce(t -> 'subtasks', '[]')), 'missing') <> 'array' or jsonb_array_length(coalesce(t -> 'subtasks', '[]')) > 5 then
      return 'A task has at most 5 subtasks';
    end if;
    for o in select * from jsonb_array_elements(coalesce(t -> 'subtasks', '[]')) loop
      if coalesce(jsonb_typeof(o), 'missing') <> 'string' or coalesce(char_length(btrim(o #>> '{}')), 0) not between 1 and 200 then
        return 'Each subtask title must be 1–200 characters';
      end if;
    end loop;
    if coalesce(jsonb_typeof(coalesce(t -> 'values', '[]')), 'missing') <> 'array' or jsonb_array_length(coalesce(t -> 'values', '[]')) > 10 then
      return 'Bad task values';
    end if;
    for v in select * from jsonb_array_elements(coalesce(t -> 'values', '[]')) loop
      select x into fld from jsonb_array_elements(coalesce(p -> 'fields', '[]')) x
      where lower(btrim(x ->> 'name')) = lower(btrim(v ->> 'field')) limit 1;
      if fld is null then return 'A task value names a field the proposal doesn''t have'; end if;
      ftype := fld ->> 'type';
      if ftype = 'text' and (coalesce(jsonb_typeof(v -> 'value'), 'missing') <> 'string' or char_length(v ->> 'value') > 1000) then
        return 'A text value must be text (up to 1,000 characters)';
      elsif ftype = 'number' and coalesce(jsonb_typeof(v -> 'value'), 'missing') <> 'number' then
        return 'A number value must be a number';
      elsif ftype = 'date' and (coalesce(jsonb_typeof(v -> 'value'), 'missing') <> 'string' or (v ->> 'value') !~ '^\d{4}-\d{2}-\d{2}$') then
        return 'A date value must be YYYY-MM-DD';
      elsif ftype = 'date' and not public.ai_builder_is_date(v ->> 'value') then
        return 'A date value must be a real date';
      elsif ftype = 'single_select' and (coalesce(jsonb_typeof(v -> 'value'), 'missing') <> 'string' or not exists (
          select 1 from jsonb_array_elements_text(fld -> 'options') x where lower(btrim(x)) = lower(btrim(v ->> 'value')))) then
        return 'A choice value must be one of the field''s options';
      elsif ftype = 'multi_select' and (case when coalesce(jsonb_typeof(v -> 'value'), 'missing') <> 'array' then true else exists (
          select 1 from jsonb_array_elements(v -> 'value') y
          where coalesce(jsonb_typeof(y), 'missing') <> 'string' or not exists (
            select 1 from jsonb_array_elements_text(fld -> 'options') x where lower(btrim(x)) = lower(btrim(y #>> '{}')))) end) then
        return 'Choice values must be the field''s options';
      end if;
    end loop;
  end loop;
  return null;
end;
$$;

revoke all on function public.ai_builder_proposal_problem(jsonb) from public, anon;
grant execute on function public.ai_builder_proposal_problem(jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Fingerprint: what Undo compares (per category, so a conflict says what changed)
-- ---------------------------------------------------------------------------------------------------

create or replace function public.ai_builder_project_fingerprint(target_project uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with top as (
    select distinct tp.task_id from public.task_projects tp where tp.project_id = target_project
  ),
  every_task as (
    select x.* from public.tasks x
    where x.id in (select task_id from top) or x.root_task_id in (select task_id from top)
  )
  select jsonb_build_object(
    'project', (select md5(row(p.name, p.description, p.status, p.status_note, p.due_on, p.archived_at,
                               p.visibility, p.team_id, p.deleted_at, p.workspace_id)::text)
                from public.projects p where p.id = target_project),
    'sections', (select md5(coalesce(string_agg(row(s.id, s.name, s.sort_order, s.deleted_at)::text, ',' order by s.id), ''))
                 from public.sections s where s.project_id = target_project),
    'fields', (select md5(coalesce(string_agg(row(f.id, f.name, f.field_type, f.options, f.deleted_at, f.in_library,
                                                  f.library_field_id, f.locked)::text, ',' order by f.id), ''))
               from public.custom_fields f where f.project_id = target_project),
    'shared_fields', (select count(*) from public.custom_fields o
                      join public.custom_fields f on f.id = o.library_field_id and f.project_id = target_project
                      where o.project_id <> target_project),
    'tasks', (select md5(coalesce(string_agg(row(t.id, t.title, t.notes, t.completed_at, t.due_on, t.start_on, t.due_at,
                                                 t.start_at, t.assignee_id, t.deleted_at, t.parent_task_id, t.kind,
                                                 t.recurrence, t.subtask_order)::text, ',' order by t.id), ''))
              from every_task t),
    'memberships', (select md5(coalesce(string_agg(row(tp.task_id, tp.section_id, tp.sort_order, tp.deleted_at)::text, ',' order by tp.task_id), ''))
                    from public.task_projects tp where tp.project_id = target_project),
    'other_projects', (select count(*) from public.task_projects tp
                       where tp.task_id in (select id from every_task) and tp.project_id <> target_project),
    'values', (select md5(coalesce(string_agg(row(v.task_id, v.field_id, v.value)::text, ',' order by v.task_id, v.field_id), ''))
               from public.task_field_values v where v.task_id in (select id from every_task)),
    'comments', (select count(*) from public.comments c where c.task_id in (select id from every_task)),
    'attachments', (select count(*) from public.task_attachments a where a.task_id in (select id from every_task)),
    'tags', (select count(*) from public.task_tags g where g.task_id in (select id from every_task)),
    'followers', (select md5(coalesce(string_agg(row(fo.task_id, fo.profile_id, fo.deleted_at)::text, ',' order by fo.task_id, fo.profile_id), ''))
                  from public.task_followers fo where fo.task_id in (select id from every_task)),
    'dependencies', (select count(*) from public.task_dependencies d
                     where d.predecessor_id in (select id from every_task) or d.successor_id in (select id from every_task)),
    'members', (select md5(coalesce(string_agg(row(m.profile_id, m.role, m.deleted_at)::text, ',' order by m.profile_id, m.created_at), ''))
                from public.project_members m where m.project_id = target_project),
    'views', (select md5(coalesce(string_agg(row(w.id, w.name, w.layout, w.config, w.deleted_at)::text, ',' order by w.id), ''))
              from public.project_views w where w.project_id = target_project),
    'forms', (select count(*) from public.forms fm where fm.project_id = target_project),
    'rules', (select count(*) from public.rules r where r.project_id = target_project),
    'messages', (select count(*) from public.project_messages pm where pm.project_id = target_project),
    'templates', (select count(*) from public.project_templates pt where pt.source_project_id = target_project),
    'portfolios', (select count(*) from public.portfolio_projects pp where pp.project_id = target_project),
    'goals', (select count(*) from public.goal_links gl where gl.project_id = target_project)
  );
$$;

revoke all on function public.ai_builder_project_fingerprint(uuid) from public, anon;
grant execute on function public.ai_builder_project_fingerprint(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Apply (all or nothing) and Undo
-- ---------------------------------------------------------------------------------------------------

create or replace function public.ai_builder_apply(target_run uuid, expected_version integer, local_today date)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r record;
  p jsonb;
  problem text;
  proj uuid;
  colors text[] := array['zinc', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'];
  sec jsonb;
  fld jsonb;
  tsk jsonb;
  val jsonb;
  sub jsonb;
  i bigint;
  section_ids jsonb := '{}';
  field_rows jsonb := '{}';
  field_ids uuid[] := '{}';
  section_list uuid[] := '{}';
  task_ids uuid[] := '{}';
  subtask_ids uuid[] := '{}';
  new_id uuid;
  new_task uuid;
  opts jsonb;
  fdef jsonb;
  stored jsonb;
  created jsonb;
  fp jsonb;
  last_order double precision;
begin
  select * into r from public.ai_builder_runs x where x.id = target_run for update;
  if not found then
    raise exception 'Run not found' using errcode = 'no_data_found';
  end if;
  if r.actor_id is distinct from auth.uid() or not public.ai_pilot_admin(r.workspace_id) then
    raise exception 'Only the admin who made this proposal can apply it in the Testing data pilot' using errcode = 'insufficient_privilege';
  end if;
  if r.status in ('applied', 'undone') then
    return jsonb_build_object('status', r.status, 'project_id', r.project_id, 'created_ids', r.created_ids, 'repeated', true);
  end if;
  if r.status <> 'proposed' then
    raise exception 'This proposal can''t be applied any more' using errcode = 'check_violation';
  end if;
  if expected_version is distinct from r.proposal_version then
    raise exception 'The proposal changed; review it again before applying' using errcode = 'serialization_failure';
  end if;
  if local_today is null or local_today not between current_date - 2 and current_date + 2 then
    raise exception 'Invalid start date' using errcode = 'invalid_parameter_value';
  end if;
  p := r.proposal;
  problem := public.ai_builder_proposal_problem(p);
  if problem is not null then
    raise exception '%', problem using errcode = 'check_violation';
  end if;

  perform set_config('alhc.ai_builder_run', r.id::text, true);

  select max(x.sort_order) into last_order from public.projects x where x.deleted_at is null;
  insert into public.projects (workspace_id, name, description, visibility, sort_order)
  values (r.workspace_id, btrim(p ->> 'name'), nullif(btrim(coalesce(p ->> 'description', '')), ''), 'private', coalesce(last_order, 0) + 1024)
  returning id into proj;

  for sec, i in select x, n from jsonb_array_elements(p -> 'sections') with ordinality as e(x, n) loop
    insert into public.sections (project_id, name, sort_order) values (proj, btrim(sec ->> 'name'), i * 1024)
    returning id into new_id;
    section_ids := section_ids || jsonb_build_object(lower(btrim(sec ->> 'name')), new_id);
    section_list := section_list || new_id;
  end loop;

  for fld, i in select x, n from jsonb_array_elements(coalesce(p -> 'fields', '[]')) with ordinality as e(x, n) loop
    select coalesce(jsonb_agg(jsonb_build_object('id', gen_random_uuid()::text, 'name', btrim(o), 'color', colors[1 + ((k - 1) % 9)::integer]) order by k), '[]')
      into opts
    from jsonb_array_elements_text(coalesce(fld -> 'options', '[]')) with ordinality as q(o, k);
    insert into public.custom_fields (project_id, name, field_type, options, show_in_views, sort_order)
    values (proj, btrim(fld ->> 'name'), fld ->> 'type', opts, true, i * 1024)
    returning id into new_id;
    field_ids := field_ids || new_id;
    field_rows := field_rows || jsonb_build_object(lower(btrim(fld ->> 'name')),
      jsonb_build_object('id', new_id, 'type', fld ->> 'type', 'options', opts));
  end loop;

  for tsk in select x from jsonb_array_elements(coalesce(p -> 'tasks', '[]')) as e(x) loop
    new_task := public.create_task(proj, (section_ids ->> lower(btrim(tsk ->> 'section')))::uuid, btrim(tsk ->> 'title'));
    task_ids := task_ids || new_task;
    if nullif(btrim(coalesce(tsk ->> 'notes', '')), '') is not null or jsonb_typeof(tsk -> 'due_in_days') = 'number' then
      update public.tasks
      set notes = coalesce(nullif(btrim(coalesce(tsk ->> 'notes', '')), ''), notes),
          due_on = case when jsonb_typeof(tsk -> 'due_in_days') = 'number' then local_today + (tsk ->> 'due_in_days')::integer else due_on end
      where id = new_task;
    end if;
    for val in select x from jsonb_array_elements(coalesce(tsk -> 'values', '[]')) as e(x) loop
      fdef := field_rows -> lower(btrim(val ->> 'field'));
      stored := case fdef ->> 'type'
        when 'single_select' then (
          select to_jsonb(o ->> 'id') from jsonb_array_elements(fdef -> 'options') o
          where lower(o ->> 'name') = lower(btrim(val ->> 'value')) limit 1)
        when 'multi_select' then (
          select coalesce(jsonb_agg(o ->> 'id'), '[]') from jsonb_array_elements(fdef -> 'options') o
          where lower(o ->> 'name') in (select lower(btrim(y)) from jsonb_array_elements_text(val -> 'value') y))
        else val -> 'value'
      end;
      if stored is not null then
        insert into public.task_field_values (task_id, field_id, value) values (new_task, (fdef ->> 'id')::uuid, stored)
        on conflict (task_id, field_id) do update set value = excluded.value;
      end if;
    end loop;
    for sub in select x from jsonb_array_elements(coalesce(tsk -> 'subtasks', '[]')) as e(x) loop
      subtask_ids := subtask_ids || public.create_subtask(new_task, btrim(sub #>> '{}'), null);
    end loop;
  end loop;

  created := jsonb_build_object('project', proj, 'sections', to_jsonb(section_list), 'fields', to_jsonb(field_ids),
                                'tasks', to_jsonb(task_ids), 'subtasks', to_jsonb(subtask_ids));
  fp := public.ai_builder_project_fingerprint(proj);
  update public.ai_builder_runs
  set status = 'applied', project_id = proj, created_ids = created, fingerprint = fp, applied_at = now()
  where id = r.id;
  perform set_config('alhc.ai_builder_run', '', true);
  return jsonb_build_object('status', 'applied', 'project_id', proj, 'created_ids', created, 'repeated', false);
end;
$$;

revoke all on function public.ai_builder_apply(uuid, integer, date) from public, anon;
grant execute on function public.ai_builder_apply(uuid, integer, date) to authenticated;

create or replace function public.ai_builder_undo(target_run uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r record;
  proj record;
  cur jsonb;
  changed text[];
begin
  select * into r from public.ai_builder_runs x where x.id = target_run for update;
  if not found then
    raise exception 'Run not found' using errcode = 'no_data_found';
  end if;
  if r.actor_id is distinct from auth.uid() or not public.ai_pilot_admin(r.workspace_id) then
    raise exception 'Only the admin who applied this run can undo it in the Testing data pilot' using errcode = 'insufficient_privilege';
  end if;
  if r.status = 'undone' then
    return jsonb_build_object('status', 'already_undone', 'project_id', r.project_id);
  end if;
  if r.status <> 'applied' or r.project_id is null then
    raise exception 'Only an applied run can be undone' using errcode = 'check_violation';
  end if;

  select p.id, p.workspace_id, p.deleted_at into proj from public.projects p where p.id = r.project_id;
  if not found or proj.workspace_id <> r.workspace_id then
    raise exception 'The run''s project isn''t in this pilot workspace' using errcode = 'insufficient_privilege';
  end if;

  perform set_config('alhc.ai_builder_run', r.id::text, true);
  if proj.deleted_at is not null then
    update public.ai_builder_runs set status = 'undone', undone_at = now() where id = r.id;
    perform set_config('alhc.ai_builder_run', '', true);
    return jsonb_build_object('status', 'already_removed', 'project_id', r.project_id);
  end if;

  cur := public.ai_builder_project_fingerprint(r.project_id);
  select coalesce(array_agg(k order by k), '{}') into changed
  from jsonb_object_keys(coalesce(r.fingerprint, '{}') || cur) k
  where (r.fingerprint -> k) is distinct from (cur -> k);
  if cardinality(changed) > 0 then
    update public.ai_builder_runs
    set undo_conflicts = jsonb_build_object('at', now(), 'changed', to_jsonb(changed))
    where id = r.id;
    perform set_config('alhc.ai_builder_run', '', true);
    return jsonb_build_object('status', 'conflict', 'project_id', r.project_id, 'changed', to_jsonb(changed));
  end if;

  -- The project menu's own soft removal: the projects guard lets only an owner do it.
  update public.projects set deleted_at = now() where id = r.project_id and deleted_at is null;
  if not found then
    raise exception 'Only the project''s owner can undo it' using errcode = 'insufficient_privilege';
  end if;
  update public.ai_builder_runs set status = 'undone', undone_at = now(), undo_conflicts = null where id = r.id;
  perform set_config('alhc.ai_builder_run', '', true);
  return jsonb_build_object('status', 'undone', 'project_id', r.project_id);
end;
$$;

revoke all on function public.ai_builder_undo(uuid) from public, anon;
grant execute on function public.ai_builder_undo(uuid) to authenticated;

-- =================================================================================================
-- TAIL
--
-- Applied by hand, like every tail: the connector refuses the row-removal keyword this function needs.
-- Nothing above depends on it. Until it's applied the pilot simply can't be cleaned up in one command.
--
-- ai_pilot_cleanup(workspace id, marker, confirm name, execute): the ONE-command cleanup of the AI
-- builder pilot. Definer; no client or service_role grant (run it as the database owner: SQL editor or
-- psql, see docs/ai-builder-pilot.md). Dry run by default (confirm_execute = false): it computes and reports
-- exactly what would go and changes nothing.
--
--   * Refuses unless ALL of these hold: the workspace id is in ai_pilot_workspaces, the marker is that
--     row's marker, the workspace is live, its name is exactly 'Testing data' and equals confirm_name,
--     and it isn't the main (oldest) workspace. A name alone never selects anything.
--   * What goes: the workspace row and every row that must point at it or at something that goes (NOT
--     NULL foreign keys, found through the catalog, so new tables are covered), plus the nullable
--     references that only make sense with their target (any workspace_id, a subtask's parent / root,
--     Inbox items, goal links, curated work, calendar events and links, pending invites, capacities).
--     Rows outside the pilot that merely point at a pilot row through another nullable reference are
--     kept, with that reference cleared (and reported).
--   * Refuses (and removes nothing) when anything it would remove has a workspace_id other than the pilot's,
--     belongs to profiles, allowed_emails, ai_pilot_workspaces, or another workspace row, or lives outside
--     the public schema. Never touches auth identities, Storage objects directly, or other workspaces.
--   * Files: each removed task's attachment folder (<task id>/ in task-attachments) is queued in
--     trash_storage_purges for the app's cron route, like the Trash purge.
--   * The registry row stays as the audit record: cleaned_at and the report. Running it again answers
--     already_cleaned and changes nothing.
-- =================================================================================================
-- TAIL

create or replace function public.ai_pilot_cleanup(target_workspace uuid, target_marker uuid, confirm_name text, confirm_execute boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  reg record;
  wsrow record;
  added integer;
  pass integer;
  n integer;
  fk record;
  cur regclass;
  progress boolean;
  left_over integer;
  settle_round integer;
  grew integer;
  stmt text;
  stmt_counts text;
  together jsonb;
  plan jsonb := '{}'::jsonb;
  cleared jsonb := '{}'::jsonb;
  tally jsonb := '{}'::jsonb;
  bad text;
  report jsonb;
  goes_with text[] := array[
    'public.inbox_items.task_id', 'public.inbox_items.comment_id', 'public.inbox_items.project_id',
    'public.inbox_items.message_id', 'public.inbox_items.team_message_id', 'public.inbox_items.status_update_id',
    'public.calendar_events.project_id', 'public.calendar_events.team_id', 'public.calendar_feeds.project_id',
    'public.calendar_feeds.team_id', 'public.email_designs.project_id', 'public.goal_links.project_id',
    'public.pending_memberships.project_id', 'public.pending_memberships.team_id', 'public.team_curated_work.project_id',
    'public.workload_capacities.project_id', 'public.task_attachment_links.attachment_id',
    'public.tasks.parent_task_id', 'public.tasks.root_task_id'];
  protected text[] := array['public.profiles', 'public.allowed_emails', 'public.ai_pilot_workspaces'];
begin
  if target_workspace is null or target_marker is null then
    raise exception 'ai_pilot_cleanup: the workspace id and the marker are both required' using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('alhc.ai_pilot', 0));

  select r.* into reg from public.ai_pilot_workspaces r where r.workspace_id = target_workspace for update;
  if not found then
    raise exception 'ai_pilot_cleanup: % is not a registered pilot workspace; refusing', target_workspace using errcode = 'check_violation';
  end if;
  if reg.marker <> target_marker then
    raise exception 'ai_pilot_cleanup: the marker does not match the registered pilot; refusing' using errcode = 'check_violation';
  end if;
  if reg.cleaned_at is not null then
    return jsonb_build_object('status', 'already_cleaned', 'workspace_id', target_workspace, 'cleaned_at', reg.cleaned_at, 'report', reg.cleanup_report);
  end if;
  if target_workspace = public.ai_main_workspace_id() then
    raise exception 'ai_pilot_cleanup: that is the main workspace; refusing' using errcode = 'check_violation';
  end if;
  select w.* into wsrow from public.workspaces w where w.id = target_workspace;
  if not found or wsrow.deleted_at is not null then
    raise exception 'ai_pilot_cleanup: the pilot workspace is missing or already removed; refusing' using errcode = 'check_violation';
  end if;
  if wsrow.name <> 'Testing data' or confirm_name is distinct from wsrow.name then
    raise exception 'ai_pilot_cleanup: confirm with the workspace''s exact name (Testing data); refusing' using errcode = 'check_violation';
  end if;

  create temporary table if not exists ai_cleanup_set (tbl regclass not null, id uuid not null, primary key (tbl, id)) on commit drop;
  create temporary table if not exists ai_cleanup_done (tbl regclass primary key) on commit drop;
  truncate pg_temp.ai_cleanup_set, pg_temp.ai_cleanup_done;
  insert into pg_temp.ai_cleanup_set values ('public.workspaces'::regclass, target_workspace);

  settle_round := 0;
  <<settle>>
  loop
    settle_round := settle_round + 1;
    grew := 0;
    pass := 0;
    -- Everything that must point at the set, and the nullable references that go with their target.
    loop
      pass := pass + 1;
      added := 0;
      for fk in
        select c.conrelid::regclass as child, a.attname as col, c.confrelid::regclass as parent, a.attnotnull as notnull,
               exists (select 1 from pg_attribute ia where ia.attrelid = c.conrelid and ia.attname = 'id'
                       and ia.atttypid = 'uuid'::regtype and not ia.attisdropped) as has_id
        from pg_constraint c
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1] and pa.attname = 'id'
        where c.contype = 'f'
          and c.confrelid in (select distinct s.tbl from pg_temp.ai_cleanup_set s)
      loop
        if (fk.notnull or (fk.child::text || '.' || fk.col) = any (goes_with)
            or (fk.parent = 'public.workspaces'::regclass and fk.col = 'workspace_id')) and fk.has_id then
          execute format(
            'insert into pg_temp.ai_cleanup_set select %L::regclass, x.id from %s x where x.%I in (select s.id from pg_temp.ai_cleanup_set s where s.tbl = %L::regclass) on conflict do nothing',
            fk.child, fk.child, fk.col, fk.parent);
          get diagnostics n = row_count;
          added := added + n;
        end if;
      end loop;
      grew := grew + added;
      exit when added = 0;
      if pass > 60 then
        raise exception 'ai_pilot_cleanup: references kept turning up new rows';
      end if;
    end loop;

    -- Safety: nothing outside the pilot may be in the set.
    select string_agg(distinct s.tbl::text, ', ') into bad from pg_temp.ai_cleanup_set s
    where s.tbl::text = any (protected)
       or (s.tbl = 'public.workspaces'::regclass and s.id <> target_workspace)
       or (select ns.nspname from pg_class k join pg_namespace ns on ns.oid = k.relnamespace where k.oid = s.tbl) <> 'public';
    if bad is not null then
      raise exception 'ai_pilot_cleanup: the cleanup would reach protected rows (%); refusing, nothing removed', bad;
    end if;
    for cur in select distinct s.tbl from pg_temp.ai_cleanup_set s loop
      if exists (select 1 from pg_attribute a where a.attrelid = cur and a.attname = 'workspace_id' and not a.attisdropped) then
        execute format('select count(*) from %s x where x.id in (select s.id from pg_temp.ai_cleanup_set s where s.tbl = %L::regclass) and x.workspace_id is distinct from %L::uuid',
          cur, cur, target_workspace) into n;
        if n > 0 then
          raise exception 'ai_pilot_cleanup: % rows of % belong to another workspace; refusing, nothing removed', n, cur;
        end if;
      end if;
    end loop;

    -- Nullable references from rows that stay are cleared (counted only in a dry run). A row that can't be
    -- cleared (a CHECK needs the reference) joins the set unless it's protected, then everything is
    -- checked again.
    added := 0;
    for fk in
      select c.conrelid::regclass as child, a.attname as col, c.confrelid::regclass as parent,
             exists (select 1 from pg_attribute ia where ia.attrelid = c.conrelid and ia.attname = 'id'
                     and ia.atttypid = 'uuid'::regtype and not ia.attisdropped) as has_id
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1] and pa.attname = 'id'
      where c.contype = 'f'
        and not a.attnotnull
        and c.confrelid in (select distinct s.tbl from pg_temp.ai_cleanup_set s)
        and not ((c.conrelid::regclass::text || '.' || a.attname) = any (goes_with))
        and not (c.confrelid = 'public.workspaces'::regclass and a.attname = 'workspace_id')
    loop
      if fk.has_id then
        execute format(
          'select count(*) from %s x where x.%I in (select s.id from pg_temp.ai_cleanup_set s where s.tbl = %L::regclass) and x.id not in (select s.id from pg_temp.ai_cleanup_set s where s.tbl = %L::regclass)',
          fk.child, fk.col, fk.parent, fk.child) into n;
      else
        execute format('select count(*) from %s x where x.%I in (select s.id from pg_temp.ai_cleanup_set s where s.tbl = %L::regclass)',
          fk.child, fk.col, fk.parent) into n;
      end if;
      continue when n = 0;
      if fk.child::text = any (protected) then
        raise exception 'ai_pilot_cleanup: % rows of % point at pilot rows (%); refusing, nothing removed', n, fk.child, fk.col;
      end if;
      cleared := cleared || jsonb_build_object(fk.child::text || '.' || fk.col, n);
      continue when not confirm_execute;
      begin
        if fk.has_id then
          execute format(
            'update %s x set %I = null where x.%I in (select s.id from pg_temp.ai_cleanup_set s where s.tbl = %L::regclass) and x.id not in (select s.id from pg_temp.ai_cleanup_set s where s.tbl = %L::regclass)',
            fk.child, fk.col, fk.col, fk.parent, fk.child);
        else
          execute format('update %s x set %I = null where x.%I in (select s.id from pg_temp.ai_cleanup_set s where s.tbl = %L::regclass)',
            fk.child, fk.col, fk.col, fk.parent);
        end if;
      exception when check_violation or not_null_violation then
        if not fk.has_id then
          raise;
        end if;
        execute format(
          'insert into pg_temp.ai_cleanup_set select %L::regclass, x.id from %s x where x.%I in (select s.id from pg_temp.ai_cleanup_set s where s.tbl = %L::regclass) on conflict do nothing',
          fk.child, fk.child, fk.col, fk.parent);
        get diagnostics n = row_count;
        added := added + n;
      end;
    end loop;
    exit settle when settle_round > 1 and grew = 0 and added = 0;
    exit settle when not confirm_execute and settle_round > 1;
    if settle_round > 20 then
      raise exception 'ai_pilot_cleanup: references kept changing';
    end if;
  end loop settle;

  -- What would go, per table (rows with an id) and per leaf table (rows without one).
  select coalesce(jsonb_object_agg(x.tbl, x.n), '{}') into plan
  from (select s.tbl::text as tbl, count(*) as n from pg_temp.ai_cleanup_set s group by s.tbl) x;
  for fk in
    select c.conrelid::regclass as child, a.attname as col, c.confrelid::regclass as parent
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1] and pa.attname = 'id'
    where c.contype = 'f' and a.attnotnull
      and c.confrelid in (select distinct s.tbl from pg_temp.ai_cleanup_set s)
      and not exists (select 1 from pg_attribute ia where ia.attrelid = c.conrelid and ia.attname = 'id'
                      and ia.atttypid = 'uuid'::regtype and not ia.attisdropped)
  loop
    if fk.child::text = any (protected)
       or (select ns.nspname from pg_class k join pg_namespace ns on ns.oid = k.relnamespace where k.oid = fk.child) <> 'public' then
      raise exception 'ai_pilot_cleanup: % rows point at pilot rows; refusing, nothing removed', fk.child;
    end if;
    if exists (select 1 from pg_attribute a2 where a2.attrelid = fk.child and a2.attname = 'workspace_id' and not a2.attisdropped) then
      execute format('select count(*) from %s x where x.%I in (select s.id from pg_temp.ai_cleanup_set s where s.tbl = %L::regclass) and x.workspace_id is distinct from %L::uuid',
        fk.child, fk.col, fk.parent, target_workspace) into n;
      if n > 0 then
        raise exception 'ai_pilot_cleanup: % rows of % belong to another workspace; refusing, nothing removed', n, fk.child;
      end if;
    end if;
    execute format('select count(*) from %s x where x.%I in (select s.id from pg_temp.ai_cleanup_set s where s.tbl = %L::regclass)',
      fk.child, fk.col, fk.parent) into n;
    if n > 0 then
      plan := plan || jsonb_build_object(fk.child::text, coalesce((plan ->> fk.child::text)::integer, 0) + n);
    end if;
  end loop;

  report := jsonb_build_object(
    'workspace_id', target_workspace,
    'marker', target_marker,
    'would_remove', plan,
    'references_cleared', cleared,
    'task_folders', (select count(*) from pg_temp.ai_cleanup_set s where s.tbl = 'public.tasks'::regclass));
  if not confirm_execute then
    return jsonb_build_object('status', 'dry_run') || report;
  end if;

  -- Files first (queued for the cron route; nothing in Storage is touched here).
  insert into public.trash_storage_purges (bucket, path, is_prefix)
  select 'task-attachments', s.id::text || '/', true from pg_temp.ai_cleanup_set s where s.tbl = 'public.tasks'::regclass
  on conflict do nothing;

  -- Leaves (no id column) by their reference, then each table's rows, children first; rows that point at
  -- each other go in one statement at the end.
  for fk in
    select c.conrelid::regclass as child, a.attname as col, c.confrelid::regclass as parent
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1] and pa.attname = 'id'
    where c.contype = 'f' and a.attnotnull
      and c.confrelid in (select distinct s.tbl from pg_temp.ai_cleanup_set s)
      and not exists (select 1 from pg_attribute ia where ia.attrelid = c.conrelid and ia.attname = 'id'
                      and ia.atttypid = 'uuid'::regtype and not ia.attisdropped)
  loop
    execute format('delete from %s x where x.%I in (select s.id from pg_temp.ai_cleanup_set s where s.tbl = %L::regclass)',
      fk.child, fk.col, fk.parent);
    get diagnostics n = row_count;
    if n > 0 then
      tally := tally || jsonb_build_object(fk.child::text, coalesce((tally ->> fk.child::text)::integer, 0) + n);
    end if;
  end loop;

  pass := 0;
  loop
    pass := pass + 1;
    progress := false;
    left_over := 0;
    for cur in
      select distinct s.tbl from pg_temp.ai_cleanup_set s
      where s.tbl not in (select d.tbl from pg_temp.ai_cleanup_done d)
    loop
      begin
        execute format('delete from %s x where x.id in (select s.id from pg_temp.ai_cleanup_set s where s.tbl = %L::regclass)', cur, cur);
        get diagnostics n = row_count;
        insert into pg_temp.ai_cleanup_done values (cur);
        tally := tally || jsonb_build_object(cur::text, coalesce((tally ->> cur::text)::integer, 0) + n);
        progress := true;
      exception when foreign_key_violation then
        left_over := left_over + 1;
      end;
    end loop;
    exit when left_over = 0;
    if not progress or pass > 60 then
      select string_agg(format('d%s as (delete from %s x where x.id in (select s.id from pg_temp.ai_cleanup_set s where s.tbl = %L::regclass) returning 1)', i, r.tbl, r.tbl), ', '),
             string_agg(format('%L, (select count(*) from d%s)', r.tbl::text, i), ', ')
        into stmt, stmt_counts
      from (
        select s.tbl, row_number() over (order by s.tbl::text) as i
        from (select distinct x.tbl from pg_temp.ai_cleanup_set x where x.tbl not in (select d.tbl from pg_temp.ai_cleanup_done d)) s
      ) r;
      execute format('with %s select jsonb_build_object(%s)', stmt, stmt_counts) into together;
      for cur, n in select key::regclass, value::integer from jsonb_each_text(together) loop
        tally := tally || jsonb_build_object(cur::text, coalesce((tally ->> cur::text)::integer, 0) + n);
        insert into pg_temp.ai_cleanup_done values (cur) on conflict do nothing;
      end loop;
      exit;
    end if;
  end loop;

  report := report || jsonb_build_object('removed', tally);
  update public.ai_pilot_workspaces set cleaned_at = now(), cleanup_report = report where workspace_id = target_workspace;
  return jsonb_build_object('status', 'cleaned') || report;
end;
$$;

revoke all on function public.ai_pilot_cleanup(uuid, uuid, text, boolean) from public, anon, authenticated, service_role;
comment on function public.ai_pilot_cleanup(uuid, uuid, text, boolean) is
  'AI builder pilot: removes the registered Testing data workspace and everything in it, only with its id, its marker, and its exact name; dry run unless confirm_execute => true. No client can execute it (run as the database owner).';
