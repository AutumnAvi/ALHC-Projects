-- ALHC Projects — Phase: Asana parity, batch 4 (create flows and Customize).
-- Mostly UI (the template gallery, New portfolio / New goal modals, the Browse projects table, the
-- Customize panel's sub-views, the form editor, the rule canvas, the Fields list and Edit field modal).
-- The database gains only what those screens need to be real:
--
--   Fields: custom_fields.description (≤ 2000 characters), notify_on_change, and in_library. Written like
--     the rest of a field (custom_fields_update_editor: Editor+; an archived project caps everyone at
--     Viewer). A section-bound Status field can't notify or join the library (CHECKs): it stores no values
--     and its options are the project's sections.
--   Field library: list_field_library() (SECURITY DEFINER, allowlisted callers) returns the name, type,
--     description, and options of every active library field in the workspace — never its project's
--     name or id, so a private project stays invisible. Adding one to a project copies the definition
--     with an ordinary custom_fields insert (Editor+ there); the copies don't sync.
--   Notify collaborators when changed: a field value change (not in the transaction that created the
--     task) sends each active follower an inbox item through notify_with(), so the actor, people who
--     can't read the task, imports, and copies are skipped exactly as for every other notification. The
--     item reuses the inbox kind "rule" (the automated-notification kind: data.message, plus
--     data.field_change = true and the field's id / name / value text), so no inbox CHECK changes and
--     the release still on main renders it as "notified you about … · <message>".
--   Forms: two question types. "heading" (a title and help text between questions; never answered,
--     never required, never mapped, can't drive branching) and "email" (an email address, lowercased
--     and checked like the submitter's; maps to the task name, the description, or a text field).
--     validate_form and normalize_form_answer gain them through asserted text patches; submit_form is
--     unchanged (a heading normalizes to "no answer").
--   Rule branches (Check if / Else if / Otherwise): a condition or action may carry "branch": 0–4
--     (missing = 0). run_rule runs the actions of the first branch whose conditions pass, in branch
--     order; a branch without conditions passes (only the last one may have none: "Otherwise"). A rule
--     whose items carry no branch key behaves exactly as before. A delayed job re-checks only the
--     branch its remaining actions came from. The integration-secret stash trigger, the copy engine,
--     and the importer already keep unknown keys on conditions and actions, so branches survive them
--     unchanged. validate_rule checks the branch keys and per-branch limits (validate_rule_branches);
--     the run log records the branch taken (rule_runs.detail.branch, branched rules only).
--   Browse projects: browse_project_people(target_team) (SECURITY DEFINER) adds owners, members, and a
--     last-modified time to exactly the rows browse_projects() returns (it calls it), so a private
--     project of others never shows and workspace admins get nothing extra.
--
-- Two new client SECURITY DEFINER functions, list_field_library and browse_project_people (pinned in
-- suite 60). Everything else new is invoker or internal and revoked. Nothing for anon (alhc_revoke_*).
-- fire_rules, notify_with, notify_message, and add_story are untouched (their import and copy checks
-- included). Additive: the release still on main keeps working once this is applied (it never writes a
-- branch key, a new question type, or the new field columns, and every existing rule runs as before).
-- custom_fields.description is added last: the app treats this batch's database features as present
-- only once that column exists. No TAIL section.

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
-- Rule branches
-- ---------------------------------------------------------------------------

-- The branch a rule item (condition or action) belongs to: its "branch" key, 0 when missing.
-- validate_rule_branches() only lets whole numbers 0–4 through.
create or replace function public.rule_item_branch(item jsonb)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(item) = 'object' and jsonb_typeof(item -> 'branch') = 'number' and (item ->> 'branch') ~ '^[0-9]{1,3}$'
      then (item ->> 'branch')::integer
    else 0
  end;
$$;

-- The items (conditions or actions) of one branch, in their saved order.
create or replace function public.rule_branch_items(items jsonb, target_branch integer)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(x.value order by x.ordinality), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(items) = 'array' then items else '[]'::jsonb end)
    with ordinality x
  where public.rule_item_branch(x.value) = target_branch;
$$;

-- How many branches a rule has: 1 + the highest branch key of its conditions and actions.
create or replace function public.rule_branch_count(rule_conditions jsonb, rule_actions jsonb)
returns integer
language sql
immutable
set search_path = ''
as $$
  select 1 + greatest(
    coalesce((
      select max(public.rule_item_branch(c.value))
      from jsonb_array_elements(case when jsonb_typeof(rule_conditions) = 'array' then rule_conditions else '[]'::jsonb end) c
    ), 0),
    coalesce((
      select max(public.rule_item_branch(a.value))
      from jsonb_array_elements(case when jsonb_typeof(rule_actions) = 'array' then rule_actions else '[]'::jsonb end) a
    ), 0)
  );
$$;

select public.alhc_revoke_anon_execute(array[
  'rule_item_branch(jsonb)', 'rule_branch_items(jsonb,integer)', 'rule_branch_count(jsonb,jsonb)'
]);
grant execute on function public.rule_item_branch(jsonb) to authenticated;
grant execute on function public.rule_branch_items(jsonb, integer) to authenticated;
grant execute on function public.rule_branch_count(jsonb, jsonb) to authenticated;

-- Branch keys and per-branch limits, called by validate_rule (an invoker trigger) in place of its old
-- whole-rule limits. Without branch keys the old limits and messages apply unchanged (20 conditions,
-- 1–10 actions). With branches: up to 5 (Check if, three Else if, Otherwise), each with 1–10 actions and
-- up to 20 conditions, and only the last branch may have no conditions (an earlier one would always win).
create or replace function public.validate_rule_branches(rule_conditions jsonb, rule_actions jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  item jsonb;
  branches integer;
  b integer;
  n_conditions integer;
  n_actions integer;
begin
  if coalesce(jsonb_typeof(rule_conditions), 'missing') <> 'array' or coalesce(jsonb_typeof(rule_actions), 'missing') <> 'array' then
    raise exception 'Conditions and actions must be lists' using errcode = 'check_violation';
  end if;
  for item in
    select value from jsonb_array_elements(rule_conditions)
    union all
    select value from jsonb_array_elements(rule_actions)
  loop
    if jsonb_typeof(item) = 'object' and item ? 'branch'
       and (jsonb_typeof(item -> 'branch') <> 'number' or (item ->> 'branch') !~ '^[0-4]$') then
      raise exception 'A rule branch is a whole number from 0 to 4' using errcode = 'check_violation';
    end if;
  end loop;

  branches := public.rule_branch_count(rule_conditions, rule_actions);
  if branches = 1 then
    if jsonb_array_length(rule_conditions) > 20 then
      raise exception 'Rules are limited to 20 conditions' using errcode = 'check_violation';
    end if;
    if jsonb_array_length(rule_actions) not between 1 and 10 then
      raise exception 'Rules need between 1 and 10 actions' using errcode = 'check_violation';
    end if;
    return;
  end if;

  for b in 0 .. branches - 1 loop
    n_conditions := jsonb_array_length(public.rule_branch_items(rule_conditions, b));
    n_actions := jsonb_array_length(public.rule_branch_items(rule_actions, b));
    if n_conditions > 20 then
      raise exception 'Each branch is limited to 20 conditions' using errcode = 'check_violation';
    end if;
    if n_actions not between 1 and 10 then
      raise exception 'Each branch needs between 1 and 10 actions' using errcode = 'check_violation';
    end if;
    if n_conditions = 0 and b < branches - 1 then
      raise exception 'Only the last branch (Otherwise) can run without conditions' using errcode = 'check_violation';
    end if;
  end loop;
end;
$$;

select public.alhc_revoke_anon_execute(array['validate_rule_branches(jsonb,jsonb)']);
grant execute on function public.validate_rule_branches(jsonb, jsonb) to authenticated;

select public.alhc_patch_function('public.validate_rule()'::regprocedure,
  $old$  if jsonb_array_length(new.conditions) > 20 then
    raise exception 'Rules are limited to 20 conditions' using errcode = 'check_violation';
  end if;$old$,
  $new$  -- Branch keys and limits (Asana parity, batch 4): the old whole-rule limits without branches.
  perform public.validate_rule_branches(new.conditions, new.actions);$new$,
  $old$  if jsonb_array_length(new.actions) not between 1 and 10 then
    raise exception 'Rules need between 1 and 10 actions' using errcode = 'check_violation';
  end if;
$old$,
  ''
);

-- Picks the branch to run: the first whose conditions pass (Check if, then each Else if, then
-- Otherwise). A rule without branch keys is one branch, so this is rule_conditions_pass() as before.
-- A delayed job (resume = its remaining actions) re-checks only the branch those actions came from,
-- and is cancelled when the rule no longer has that branch.
-- Internal: called by run_rule (definer); revoked from every client role.
create or replace function public.rule_pick_branch(r public.rules, target_task uuid, resume jsonb)
returns integer
language plpgsql
stable
set search_path = ''
as $$
declare
  branches integer := public.rule_branch_count(r.conditions, r.actions);
  candidate public.rules := r;
  b integer;
begin
  if jsonb_typeof(resume) = 'array' and jsonb_array_length(resume) > 0 then
    b := public.rule_item_branch(resume -> 0);
    if b >= branches then
      return null;
    end if;
    candidate.conditions := public.rule_branch_items(r.conditions, b);
    return case when public.rule_conditions_pass(candidate, target_task) then b end;
  end if;
  if branches <= 1 then
    return case when public.rule_conditions_pass(r, target_task) then 0 end;
  end if;
  for b in 0 .. branches - 1 loop
    candidate.conditions := public.rule_branch_items(r.conditions, b);
    if public.rule_conditions_pass(candidate, target_task) then
      return b;
    end if;
  end loop;
  return null;
end;
$$;

revoke all on function public.rule_pick_branch(public.rules, uuid, jsonb) from public, anon, authenticated;

select public.alhc_patch_function('public.run_rule(public.rules, uuid, jsonb, jsonb, text)'::regprocedure,
  $old$  run_id uuid := gen_random_uuid();
begin$old$,
  $new$  run_id uuid := gen_random_uuid();
  chosen_branch integer;
begin$new$,
  $old$  if not public.rule_conditions_pass(r, target_task) then
    return 'conditions';
  end if;$old$,
  $new$  chosen_branch := public.rule_pick_branch(r, target_task, rule_actions);
  if chosen_branch is null then
    return 'conditions';
  end if;$new$,
  $old$coalesce(rule_actions, r.actions)$old$,
  $new$coalesce(rule_actions, public.rule_branch_items(r.actions, chosen_branch))$new$,
  $old$jsonb_build_object('actions', log, 'event', coalesce(event, '{}'::jsonb)), dedupe);$old$,
  $new$jsonb_build_object('actions', log, 'event', coalesce(event, '{}'::jsonb))
      || case when public.rule_branch_count(r.conditions, r.actions) > 1
        then jsonb_build_object('branch', chosen_branch) else '{}'::jsonb end, dedupe);$new$
);

-- ---------------------------------------------------------------------------
-- Forms: heading and email questions
-- ---------------------------------------------------------------------------

select public.alhc_patch_function('public.validate_form()'::regprocedure,
  $old$      'short_text', 'long_text', 'number', 'date', 'single_select', 'multi_select', 'checkbox'
    ) then$old$,
  $new$      'short_text', 'long_text', 'number', 'date', 'single_select', 'multi_select', 'checkbox', 'email', 'heading'
    ) then$new$,
  $old$    if q ? 'required' and coalesce(jsonb_typeof(q -> 'required'), 'missing') <> 'boolean' then
      raise exception 'required must be true or false' using errcode = 'check_violation';
    end if;$old$,
  $new$    if q ? 'required' and coalesce(jsonb_typeof(q -> 'required'), 'missing') <> 'boolean' then
      raise exception 'required must be true or false' using errcode = 'check_violation';
    end if;
    -- A heading (Asana parity, batch 4) only shows text: never answered, required, or mapped.
    if qtype = 'heading' and (q -> 'required' = 'true'::jsonb or jsonb_typeof(q -> 'maps_to') = 'object') then
      raise exception 'The heading “%” can''t be required or fill in a task detail', q ->> 'label'
        using errcode = 'check_violation';
    end if;$new$
);

