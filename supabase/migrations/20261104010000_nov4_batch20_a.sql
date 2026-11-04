-- Nov 4 notes, batch 20 (notes 149–152). Additive: no object or row is removed, no tail.
--
-- 149. My Tasks automations get the project automations' vocabulary wherever it makes sense for personal
--      tasks. my_task_rules.trigger_type is pinned by a CHECK (only a tail could widen it), so the new
--      triggers keep a stored type with a discriminator in trigger_config (the batch 19 "task is imported"
--      pattern):
--        trigger_type 'assigned' + trigger_config.event =
--          task_completed | task_reopened | comment_added | attachment_added | due_date_changed |
--          start_date_changed | tag_added { tag_id? } | subtasks_completed
--          (no event, or 'assigned' = "a task is assigned to me", as before);
--        trigger_type 'due_approaching' + trigger_config.date = 'start' = "a task of mine starts soon".
--      New conditions: has_tag / lacks_tag { tag_id }, is_overdue, has_start_date, no_start_date,
--      start_within { days }, task_type_is_not { kind }, has_open_subtasks, all_subtasks_done,
--      title_contains { text }, is_blocked, is_not_blocked, has_attachment, no_attachment, has_comment,
--      no_comment, is_not_private, created_by_me, not_created_by_me.
--      New actions: add_comment { body }, set_title { title }, set_start_date { days, business_days?,
--      workdays? }, reopen_task, add_tag / remove_tag { tag_id }, add_followers / remove_followers
--      { people }, set_assignee { assignee }, create_subtasks { titles }, add_to_project { project_id,
--      section_id? }, set_task_type { kind: task | milestone }.
--      Everything still runs as the person, with their own access (definer code checks the role each step
--      needs, or goes through the invoker RPCs people use, e.g. bulk_update_tasks). A My Tasks automation's
--      own changes never start another My Tasks automation (alhc.my_task_rule is set while it runs), so
--      they can't loop. my_task_rules_batch20_ready() lets the app offer the new vocabulary only once this
--      is applied.
--
-- 151. An automation that assigns (or adds followers) through a project role now links the task to the
--      role (task_role_links, slot assignee / follower) — the role-assigned record the role-change prompt
--      lists. The link stays until someone assigns the task to somebody else (tasks_zz_role_assignee_unlink,
--      unchanged). Tasks automations already assigned through a role are linked once (backfill below).
--
-- 150 and 152 are app only.

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
-- 149. My Tasks automations
-- =================================================================================================

-- The app asks this before offering the new vocabulary (a database without it refuses the new steps).
create or replace function public.my_task_rules_batch20_ready()
returns boolean
language sql
stable
set search_path = ''
as $$ select true; $$;

select public.alhc_revoke_anon_execute(array['my_task_rules_batch20_ready()']);
revoke all on function public.my_task_rules_batch20_ready() from public, anon;
grant execute on function public.my_task_rules_batch20_ready() to authenticated;

comment on function public.my_task_rules_batch20_ready() is
  'Nov 4 notes (batch 20, 149): true once My Tasks automations take the wider vocabulary.';

-- The vocabulary (invoker: runs as the person saving). Owner fixed, removal final.
create or replace function public.guard_my_task_rule()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  item jsonb;
  kind text;
  cfg jsonb := new.trigger_config;
  event_name text := nullif(new.trigger_config ->> 'event', '');
  ws uuid;
