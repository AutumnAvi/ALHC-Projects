-- ALHC Projects — Nov 3 notes, batch 19 (notes 140–148 and the video run's bugs, note 142). Additive: no
-- table or column removed, nothing dropped; the release still on main keeps working once this is applied
-- (same function signatures and grants; new keys and columns are optional). No TAIL.
--
-- 142 (video bugs)
--   search_tasks matches every word ("zz-video brochure" finds "zz-video Draft brochure"), phrase matches
--     first (search_word_patterns, invoker).
--   40.5 "Create a task" with no section picked lands in the project's first section (not "No section").
--   23.5 tasks and task_projects join the Realtime publication (guarded), so project views and an open task
--     pane hear about renames and moves; Realtime applies each table's read policy.
--   Automation vocabulary: "Task assigned to …" (assignee_changed + trigger_config.to), "Task is imported"
--     (task_created + trigger_config.via = 'import', fired once per created top-level task by
--     finish_import_run — imports stay muted; fire_rules' import / copy checks are untouched and first),
--     conditions in_project / not_in_project and is_private / is_not_private.
-- 145 Set task type → Approval may carry the approval's setup (approvers, Any one / Everyone, due date,
--     after approval, reminders, who does the work): rule_approval_setup_problem (invoker, validate_rule),
--     rule_apply_approval_setup (definer, revoked from clients).
-- 147 create_subtask_blocking_parent (invoker): a new subtask that blocks its parent, in one transaction.
-- 140 Personal workdays: profile_preferences.work_week (own row, null = the organization's),
--     set_my_work_week (invoker); business-day steps take "workdays": "org" | "personal" (default: personal on
--     My Tasks automations and on a project only the owner is in, the organization's elsewhere;
--     rule_work_days / rule_personal_by_default, internal).
-- 148 preview_dependency_move_along (invoker): the Timeline's Shift+drag plan, applied through the unchanged
--     apply_dependency_shifts.
--
-- No new SECURITY DEFINER function a client can call (suite 60 unchanged); nothing for anon.

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
-- 142 (video bug 3). Search matches every word, not only the exact phrase: "zz-video brochure" finds
-- "zz-video Draft brochure". A task matches when the whole text is in its name, description, a tag, or a
-- number (as before), or — for two or more words — when each word is in its name, description, or one of
-- its tags (any order, any case). Phrase matches still sort first.
-- =================================================================================================

-- The words of a search, as escaped ILIKE patterns (at most 8; empty for one word or none).
create or replace function public.search_word_patterns(query text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case when count(*) < 2 then '{}'::text[] else array_agg(p order by n) end
  from (
    select n, '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%' as p
    from regexp_split_to_table(trim(coalesce(query, '')), '\s+') with ordinality as x(w, n)
    where w <> ''
    order by n
    limit 8
  ) words;
$$;

comment on function public.search_word_patterns(text) is
  'Nov 3 notes (batch 19, 142): the words of a search as ILIKE patterns (two or more words, at most 8), for search_tasks.';

select public.alhc_revoke_anon_execute(array['search_word_patterns(text)']);
revoke all on function public.search_word_patterns(text) from public, anon;
grant execute on function public.search_word_patterns(text) to authenticated, service_role;

select public.alhc_patch_function('public.search_tasks(text, integer)'::regprocedure,
  $o$  with pattern as (
    select '%' || replace(replace(replace(trim(query), '\', '\\'), '%', '\%'), '_', '\_') || '%' as value
  )$o$,
  $n$  with pattern as (
    select '%' || replace(replace(replace(trim(query), '\', '\\'), '%', '\%'), '_', '\_') || '%' as value,
      public.search_word_patterns(query) as words
  )$n$,
  $o$      t.title ilike pattern.value
      or t.notes ilike pattern.value
      or exists ($o$,
  $n$      t.title ilike pattern.value
      or t.notes ilike pattern.value
      -- Nov 3 notes (batch 19): every word somewhere in the name, the description, or a tag.
      or (
        cardinality(pattern.words) > 1
        and not exists (
          select 1 from unnest(pattern.words) w(p)
          where not (
            t.title ilike w.p
            or coalesce(t.notes, '') ilike w.p
            or exists (
              select 1 from public.task_tags wt
              join public.tags wg on wg.id = wt.tag_id and wg.deleted_at is null
              join public.workspaces ww on ww.id = wg.workspace_id and ww.tags_enabled
              where wt.task_id = t.id and wt.deleted_at is null and wg.name ilike w.p
            )
          )
        )
      )
      or exists ($n$,
  $o$    t.completed_at is not null, t.title ilike pattern.value desc,$o$,
  $n$    t.completed_at is not null, t.title ilike pattern.value desc,
    (cardinality(pattern.words) > 1
      and not exists (select 1 from unnest(pattern.words) w(p) where not t.title ilike w.p)) desc,$n$
);

-- =================================================================================================
-- 147. "Block parent" when creating a subtask: the new subtask blocks its parent (finish-to-start, no lag),
-- in the same transaction as the create. Invoker: create_subtask (Editor of the tree) and
-- set_task_dependency (Editor on both, no cycles) decide, exactly as when the link is added by hand.
-- =================================================================================================

create or replace function public.create_subtask_blocking_parent(
  parent_task uuid,
  task_title text,
  before_task uuid default null
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  new_id uuid;
begin
  new_id := public.create_subtask(parent_task, task_title, before_task);
  perform public.set_task_dependency(new_id, parent_task, 'finish_to_start', 0);
  return new_id;
end;
$$;

comment on function public.create_subtask_blocking_parent(uuid, text, uuid) is
  'Nov 3 notes (batch 19, 147): create a subtask that blocks its parent (finish-to-start), in one transaction.';

select public.alhc_revoke_anon_execute(array['create_subtask_blocking_parent(uuid, text, uuid)']);
revoke all on function public.create_subtask_blocking_parent(uuid, text, uuid) from public, anon;
grant execute on function public.create_subtask_blocking_parent(uuid, text, uuid) to authenticated;

-- =================================================================================================
-- 140. Business days: the organization's workdays (workspaces.work_week, Admin console → Organization,
-- Sunday–Thursday by default) and each person's own (profile_preferences.work_week, Settings → Profile →
-- My workdays; null = the organization's). A business-day automation step counts:
--   "workdays": "org"       the organization's days;
--   "workdays": "personal"  its owner's own days (My Tasks automations: the person's);
--   no key                  personal on My Tasks automations and on a project whose only member is the
--                           automation's owner, the organization's everywhere else (shared projects,
--                           portfolios) — so nothing changes until someone sets their own days.
-- A person without their own days always counts the organization's.
-- =================================================================================================

alter table public.profile_preferences add column if not exists work_week smallint[];

alter table public.profile_preferences add constraint profile_preferences_work_week_check check (
  work_week is null
  or (cardinality(work_week) between 1 and 7 and work_week <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[])
);

grant select (work_week), insert (work_week), update (work_week) on public.profile_preferences to authenticated;

-- The caller's own days (null = the organization's). Invoker: own row through RLS.
create or replace function public.set_my_work_week(days smallint[])
returns smallint[]
language plpgsql
set search_path = ''
as $$
declare
  cleaned smallint[];
begin
  if auth.uid() is null or not public.is_allowlisted() then
    raise exception 'Sign in to change your settings' using errcode = 'insufficient_privilege';
  end if;
  if days is not null then
    select array_agg(distinct d order by d) into cleaned from unnest(days) d where d between 0 and 6;
    if cleaned is null then
      raise exception 'Pick at least one workday' using errcode = 'check_violation';
    end if;
  end if;
  insert into public.profile_preferences as p (work_week)
  values (cleaned)
  on conflict (profile_id) do update set work_week = excluded.work_week;
  return cleaned;
end;
$$;

comment on function public.set_my_work_week(smallint[]) is
  'Nov 3 notes (batch 19, 140): the caller''s own workdays (0 = Sunday … 6 = Saturday; null = the organization''s).';

select public.alhc_revoke_anon_execute(array['set_my_work_week(smallint[])']);
revoke all on function public.set_my_work_week(smallint[]) from public, anon;
grant execute on function public.set_my_work_week(smallint[]) to authenticated;

-- Which days a business-day step counts (see above). Internal: called by the automation runners (definer).
create or replace function public.rule_work_days(
  org_days smallint[],
  person uuid,
  choice text,
  personal_default boolean
)
returns smallint[]
language sql
stable
set search_path = ''
as $$
  select case
    when coalesce(nullif(choice, ''), case when personal_default then 'personal' else 'org' end) = 'personal'
      then coalesce((select pp.work_week from public.profile_preferences pp where pp.profile_id = person), org_days)
    else org_days
  end;
$$;

comment on function public.rule_work_days(smallint[], uuid, text, boolean) is
  'Nov 3 notes (batch 19, 140): the workdays a business-day automation step counts (org, or its owner''s own).';

select public.alhc_revoke_anon_execute(array['rule_work_days(smallint[], uuid, text, boolean)']);
revoke all on function public.rule_work_days(smallint[], uuid, text, boolean) from public, anon, authenticated;

-- A project automation's default: personal when the project's only active member is its owner.
create or replace function public.rule_personal_by_default(r public.rules)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(r.owner_id, r.created_by) is not null
    and not exists (
      select 1 from public.project_members m
      where m.project_id = r.project_id and m.deleted_at is null
        and m.profile_id is distinct from coalesce(r.owner_id, r.created_by)
    );
$$;

comment on function public.rule_personal_by_default(public.rules) is
  'Nov 3 notes (batch 19, 140): true when the automation''s project has no member but its owner (a personal project).';

select public.alhc_revoke_anon_execute(array['rule_personal_by_default(rules)']);
revoke all on function public.rule_personal_by_default(public.rules) from public, anon, authenticated;

select public.alhc_patch_function('public.rule_set_task_date(public.rules, uuid, jsonb, text)'::regprocedure,
  $o$      new_day := public.rule_add_days(base, n, business, public.project_work_week(r.project_id));$o$,
  $n$      new_day := public.rule_add_days(base, n, business,
        public.rule_work_days(public.project_work_week(r.project_id), coalesce(r.owner_id, r.created_by), a ->> 'workdays',
          public.rule_personal_by_default(r)));$n$,
  $o$    input := jsonb_build_object('days', n, 'unit', unit, 'business_days', business, 'from', coalesce(a ->> 'from', 'today'));$o$,
  $n$    input := jsonb_build_object('days', n, 'unit', unit, 'business_days', business, 'from', coalesce(a ->> 'from', 'today'))
      || case when business and a ? 'workdays' then jsonb_build_object('workdays', a ->> 'workdays') else '{}'::jsonb end;$n$
);

select public.alhc_patch_function('public.execute_rule_actions(public.rules, uuid, jsonb, jsonb)'::regprocedure,
  $o$                coalesce((a ->> 'business_days')::boolean, false), public.project_work_week(r.project_id)) end$o$,
  $n$                coalesce((a ->> 'business_days')::boolean, false),
                public.rule_work_days(public.project_work_week(r.project_id), coalesce(r.owner_id, r.created_by), a ->> 'workdays',
                  public.rule_personal_by_default(r))) end$n$
);

select public.alhc_patch_function('public.run_my_task_rule(public.my_task_rules, uuid, jsonb, text)'::regprocedure,
  $o$            (select w.work_week from public.workspaces w where w.id = t.workspace_id));$o$,
  $n$            public.rule_work_days((select w.work_week from public.workspaces w where w.id = t.workspace_id), r.profile_id,
              a ->> 'workdays', true));$n$
);

select public.alhc_patch_function('public.execute_portfolio_rule_actions(public.portfolio_rules, uuid, jsonb)'::regprocedure,
  $o$              (select w.work_week from public.workspaces w where w.id = p.workspace_id))$o$,
  $n$              public.rule_work_days((select w.work_week from public.workspaces w where w.id = p.workspace_id),
                coalesce(r.owner_id, r.created_by), a ->> 'workdays', false))$n$
);

-- The step's choice is "org" or "personal" (or left out).
select public.alhc_patch_function('public.validate_rule()'::regprocedure,
  $o$  for item in select value from jsonb_array_elements(new.actions) loop
    kind := item ->> 'type';
    case kind$o$,
  $n$  for item in select value from jsonb_array_elements(new.actions) loop
    kind := item ->> 'type';
    -- Nov 3 notes (batch 19, 140): whose workdays a business-day step counts.
    if item ? 'workdays' and coalesce(item ->> 'workdays', '') not in ('org', 'personal') then
      raise exception 'Business days: count the organization''s workdays or the owner''s own' using errcode = 'check_violation';
    end if;
    case kind$n$
);

-- =================================================================================================
-- Automation vocabulary (video bugs 37.1, 37.8, 39.3, 39.4) and note 145 (Set task type → Approval
-- carries the approval's setup). Fork A of batch 19.
--
-- 37.1  "Task assigned to me / to someone": an assignee_changed rule may name who it's assigned to
--       (trigger_config.to = person slots: profile ids, People fields, project roles); fire_rules skips
--       it for anyone else. Without `to` it fires on every assignee change, as before.
-- 37.8  "Task is imported": a task_created rule with trigger_config.via = 'import'. Imports stay muted
--       (fire_rules' import / copy checks are untouched and still first); instead finish_import_run fires
--       those rules once per top-level task the finished import created, outside the import's
--       transactions. Ordinary task_created rules never fire for imports, and via = 'import' rules never
--       fire for tasks people create.
-- 39.3  Conditions "In project" / "Not in project" (the task, or a subtask's top-level task, is in one of
--       the projects picked — "is it also in Marketing?").
-- 39.4  Conditions "Is private" / "Isn't private": private = none of the task's projects is public to its
--       team (only project members can see it).
-- 145   Set task type → Approval may also name the approvers (person slots, up to 10, who need
--       Commenter+), Any one / Everyone, an approval due date (days or business days from today), what
--       happens after approval (complete / move to a section / just notify), reminders, and who does the
--       work (the assignee). Applied when the step makes the task an approval, or on an approval task
--       nobody has set up yet; never while a round is pending.
-- =================================================================================================

-- 145: the step's approval keys, checked by validate_rule (runs as the person saving: invoker).
create or replace function public.rule_approval_setup_problem(target_project uuid, item jsonb)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  setup_keys text[] := array[
    'approvers', 'approval_mode', 'approval_due_days', 'approval_business_days', 'after_approval',
    'after_section_id', 'reminders', 'assignee'
  ];
begin
  if coalesce(item ->> 'kind', '') <> 'approval' then
    if exists (select 1 from jsonb_object_keys(item) k where k = any (setup_keys)) then
      return 'Set task type: approvers and what happens after approval only go with Approval';
    end if;
    return null;
  end if;
  if item ? 'approvers' and (
    coalesce(jsonb_typeof(item -> 'approvers'), 'missing') <> 'array'
    or jsonb_array_length(item -> 'approvers') not between 1 and 10
    or exists (select 1 from jsonb_array_elements(item -> 'approvers') p where not public.rule_person_in_project(target_project, p))
  ) then
    return 'Set task type: choose up to 10 approvers';
  end if;
  if item ? 'approval_mode' and coalesce(item ->> 'approval_mode', '') not in ('any', 'all') then
    return 'Set task type: choose whether any one or everyone must approve';
  end if;
  if item ? 'approval_due_days' and (
    jsonb_typeof(item -> 'approval_due_days') <> 'number' or (item ->> 'approval_due_days') !~ '^[0-9]{1,3}$'
    or (item ->> 'approval_due_days')::integer > 365
  ) then
    return 'Set task type: the approval is due 0 to 365 days later';
  end if;
  if item ? 'approval_business_days' and jsonb_typeof(item -> 'approval_business_days') <> 'boolean' then
    return 'Set task type: business days are on or off';
  end if;
  if item ? 'after_approval' and coalesce(item ->> 'after_approval', '') not in ('complete', 'move_section', 'notify') then
    return 'Set task type: choose what happens after approval';
  end if;
  if coalesce(item ->> 'after_approval', '') = 'move_section'
     and not public.rule_section_ok(target_project, item ->> 'after_section_id') then
    return 'Set task type: choose the section it moves to after approval';
  end if;
  if item ? 'after_section_id' and coalesce(item ->> 'after_approval', '') <> 'move_section' then
    return 'Set task type: a section only goes with "move it to a section"';
  end if;
  if item ? 'reminders' and jsonb_typeof(item -> 'reminders') <> 'boolean' then
    return 'Set task type: reminders are on or off';
  end if;
  if item ? 'assignee' and item -> 'assignee' <> 'null'::jsonb
     and not public.rule_person_in_project(target_project, item -> 'assignee') then
    return 'Set task type: choose who does the work';
  end if;
  return null;
end;
$$;

comment on function public.rule_approval_setup_problem(uuid, jsonb) is
  'Nov 3 notes (batch 19, note 145): what is wrong with a Set task type step''s approval setup (null = fine).';

select public.alhc_revoke_anon_execute(array['rule_approval_setup_problem(uuid, jsonb)']);
revoke all on function public.rule_approval_setup_problem(uuid, jsonb) from public, anon;
grant execute on function public.rule_approval_setup_problem(uuid, jsonb) to authenticated, service_role;

-- 145: applying it while the automation runs (definer, like the rest of execute_rule_actions; never
-- callable by clients).
create or replace function public.rule_apply_approval_setup(r public.rules, target_task uuid, a jsonb, kind_changed boolean)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tasks;
  wanted uuid[] := '{}';
  person uuid;
  approver_slot jsonb;
  skipped text[] := '{}';
  parts text[] := '{}';
  due date;
  doer uuid;
begin
  if not (a ?| array['approvers', 'approval_mode', 'approval_due_days', 'after_approval', 'reminders', 'assignee']) then
    return null;
  end if;
  select * into t from public.tasks where id = target_task;
  if t.id is null or t.kind <> 'approval' then
    return null;
  end if;
  -- An approval task someone already set up keeps its setup; this step only fills in a new one.
  if not kind_changed and exists (
    select 1 from public.task_approvers x where x.task_id = target_task and x.deleted_at is null
  ) then
    return 'its approval was already set up (kept)';
  end if;
  if exists (select 1 from public.approval_rounds ro where ro.task_id = target_task and ro.status = 'pending') then
    return 'its approval is pending (setup kept)';
  end if;

  -- Who does the work.
  if a ? 'assignee' and a -> 'assignee' <> 'null'::jsonb then
    doer := public.resolve_rule_person(a -> 'assignee', target_task);
    if doer is not null then
      update public.tasks set assignee_id = doer where id = target_task and assignee_id is distinct from doer;
      parts := parts || ('assigned to ' || coalesce(public.rule_profile_name(doer), 'someone'));
    end if;
  end if;

  -- Approvers (Commenter+ on the task; others are left out and named).
  if a ? 'approvers' then
    for person in select x from unnest(public.rule_people(a -> 'approvers', target_task)) x where x is not null loop
      if public.approver_eligible(target_task, person) then
        wanted := wanted || person;
      else
        skipped := skipped || coalesce(public.rule_profile_name(person), 'someone');
      end if;
    end loop;
    select coalesce(array_agg(distinct x), '{}') into wanted from unnest(wanted) x;
    wanted := wanted[1:10];
    if cardinality(wanted) > 0 then
      update public.task_approvers set deleted_at = now(), updated_at = now()
      where task_id = target_task and deleted_at is null and not (profile_id = any (wanted));
      insert into public.task_approvers (task_id, profile_id, added_by)
      select target_task, w, auth.uid() from unnest(wanted) w
      where not exists (
        select 1 from public.task_approvers x where x.task_id = target_task and x.profile_id = w and x.deleted_at is null
      );
      parts := parts || ('approvers ' || (
        select string_agg(coalesce(public.rule_profile_name(w), 'someone'), ', ') from unnest(wanted) w
      ));
      -- A role named as approver stays linked (changing who fills the role updates open tasks).
      for approver_slot in select value from jsonb_array_elements(a -> 'approvers') loop
        if (approver_slot #>> '{}') ~* '^project_role:[0-9a-f-]{36}$' and not exists (
          select 1 from public.task_role_links l
          where l.task_id = target_task and l.project_role_id::text = substr(approver_slot #>> '{}', 14)
            and l.slot = 'approver' and l.deleted_at is null
        ) and exists (
          select 1 from public.project_roles pr
          join public.task_projects tp on tp.project_id = pr.project_id and tp.deleted_at is null
          where pr.id::text = substr(approver_slot #>> '{}', 14) and pr.deleted_at is null and tp.task_id = coalesce(t.root_task_id, t.id)
        ) then
          insert into public.task_role_links (task_id, project_role_id, slot, created_by)
          values (target_task, substr(approver_slot #>> '{}', 14)::uuid, 'approver', auth.uid());
        end if;
      end loop;
    end if;
    if cardinality(skipped) > 0 then
      parts := parts || ('left out ' || array_to_string(skipped, ', ') || ' (they need Commenter access)');
    end if;
  end if;

  due := case when a ? 'approval_due_days' then public.rule_add_days(
    public.rule_local_today(r), (a ->> 'approval_due_days')::integer,
    coalesce((a ->> 'approval_business_days')::boolean, false),
    -- Note 140: the step's "whose workdays" (the organization's, or the owner's own).
    public.rule_work_days(public.project_work_week(r.project_id), coalesce(r.owner_id, r.created_by), a ->> 'workdays',
      public.rule_personal_by_default(r))) end;
  insert into public.task_approval_settings as s (task_id, mode, due_on, updated_by, after_approval, after_section_id, reminders)
  values (
    target_task, coalesce(a ->> 'approval_mode', 'any'), due, auth.uid(),
    coalesce(a ->> 'after_approval', 'complete'),
    case when a ->> 'after_approval' = 'move_section' then (a ->> 'after_section_id')::uuid end,
    coalesce((a ->> 'reminders')::boolean, true)
  )
  on conflict (task_id) do update set
    mode = case when a ? 'approval_mode' then excluded.mode else s.mode end,
    due_on = case when a ? 'approval_due_days' then excluded.due_on else s.due_on end,
    after_approval = case when a ? 'after_approval' then excluded.after_approval else s.after_approval end,
    after_section_id = case when a ? 'after_approval' then excluded.after_section_id else s.after_section_id end,
    reminders = case when a ? 'reminders' then excluded.reminders else s.reminders end,
    updated_by = excluded.updated_by,
    updated_at = now();
  if a ? 'approval_mode' then
    parts := parts || case a ->> 'approval_mode' when 'all' then 'everyone must approve' else 'any one can approve' end;
  end if;
  if due is not null then
    parts := parts || ('approval due ' || to_char(due, 'Mon FMDD'));
  end if;
  if a ? 'after_approval' then
    parts := parts || case a ->> 'after_approval'
      when 'move_section' then 'then moves to “' || coalesce((select s.name from public.sections s where s.id::text = a ->> 'after_section_id'), 'a section') || '”'
      when 'notify' then 'then notifies'
      else 'then completes' end;
  end if;
  return nullif(array_to_string(parts, ' · '), '');
end;
$$;

comment on function public.rule_apply_approval_setup(public.rules, uuid, jsonb, boolean) is
  'Nov 3 notes (batch 19, note 145): a Set task type → Approval step''s approvers, mode, due date, follow-up, reminders, and assignee, applied as the automation.';

select public.alhc_revoke_anon_execute(array['rule_apply_approval_setup(rules, uuid, jsonb, boolean)']);
revoke all on function public.rule_apply_approval_setup(public.rules, uuid, jsonb, boolean) from public, anon, authenticated;

-- validate_rule: the new trigger settings, conditions, and the approval keys.
select public.alhc_patch_function('public.validate_rule()'::regprocedure,
  E'  case new.trigger_type\n    when ''section_changed'' then',
  E'  case new.trigger_type\n'
  || E'    -- Nov 3 notes (batch 19, 37.8): "Task is imported" = task_created with via = import.\n'
  || E'    when ''task_created'' then\n'
  || E'      if cfg ? ''via'' and coalesce(cfg ->> ''via'', '''') <> ''import'' then\n'
  || E'        raise exception ''Task is added: the only special source is an import'' using errcode = ''check_violation'';\n'
  || E'      end if;\n'
  || E'    -- Batch 19 (37.1): "Task assigned to …" names who it''s assigned to.\n'
  || E'    when ''assignee_changed'' then\n'
  || E'      if cfg ? ''to'' and (\n'
  || E'        coalesce(jsonb_typeof(cfg -> ''to''), ''missing'') <> ''array'' or jsonb_array_length(cfg -> ''to'') not between 1 and 50\n'
  || E'        or exists (select 1 from jsonb_array_elements(cfg -> ''to'') p where not public.rule_person_in_project(new.project_id, p))\n'
  || E'      ) then\n'
  || E'        raise exception ''Task assigned to: choose who'' using errcode = ''check_violation'';\n'
  || E'      end if;\n'
  || E'    when ''section_changed'' then',
  E'    elsif kind in (''section_is_one_of'', ''section_is_none_of'') then',
  E'    -- Nov 3 notes (batch 19, 39.3): the task is (or isn''t) in projects of this workspace; a person\n'
  || E'    -- saving it must be able to open them (copies and templates keep what was saved).\n'
  || E'    elsif kind in (''in_project'', ''not_in_project'') then\n'
  || E'      if coalesce(jsonb_typeof(item -> ''project_ids''), ''missing'') <> ''array'' or jsonb_array_length(item -> ''project_ids'') not between 1 and 20\n'
  || E'         or exists (\n'
  || E'           select 1 from jsonb_array_elements(item -> ''project_ids'') x\n'
  || E'           where jsonb_typeof(x) <> ''string'' or not exists (\n'
  || E'             select 1 from public.projects pj\n'
  || E'             where pj.id::text = x #>> ''{}'' and pj.workspace_id = ws and pj.deleted_at is null\n'
  || E'               and (not public.is_client_role() or public.has_project_role(pj.id, ''viewer''))\n'
  || E'           )\n'
  || E'         ) then\n'
  || E'        raise exception ''In project: choose projects you can open'' using errcode = ''check_violation'';\n'
  || E'      end if;\n'
  || E'    elsif kind in (''section_is_one_of'', ''section_is_none_of'') then',
  E'      ''is_blocked'', ''is_not_blocked'', ''has_attachment'', ''no_attachment'', ''has_comment'', ''no_comment''\n',
  E'      ''is_blocked'', ''is_not_blocked'', ''has_attachment'', ''no_attachment'', ''has_comment'', ''no_comment'',\n'
  || E'      -- Batch 19 (39.4)\n'
  || E'      ''is_private'', ''is_not_private''\n',
  E'      when ''set_task_type'' then\n'
  || E'        if coalesce(item ->> ''kind'', '''') not in (''task'', ''milestone'', ''approval'') then\n'
  || E'          raise exception ''Set task type: choose task, milestone, or approval'' using errcode = ''check_violation'';\n'
  || E'        end if;\n',
  E'      when ''set_task_type'' then\n'
  || E'        if coalesce(item ->> ''kind'', '''') not in (''task'', ''milestone'', ''approval'') then\n'
  || E'          raise exception ''Set task type: choose task, milestone, or approval'' using errcode = ''check_violation'';\n'
  || E'        end if;\n'
  || E'        -- Batch 19 (note 145): an approval''s setup.\n'
  || E'        if public.rule_approval_setup_problem(new.project_id, item) is not null then\n'
  || E'          raise exception ''%'', public.rule_approval_setup_problem(new.project_id, item) using errcode = ''check_violation'';\n'
  || E'        end if;\n'
);

-- rule_condition_ok: the new conditions.
select public.alhc_patch_function('public.rule_condition_ok(public.rules, jsonb, public.tasks, uuid)'::regprocedure,
  E'    when ''has_open_subtasks'' then\n',
  E'    -- Nov 3 notes (batch 19, 39.3): in (or not in) one of the projects picked (subtasks: their\n'
  || E'    -- top-level task''s projects).\n'
  || E'    when ''in_project'', ''not_in_project'' then\n'
  || E'      return (c ->> ''type'' = ''in_project'') = exists (\n'
  || E'        select 1 from public.task_projects tp\n'
  || E'        join public.projects pj on pj.id = tp.project_id and pj.deleted_at is null\n'
  || E'        where tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null\n'
  || E'          and tp.project_id::text in (select jsonb_array_elements_text(c -> ''project_ids''))\n'
  || E'      );\n'
  || E'    -- Batch 19 (39.4): private = none of its projects is public to its team (only members see it).\n'
  || E'    when ''is_private'', ''is_not_private'' then\n'
  || E'      return (c ->> ''type'' = ''is_private'') = not exists (\n'
  || E'        select 1 from public.task_projects tp\n'
  || E'        join public.projects pj on pj.id = tp.project_id and pj.deleted_at is null\n'
  || E'        where tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null and pj.visibility = ''team''\n'
  || E'      );\n'
  || E'    when ''has_open_subtasks'' then\n'
);

-- fire_rules: who it's assigned to, and imports (after its import / copy checks, which stay first).
select public.alhc_patch_function('public.fire_rules(text, uuid, uuid, jsonb)'::regprocedure,
  E'    continue when trigger_kind = ''tag_added'' and cfg ? ''tag_id'' and cfg ->> ''tag_id'' is distinct from event ->> ''tag_id'';\n',
  E'    continue when trigger_kind = ''tag_added'' and cfg ? ''tag_id'' and cfg ->> ''tag_id'' is distinct from event ->> ''tag_id'';\n'
  || E'    -- Nov 3 notes (batch 19, 37.1): "Task assigned to …" fires only for the people it names.\n'
  || E'    continue when trigger_kind = ''assignee_changed'' and cfg ? ''to''\n'
  || E'      and not coalesce((event ->> ''assignee_id'')::uuid = any (public.rule_people(cfg -> ''to'', target_task)), false);\n'
  || E'    -- Batch 19 (37.8): "Task is imported" rules fire only from a finished import, and other\n'
  || E'    -- task_created rules never do.\n'
  || E'    continue when trigger_kind = ''task_created'' and coalesce(cfg ->> ''via'', '''') is distinct from coalesce(event ->> ''via'', '''');\n'
);

-- execute_rule_actions: Set task type → Approval applies its setup (only the set_task_type branch).
select public.alhc_patch_function('public.execute_rule_actions(public.rules, uuid, jsonb, jsonb)'::regprocedure,
  E'            result := ''Now a'' || case a ->> ''kind'' when ''approval'' then ''n approval'' when ''milestone'' then '' milestone'' else '' task'' end;\n'
  || E'          end if;\n',
  E'            result := ''Now a'' || case a ->> ''kind'' when ''approval'' then ''n approval'' when ''milestone'' then '' milestone'' else '' task'' end;\n'
  || E'          end if;\n'
  || E'          -- Nov 3 notes (batch 19, note 145): an approval''s approvers, due date, and follow-up.\n'
  || E'          if a ->> ''kind'' = ''approval'' then\n'
  || E'            body := public.rule_apply_approval_setup(r, target_task, a, outcome = ''done'');\n'
  || E'            if body is not null then\n'
  || E'              outcome := ''done'';\n'
  || E'              result := result || '' · '' || body;\n'
  || E'            end if;\n'
  || E'          end if;\n'
);

-- finish_import_run: "Task is imported" rules, once per top-level task the finished import created.
select public.alhc_patch_function('public.finish_import_run(uuid, text, jsonb)'::regprocedure,
  E'  where id = run.id;\nend;\n',
  E'  where id = run.id;\n'
  || E'  -- Nov 3 notes (batch 19, 37.8): automations "When a task is imported" (task_created, via = import)\n'
  || E'  -- run now, outside the import''s own (muted) transactions. Ordinary task_created rules stay quiet.\n'
  || E'  if run_status = ''completed'' and public.import_context_id() is null and exists (\n'
  || E'    select 1 from public.rules ru\n'
  || E'    where ru.project_id = run.project_id and ru.enabled and ru.deleted_at is null\n'
  || E'      and ru.trigger_type = ''task_created'' and ru.trigger_config ->> ''via'' = ''import''\n'
  || E'  ) then\n'
  || E'    for imported in\n'
  || E'      select x.local_id from public.import_external_ids x\n'
  || E'      join public.tasks tk on tk.id = x.local_id and tk.deleted_at is null and tk.parent_task_id is null\n'
  || E'      where x.run_id = run.id and x.kind = ''task''\n'
  || E'      order by x.created_at, x.local_id\n'
  || E'      limit 2000\n'
  || E'    loop\n'
  || E'      perform public.fire_rules(''task_created'', imported, run.project_id,\n'
  || E'        jsonb_build_object(''via'', ''import'', ''import_run_id'', run.id));\n'
  || E'    end loop;\n'
  || E'  end if;\n'
  || E'end;\n',
  E'  run public.import_runs;\n',
  E'  run public.import_runs;\n  imported uuid;\n'
);

-- -------------------------------------------------------------------------------------------------
-- Engine and live updates (notes 141, 142: video bugs 40.5 and 23.5)
-- -------------------------------------------------------------------------------------------------
--
-- 40.5 "Create a task" with no section picked used to leave the new task under "No section", which the
--      List shows below every other section, so the follow-up looked missing. It now lands in the target
--      project's first section. (The other engine reports from the video — 35.5, 35.8, 35.12, 35.17, 37.1,
--      40.6 — ran correctly in the database; the open task pane just didn't show the result. That is an
--      app fix.)
-- 23.5 tasks and task_projects join the Realtime publication, so a project's List / Board / Calendar /
--      Timeline (and an open task pane) hear about renames, moves, and new tasks made by other people or
--      in other tabs. Realtime applies each table's read policy to every subscriber, as for the tables
--      already published.

select public.alhc_patch_function(
  'public.execute_rule_actions(public.rules, uuid, jsonb, jsonb)'::regprocedure,
  $old$            if target_section is not null then
              update public.task_projects set section_id = target_section where task_id = made and project_id = target_project;
            end if;$old$,
  $new$            -- Nov 3 notes (batch 19, 40.5): no section picked = the project's first section (not "No section").
            if target_section is null then
              target_section := (
                select sc.id from public.sections sc
                where sc.project_id = target_project and sc.deleted_at is null
                order by sc.sort_order, sc.created_at, sc.id
                limit 1
              );
            end if;
            if target_section is not null then
              update public.task_projects set section_id = target_section where task_id = made and project_id = target_project;
            end if;$new$
);

do $$
declare
  name text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach name in array array['tasks', 'task_projects'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = name
      ) then
        execute format('alter publication supabase_realtime add table public.%I', name);
      end if;
    end loop;
  end if;
end $$;

-- =================================================================================================
-- 148. Timeline drags: Shift moves dependents along by the same amount
-- =================================================================================================
-- On the Timeline a plain drag moves only the task, Alt (Option) pushes its dependents only as far as their
-- links ask (preview_dependency_shifts without pulling), and Shift moves them along by the same amount.
-- preview_dependency_move_along() is that last plan (mirrored by planMoveAlong in src/lib/dependency-plan.ts;
-- unit tests and suite zz49 share the vectors). Same output as preview_dependency_shifts, so the app applies
-- it through the unchanged apply_dependency_shifts (each row given as its own move; the database checks the
-- person can edit each task). SECURITY INVOKER: links to tasks the caller can't read are never followed.
--
--   * a dependent's shift is the largest change of a moved predecessor's anchor for its links (its due date
--     for finish-to-start / finish-to-finish, its start for start links), counted in workdays (later wins
--     over earlier); its start moves by that many workdays (a shift of 0 keeps it);
--   * it never starts before what a moved predecessor's link asks, and moving earlier never takes it
--     before what any of its links allows;
--   * it keeps its length in workdays; completed tasks and tasks the caller can't edit stay (listed), and
--     nothing is followed through them.

create or replace function public.preview_dependency_move_along(moves jsonb)
returns table (
  task_id uuid, title text, start_on date, due_on date, new_start date, new_due date,
  shift_days integer, status text, reason text
)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  item jsonb;
  src public.tasks;
  t public.tasks;
  pt public.tasks;
  roots uuid[] := '{}';
  ns date;
  nd date;
  node record;
  edge record;
  moved jsonb := '{}'::jsonb;
  m jsonb;
  ww smallint[];
  cur_start date;
  cur_end date;
  span integer;
  shift integer;
  need date;
  floor_start date;
  old_anchor date;
  new_anchor date;
  asked date;
  required date;
  next_start date;
  next_due date;
begin
  if jsonb_typeof(moves) is distinct from 'array' or jsonb_array_length(moves) not between 1 and 200 then
    raise exception 'Choose 1 to 200 tasks to move' using errcode = 'check_violation';
  end if;
  for item in select value from jsonb_array_elements(moves) loop
    if jsonb_typeof(item) <> 'object' or coalesce(item ->> 'task_id', '') !~* '^[0-9a-f-]{36}$' then
      raise exception 'Each move needs a task_id' using errcode = 'check_violation';
    end if;
    select * into src from public.tasks x where x.id = (item ->> 'task_id')::uuid and x.deleted_at is null;
    continue when not found or src.id = any (roots);
    ns := case when item ? 'start_on' then (item ->> 'start_on')::date else src.start_on end;
    nd := case when item ? 'due_on' then (item ->> 'due_on')::date else src.due_on end;
    if src.kind = 'milestone' then
      ns := null;
    end if;
    continue when ns is not null and nd is not null and ns > nd;
    if ww is null then
      select w.work_week into ww from public.workspaces w where w.id = src.workspace_id;
    end if;
    roots := roots || src.id;
    moved := moved || jsonb_build_object(src.id::text, jsonb_build_object(
      'os', case when src.kind = 'milestone' then src.due_on else coalesce(src.start_on, src.due_on) end,
      'od', coalesce(src.due_on, src.start_on),
      'ns', case when src.kind = 'milestone' then nd else coalesce(ns, nd) end,
      'nd', coalesce(nd, ns)
    ));
  end loop;
  if cardinality(roots) = 0 then
    return;
  end if;

  for node in
    with recursive walk (id, depth) as (
      select d.successor_id, 1 from public.task_dependencies d
      where d.predecessor_id = any (roots) and d.deleted_at is null
      union
      select d.successor_id, w.depth + 1 from public.task_dependencies d
      join walk w on d.predecessor_id = w.id
      where d.deleted_at is null and w.depth < 200
    )
    select w.id, max(w.depth) as depth from walk w where not (w.id = any (roots))
    group by w.id order by max(w.depth), w.id
  loop
    select * into t from public.tasks x where x.id = node.id and x.deleted_at is null;
    continue when not found;
    cur_start := case when t.kind = 'milestone' then t.due_on else coalesce(t.start_on, t.due_on) end;
    continue when cur_start is null;
    cur_end := coalesce(t.due_on, cur_start);
    span := public.workday_steps(cur_start, cur_end, ww);

    shift := null;
    need := null;
    floor_start := null;
    for edge in
      select d.predecessor_id, d.kind, d.lag_days from public.task_dependencies d
      where d.successor_id = node.id and d.deleted_at is null
    loop
      m := null;
      if moved ? edge.predecessor_id::text then
        m := moved -> edge.predecessor_id::text;
        if edge.kind in ('start_to_start', 'start_to_finish') then
          old_anchor := (m ->> 'os')::date;
          new_anchor := (m ->> 'ns')::date;
        else
          old_anchor := (m ->> 'od')::date;
          new_anchor := (m ->> 'nd')::date;
        end if;
        if old_anchor is not null and new_anchor is not null then
          shift := greatest(shift, case when new_anchor >= old_anchor
            then public.workday_steps(old_anchor, new_anchor, ww)
            else -public.workday_steps(new_anchor, old_anchor, ww) end);
        end if;
      else
        select * into pt from public.tasks x where x.id = edge.predecessor_id and x.deleted_at is null;
        continue when not found;
        new_anchor := case when edge.kind in ('start_to_start', 'start_to_finish')
          then case when pt.kind = 'milestone' then pt.due_on else coalesce(pt.start_on, pt.due_on) end
          else coalesce(pt.due_on, pt.start_on) end;
      end if;
      continue when new_anchor is null;
      asked := public.rule_add_days(public.rule_add_days(new_anchor, edge.lag_days, true, ww), 0, true, ww);
      required := case when edge.kind in ('finish_to_finish', 'start_to_finish')
        then public.rule_add_days(public.rule_add_days(asked, -span, true, ww), 0, true, ww)
        else asked end;
      floor_start := greatest(floor_start, required);
      if m is not null then
        need := greatest(need, required);
      end if;
    end loop;
    -- Not reached through a moved task (only through a completed one, say): it stays.
    continue when shift is null;

    next_start := case when shift = 0 then cur_start else public.rule_add_days(cur_start, shift, true, ww) end;
    if need is not null and need > next_start then
      next_start := need;
    end if;
    if shift < 0 and floor_start is not null and floor_start > next_start then
      next_start := floor_start;
    end if;
    continue when next_start = cur_start;
    next_due := case
      when t.due_on is null then null
      when t.kind = 'milestone' then next_start
      else public.rule_add_days(next_start, span, true, ww)
    end;

    task_id := t.id;
    title := t.title;
    start_on := t.start_on;
    due_on := t.due_on;
    shift_days := next_start - cur_start;
    if t.completed_at is not null then
      new_start := t.start_on;
      new_due := t.due_on;
      status := 'skipped';
      reason := 'Completed';
    elsif not public.has_task_role(t.id, 'editor') then
      new_start := t.start_on;
      new_due := t.due_on;
      status := 'skipped';
      reason := 'You can’t edit this task';
    else
      new_start := case when t.start_on is null or t.kind = 'milestone' then null else next_start end;
      new_due := next_due;
      status := 'move';
      reason := null;
      moved := moved || jsonb_build_object(t.id::text, jsonb_build_object(
        'os', cur_start, 'od', cur_end,
        'ns', next_start, 'nd', coalesce(next_due, next_start)
      ));
    end if;
    return next;
  end loop;
end;
$$;

comment on function public.preview_dependency_move_along(jsonb) is
  'Nov 3 notes (batch 19, 148): Shift + drag on the Timeline — the dependents that move along by the same amount (chained, workdays, lengths kept). Invoker; same rows as preview_dependency_shifts.';

select public.alhc_revoke_anon_execute(array['preview_dependency_move_along(jsonb)']);
revoke all on function public.preview_dependency_move_along(jsonb) from public, anon;
grant execute on function public.preview_dependency_move_along(jsonb) to authenticated;
