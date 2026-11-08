-- AI builder round 3, "AI everywhere" (note 171; EXPERIMENTAL, branch feat/ai-builder-p3 → feat/ai-builder;
-- draft PR "[Asana Recreation PM] Nov 8 feat: AI everywhere (do not merge to main)"). Made with
-- `supabase migration new`; NOT applied anywhere. Additive: no row or object is removed (no TAIL). Apply
-- after 20261108140817_ai_builder_round2_a.sql.
--
-- What this adds to the Testing data pilot:
--   * ai_assistant_runs: the global AI assistant's log. One row per request: who asked, the pilot
--     workspace, what kind of page it came from (and its project / task / automation ids), how long the
--     instruction was (never its text), the model, its effort and why it was picked (route_reason,
--     escalated), token usage, the validated change set (proposal: typed operations on existing data,
--     resolved to real ids by the app), what applying it changed (applied: each operation's before and
--     after, the ids it touched), Undo's conflicts, and every failure (error_code + the provider's own
--     line in error_detail; never a key, a header, or a prompt).
--   * guard_ai_assistant_run() (invoker): the run's identity never changes; its states are
--     generating → proposed | failed | cancelled, proposed → applying | cancelled | failed,
--     applying → applied | rolled_back | failed, applied → applied (Undo's progress and conflicts) | undone;
--     the change set is set once (when it is proposed) and never edited; an apply key is set once.
--     Rate limits (mirrored by ASSISTANT_LIMITS in packages/core/src/ai-assistant.ts): two requests
--     generating at once, 30 an hour and 150 a day per person, 400 a day per workspace.
--   * Row level security: only workspace admins of the live pilot workspace read its runs; each person
--     writes only their own.
--
-- The assistant's operations themselves are ordinary writes the app makes as the signed-in person through
-- the typed API (RLS, the guards, validate_rule, and the blocked-completion guard decide); nothing here
-- writes tasks, sections, or automations, and nothing here sends anything.
--
-- No new client SECURITY DEFINER function (suite 60 unchanged); nothing for anon.

create table public.ai_assistant_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  actor_id uuid not null default auth.uid() references public.profiles (id),
  request_key text not null check (request_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  status text not null default 'generating'
    check (status in ('generating', 'proposed', 'failed', 'cancelled', 'applying', 'applied', 'rolled_back', 'undone')),
  page_kind text not null default 'other'
    check (page_kind in ('project', 'task', 'my_tasks', 'rules', 'rule', 'other')),
  page_project_id uuid references public.projects (id),
  page_task_id uuid references public.tasks (id),
  page_rule_id uuid references public.rules (id),
  instruction_chars integer not null default 0 check (instruction_chars between 0 and 4000),
  model text check (char_length(model) <= 100),
  effort text check (effort is null or effort in ('low', 'medium', 'high')),
  route_reason text check (route_reason is null or route_reason ~ '^[a-z0-9_]{1,40}$'),
  escalated boolean not null default false,
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  proposal jsonb,
  op_count integer not null default 0 check (op_count between 0 and 100),
  ops_summary jsonb,
  error_code text check (error_code ~ '^[a-z_]{1,40}$'),
  error_detail text check (char_length(error_detail) <= 400),
  apply_key text check (apply_key is null or apply_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  applied jsonb,
  touched_ids uuid[],
  undo_conflicts jsonb,
  generated_at timestamptz,
  applied_at timestamptz,
  undone_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (actor_id, request_key)
);

create index ai_assistant_runs_workspace_created_idx on public.ai_assistant_runs (workspace_id, created_at desc);
create index ai_assistant_runs_actor_created_idx on public.ai_assistant_runs (actor_id, created_at desc);
create index ai_assistant_runs_page_project_idx on public.ai_assistant_runs (page_project_id);
create index ai_assistant_runs_page_task_idx on public.ai_assistant_runs (page_task_id);
create index ai_assistant_runs_page_rule_idx on public.ai_assistant_runs (page_rule_id);

alter table public.ai_assistant_runs enable row level security;
select public.alhc_revoke_anon_grants(array['ai_assistant_runs']);
select public.alhc_revoke_client_truncate(array['ai_assistant_runs']);
revoke insert, update on public.ai_assistant_runs from authenticated;
grant select on public.ai_assistant_runs to authenticated;
grant insert (workspace_id, request_key, page_kind, page_project_id, page_task_id, page_rule_id, instruction_chars)
  on public.ai_assistant_runs to authenticated;
grant update (status, model, effort, route_reason, escalated, input_tokens, output_tokens, proposal, op_count, ops_summary,
              error_code, error_detail, apply_key, applied, touched_ids, undo_conflicts, generated_at)
  on public.ai_assistant_runs to authenticated;

create policy ai_assistant_runs_select_admin on public.ai_assistant_runs
  for select to authenticated using ((select public.ai_pilot_admin(workspace_id)));
create policy ai_assistant_runs_insert_own on public.ai_assistant_runs
  for insert to authenticated
  with check (actor_id = (select auth.uid()) and (select public.ai_pilot_admin(workspace_id)));
create policy ai_assistant_runs_update_own on public.ai_assistant_runs
  for update to authenticated
  using (actor_id = (select auth.uid()) and (select public.ai_pilot_admin(workspace_id)))
  with check (actor_id = (select auth.uid()) and (select public.ai_pilot_admin(workspace_id)));

create or replace function public.guard_ai_assistant_run()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.actor_id := auth.uid();
    new.status := 'generating';
    new.created_at := now();
    new.updated_at := now();
    new.model := null;
    new.effort := null;
    new.route_reason := null;
    new.escalated := false;
    new.input_tokens := null;
    new.output_tokens := null;
    new.proposal := null;
    new.op_count := 0;
    new.ops_summary := null;
    new.error_code := null;
    new.error_detail := null;
    new.apply_key := null;
    new.applied := null;
    new.touched_ids := null;
    new.undo_conflicts := null;
    new.generated_at := null;
    new.applied_at := null;
    new.undone_at := null;
    if new.actor_id is null or not public.ai_pilot_admin(new.workspace_id) then
      raise exception 'The AI assistant is only for workspace admins of the Testing data pilot' using errcode = 'insufficient_privilege';
    end if;
    if new.page_project_id is not null and not exists (
      select 1 from public.projects p
      where p.id = new.page_project_id and p.workspace_id = new.workspace_id and p.deleted_at is null
    ) then
      raise exception 'The AI assistant only works in projects of the Testing data workspace' using errcode = 'insufficient_privilege';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('alhc.ai_assistant:' || new.workspace_id::text, 0));
    if (select count(*) from public.ai_assistant_runs r
        where r.actor_id = new.actor_id and r.status = 'generating' and r.created_at > now() - interval '5 minutes') >= 2
       or (select count(*) from public.ai_assistant_runs r
           where r.actor_id = new.actor_id and r.created_at > now() - interval '1 hour') >= 30
       or (select count(*) from public.ai_assistant_runs r
           where r.actor_id = new.actor_id and r.created_at > now() - interval '1 day') >= 150
       or (select count(*) from public.ai_assistant_runs r
           where r.workspace_id = new.workspace_id and r.created_at > now() - interval '1 day') >= 400 then
      raise exception 'AI assistant limit reached; try again later'
        using errcode = 'program_limit_exceeded', hint = 'ai_assistant_rate_limited';
    end if;
    return new;
  end if;

  if new.id <> old.id or new.workspace_id <> old.workspace_id or new.actor_id <> old.actor_id
     or new.request_key <> old.request_key or new.created_at <> old.created_at
     or new.page_kind <> old.page_kind or new.page_project_id is distinct from old.page_project_id
     or new.page_task_id is distinct from old.page_task_id or new.page_rule_id is distinct from old.page_rule_id
     or new.instruction_chars <> old.instruction_chars then
    raise exception 'A run''s identity can''t change' using errcode = 'insufficient_privilege';
  end if;
  if old.status in ('failed', 'cancelled', 'rolled_back', 'undone') then
    raise exception 'This run is finished' using errcode = 'check_violation';
  end if;
  -- The model's answer and its usage are recorded once, while the run is generating.
  if old.status <> 'generating' and (
       new.proposal is distinct from old.proposal or new.model is distinct from old.model
       or new.effort is distinct from old.effort or new.route_reason is distinct from old.route_reason
       or new.escalated is distinct from old.escalated or new.input_tokens is distinct from old.input_tokens
       or new.output_tokens is distinct from old.output_tokens or new.op_count <> old.op_count
       or new.ops_summary is distinct from old.ops_summary or new.generated_at is distinct from old.generated_at) then
    raise exception 'A change set never changes once it is proposed' using errcode = 'check_violation';
  end if;
  if old.apply_key is not null and new.apply_key is distinct from old.apply_key then
    raise exception 'A run is applied once' using errcode = 'check_violation';
  end if;
  if old.status not in ('applying', 'applied') and (
       new.applied is distinct from old.applied or new.touched_ids is distinct from old.touched_ids) then
    raise exception 'Only applying a run records what it changed' using errcode = 'check_violation';
  end if;
  if new.undo_conflicts is distinct from old.undo_conflicts and old.status <> 'applied' then
    raise exception 'Only an applied run has Undo conflicts' using errcode = 'check_violation';
  end if;

  if new.status is distinct from old.status then
    if not (
         (old.status = 'generating' and new.status in ('proposed', 'failed', 'cancelled'))
      or (old.status = 'proposed' and new.status in ('applying', 'cancelled', 'failed'))
      or (old.status = 'applying' and new.status in ('applied', 'rolled_back', 'failed'))
      or (old.status = 'applied' and new.status = 'undone')) then
      raise exception 'That isn''t a step this run can take' using errcode = 'check_violation';
    end if;
    if new.status = 'proposed' and new.proposal is null then
      raise exception 'A proposed run carries its change set' using errcode = 'check_violation';
    end if;
    if new.status = 'applying' and new.apply_key is null then
      raise exception 'Applying needs an apply key' using errcode = 'check_violation';
    end if;
  end if;
  new.applied_at := case when new.status = 'applied' and old.status = 'applying' then now() else old.applied_at end;
  new.undone_at := case when new.status = 'undone' and old.status = 'applied' then now() else old.undone_at end;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.guard_ai_assistant_run() from public, anon;
grant execute on function public.guard_ai_assistant_run() to authenticated;

create trigger ai_assistant_runs_05_guard
  before insert or update on public.ai_assistant_runs
  for each row execute function public.guard_ai_assistant_run();

comment on table public.ai_assistant_runs is
  'AI builder round 3 (experimental pilot, note 171): the global AI assistant''s log — request, change set, apply, Undo, failures. Never the instruction''s text, a prompt, or a key.';