begin
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.profile_id := auth.uid();
      new.created_at := now();
    end if;
  else
    if new.profile_id is distinct from old.profile_id then
      raise exception 'An automation stays its owner''s' using errcode = 'check_violation';
    end if;
    if old.deleted_at is not null and new.deleted_at is null then
      raise exception 'A removed automation stays removed' using errcode = 'check_violation';
    end if;
    new.updated_at := now();
    if new.deleted_at is not null then
      return new;
    end if;
  end if;
  select w.id into ws from public.workspaces w where w.deleted_at is null order by w.created_at limit 1;
  if cfg ? 'timezone' and (jsonb_typeof(cfg -> 'timezone') <> 'string' or length(cfg ->> 'timezone') > 64) then
    raise exception 'The automation''s time zone is not valid' using errcode = 'check_violation';
  end if;
  -- Triggers.
  if event_name is not null then
    if new.trigger_type <> 'assigned' or event_name not in (
      'assigned', 'task_completed', 'task_reopened', 'comment_added', 'attachment_added', 'due_date_changed',
      'start_date_changed', 'tag_added', 'subtasks_completed'
    ) then
      raise exception 'Unknown trigger %', event_name using errcode = 'check_violation';
    end if;
    if event_name = 'tag_added' and coalesce(cfg ->> 'tag_id', '') <> '' and not exists (
      select 1 from public.tags tg where tg.id::text = cfg ->> 'tag_id' and tg.deleted_at is null
    ) then
      raise exception 'A tag is added: choose a tag' using errcode = 'check_violation';
    end if;
  end if;
  if cfg ? 'date' and (new.trigger_type <> 'due_approaching' or coalesce(cfg ->> 'date', '') not in ('due', 'start')) then
    raise exception 'Only "due soon" can count from the start date' using errcode = 'check_violation';
  end if;
  if new.trigger_type in ('due_approaching', 'task_overdue') and cfg ? 'days' and (
    coalesce(jsonb_typeof(cfg -> 'days'), 'missing') <> 'number' or (cfg ->> 'days') !~ '^[0-9]{1,2}$' or (cfg ->> 'days')::integer > 60
    or (new.trigger_type = 'task_overdue' and (cfg ->> 'days')::integer < 1)
  ) then
    raise exception 'Days must be between % and 60', case new.trigger_type when 'task_overdue' then 1 else 0 end using errcode = 'check_violation';
  end if;
  -- Conditions.
  if jsonb_array_length(new.conditions) > 10 then
    raise exception 'Up to 10 conditions' using errcode = 'check_violation';
  end if;
  for item in select value from jsonb_array_elements(new.conditions) loop
    kind := item ->> 'type';
    if kind in ('in_project', 'not_in_project') then
      if coalesce(jsonb_typeof(item -> 'project_ids'), 'missing') <> 'array' or jsonb_array_length(item -> 'project_ids') not between 1 and 50
         or exists (select 1 from jsonb_array_elements_text(item -> 'project_ids') x where x !~* '^[0-9a-f-]{36}$') then
        raise exception 'In project: choose projects' using errcode = 'check_violation';
      end if;
    elsif kind in ('due_within', 'start_within') then
      if coalesce(jsonb_typeof(item -> 'days'), 'missing') <> 'number' or (item ->> 'days') !~ '^[0-9]{1,3}$' or (item ->> 'days')::integer > 365 then
        raise exception '%: choose 0 to 365 days', case kind when 'due_within' then 'Due within' else 'Starts within' end using errcode = 'check_violation';
      end if;
    elsif kind in ('task_type_is', 'task_type_is_not') then
      if coalesce(item ->> 'kind', '') not in ('task', 'milestone', 'approval') then
        raise exception 'Choose a task type' using errcode = 'check_violation';
      end if;
    elsif kind in ('has_tag', 'lacks_tag') then
      if not exists (select 1 from public.tags tg where tg.id::text = item ->> 'tag_id' and tg.deleted_at is null) then
        raise exception 'Has tag: choose a tag' using errcode = 'check_violation';
      end if;
    elsif kind = 'title_contains' then
      if coalesce(jsonb_typeof(item -> 'text'), 'missing') <> 'string' or char_length(btrim(item ->> 'text')) not between 1 and 200 then
        raise exception 'Name contains: enter some text' using errcode = 'check_violation';
      end if;
    elsif kind is null or kind not in (
      'has_due_date', 'no_due_date', 'is_private', 'is_not_private', 'is_overdue', 'has_start_date', 'no_start_date',
      'has_open_subtasks', 'all_subtasks_done', 'is_blocked', 'is_not_blocked', 'has_attachment', 'no_attachment',
      'has_comment', 'no_comment', 'created_by_me', 'not_created_by_me'
    ) then
      raise exception 'Unknown condition %', coalesce(kind, '(none)') using errcode = 'check_violation';
    end if;
  end loop;
  -- Actions.
  if jsonb_array_length(new.actions) not between 1 and 10 then
    raise exception 'An automation has 1 to 10 actions' using errcode = 'check_violation';
  end if;
  for item in select value from jsonb_array_elements(new.actions) loop
    kind := item ->> 'type';
    if item ? 'workdays' and coalesce(item ->> 'workdays', '') not in ('org', 'personal') then
      raise exception 'Business days: count the organization''s workdays or your own' using errcode = 'check_violation';
    end if;
    if kind = 'move_to_section' then
      if not exists (
        select 1 from public.my_task_sections s
        where s.id::text = item ->> 'section_id' and s.profile_id = new.profile_id and s.deleted_at is null
      ) then
        raise exception 'Move to section: choose one of your My Tasks sections' using errcode = 'check_violation';
      end if;
    elsif kind in ('set_due_date', 'set_start_date') then
      if coalesce(jsonb_typeof(item -> 'days'), 'missing') <> 'number' or (item ->> 'days') !~ '^[0-9]{1,3}$' or (item ->> 'days')::integer > 365
         or (item ? 'business_days' and jsonb_typeof(item -> 'business_days') <> 'boolean') then
        raise exception '%: 0 to 365 days from today', case kind when 'set_due_date' then 'Set due date' else 'Set start date' end
          using errcode = 'check_violation';
      end if;
    elsif kind = 'add_comment' then
      if coalesce(jsonb_typeof(item -> 'body'), 'missing') <> 'string' or char_length(btrim(item ->> 'body')) not between 1 and 10000 then
        raise exception 'Add comment: write the comment' using errcode = 'check_violation';
      end if;
    elsif kind = 'set_title' then
      if coalesce(jsonb_typeof(item -> 'title'), 'missing') <> 'string' or char_length(btrim(item ->> 'title')) not between 1 and 500 then
        raise exception 'Rename task: write the new name' using errcode = 'check_violation';
      end if;
    elsif kind in ('add_tag', 'remove_tag') then
      if not exists (select 1 from public.tags tg where tg.id::text = item ->> 'tag_id' and tg.deleted_at is null) then
        raise exception '%: choose a tag', case kind when 'add_tag' then 'Add tag' else 'Remove tag' end using errcode = 'check_violation';
      end if;
    elsif kind in ('add_followers', 'remove_followers') then
      if coalesce(jsonb_typeof(item -> 'people'), 'missing') <> 'array' or jsonb_array_length(item -> 'people') not between 1 and 20
         or exists (
           select 1 from jsonb_array_elements_text(item -> 'people') x
           where x !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             or not exists (select 1 from public.profiles pr where pr.id::text = x)
         ) then
        raise exception '%: choose people', case kind when 'add_followers' then 'Add followers' else 'Remove followers' end using errcode = 'check_violation';
      end if;
    elsif kind = 'set_assignee' then
      if coalesce(item ->> 'assignee', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or not exists (select 1 from public.profiles pr where pr.id::text = item ->> 'assignee') then
        raise exception 'Set assignee: choose a person' using errcode = 'check_violation';
      end if;
    elsif kind = 'create_subtasks' then
      if coalesce(jsonb_typeof(item -> 'titles'), 'missing') <> 'array' or jsonb_array_length(item -> 'titles') not between 1 and 20
         or exists (
           select 1 from jsonb_array_elements(item -> 'titles') x
           where jsonb_typeof(x) <> 'string' or char_length(btrim(x #>> '{}')) not between 1 and 500
         ) then
        raise exception 'Create subtasks: name 1 to 20 subtasks' using errcode = 'check_violation';
      end if;
    elsif kind = 'add_to_project' then
      if coalesce(item ->> 'project_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or (coalesce(item ->> 'section_id', '') <> '' and not exists (
           select 1 from public.sections sc
           where sc.id::text = item ->> 'section_id' and sc.project_id::text = item ->> 'project_id' and sc.deleted_at is null
         )) then
        raise exception 'Add to project: choose a project' using errcode = 'check_violation';
      end if;
    elsif kind = 'set_task_type' then
      if coalesce(item ->> 'kind', '') not in ('task', 'milestone') then
        raise exception 'Set task type: choose Task or Milestone' using errcode = 'check_violation';
      end if;
    elsif kind is null or kind not in ('complete_task', 'reopen_task') then
      raise exception 'Unknown action %', coalesce(kind, '(none)') using errcode = 'check_violation';
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function public.guard_my_task_rule() from public, anon;
grant execute on function public.guard_my_task_rule() to authenticated;

-- One My Tasks automation on one task assigned to its owner: conditions, then the actions as the owner.
-- 100 runs an hour per automation at most; a failure is logged (nothing is kept).
create or replace function public.run_my_task_rule(r public.my_task_rules, target_task uuid, event jsonb, dedupe text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tasks;
  c jsonb;
  a jsonb;
  ok boolean;
  today date := (now() at time zone public.safe_timezone(coalesce(nullif(r.trigger_config ->> 'timezone', ''), 'UTC')))::date;
  previous_sub text := coalesce(current_setting('request.jwt.claim.sub', true), '');
  previous_rule text := coalesce(current_setting('alhc.my_task_rule', true), '');
  event_name text := coalesce(nullif(r.trigger_config ->> 'event', ''), r.trigger_type);
  log jsonb := '[]'::jsonb;
  outcome text;
  result text;
  new_due date;
  new_start date;
  body text;
  person uuid;
  bulk jsonb;
  title_item jsonb;
  made integer;
  error_message text;
  run_status text := 'succeeded';
begin
  select * into t from public.tasks where id = target_task and deleted_at is null;
  if not found or t.assignee_id is distinct from r.profile_id then
    return 'missing';
  end if;
  -- Only "a task of mine is completed" runs on a completed task.
  if t.completed_at is not null and event_name <> 'task_completed' then
    return 'missing';
  end if;
  if dedupe is not null and exists (
    select 1 from public.my_task_rule_runs rr where rr.rule_id = r.id and rr.task_id = target_task and rr.dedupe_key = dedupe
  ) then
    return 'duplicate';
  end if;
  if (select count(*) from public.my_task_rule_runs rr where rr.rule_id = r.id and rr.created_at > now() - interval '1 hour') >= 100 then
    return 'skipped';
  end if;
  for c in select value from jsonb_array_elements(r.conditions) loop
    ok := case c ->> 'type'
      when 'in_project' then exists (
        select 1 from public.task_projects tp where tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null
          and tp.project_id::text in (select jsonb_array_elements_text(c -> 'project_ids')))
      when 'not_in_project' then not exists (
        select 1 from public.task_projects tp where tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null
          and tp.project_id::text in (select jsonb_array_elements_text(c -> 'project_ids')))
      when 'has_due_date' then t.due_on is not null
      when 'no_due_date' then t.due_on is null
      when 'due_within' then t.due_on between today and today + coalesce((c ->> 'days')::integer, 0)
      when 'is_overdue' then t.completed_at is null and t.due_on < today
      when 'has_start_date' then t.start_on is not null
      when 'no_start_date' then t.start_on is null
      when 'start_within' then t.start_on between today and today + coalesce((c ->> 'days')::integer, 0)
      when 'task_type_is' then t.kind = c ->> 'kind'
      when 'task_type_is_not' then t.kind is distinct from c ->> 'kind'
      when 'is_private' then t.home_project_id is null
      when 'is_not_private' then t.home_project_id is not null
      when 'has_tag' then exists (
        select 1 from public.task_tags tt where tt.task_id = t.id and tt.tag_id::text = c ->> 'tag_id' and tt.deleted_at is null)
      when 'lacks_tag' then not exists (
        select 1 from public.task_tags tt where tt.task_id = t.id and tt.tag_id::text = c ->> 'tag_id' and tt.deleted_at is null)
      when 'has_open_subtasks' then exists (
        select 1 from public.tasks s where s.parent_task_id = t.id and s.deleted_at is null and s.completed_at is null)
      when 'all_subtasks_done' then
        exists (select 1 from public.tasks s where s.parent_task_id = t.id and s.deleted_at is null)
        and not exists (select 1 from public.tasks s where s.parent_task_id = t.id and s.deleted_at is null and s.completed_at is null)
      when 'title_contains' then coalesce(c ->> 'text', '') <> '' and strpos(lower(t.title), lower(c ->> 'text')) > 0
      when 'is_blocked' then public.task_is_blocked(t.id)
      when 'is_not_blocked' then not public.task_is_blocked(t.id)
      when 'has_attachment' then exists (select 1 from public.task_attachments x where x.task_id = t.id and x.deleted_at is null)
      when 'no_attachment' then not exists (select 1 from public.task_attachments x where x.task_id = t.id and x.deleted_at is null)
      when 'has_comment' then exists (select 1 from public.comments cm where cm.task_id = t.id and cm.deleted_at is null)
      when 'no_comment' then not exists (select 1 from public.comments cm where cm.task_id = t.id and cm.deleted_at is null)
      when 'created_by_me' then t.created_by = r.profile_id
      when 'not_created_by_me' then t.created_by is distinct from r.profile_id
      else false
    end;
    if not coalesce(ok, false) then
      return 'conditions';
    end if;
  end loop;

  begin
    perform set_config('request.jwt.claim.sub', r.profile_id::text, true);
    -- While it runs, nothing it changes starts another My Tasks automation (no loops).
    perform set_config('alhc.my_task_rule', r.id::text, true);
    for a in select value from jsonb_array_elements(r.actions) loop
      outcome := 'done';
      result := null;
      select * into t from public.tasks where id = target_task;
      case a ->> 'type'
        when 'move_to_section' then
          if t.completed_at is not null or t.assignee_id is distinct from r.profile_id then
            outcome := 'skipped';
            result := 'Only open tasks assigned to you sit in your sections';
          elsif exists (
            select 1 from public.my_task_placements pl
            where pl.profile_id = r.profile_id and pl.task_id = target_task and pl.section_id::text = a ->> 'section_id'
              and public.my_task_placement_valid(pl.profile_id, pl.assigned_at, t.assignee_id, t.assigned_at)
          ) then
            outcome := 'unchanged';
            result := 'Already in that section';
          else
            perform public.place_my_task(target_task, (a ->> 'section_id')::uuid, null);
            result := 'Moved to “' || coalesce((select s.name from public.my_task_sections s where s.id::text = a ->> 'section_id'), '?') || '”';
          end if;
        when 'set_due_date' then
          if not public.has_task_role(target_task, 'editor') then
            raise exception 'You can’t change this task’s dates' using errcode = 'insufficient_privilege';
          end if;
          new_due := public.rule_add_days(today, (a ->> 'days')::integer, coalesce((a ->> 'business_days')::boolean, false),
            public.rule_work_days((select w.work_week from public.workspaces w where w.id = t.workspace_id), r.profile_id,
              a ->> 'workdays', true));
          update public.tasks
          set due_on = new_due,
              start_on = case when start_on > new_due then null else start_on end,
              start_at = case when start_on > new_due then null else start_at end
          where id = target_task and due_on is distinct from new_due;
          if not found then outcome := 'unchanged'; result := 'Already due then';
          else result := 'Due date set to ' || to_char(new_due, 'Dy, Mon FMDD, YYYY'); end if;
        when 'set_start_date' then
          if not public.has_task_role(target_task, 'editor') then
            raise exception 'You can’t change this task’s dates' using errcode = 'insufficient_privilege';
          end if;
          if t.kind = 'milestone' then
            outcome := 'skipped';
            result := 'Milestones have no start date';
          else
            new_start := public.rule_add_days(today, (a ->> 'days')::integer, coalesce((a ->> 'business_days')::boolean, false),
              public.rule_work_days((select w.work_week from public.workspaces w where w.id = t.workspace_id), r.profile_id,
                a ->> 'workdays', true));
            -- The start never ends up after the due date (the due date moves to it).
            update public.tasks
            set start_on = new_start,
                due_on = case when due_on < new_start then new_start else due_on end
            where id = target_task and start_on is distinct from new_start;
            if not found then outcome := 'unchanged'; result := 'Already starts then';
            else result := 'Start date set to ' || to_char(new_start, 'Dy, Mon FMDD, YYYY'); end if;
          end if;
        when 'complete_task' then
          if t.completed_at is not null then
            outcome := 'unchanged';
            result := 'Already complete';
          elsif t.kind = 'approval' then
            outcome := 'skipped';
            result := 'Approval tasks are completed by their approvers';
          else
            if not public.has_task_role(target_task, 'editor') then
              raise exception 'You can’t complete this task' using errcode = 'insufficient_privilege';
            end if;
            if public.open_blocker_count(target_task) > 0 then
              raise exception 'This task is blocked by tasks that aren’t done' using errcode = 'check_violation';
            end if;
            update public.tasks set completed_at = now() where id = target_task and completed_at is null;
            result := 'Marked complete';
          end if;
        when 'reopen_task' then
          if t.completed_at is null then
            outcome := 'unchanged';
            result := 'Already open';
          else
            if not public.has_task_role(target_task, 'editor') then
              raise exception 'You can’t reopen this task' using errcode = 'insufficient_privilege';
            end if;
            update public.tasks set completed_at = null where id = target_task and completed_at is not null;
            result := 'Marked incomplete';
          end if;
        when 'add_comment' then
          if not public.has_task_role(target_task, 'commenter') then
            raise exception 'You can’t comment on this task' using errcode = 'insufficient_privilege';
          end if;
          body := left(btrim(public.render_rule_text_as(a ->> 'body', target_task, t.home_project_id, event, 'comment')), 10000);
          if body = '' then
            outcome := 'empty';
            result := 'Nothing to say (the comment came out empty)';
          else
            -- Posted as you (it's your automation), like a comment you wrote.
            insert into public.comments (task_id, author_id, body) values (target_task, r.profile_id, body);
            result := 'Commented: “' || left(body, 200) || case when length(body) > 200 then '…' else '' end || '”';
          end if;
        when 'set_title' then
          if not public.has_task_role(target_task, 'editor') then
            raise exception 'You can’t rename this task' using errcode = 'insufficient_privilege';
          end if;
          body := left(btrim(public.render_rule_text(a ->> 'title', target_task, t.home_project_id, event)), 500);
          if body = '' then
            outcome := 'empty';
            result := 'The new name came out empty, so the name was kept';
          else
            update public.tasks set title = body where id = target_task and title is distinct from body;
            if not found then outcome := 'unchanged'; result := 'Already named “' || left(body, 200) || '”';
            else result := 'Renamed to “' || left(body, 200) || '”'; end if;
          end if;
        when 'add_tag', 'remove_tag', 'set_assignee', 'add_to_project' then
          -- The bulk edit path people use (it checks the role and says why it skipped).
          bulk := public.bulk_update_tasks(array[target_task], case a ->> 'type'
            when 'add_tag' then jsonb_build_object('action', 'add_tag', 'tag_id', a ->> 'tag_id')
            when 'remove_tag' then jsonb_build_object('action', 'remove_tag', 'tag_id', a ->> 'tag_id')
            when 'set_assignee' then jsonb_build_object('action', 'assign', 'assignee_id', a ->> 'assignee')
            -- No section picked: the project's first section.
            else jsonb_build_object('action', 'add_to_project', 'project_id', a ->> 'project_id', 'section_id', coalesce(
              nullif(a ->> 'section_id', ''),
              (select sc.id::text from public.sections sc
               where sc.project_id::text = a ->> 'project_id' and sc.deleted_at is null
               order by sc.sort_order, sc.created_at limit 1)))
          end);
          if jsonb_array_length(coalesce(bulk -> 'skipped', '[]'::jsonb)) > 0 then
            outcome := 'skipped';
            result := coalesce(bulk -> 'skipped' -> 0 ->> 'reason', 'Skipped');
          elsif jsonb_array_length(coalesce(bulk -> 'updated', '[]'::jsonb)) = 0 then
            outcome := 'unchanged';
            result := 'Nothing to change';
          else
            result := case a ->> 'type'
              when 'add_tag' then 'Tag “' || coalesce((select tg.name from public.tags tg where tg.id::text = a ->> 'tag_id'), '?') || '” added'
              when 'remove_tag' then 'Tag “' || coalesce((select tg.name from public.tags tg where tg.id::text = a ->> 'tag_id'), '?') || '” removed'
              when 'set_assignee' then 'Assigned to ' || coalesce((select coalesce(nullif(pr.full_name, ''), pr.email) from public.profiles pr where pr.id::text = a ->> 'assignee'), 'someone')
              else 'Added to “' || coalesce((select pj.name from public.projects pj where pj.id::text = a ->> 'project_id'), 'a project') || '”'
            end;
          end if;
        when 'add_followers' then
          made := 0;
          for person in select x::uuid from jsonb_array_elements_text(a -> 'people') x loop
            if not exists (select 1 from public.task_followers f where f.task_id = target_task and f.profile_id = person and f.deleted_at is null) then
              perform public.follow_task(target_task, person);
              if exists (select 1 from public.task_followers f where f.task_id = target_task and f.profile_id = person and f.deleted_at is null) then
                made := made + 1;
              end if;
            end if;
          end loop;
          if made = 0 then outcome := 'unchanged'; result := 'Nobody new to add (people who can’t open the task are left out)';
          else result := made || ' follower' || case when made = 1 then '' else 's' end || ' added'; end if;
        when 'remove_followers' then
          -- Removing someone else needs Editor (removing yourself never does).
          update public.task_followers f set deleted_at = now()
          where f.task_id = target_task and f.deleted_at is null
            and f.profile_id::text in (select jsonb_array_elements_text(a -> 'people'))
            and (f.profile_id = r.profile_id or public.has_task_role(target_task, 'editor'));
          get diagnostics made = row_count;
          if made = 0 then outcome := 'unchanged'; result := 'Nobody to remove';
          else result := made || ' follower' || case when made = 1 then '' else 's' end || ' removed'; end if;
        when 'create_subtasks' then
          if not public.has_task_role(target_task, 'editor') then
            raise exception 'You can’t add subtasks to this task' using errcode = 'insufficient_privilege';
          end if;
          made := 0;
          for title_item in select value from jsonb_array_elements(a -> 'titles') loop
            perform public.create_subtask(target_task, left(btrim(title_item #>> '{}'), 500), null);
            made := made + 1;
          end loop;
          result := made || ' subtask' || case when made = 1 then '' else 's' end || ' created';
        when 'set_task_type' then
          if not public.has_task_role(target_task, 'editor') then
            raise exception 'You can’t change this task’s type' using errcode = 'insufficient_privilege';
          end if;
          if t.kind = 'approval' then
            outcome := 'skipped';
            result := 'Approval tasks keep their type (their approvers decide)';
          else
            update public.tasks set kind = a ->> 'kind' where id = target_task and kind is distinct from a ->> 'kind';
            if not found then outcome := 'unchanged'; result := 'Already that type';
            else result := 'Task type set to ' || case a ->> 'kind' when 'milestone' then 'Milestone' else 'Task' end; end if;
          end if;
        else
          outcome := 'skipped';
          result := 'Unknown step';
      end case;
      log := log || jsonb_build_array(jsonb_build_object('type', a ->> 'type', 'outcome', outcome, 'result', result));
    end loop;
    perform set_config('request.jwt.claim.sub', previous_sub, true);
    perform set_config('alhc.my_task_rule', previous_rule, true);
  exception when others then
    error_message := sqlerrm;
    log := jsonb_build_object('error', error_message);
    run_status := 'failed';
  end;
  perform set_config('request.jwt.claim.sub', previous_sub, true);
  perform set_config('alhc.my_task_rule', previous_rule, true);
  insert into public.my_task_rule_runs (rule_id, profile_id, task_id, status, detail, dedupe_key)
  values (r.id, r.profile_id, target_task, run_status, jsonb_build_object('actions', log, 'event', coalesce(event, '{}'::jsonb)), dedupe);
  return run_status;
end;
$$;

revoke all on function public.run_my_task_rule(public.my_task_rules, uuid, jsonb, text) from public, anon, authenticated;

-- Runs the owner's automations for one event on a task assigned to them. Quiet during imports and copies,
-- and while a My Tasks automation is already running (its own changes never start another).
create or replace function public.fire_my_task_rules(target_task uuid, owner uuid, event_name text, event_data jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.my_task_rules;
begin
  if owner is null or public.import_context_id() is not null or public.copy_context_id() is not null
     or coalesce(current_setting('alhc.my_task_rule', true), '') <> '' then
    return;
  end if;
  if not public.profile_is_allowlisted(owner) then
    return;
  end if;
  for r in
    select * from public.my_task_rules ru
    where ru.profile_id = owner and ru.enabled and ru.deleted_at is null and ru.trigger_type = 'assigned'
      and ru.trigger_config ->> 'event' = event_name
      and (event_name <> 'tag_added' or coalesce(ru.trigger_config ->> 'tag_id', '') in ('', coalesce(event_data ->> 'tag_id', '')))
    order by ru.created_at
  loop
    perform public.run_my_task_rule(r, target_task, coalesce(event_data, '{}'::jsonb) || jsonb_build_object('event', event_name));
  end loop;
end;
$$;

select public.alhc_revoke_anon_execute(array['fire_my_task_rules(uuid, uuid, text, jsonb)']);
revoke all on function public.fire_my_task_rules(uuid, uuid, text, jsonb) from public, anon, authenticated;

-- "A task is assigned to me": only automations without another event (as before), never from inside a
-- My Tasks automation.
create or replace function public.my_task_rules_on_assign()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.my_task_rules;
begin
  if public.import_context_id() is not null or public.copy_context_id() is not null
     or coalesce(current_setting('alhc.my_task_rule', true), '') <> '' then
    return null;
  end if;
  if new.assignee_id is null or new.deleted_at is not null or new.completed_at is not null
     or (tg_op = 'UPDATE' and new.assignee_id is not distinct from old.assignee_id) then
    return null;
  end if;
  for r in
    select * from public.my_task_rules
    where profile_id = new.assignee_id and enabled and deleted_at is null and trigger_type = 'assigned'
      and coalesce(nullif(trigger_config ->> 'event', ''), 'assigned') = 'assigned'
    order by created_at
  loop
    perform public.run_my_task_rule(r, new.id, jsonb_build_object('assigned_at', now()));
  end loop;
  return null;
end;
$$;

revoke all on function public.my_task_rules_on_assign() from public, anon, authenticated;

-- Completed, reopened, due / start date changed; and "all subtasks are done" on the parent. Changes made in
-- the transaction that created the task don't count (like project automations).
create or replace function public.my_task_rules_on_task_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  parent public.tasks;
begin
  if new.deleted_at is not null then
    return null;
  end if;
  if new.assignee_id is not null then
    if old.completed_at is null and new.completed_at is not null then
      perform public.fire_my_task_rules(new.id, new.assignee_id, 'task_completed', '{}'::jsonb);
    elsif old.completed_at is not null and new.completed_at is null then
      perform public.fire_my_task_rules(new.id, new.assignee_id, 'task_reopened', '{}'::jsonb);
    end if;
    if new.created_at <> now() and new.completed_at is null then
      if old.due_on is distinct from new.due_on then
        perform public.fire_my_task_rules(new.id, new.assignee_id, 'due_date_changed',
          jsonb_build_object('old_due_on', old.due_on, 'due_on', new.due_on));
      end if;
      if old.start_on is distinct from new.start_on then
        perform public.fire_my_task_rules(new.id, new.assignee_id, 'start_date_changed',
          jsonb_build_object('old_start_on', old.start_on, 'start_on', new.start_on));
      end if;
    end if;
  end if;
  if new.parent_task_id is not null and old.completed_at is null and new.completed_at is not null then
    select * into parent from public.tasks p where p.id = new.parent_task_id;
    if found and parent.deleted_at is null and parent.completed_at is null and parent.assignee_id is not null
       and not exists (
         select 1 from public.tasks s where s.parent_task_id = parent.id and s.deleted_at is null and s.completed_at is null
       ) then
      perform public.fire_my_task_rules(parent.id, parent.assignee_id, 'subtasks_completed', '{}'::jsonb);
    end if;
  end if;
  return null;
end;
$$;

revoke all on function public.my_task_rules_on_task_change() from public, anon, authenticated;

create or replace trigger tasks_zz_my_task_rules_events
after update of completed_at, due_on, start_on on public.tasks
for each row
when (old.completed_at is distinct from new.completed_at or old.due_on is distinct from new.due_on or old.start_on is distinct from new.start_on)
execute function public.my_task_rules_on_task_change();

-- Someone else comments on a task of mine.
create or replace function public.my_task_rules_on_comment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner uuid;
begin
  if new.deleted_at is not null then
    return null;
  end if;
  select t.assignee_id into owner from public.tasks t where t.id = new.task_id and t.deleted_at is null and t.completed_at is null;
  if owner is not null and new.author_id is distinct from owner then
    perform public.fire_my_task_rules(new.task_id, owner, 'comment_added', jsonb_build_object('comment_id', new.id));
  end if;
  return null;
end;
$$;

revoke all on function public.my_task_rules_on_comment() from public, anon, authenticated;

create or replace trigger comments_after_insert_zz_my_task_rules
after insert on public.comments
for each row execute function public.my_task_rules_on_comment();

-- Someone else attaches a file to a task of mine.
create or replace function public.my_task_rules_on_attachment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner uuid;
begin
  if new.deleted_at is not null then
    return null;
  end if;
  select t.assignee_id into owner from public.tasks t where t.id = new.task_id and t.deleted_at is null and t.completed_at is null;
  if owner is not null and new.uploaded_by is distinct from owner then
    perform public.fire_my_task_rules(new.task_id, owner, 'attachment_added', jsonb_build_object('attachment_id', new.id));
  end if;
  return null;
end;
$$;

revoke all on function public.my_task_rules_on_attachment() from public, anon, authenticated;

create or replace trigger task_attachments_after_insert_zz_my_task_rules
after insert on public.task_attachments
for each row execute function public.my_task_rules_on_attachment();

-- A tag is added to a task of mine.
create or replace function public.my_task_rules_on_tag()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner uuid;
begin
  if new.deleted_at is not null then
    return null;
  end if;
  select t.assignee_id into owner from public.tasks t
  where t.id = new.task_id and t.deleted_at is null and t.completed_at is null and t.created_at <> now();
  if owner is not null then
    perform public.fire_my_task_rules(new.task_id, owner, 'tag_added', jsonb_build_object('tag_id', new.tag_id));
  end if;
  return null;
end;
$$;

revoke all on function public.my_task_rules_on_tag() from public, anon, authenticated;

create or replace trigger task_tags_after_insert_zz_my_task_rules
after insert on public.task_tags
for each row execute function public.my_task_rules_on_tag();

select public.alhc_revoke_anon_execute(array[
  'my_task_rules_on_task_change()', 'my_task_rules_on_comment()', 'my_task_rules_on_attachment()', 'my_task_rules_on_tag()'
]);

-- The scheduler's part: due soon, overdue, and (date = start) starts soon, once per task and date.
create or replace function public.my_task_rules_tick()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.my_task_rules;
  x record;
  days integer;
  today date;
  ran integer := 0;
  by_start boolean;
begin
  for r in
    select ru.* from public.my_task_rules ru
    where ru.enabled and ru.deleted_at is null and ru.trigger_type in ('due_approaching', 'task_overdue')
      and public.profile_is_allowlisted(ru.profile_id)
  loop
    days := coalesce((r.trigger_config ->> 'days')::integer, 1);
    today := (now() at time zone public.safe_timezone(coalesce(nullif(r.trigger_config ->> 'timezone', ''), 'UTC')))::date;
    by_start := r.trigger_type = 'due_approaching' and r.trigger_config ->> 'date' = 'start';
    for x in
      select tk.id, case when by_start then tk.start_on else tk.due_on end as day from public.tasks tk
      where tk.assignee_id = r.profile_id and tk.deleted_at is null and tk.completed_at is null
        and case
          when by_start then tk.start_on = today + days
          when r.trigger_type = 'due_approaching' then tk.due_on = today + days
          else tk.due_on between today - greatest(days, 1) - 2 and today - greatest(days, 1) end
    loop
      if public.run_my_task_rule(r, x.id,
           case when by_start then jsonb_build_object('start_on', x.day) else jsonb_build_object('due_on', x.day) end,
           case when by_start then 'start:' when r.trigger_type = 'due_approaching' then 'due:' else 'overdue:' end || x.day::text) = 'succeeded' then
        ran := ran + 1;
      end if;
    end loop;
  end loop;
  return ran;
end;
$$;

revoke all on function public.my_task_rules_tick() from public, anon, authenticated;

-- =================================================================================================
-- 151. Tasks an automation assigns through a role stay linked to the role
-- =================================================================================================

-- Links a task to a role's slot when the automation step named the person as "project_role:<id>" (only
-- roles of the task's projects; a task has one assignee role at a time). Definer, like the engine.
create or replace function public.rule_link_task_role(target_task uuid, person jsonb, link_slot text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  role_id uuid;
begin
  if person is null or jsonb_typeof(person) <> 'string'
     or (person #>> '{}') !~* '^project_role:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or link_slot not in ('assignee', 'approver', 'follower') then
    return false;
  end if;
  select r.id into role_id
  from public.project_roles r
  join public.tasks t on t.id = target_task and t.deleted_at is null
  join public.task_projects tp on tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null and tp.project_id = r.project_id
  where r.id::text = substr(person #>> '{}', 14) and r.deleted_at is null
  limit 1;
  if role_id is null then
    return false;
  end if;
  if link_slot = 'assignee' then
    update public.task_role_links set deleted_at = now()
    where task_id = target_task and slot = 'assignee' and deleted_at is null and project_role_id <> role_id;
  end if;
  insert into public.task_role_links (task_id, project_role_id, slot)
  select target_task, role_id, link_slot
  where not exists (
    select 1 from public.task_role_links l
    where l.task_id = target_task and l.project_role_id = role_id and l.slot = link_slot and l.deleted_at is null
  );
  return true;
end;
$$;

select public.alhc_revoke_anon_execute(array['rule_link_task_role(uuid, jsonb, text)']);
revoke all on function public.rule_link_task_role(uuid, jsonb, text) from public, anon, authenticated;

comment on function public.rule_link_task_role(uuid, jsonb, text) is
  'Nov 4 notes (batch 20, 151): an automation that assigns or adds followers through a project role links the '
  'task to the role (task_role_links), so changing who fills the role lists and updates it.';

-- Set assignee: after the change, a role-named person links the task to the role (an unassign or another
-- person leaves the old link to tasks_zz_role_assignee_unlink, as before).
select public.alhc_patch_function('public.execute_rule_actions(public.rules, uuid, jsonb, jsonb)'::regprocedure,
  $o$                || case a ->> 'mode' when 'round_robin' then ' (round robin)' when 'balanced' then ' (fewest open tasks)' else '' end;
            end if;$o$,
  $n$                || case a ->> 'mode' when 'round_robin' then ' (round robin)' when 'balanced' then ' (fewest open tasks)' else '' end;
            end if;
            -- Nov 4 notes (batch 20, 151): assigned through a role = linked to it until someone reassigns it.
            if person is not null and coalesce(a ->> 'mode', 'person') = 'person' then
              perform public.rule_link_task_role(target_task, a -> 'assignee', 'assignee');
            end if;$n$,
  $o$          foreach person in array public.rule_people(a -> 'people', target_task) loop
            perform public.follow_task(target_task, person);
          end loop;
          result := case when names is null then 'Nobody to add' else 'Followers: ' || names end;$o$,
  $n$          foreach person in array public.rule_people(a -> 'people', target_task) loop
            perform public.follow_task(target_task, person);
          end loop;
          -- Nov 4 notes (batch 20, 151): followers given by a role are linked to it.
          if jsonb_typeof(a -> 'people') = 'array' then
            perform public.rule_link_task_role(target_task, people_slot.slot_value, 'follower')
            from jsonb_array_elements(a -> 'people') as people_slot(slot_value);
          end if;
          result := case when names is null then 'Nobody to add' else 'Followers: ' || names end;$n$
);

-- Once: open tasks an automation of their project assigned through a role, still assigned to the person who
-- fills it, get the link they should have had.
insert into public.task_role_links (task_id, project_role_id, slot)
select distinct on (t.id) t.id, pr.id, 'assignee'
from public.rules ru
cross join lateral jsonb_array_elements(ru.actions) as act(a)
join public.project_roles pr
  on pr.id::text = substr(act.a ->> 'assignee', 14) and pr.deleted_at is null and pr.project_id = ru.project_id
join public.rule_runs rr on rr.rule_id = ru.id and rr.status = 'succeeded' and rr.task_id is not null
join public.tasks t on t.id = rr.task_id and t.deleted_at is null and t.completed_at is null and t.assignee_id = pr.profile_id
join public.task_projects tp on tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null and tp.project_id = pr.project_id
where ru.deleted_at is null
  and act.a ->> 'type' = 'set_assignee'
  and coalesce(act.a ->> 'mode', 'person') = 'person'
  and (act.a ->> 'assignee') ~* '^project_role:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and not exists (select 1 from public.task_role_links l where l.task_id = t.id and l.slot = 'assignee' and l.deleted_at is null)
order by t.id, rr.created_at desc;
