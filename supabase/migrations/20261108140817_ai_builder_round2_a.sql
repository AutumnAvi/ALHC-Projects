-- AI builder round 2 (EXPERIMENTAL, branch feat/ai-builder-p2 → feat/ai-builder; draft PR "feat: AI builder
-- round 2 (do not merge to main)"). Made with `supabase migration new`; NOT applied anywhere. Additive: no
-- row or object is removed (no TAIL). Apply after 20261108122112_ai_builder_pilot_a.sql.
--
-- What this adds to the Testing data pilot:
--   * ai_builder_runs.kind: build (phase 1's first build) | edit (an AI change to a draft, a child run of
--     its build: parent_run_id) | automation (an AI automation draft for a project of the pilot:
--     target_project_id; rule_id once the person saved it from the normal rule canvas). effort = the model's
--     effort setting for that call (model was already logged). Each kind has its own rate limits in the
--     insert guard; build keeps phase 1's (10 an hour, 30 a day per person, 60 a day per workspace).
--   * guard_ai_builder_run(): the kinds' rules. An edit's parent is the caller's own build run, still a
--     proposal; an automation's project is a live project of the pilot where the caller is Admin+ (who may
--     add automations); only ai_builder_apply applies, and only a build; an automation draft becomes
--     "applied" only with the id of a live rule of its project that the same person created (the normal
--     rule-save path made it: validate_rule, and the blocked-completion guard at run time; nothing bypassed).
--   * ai_pilot_members(workspace) (invoker): the pilot's people (its workspace admins and active team
--     members, still on the allowlist): who a draft task may be assigned to. Nothing for non-admins.
--   * ai_builder_proposal_problem(): also start_in_days (0–365, never after the due date) and assignee
--     ({ member: profile id } | { placeholder: 1–60 characters } | null).
--   * ai_builder_apply(): refuses anything but a build run; sets start dates; assigns members (anyone but
--     the caller joins the new private project as an Editor first, through add_project_member) and turns
--     placeholders into project roles linked as the task's assignee role. Assigning someone other than
--     yourself sends them the usual assignment notice; nothing else notifies or sends.
--   * ai_builder_project_fingerprint(): also project roles and their task links (left out while a project
--     has none, so fingerprints taken before this release still compare equal).
--
-- No new client SECURITY DEFINER function (suite 60 unchanged); nothing for anon.

-- ---------------------------------------------------------------------------------------------------
-- Run kinds
-- ---------------------------------------------------------------------------------------------------

alter table public.ai_builder_runs
  add column if not exists kind text not null default 'build',
  add column if not exists parent_run_id uuid references public.ai_builder_runs (id),
  add column if not exists target_project_id uuid references public.projects (id),
  add column if not exists rule_id uuid references public.rules (id),
  add column if not exists effort text;

alter table public.ai_builder_runs
  add constraint ai_builder_runs_kind_check check (kind in ('build', 'edit', 'automation')),
  add constraint ai_builder_runs_effort_check check (effort is null or effort in ('low', 'medium', 'high')),
  add constraint ai_builder_runs_kind_shape_check check (
    (kind = 'edit') = (parent_run_id is not null)
    and (kind = 'automation') = (target_project_id is not null)
    and (rule_id is null or kind = 'automation')
  );

create index if not exists ai_builder_runs_parent_idx on public.ai_builder_runs (parent_run_id);
create index if not exists ai_builder_runs_target_project_idx on public.ai_builder_runs (target_project_id);
create index if not exists ai_builder_runs_rule_idx on public.ai_builder_runs (rule_id);
create index if not exists ai_builder_runs_actor_kind_created_idx on public.ai_builder_runs (actor_id, kind, created_at desc);

grant insert (kind, parent_run_id, target_project_id) on public.ai_builder_runs to authenticated;
grant update (effort, rule_id) on public.ai_builder_runs to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- The pilot's people
-- ---------------------------------------------------------------------------------------------------

create or replace function public.ai_pilot_members(target_workspace uuid)
returns table (profile_id uuid, name text, email text, is_me boolean)
language sql
stable
security invoker
set search_path = ''
as $$
  select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email), p.email, p.id = auth.uid()
  from public.profiles p
  where public.ai_pilot_admin(target_workspace)
    and p.id in (
      select wa.profile_id from public.workspace_admins wa
      where wa.workspace_id = target_workspace and wa.deleted_at is null
      union
      select tm.profile_id from public.team_members tm
      join public.teams t on t.id = tm.team_id and t.deleted_at is null
      where t.workspace_id = target_workspace and tm.deleted_at is null
    )
    and exists (
      select 1 from public.allowed_emails a
      where lower(a.email) = lower(p.email) and a.removed_at is null
    )
  order by p.id = auth.uid() desc, lower(coalesce(nullif(btrim(p.full_name), ''), p.email)), p.id;
