-- Nov 2 security fix (note 119: "a project Viewer can delete tasks"). Additive: one invoker function, one
-- invoker guard trigger function on four tables, and two narrowed follower policies. No tail; nothing is
-- renamed or taken away, and the release still on main keeps working (it never trashes anything a
-- Viewer or Commenter may trash, and Commenters still follow and unfollow themselves and add followers).
--
-- What we found: RLS already refused a Viewer's or Commenter's soft delete (tasks_update_editor needs
-- Editor of the top-level task), but the refusal is silent — an UPDATE that RLS filters out changes zero
-- rows and returns no error — and the app's delete actions didn't check that a row changed. So a person
-- whose page still offered Delete (a role lowered while the page was open, a stale pane) was told "Task
-- moved to the Trash" and saw the task vanish, although nothing changed in the database. This release:
--   * trash_task(target_task) (invoker): the one way the app trashes a task or subtask. It says plainly
--     why it can't ("Only Editors and above can delete tasks") instead of changing nothing in silence.
--   * guard_trash_change() (invoker, BEFORE UPDATE OF deleted_at on tasks, sections, custom_fields,
--     task_attachments): a second wall behind RLS for people's writes. Trashing or restoring needs Editor
--     of the task (its top-level task) or of the project, whatever any update policy says now or later.
--     System code (definer functions, the copy engine, imports, the Trash purge) is never checked.
--   * Followers: a Commenter follows and unfollows themselves and adds people who can open the task, but
--     removing someone else as a follower now needs Editor (task_followers' insert / update policies).
-- Nothing new for anon; no new client SECURITY DEFINER function (suite 60 unchanged). fire_rules,
-- notify_with, notify_message, and add_story are untouched.

-- ---------------------------------------------------------------------------------------------
-- trash_task: an honest soft delete
-- ---------------------------------------------------------------------------------------------

create or replace function public.trash_task(target_task uuid)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  found_task record;
  stamp timestamptz;
begin
  if target_task is null then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  -- Read as the caller: a task they can't open (or a trashed one below Editor) reads as not found.
  select t.id, t.root_task_id, t.deleted_at into found_task
  from public.tasks t
  where t.id = target_task;
  if not found then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if found_task.deleted_at is not null then
    return found_task.deleted_at;
  end if;
  if not public.has_task_role(coalesce(found_task.root_task_id, found_task.id), 'editor') then
    raise exception 'Only Editors and above can delete tasks'
      using errcode = 'insufficient_privilege',
        hint = 'Your role in this task''s projects lets you view it. Ask an Owner or Editor to move it to the Trash.';
  end if;
  update public.tasks set deleted_at = now()
  where id = target_task and deleted_at is null
  returning deleted_at into stamp;
  if stamp is null then
    raise exception 'Only Editors and above can delete tasks' using errcode = 'insufficient_privilege';
  end if;
  return stamp;
end;
$$;

comment on function public.trash_task(uuid) is
  'Nov 2 security fix (note 119): moves a task or subtask to the Trash (Editor+ of its top-level task), '
  'refusing with insufficient_privilege instead of changing nothing in silence. Invoker: RLS and every '
  'trigger apply.';

select public.alhc_revoke_anon_execute(array['trash_task(uuid)']);
grant execute on function public.trash_task(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- guard_trash_change: trashing and restoring need Editor, behind RLS
-- ---------------------------------------------------------------------------------------------

create or replace function public.guard_trash_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  allowed boolean;
begin
  if not public.is_client_role() or old.deleted_at is not distinct from new.deleted_at then
    return new;
  end if;
  if tg_table_name = 'tasks' then
    allowed := public.has_task_role(coalesce(old.root_task_id, old.id), 'editor');
  elsif tg_table_name = 'task_attachments' then
    allowed := public.has_task_role(old.task_id, 'editor');
  elsif tg_table_name in ('sections', 'custom_fields') then
    allowed := public.has_project_role(old.project_id, 'editor');
  else
    allowed := false;
  end if;
  if not coalesce(allowed, false) then
    raise exception 'Only Editors and above can move things to the Trash or restore them'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

comment on function public.guard_trash_change() is
  'Nov 2 security fix (note 119): a person''s write that trashes or restores a task, section, field, or '
  'attachment needs Editor of it (a task: of its top-level task), behind RLS. System code is not checked.';

select public.alhc_revoke_anon_execute(array['guard_trash_change()']);
grant execute on function public.guard_trash_change() to authenticated;

create trigger tasks_00_guard_trash
  before update of deleted_at on public.tasks
  for each row execute function public.guard_trash_change();

create trigger sections_00_guard_trash
  before update of deleted_at on public.sections
  for each row execute function public.guard_trash_change();

create trigger custom_fields_00_guard_trash
  before update of deleted_at on public.custom_fields
  for each row execute function public.guard_trash_change();

create trigger task_attachments_00_guard_trash
  before update of deleted_at on public.task_attachments
  for each row execute function public.guard_trash_change();

-- ---------------------------------------------------------------------------------------------
-- Followers: removing someone else needs Editor
-- ---------------------------------------------------------------------------------------------
-- Commenters keep: follow / unfollow themselves, add a follower who can open the task. A row that ends
-- up removed (deleted_at set) for someone else is only for Editors+.

alter policy task_followers_insert_commenter on public.task_followers
  with check (
    (select public.has_task_role(task_id, 'commenter'))
    and (
      (deleted_at is null and public.profile_can_read_task(profile_id, task_id))
      or (deleted_at is not null and (profile_id = (select auth.uid()) or (select public.has_task_role(task_id, 'editor'))))
    )
  );

alter policy task_followers_update_commenter on public.task_followers
  with check (
    (select public.has_task_role(task_id, 'commenter'))
    and (
      (deleted_at is null and public.profile_can_read_task(profile_id, task_id))
      or (deleted_at is not null and (profile_id = (select auth.uid()) or (select public.has_task_role(task_id, 'editor'))))
    )
  );
