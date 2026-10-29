-- ---------------------------------------------------------------------------------------------------
-- Oct 29 notes, batch 7 — track T4: 55b. No home project in the UI.
--
-- tasks.home_project_id stays, as an internal pointer the database keeps on one of the task's active
-- projects (numbering, private tasks, access checks that already read "the pointer or any active
-- project"). People no longer see or set it:
--
--   * Removing a task from the project the pointer is on is allowed now: the definer trigger
--     task_projects_20_move_pointer moves the pointer to the next active project by the stable rule
--     (the first project the task was added to: task_projects.created_at, then project id; membership
--     active, project not deleted). It reuses the old "Make home" path (shape_task_number moves that
--     project's number onto tasks.req_*), and never renumbers (maybe_renumber_on_move stands down while
--     the pointer moves).
--   * Removing the task's LAST active project is refused (check_violation, detail last_project): "This is
--     the task's only project. Add it to another project first, or move the task to the Trash." The guard
--     (guard_home_membership) became SECURITY DEFINER so it counts memberships the caller can't see.
--   * task_project_labels(task_ids) (invoker, authenticated): every project of each task the caller can
--     read, in the stable order, with that project's number when it numbers the task (task_request_labels_in
--     per project, so subtasks get their path there). Never a project — or a number — the caller can't read.
--   * Links and defaults follow the stable rule instead of "home first": comment_email_project (the
--     recipient's project), calendar_feed, duplicate_task, my_task_cards, portfolio_workload,
--     report_overdue_tasks(_after), search_tasks, subtask_parent_candidates, task_open_blockers,
--     review_check_view (the form's project, else the first), dependency_shift_mode (the first project),
--     restore_task (refuses only when none of the task's projects is active), the rule
--     actions Move to another project / Remove from this project (the database moves the pointer).
--   * Emails: email_design_context returns task_numbers — the first number the recipient can read with
--     the rest for "+N" (recipient_task_numbers, run as the recipient), or the request's own number (its
--     form's project) for requester emails; submitter_response_subject uses the form's project too.
--
-- New internal helpers (revoked from clients): task_first_project, task_number_in, recipient_task_numbers,
-- move_task_pointer_on_removal. No new client SECURITY DEFINER function (suite 60 unchanged); nothing for
-- anon. No row-removal or object-removal keywords anywhere in this file. Additive: no tail.
-- ---------------------------------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------------------------------
-- 55b. The stable rule, for code that has no viewer: the first project the task (a subtask: its
--      top-level task) was added to whose membership is active and whose project isn't deleted. Null for a
--      private task. Internal (definer, revoked): emails, the review page.
-- ---------------------------------------------------------------------------------------------------

create or replace function public.task_first_project(target_task uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select tp.project_id
  from public.tasks t
  join public.task_projects tp on tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null
  join public.projects p on p.id = tp.project_id and p.deleted_at is null
  where t.id = target_task
  order by tp.created_at, tp.project_id
  limit 1;
$$;

revoke all on function public.task_first_project(uuid) from public, anon, authenticated;

-- A top-level task's label in one project, while that project numbers tasks (else null). Internal.
create or replace function public.task_number_in(target_task uuid, target_project uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select x.req_label
  from public.task_project_numbers x
  join public.request_sequences s on s.project_id = x.project_id and s.enabled and s.deleted_at is null
  where x.task_id = target_task and x.project_id = target_project and x.req_label is not null;
$$;

revoke all on function public.task_number_in(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 55b. Every project of each task the caller can read, in the stable order, with the number that
--      project gives the task (null when it doesn't number tasks, or not this one). Invoker: RLS plus an
--      explicit has_project_role per project, so a project the caller can't read — and its number — never
--      comes back (also when a definer helper runs it as someone else, see recipient_task_numbers).
--      { "<task id>": [ { project_id, project_name, label, wrap }, ... ] }; tasks with no readable project
--      (private tasks, unreadable ones) are left out. At most 2,000 tasks.
-- ---------------------------------------------------------------------------------------------------

create or replace function public.task_project_labels(task_ids uuid[])
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  ids uuid[] := (select coalesce(array_agg(distinct x), '{}') from unnest(task_ids[1:2000]) x where x is not null);
  p record;
  by_project jsonb := '{}'::jsonb;
  result jsonb;
begin
  if cardinality(ids) = 0 then
    return '{}'::jsonb;
  end if;
  -- Each numbering project's own labels, subtasks included (their path in that project).
  for p in
    select tp.project_id, array_agg(distinct t.id) as tids
    from public.tasks t
    join public.task_projects tp on tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null
    join public.projects pj on pj.id = tp.project_id and pj.deleted_at is null
    join public.request_sequences s on s.project_id = tp.project_id and s.enabled and s.deleted_at is null
    where t.id = any (ids)
      and public.has_project_role(tp.project_id, 'viewer')
    group by tp.project_id
  loop
    by_project := by_project || jsonb_build_object(p.project_id::text, public.task_request_labels_in(p.project_id, p.tids));
  end loop;

  select coalesce(jsonb_object_agg(x.task_id, x.projects), '{}'::jsonb) into result
  from (
    select t.id as task_id,
      jsonb_agg(jsonb_build_object(
        'project_id', tp.project_id,
        'project_name', pj.name,
        'label', by_project -> tp.project_id::text -> t.id::text ->> 'label',
        'wrap', by_project -> tp.project_id::text -> t.id::text -> 'wrap'
      ) order by tp.created_at, tp.project_id) as projects
    from public.tasks t
    join public.task_projects tp on tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null
    join public.projects pj on pj.id = tp.project_id and pj.deleted_at is null
    where t.id = any (ids)
      and public.has_project_role(tp.project_id, 'viewer')
    group by t.id
  ) x;
  return result;
end;
$$;

revoke all on function public.task_project_labels(uuid[]) from public, anon;
grant execute on function public.task_project_labels(uuid[]) to authenticated;

-- The numbers a person can read for one task, in the stable order: [ { label, wrap, project_name } ].
-- Runs task_project_labels as that person (request.jwt.claim.sub set locally, then put back), so emails
-- show only numbers of projects the recipient can open. Internal (definer, revoked): email_design_context.
create or replace function public.recipient_task_numbers(target_task uuid, target_profile uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_sub text := current_setting('request.jwt.claim.sub', true);
  list jsonb;
begin
  if target_task is null or target_profile is null then
    return '[]'::jsonb;
  end if;
  perform set_config('request.jwt.claim.sub', target_profile::text, true);
  list := public.task_project_labels(array[target_task]) -> target_task::text;
  perform set_config('request.jwt.claim.sub', coalesce(previous_sub, ''), true);
  return coalesce((
    select jsonb_agg(jsonb_build_object('label', e ->> 'label', 'wrap', coalesce((e ->> 'wrap')::boolean, true),
                                        'project_name', e ->> 'project_name') order by n)
    from jsonb_array_elements(coalesce(list, '[]'::jsonb)) with ordinality as x(e, n)
    where coalesce(e ->> 'label', '') <> ''
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.recipient_task_numbers(uuid, uuid) from public, anon, authenticated;

-- The stable rule reads task_projects.created_at = when the task was (last) added to the project. It's
-- the database's: every new membership is stamped with the clock (not the transaction's start, so the
-- projects a task joins in one transaction — its first project, then the others a copy, recurrence, or
-- import adds — keep that order, and the internal pointer, set first, stays first); people can't change
-- it; and adding a task back to a project it was removed from puts that project last, after the ones it
-- stayed in (so the pointer, which moves to the first remaining project, stays the first one). Invoker.
create or replace function public.stamp_task_project_created()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or (old.deleted_at is not null and new.deleted_at is null) then
    new.created_at := clock_timestamp();
  elsif public.is_client_role() then
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

select public.alhc_revoke_anon_execute(array['stamp_task_project_created()']);
grant execute on function public.stamp_task_project_created() to authenticated;

create trigger task_projects_04_stamp_created
  before insert or update of created_at, deleted_at on public.task_projects
  for each row
  execute function public.stamp_task_project_created();

-- ---------------------------------------------------------------------------------------------------
-- 55b. Removing a task from a project. The project the pointer is on can be removed now (the pointer
--      moves, below); the task's last active project can't. Definer, so the count sees memberships in
--      projects the caller can't read (a task in your project and in someone else's private one isn't in
--      its last project). Subtasks have no memberships; private tasks none either.
-- ---------------------------------------------------------------------------------------------------

alter function public.guard_home_membership() security definer;

select public.alhc_patch_function(
  'public.guard_home_membership()'::regprocedure,
  $old$  if new.deleted_at is not null and old.deleted_at is null and exists (
    select 1 from public.tasks t
    where t.id = new.task_id and t.home_project_id = new.project_id and t.parent_task_id is null
  ) then
    raise exception 'Cannot remove a task from its home project; change the home project first'
      using errcode = 'check_violation';
  end if;$old$,
  $new$  -- Oct 29 notes (55b): any project can be removed but the task's last active one.
  if new.deleted_at is not null and old.deleted_at is null and exists (
    select 1 from public.tasks t
    where t.id = new.task_id and t.parent_task_id is null and t.home_project_id is not null
  ) and not exists (
    select 1 from public.task_projects o
    join public.projects p on p.id = o.project_id and p.deleted_at is null
    where o.task_id = new.task_id and o.project_id <> new.project_id and o.deleted_at is null
  ) then
    raise exception 'This is the task’s only project. Add it to another project first, or move the task to the Trash.'
      using errcode = 'check_violation', detail = 'last_project';
  end if;$new$
);

revoke all on function public.guard_home_membership() from public, anon, authenticated;

-- The pointer follows: when the membership it points at is removed, it moves to the next active project
-- by the stable rule — the old "Make home" path, so that project's number becomes the task's outside
-- number (shape_task_number) and nothing is renumbered (maybe_renumber_on_move stands down meanwhile).
create or replace function public.move_task_pointer_on_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_project uuid;
begin
  if not exists (
    select 1 from public.tasks t
    where t.id = new.task_id and t.parent_task_id is null and t.home_project_id = new.project_id
  ) then
    return null;
  end if;
  select tp.project_id into next_project
  from public.task_projects tp
  join public.projects p on p.id = tp.project_id and p.deleted_at is null
  where tp.task_id = new.task_id and tp.deleted_at is null
  order by tp.created_at, tp.project_id
  limit 1;
  if next_project is null then
    return null;
  end if;
  -- req_label is named too, so the label triggers run when shape_task_number changes it (column triggers
  -- only fire for columns the statement sets): the subtasks' paths follow (renumber_task_children) and
  -- the mirror stays in step. No "assigned request number" story: nothing was assigned.
  perform set_config('alhc.home_pointer_move', 'on', true);
  update public.tasks set home_project_id = next_project, req_label = req_label where id = new.task_id;
  perform set_config('alhc.home_pointer_move', '', true);
  return null;
end;
$$;

revoke all on function public.move_task_pointer_on_removal() from public, anon, authenticated;

create trigger task_projects_20_move_pointer
  after update of deleted_at on public.task_projects
  for each row
  when (old.deleted_at is null and new.deleted_at is not null)
  execute function public.move_task_pointer_on_removal();

select public.alhc_patch_function(
  'public.story_request_number()'::regprocedure,
  $old$  if public.import_context_id() is not null or public.copy_context_id() is not null then
    return new;
  end if;$old$,
  $new$  if public.import_context_id() is not null or public.copy_context_id() is not null then
    return new;
  end if;
  -- Oct 29 notes (55b): the database moving its pointer after a project was removed assigns nothing.
  if coalesce(current_setting('alhc.home_pointer_move', true), '') = 'on' then
    return new;
  end if;$new$
);

select public.alhc_patch_function(
  'public.maybe_renumber_on_move()'::regprocedure,
  $old$  if new.parent_task_id is not null
     or new.home_project_id is not distinct from old.home_project_id$old$,
  $new$  -- Oct 29 notes (55b): the database moving its pointer after a project was removed never renumbers.
  if coalesce(current_setting('alhc.home_pointer_move', true), '') = 'on'
     or new.parent_task_id is not null
     or new.home_project_id is not distinct from old.home_project_id$new$
);

-- Rule actions Move to another project / Remove from this project: leave the pointer to the database.
select public.alhc_patch_function(
  'public.execute_rule_actions(public.rules, uuid, jsonb, jsonb)'::regprocedure,
  $old$          -- The task leaves this project (its home moves to the new project first).
          if t.home_project_id = r.project_id then
            update public.tasks set home_project_id = target_project where id = target_task;
          end if;
$old$,
  $new$          -- The task leaves this project (the database moves its internal pointer; Oct 29 notes, 55b).
$new$,
  $old$          order by (tp.project_id = t.home_project_id) desc, tp.created_at
          limit 1;$old$,
  $new$          order by tp.created_at, tp.project_id
          limit 1;$new$,
  $old$            if t.home_project_id = r.project_id then
              update public.tasks set home_project_id = new_home where id = target_task;
            end if;
$old$,
  $new$$new$
);

select public.alhc_patch_function(
  'public.assign_request_number(uuid)'::regprocedure,
  $old$'Request numbers are not enabled for this task''s home project'$old$,
  $new$'Request numbers are not enabled for this task''s project'$new$
);

-- ---------------------------------------------------------------------------------------------------
-- 55b. Links and labels: the stable rule instead of "home first".
-- ---------------------------------------------------------------------------------------------------

-- The recipient's project for an email's link: the first one (stable rule) they're a member of.
select public.alhc_patch_function(
  'public.comment_email_project(uuid, uuid)'::regprocedure,
  $old$  order by (p.id = t.home_project_id) desc, p.name, p.id$old$,
  $new$  order by (
    select tp.created_at from public.task_projects tp
    where tp.task_id = coalesce(t.root_task_id, t.id) and tp.project_id = p.id
  ) nulls last, p.id$new$
);

select public.alhc_patch_function(
  'public.calendar_feed(text)'::regprocedure,
  $old$(pr.id = t.home_project_id) desc, pr.name$old$,
  $new$tp.created_at, pr.id$new$
);

-- The copy's first project: the first of the task's projects the caller edits (stable rule).
select public.alhc_patch_function(
  'public.duplicate_task(uuid, jsonb)'::regprocedure,
  $old$    order by (tp.project_id = src.home_project_id) desc, tp.created_at, tp.project_id$old$,
  $new$    order by tp.created_at, tp.project_id$new$
);

select public.alhc_patch_function(
  'public.my_task_cards()'::regprocedure,
  $old$        when a.home_project_id is not null and exists (
          select 1 from named n where n.project_id = a.home_project_id
        ) then a.home_project_id$old$,
  $new$        -- The first project the task was added to that the viewer can read (Oct 29 notes, 55b).
        when a.home_project_id is null then null$new$
);

select public.alhc_patch_function(
  'public.portfolio_workload(uuid, date, date, text)'::regprocedure,
  $old$(vp.project_id = t.home_project_id) desc, vp.sort_order, vp.project_id$old$,
  $new$tp.created_at, vp.project_id$new$
);

select public.alhc_patch_function(
  'public.report_overdue_tasks(jsonb, text, integer)'::regprocedure,
  $old$    order by r.task_id, (r.project_id = coalesce(t.home_project_id, r.project_id)) desc, r.project_id$old$,
  $new$    order by r.task_id, (
      select tp.created_at from public.task_projects tp
      where tp.task_id = coalesce(t.root_task_id, t.id) and tp.project_id = r.project_id
    ) nulls last, r.project_id$new$
);

select public.alhc_patch_function(
  'public.report_overdue_tasks_after(jsonb, text, date, text, uuid, integer)'::regprocedure,
  $old$    order by r.task_id, (r.project_id = coalesce(t.home_project_id, r.project_id)) desc, r.project_id$old$,
  $new$    order by r.task_id, (
      select tp.created_at from public.task_projects tp
      where tp.task_id = coalesce(t.root_task_id, t.id) and tp.project_id = r.project_id
    ) nulls last, r.project_id$new$
);

-- Search labels and links a task with the first of its projects the caller can read (RLS on
-- task_projects); the result columns keep their names.
select public.alhc_patch_function(
  'public.search_tasks(text, integer)'::regprocedure,
  $old$    order by (tp.project_id = t.home_project_id) desc, tp.created_at
    limit 1$old$,
  $new$    order by tp.created_at, tp.project_id
    limit 1$new$
);

select public.alhc_patch_function(
  'public.subtask_parent_candidates(uuid, text, integer)'::regprocedure,
  $old$  select t.id, t.title, t.parent_task_id, coalesce(r.home_project_id, t.home_project_id), t.completed_at$old$,
  $new$  select t.id, t.title, t.parent_task_id, (
    select tp.project_id
    from public.task_projects tp
    join public.projects pj on pj.id = tp.project_id and pj.deleted_at is null
    where tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null
      and public.has_project_role(tp.project_id, 'viewer')
    order by tp.created_at, tp.project_id
    limit 1
  ), t.completed_at$new$
);

select public.alhc_patch_function(
  'public.task_open_blockers(uuid)'::regprocedure,
  $old$'home_project_id', coalesce(r.home_project_id, p.home_project_id)$old$,
  $new$'home_project_id', (
          select tp.project_id
          from public.task_projects tp
          join public.projects pj on pj.id = tp.project_id and pj.deleted_at is null
          where tp.task_id = coalesce(r.id, p.id) and tp.deleted_at is null
            and public.has_project_role(tp.project_id, 'viewer')
          order by tp.created_at, tp.project_id
          limit 1
        )$new$
);

-- Dependency shifting: each task's first project (stable rule; one the caller can read — the one the
-- shift dialog links to) decides for it; across tasks, Ask me wins and Off only when all are Off.
select public.alhc_patch_function(
  'public.dependency_shift_mode(uuid[])'::regprocedure,
  $old$    left join public.tasks r on r.id = t.root_task_id
    left join public.projects p on p.id = coalesce(r.home_project_id, t.home_project_id)$old$,
  $new$    left join public.projects p on p.id = (
      select tp.project_id
      from public.task_projects tp
      join public.projects pj on pj.id = tp.project_id and pj.deleted_at is null
      where tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null
      order by tp.created_at, tp.project_id
      limit 1
    )$new$
);

-- Restoring needs one of the task's projects to be active (not the pointer's in particular).
select public.alhc_patch_function(
  'public.restore_task(uuid)'::regprocedure,
  $old$  if exists (select 1 from public.projects p where p.id = t.home_project_id and p.deleted_at is not null) then
    raise exception 'This task''s home project is deleted' using errcode = 'check_violation',
      hint = 'Restore the project or make another project the task''s home first';
  end if;$old$,
  $new$  if t.home_project_id is not null and not exists (
    select 1 from public.task_projects tp
    join public.projects p on p.id = tp.project_id and p.deleted_at is null
    where tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null
  ) then
    raise exception 'This task''s projects are deleted' using errcode = 'check_violation',
      hint = 'Restore one of its projects first';
  end if;$new$
);

-- The review page names the request's project: its form's, else the first of the task's projects.
select public.alhc_patch_function(
  'public.review_check_view(text)'::regprocedure,
  $old$  where p.id = coalesce((select root.home_project_id from public.tasks root where root.id = coalesce(t.root_task_id, t.id)), t.home_project_id);$old$,
  $new$  where p.id = coalesce(
    (select f.project_id from public.task_submitter(t.id) s join public.forms f on f.id = s.form_id),
    public.task_first_project(t.id)
  );$new$
);

-- A response's subject: the request's own project (its form's) and its number there.
select public.alhc_patch_function(
  'public.submitter_response_subject(uuid, uuid)'::regprocedure,
  $old$  tmpl := public.resolve_email_design('requester', r.home_project_id, s.form_id) ->> 'subject_template';$old$,
  $new$  tmpl := public.resolve_email_design('requester',
    coalesce((select f.project_id from public.forms f where f.id = s.form_id), r.home_project_id), s.form_id) ->> 'subject_template';$new$,
  $old$    'request_number', public.task_request_label(r.id),$old$,
  $new$    'request_number', coalesce(
      public.task_number_in(r.id, (select f.project_id from public.forms f where f.id = s.form_id)),
      public.task_request_label(r.id)
    ),$new$,
  $old$    'project_name', (select p.name from public.projects p where p.id = r.home_project_id),$old$,
  $new$    'project_name', (select p.name from public.projects p
      where p.id = coalesce((select f.project_id from public.forms f where f.id = s.form_id), r.home_project_id)),$new$
);

-- ---------------------------------------------------------------------------------------------------
-- 55b. Emails: the project (links, design) and the numbers shown.
--   * requester emails: the request's form's project, and the request's number there;
--   * emails to a person: the first of the task's projects they can read (comment_email_project) unless
--     the email names one, and task_numbers = the numbers they can read, in the stable order (the app
--     shows the first and "+N");
--   * anything else: the first active project, and the label the email was queued with.
-- ---------------------------------------------------------------------------------------------------

select public.alhc_patch_function(
  'public.email_design_context(uuid)'::regprocedure,
  $old$  design_kind text := 'internal';$old$,
  $new$  design_kind text := 'internal';
  numbers jsonb;
  request_numbers jsonb;
  form_project uuid;$new$,
  $old$  project := case
    when coalesce(o.payload ->> 'project_id', '') ~ uuid_pattern then (o.payload ->> 'project_id')::uuid
    else r.home_project_id
  end;
  if design_kind = 'requester' then
    form := sub.form_id;
  end if;$old$,
  $new$  if design_kind = 'requester' then
    form := sub.form_id;
    form_project := (select f.project_id from public.forms f where f.id = form);
  end if;
  project := case
    when form_project is not null then form_project
    when coalesce(o.payload ->> 'project_id', '') ~ uuid_pattern then (o.payload ->> 'project_id')::uuid
    when r.id is not null and o.to_profile_id is not null then public.comment_email_project(o.to_profile_id, r.id)
    else public.task_first_project(r.id)
  end;
  if r.id is not null then
    if form_project is not null then
      -- Null when the form's project doesn't number it: the email keeps the label it was queued with.
      numbers := (
        select jsonb_build_array(jsonb_build_object('label', x.req_label, 'wrap', s.wrap_brackets))
        from public.task_project_numbers x
        join public.request_sequences s on s.project_id = x.project_id and s.enabled and s.deleted_at is null
        where x.task_id = r.id and x.project_id = form_project and x.req_label is not null
      );
      request_numbers := numbers;
    elsif o.to_profile_id is not null and t.id is not null then
      numbers := public.recipient_task_numbers(t.id, o.to_profile_id);
      request_numbers := case when t.id = r.id then numbers else public.recipient_task_numbers(r.id, o.to_profile_id) end;
    end if;
  end if;$new$,
  $old$      'request_number', case when r.id is not null then public.task_request_label(r.id) end,
      'request_wrap', coalesce((
        select s.wrap_brackets from public.request_sequences s
        where s.project_id = coalesce(t.req_project_id, t.home_project_id) and s.deleted_at is null
      ), true),$old$,
  $new$      'request_number', case
        when r.id is null then null
        when jsonb_array_length(coalesce(request_numbers, '[]'::jsonb)) > 0 then request_numbers -> 0 ->> 'label'
        when form_project is not null then public.task_request_label(r.id)
        when request_numbers is not null then null
        else public.task_request_label(r.id)
      end,
      'request_wrap', coalesce(
        (request_numbers -> 0 ->> 'wrap')::boolean,
        (select s.wrap_brackets from public.request_sequences s
         where s.project_id = coalesce(t.req_project_id, t.home_project_id) and s.deleted_at is null),
        true
      ),
      'task_numbers', numbers,$new$
);