$$;

revoke all on function public.ai_pilot_members(uuid) from public, anon;
grant execute on function public.ai_pilot_members(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- The runs' guard: kinds, their rate limits (mirrored by AI_BUILDER_LIMITS in packages/core/src/ai-builder.ts),
-- and their transitions
-- ---------------------------------------------------------------------------------------------------

create or replace function public.guard_ai_builder_run()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  writing boolean;
  parent record;
begin
  if tg_op = 'INSERT' then
    new.actor_id := auth.uid();
    new.status := 'generating';
    new.created_at := now();
    new.updated_at := now();
    new.model := null;
    new.effort := null;
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
    new.rule_id := null;
    new.kind := coalesce(new.kind, 'build');
    if new.actor_id is null or not public.ai_pilot_admin(new.workspace_id) then
      raise exception 'The AI builder is only for workspace admins of the Testing data pilot' using errcode = 'insufficient_privilege';
    end if;
    if new.kind = 'build' then
      if new.parent_run_id is not null or new.target_project_id is not null then
        raise exception 'A project proposal has no parent run or project' using errcode = 'check_violation';
      end if;
      if new.template_id is not null and not exists (
        select 1 from public.project_templates t
        where t.id = new.template_id and t.workspace_id = new.workspace_id and t.deleted_at is null
      ) then
        raise exception 'Template not found in this workspace' using errcode = 'no_data_found';
      end if;
    elsif new.kind = 'edit' then
      -- An AI change belongs to the caller's own project proposal, still a proposal, in this workspace.
      select x.actor_id, x.workspace_id, x.kind, x.status into parent from public.ai_builder_runs x where x.id = new.parent_run_id;
      if not found or parent.actor_id is distinct from new.actor_id or parent.workspace_id is distinct from new.workspace_id
         or parent.kind <> 'build' or parent.status <> 'proposed' then
        raise exception 'That draft can''t be changed with AI' using errcode = 'check_violation';
      end if;
      if new.target_project_id is not null or new.template_id is not null then
        raise exception 'An AI change has no project or template' using errcode = 'check_violation';
      end if;
    elsif new.kind = 'automation' then
      -- An automation draft is for a live project of this pilot workspace where the caller may add
      -- automations (rules_insert_admin: Admin+ by their own role; an archived project caps everyone).
      if new.parent_run_id is not null or new.template_id is not null then
        raise exception 'An automation draft has no parent run or template' using errcode = 'check_violation';
      end if;
      if not exists (
        select 1 from public.projects p
        where p.id = new.target_project_id and p.workspace_id = new.workspace_id and p.deleted_at is null
      ) or not public.has_project_role(new.target_project_id, 'admin') then
        raise exception 'Only the project''s Owners and Admins can add automations' using errcode = 'insufficient_privilege';
      end if;
    else
      raise exception 'Unknown kind of AI builder run' using errcode = 'check_violation';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('alhc.ai_builder:' || new.workspace_id::text, 0));
    if (select count(*) from public.ai_builder_runs r
        where r.actor_id = new.actor_id and r.status = 'generating' and r.created_at > now() - interval '5 minutes') >= 2
       or (new.kind = 'build' and (
             (select count(*) from public.ai_builder_runs r
              where r.actor_id = new.actor_id and r.kind = 'build' and r.created_at > now() - interval '1 hour') >= 10
          or (select count(*) from public.ai_builder_runs r
              where r.actor_id = new.actor_id and r.kind = 'build' and r.created_at > now() - interval '1 day') >= 30
          or (select count(*) from public.ai_builder_runs r
              where r.workspace_id = new.workspace_id and r.kind = 'build' and r.created_at > now() - interval '1 day') >= 60))
       or (new.kind = 'edit' and (
             (select count(*) from public.ai_builder_runs r
              where r.actor_id = new.actor_id and r.kind = 'edit' and r.created_at > now() - interval '1 hour') >= 30
          or (select count(*) from public.ai_builder_runs r
              where r.actor_id = new.actor_id and r.kind = 'edit' and r.created_at > now() - interval '1 day') >= 100))
       or (new.kind = 'automation' and (
             (select count(*) from public.ai_builder_runs r
              where r.actor_id = new.actor_id and r.kind = 'automation' and r.created_at > now() - interval '1 hour') >= 10
          or (select count(*) from public.ai_builder_runs r
              where r.actor_id = new.actor_id and r.kind = 'automation' and r.created_at > now() - interval '1 day') >= 30))
       or (select count(*) from public.ai_builder_runs r
           where r.workspace_id = new.workspace_id and r.created_at > now() - interval '1 day') >= 300 then
      raise exception 'AI builder limit reached; try again later'
        using errcode = 'program_limit_exceeded', hint = 'ai_builder_rate_limited';
    end if;
    return new;
  end if;

  if new.id <> old.id or new.workspace_id <> old.workspace_id or new.actor_id <> old.actor_id
     or new.request_key <> old.request_key or new.created_at <> old.created_at
     or new.brief_chars <> old.brief_chars or new.template_id is distinct from old.template_id
     or new.kind is distinct from old.kind or new.parent_run_id is distinct from old.parent_run_id
     or new.target_project_id is distinct from old.target_project_id then
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
  if new.rule_id is distinct from old.rule_id and not (
       old.kind = 'automation' and old.status = 'proposed' and old.rule_id is null and new.status = 'applied'
       and exists (
         select 1 from public.rules ru
         where ru.id = new.rule_id and ru.project_id = old.target_project_id
           and ru.created_by = old.actor_id and ru.deleted_at is null
       )) then
    raise exception 'An automation draft records only the rule its person saved from it' using errcode = 'check_violation';
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
    if new.model is distinct from old.model or new.effort is distinct from old.effort
       or new.input_tokens is distinct from old.input_tokens
       or new.output_tokens is distinct from old.output_tokens or new.generated_at is distinct from old.generated_at then
      raise exception 'A run''s generation details can''t change' using errcode = 'check_violation';
    end if;
    if old.kind = 'build' then
      if new.status not in ('proposed', 'cancelled', 'applied') or (new.status = 'applied' and not writing) then
        raise exception 'Only ai_builder_apply applies a proposal' using errcode = 'check_violation';
      end if;
      if new.proposal is distinct from old.proposal and (new.status <> 'proposed' or new.proposal_version <> old.proposal_version + 1) then
        raise exception 'Each edit of a proposal is a new version' using errcode = 'check_violation';
      end if;
      if new.proposal is not distinct from old.proposal and new.proposal_version <> old.proposal_version then
        raise exception 'Each edit of a proposal is a new version' using errcode = 'check_violation';
      end if;
    else
      -- An AI change's or an automation draft's answer is a record: it never changes. An AI change
      -- stays a proposal (the build's own versions carry it); an automation draft is applied only by the
      -- rule check above.
      if new.proposal is distinct from old.proposal or new.proposal_version <> old.proposal_version then
        raise exception 'This run''s answer can''t change' using errcode = 'check_violation';
      end if;
      if new.status not in ('proposed', 'cancelled', 'applied')
         or (new.status = 'applied' and (old.kind <> 'automation' or new.rule_id is null or writing)) then
        raise exception 'Only a saved rule finishes an automation draft' using errcode = 'check_violation';
      end if;
    end if;
  elsif old.status = 'applied' then
    if old.kind <> 'build' or not writing or new.status not in ('applied', 'undone')
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

-- ---------------------------------------------------------------------------------------------------
-- Proposal validation (mirrors parseProposal in packages/core/src/ai-builder.ts)
-- ---------------------------------------------------------------------------------------------------

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
  asg jsonb;
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
    -- Round 2: a start date (like the due date, never after it) and an assignee (a person's profile id —
    -- ai_builder_apply checks they belong to the pilot — or a placeholder role name, 1–60 characters).
    if t ? 'start_in_days' and coalesce(jsonb_typeof(t -> 'start_in_days'), 'missing') <> 'null' then
      if coalesce(jsonb_typeof(t -> 'start_in_days'), 'missing') <> 'number' then
        return 'A start date is 0–365 days from today';
      end if;
      if (t ->> 'start_in_days')::numeric not between 0 and 365
         or (t ->> 'start_in_days')::numeric <> trunc((t ->> 'start_in_days')::numeric) then
        return 'A start date is 0–365 days from today';
      end if;
      if jsonb_typeof(t -> 'due_in_days') = 'number' and (t ->> 'start_in_days')::numeric > (t ->> 'due_in_days')::numeric then
        return 'A task can''t start after it''s due';
      end if;
    end if;
    asg := t -> 'assignee';
    if asg is not null and jsonb_typeof(asg) <> 'null' then
      if jsonb_typeof(asg) <> 'object' or (select count(*) from jsonb_object_keys(asg)) <> 1 then
        return 'An assignee is a person or a placeholder';
      end if;
      if asg ? 'member' then
        if coalesce(jsonb_typeof(asg -> 'member'), 'missing') <> 'string'
           or (asg ->> 'member') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          return 'An assignee is a person or a placeholder';
        end if;
      elsif asg ? 'placeholder' then
        if coalesce(jsonb_typeof(asg -> 'placeholder'), 'missing') <> 'string'
           or coalesce(char_length(btrim(asg ->> 'placeholder')), 0) not between 1 and 60 then
          return 'A placeholder is 1–60 characters';
        end if;
      else
        return 'An assignee is a person or a placeholder';
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
-- Fingerprint (project roles and their links too)
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
  select jsonb_strip_nulls(jsonb_build_object(
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
    'goals', (select count(*) from public.goal_links gl where gl.project_id = target_project),
    'roles', (select case when count(*) = 0 then null
                     else md5(string_agg(row(pr.id, pr.name, pr.profile_id, pr.deleted_at)::text, ',' order by pr.id)) end
              from public.project_roles pr where pr.project_id = target_project),
    'role_links', (select case when count(*) = 0 then null
                          else md5(string_agg(row(rl.task_id, rl.project_role_id, rl.slot, rl.deleted_at)::text, ',' order by rl.id)) end
                   from public.task_role_links rl
                   where rl.task_id in (select id from every_task))
  ));
$$;

revoke all on function public.ai_builder_project_fingerprint(uuid) from public, anon;
grant execute on function public.ai_builder_project_fingerprint(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Apply (builds only; start dates, assignees, placeholders)
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
  asg jsonb;
  person uuid;
  person_email text;
  role_ids jsonb := '{}';
  role_list uuid[] := '{}';
  role_id uuid;
begin
  select * into r from public.ai_builder_runs x where x.id = target_run for update;
  if not found then
    raise exception 'Run not found' using errcode = 'no_data_found';
  end if;
  if r.actor_id is distinct from auth.uid() or not public.ai_pilot_admin(r.workspace_id) then
    raise exception 'Only the admin who made this proposal can apply it in the Testing data pilot' using errcode = 'insufficient_privilege';
  end if;
  -- Round 2: only a project proposal (kind build) is ever created; AI changes and automation drafts aren't.
  if coalesce(r.kind, 'build') <> 'build' then
    raise exception 'Only a project proposal can be created' using errcode = 'check_violation';
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
    if nullif(btrim(coalesce(tsk ->> 'notes', '')), '') is not null or jsonb_typeof(tsk -> 'due_in_days') = 'number'
       or jsonb_typeof(tsk -> 'start_in_days') = 'number' then
      update public.tasks
      set notes = coalesce(nullif(btrim(coalesce(tsk ->> 'notes', '')), ''), notes),
          due_on = case when jsonb_typeof(tsk -> 'due_in_days') = 'number' then local_today + (tsk ->> 'due_in_days')::integer else due_on end,
          start_on = case when jsonb_typeof(tsk -> 'start_in_days') = 'number' then local_today + (tsk ->> 'start_in_days')::integer else start_on end
      where id = new_task;
    end if;
    -- Round 2: the assignee. A person must be one of the pilot workspace's people (ai_pilot_members);
    -- anyone but the caller joins the new project as an Editor first (add_project_member, the Share
    -- dialog's own path), so they can read what they're assigned. A placeholder becomes a project role
    -- with nobody in it yet (Overview → Project roles), linked to the task as its assignee role.
    asg := tsk -> 'assignee';
    if asg is not null and jsonb_typeof(asg) = 'object' and asg ? 'member' then
      person := (asg ->> 'member')::uuid;
      select m.email into person_email from public.ai_pilot_members(r.workspace_id) m where m.profile_id = person;
      if not found then
        raise exception 'Only people of the Testing data workspace can be assigned' using errcode = 'check_violation';
      end if;
      if person is distinct from auth.uid() and not exists (
        select 1 from public.project_members pm where pm.project_id = proj and pm.profile_id = person and pm.deleted_at is null
      ) then
        perform public.add_project_member(proj, person_email, 'editor');
      end if;
      update public.tasks set assignee_id = person where id = new_task;
    elsif asg is not null and jsonb_typeof(asg) = 'object' and asg ? 'placeholder' then
      role_id := (role_ids ->> lower(btrim(asg ->> 'placeholder')))::uuid;
      if role_id is null then
        insert into public.project_roles (project_id, name) values (proj, btrim(asg ->> 'placeholder')) returning id into role_id;
        role_ids := role_ids || jsonb_build_object(lower(btrim(asg ->> 'placeholder')), role_id);
        role_list := role_list || role_id;
      end if;
      insert into public.task_role_links (task_id, project_role_id, slot) values (new_task, role_id, 'assignee');
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
                                'tasks', to_jsonb(task_ids), 'subtasks', to_jsonb(subtask_ids), 'roles', to_jsonb(role_list));
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