select public.alhc_patch_function('public.normalize_form_answer(jsonb, jsonb)'::regprocedure,
  $old$    when 'checkbox' then
      return case when raw = 'true'::jsonb then 'true'::jsonb end;$old$,
  $new$    when 'checkbox' then
      return case when raw = 'true'::jsonb then 'true'::jsonb end;
    when 'email' then
      if coalesce(jsonb_typeof(raw), 'missing') <> 'string' then
        raise exception 'Invalid answer for “%”', label using errcode = 'check_violation';
      end if;
      value := lower(trim(raw #>> '{}'));
      if value = '' then return null; end if;
      if not public.is_email(value) then
        raise exception 'Enter a valid email address for “%”', label using errcode = 'check_violation';
      end if;
      return to_jsonb(value);
    when 'heading' then
      return null;$new$
);

-- ---------------------------------------------------------------------------
-- Browse projects: owners, members, last modified
-- ---------------------------------------------------------------------------

-- The extra columns of the Browse projects table, for exactly the rows browse_projects() returns to the
-- caller (the caller's own projects plus public-to-team projects of their teams): owners and members
-- (owners first, then by role and join date) and the last time the project or one of its tasks changed.
-- Never a private project of others; workspace admins get nothing extra.
create or replace function public.browse_project_people(target_team uuid default null)
returns table (project_id uuid, owner_ids uuid[], member_ids uuid[], modified_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select
    b.project_id,
    coalesce((
      select array_agg(m.profile_id order by m.created_at, m.profile_id)
      from public.project_members m
      where m.project_id = b.project_id and m.deleted_at is null and m.role = 'owner'
    ), '{}'::uuid[]),
    coalesce((
      select array_agg(m.profile_id order by public.project_role_rank(m.role) desc, m.created_at, m.profile_id)
      from public.project_members m
      where m.project_id = b.project_id and m.deleted_at is null
    ), '{}'::uuid[]),
    greatest(p.updated_at, (
      select max(t.updated_at)
      from public.task_projects tp
      join public.tasks t on t.id = tp.task_id
      where tp.project_id = b.project_id
    ))
  from public.browse_projects(target_team) b
  join public.projects p on p.id = b.project_id;
$$;

revoke all on function public.browse_project_people(uuid) from public, anon;
grant execute on function public.browse_project_people(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Fields: notify collaborators, field library
-- ---------------------------------------------------------------------------

alter table public.custom_fields
  add column notify_on_change boolean not null default false,
  add column in_library boolean not null default false;

alter table public.custom_fields
  add constraint custom_fields_notify_check check (not (bound_to_sections and notify_on_change)),
  add constraint custom_fields_library_check check (not (bound_to_sections and in_library));

comment on column public.custom_fields.notify_on_change is
  'Asana parity, batch 4: when a value of this field changes (not while the task is being created), every '
  'active follower of the task gets an inbox item (kind rule, data.field_change = true) through notify_with().';
comment on column public.custom_fields.in_library is
  'Asana parity, batch 4: listed in the workspace field library (list_field_library: name, type, '
  'description, and options only). Adding a library field to a project copies it.';

-- Followers hear about a change of a field that asks for it. Values set in the transaction that created
-- the task (forms, templates, duplicates, quick-add) don't notify; notify_with() skips the actor, people
-- who can't read the task, imports, and copies.
create or replace function public.on_task_field_value_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.custom_fields;
  t public.tasks;
  follower uuid;
  shown text;
begin
  if tg_op = 'UPDATE' and new.value is not distinct from old.value then
    return new;
  end if;
  select * into f from public.custom_fields cf where cf.id = new.field_id;
  if f.id is null or not f.notify_on_change or f.deleted_at is not null then
    return new;
  end if;
  select * into t from public.tasks tk where tk.id = new.task_id;
  if t.id is null or t.deleted_at is not null or t.created_at = now() then
    return new;
  end if;
  shown := left(nullif(trim(coalesce(public.task_field_text(new.task_id, new.field_id), '')), ''), 200);
  for follower in
    select tf.profile_id from public.task_followers tf
    where tf.task_id = new.task_id and tf.deleted_at is null
  loop
    perform public.notify_with(follower, new.task_id, 'rule', null, jsonb_build_object(
      'field_change', true,
      'field_id', f.id,
      'field_name', f.name,
      'value_text', shown,
      'message', left(case when shown is null then f.name || ' was cleared' else f.name || ' changed to ' || shown end, 1000)
    ));
  end loop;
  return new;
end;
$$;

revoke all on function public.on_task_field_value_notify() from public, anon, authenticated;

create trigger task_field_values_zz_notify
  after insert or update of value on public.task_field_values
  for each row execute function public.on_task_field_value_notify();

-- Added last on purpose (see the header): the app reads this column to know the batch is applied.
alter table public.custom_fields
  add column description text
    constraint custom_fields_description_check check (description is null or char_length(description) <= 2000);

comment on column public.custom_fields.description is
  'Asana parity, batch 4: what the field is for (Edit field → Description), ≤ 2000 characters.';

-- The workspace field library: name, type, description, and options of every active library field
-- (never its project's name or id). Allowlisted callers only; nothing else.
create or replace function public.list_field_library()
returns table (field_id uuid, name text, field_type text, description text, options jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select f.id, f.name, f.field_type, f.description, f.options
  from public.custom_fields f
  join public.projects p on p.id = f.project_id and p.deleted_at is null
  where public.is_allowlisted()
    and p.workspace_id = public.default_workspace_id()
    and f.in_library
    and f.deleted_at is null
    and not f.bound_to_sections
  order by lower(f.name), f.created_at, f.id;
$$;

revoke all on function public.list_field_library() from public, anon;
grant execute on function public.list_field_library() to authenticated;
