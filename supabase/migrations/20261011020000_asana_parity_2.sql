-- ALHC Projects — Phase: Asana parity, batch 2 (the project page).
-- Mostly UI (header with a status menu and Share, the Overview tab, the one-line toolbar, List and Board
-- details). The database only gains what the header's status menu and the Overview tab need:
--
--   On hold: a fifth project status (on_track | at_risk | off_track | on_hold | complete), like Asana's.
--     set_project_status() accepts it (asserted text patch: same signature, checks, and grants). Each
--     status column gets a wider CHECK next to the old one; the old CHECKs are retired in the TAIL
--     section, so On hold saves only once the tail is applied (until then the old CHECK refuses it and the
--     app shows the error).
--   Status update titles: project_status_updates.title (optional, 1–200 characters). The status panel
--     writes a title and a summary through post_project_status_update(project, status, title, summary),
--     a SECURITY INVOKER wrapper that hands the title to set_project_status() through the transaction-local
--     setting alhc.status_title and clears it afterwards. set_project_status() stays the only writer of
--     the history and of the project's status columns (Editor+, unchanged); called directly it stores no
--     title.
--   Project due date: projects.due_on (optional), shown and edited on the Overview tab. Written like the
--     name and description (projects_update_admin: Admin+; an archived project caps everyone at Viewer).
--     Copies (templates, Duplicate project) don't carry it.
--   Comment counts for List rows and Board cards: task_comment_counts(task_ids), SECURITY INVOKER, so
--     comments RLS decides what is counted (the caller's readable tasks only; deleted comments left out).
--
-- No new SECURITY DEFINER function (post_project_status_update and task_comment_counts are invoker);
-- suite 60's list is unchanged. Nothing for anon (alhc_revoke_*).
-- fire_rules, notify_with, notify_message, and add_story are untouched. Additive: the release still on
-- main keeps working once this is applied (it never sends a title and never reads the new columns).
-- The statements that retire the old CHECK constraints are in the TAIL section at the end (applied by
-- hand); nothing above depends on them.

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
-- On hold
-- ---------------------------------------------------------------------------

-- The wider CHECKs. Until the tail retires the old ones (projects_status_check and
-- project_status_updates_status_check), both apply and on_hold is still refused.
alter table public.projects
  add constraint projects_status_check_v2
    check (status in ('on_track', 'at_risk', 'off_track', 'on_hold', 'complete'));

alter table public.project_status_updates
  add constraint project_status_updates_status_check_v2
    check (status in ('on_track', 'at_risk', 'off_track', 'on_hold', 'complete'));

-- ---------------------------------------------------------------------------
-- Status update titles
-- ---------------------------------------------------------------------------

alter table public.project_status_updates
  add column title text
    constraint project_status_updates_title_check check (title is null or char_length(title) between 1 and 200);

comment on column public.project_status_updates.title is
  'Optional title of a status update (the status panel''s Title). Set through post_project_status_update(); '
  'null for updates saved with set_project_status() alone and for every update made before this column.';

-- set_project_status(): accepts on_hold and stores the title handed over by post_project_status_update().
select public.alhc_patch_function('public.set_project_status(uuid,text,text)'::regprocedure,
$p$new_status not in ('on_track', 'at_risk', 'off_track', 'complete')$p$,
$p$new_status not in ('on_track', 'at_risk', 'off_track', 'on_hold', 'complete')$p$,
$p$'Status must be on_track, at_risk, off_track, or complete'$p$,
$p$'Status must be on_track, at_risk, off_track, on_hold, or complete'$p$,
$p$insert into public.project_status_updates (project_id, status, note, author_id)
  values (target_project, new_status, cleaned, auth.uid());$p$,
$p$insert into public.project_status_updates (project_id, status, note, author_id, title)
  values (
    target_project,
    new_status,
    cleaned,
    auth.uid(),
    nullif(trim(coalesce(current_setting('alhc.status_title', true), '')), '')
  );$p$);

-- The status panel: a title and a summary in one call. Runs as the caller; set_project_status() does
-- every check (Editor+, a known status, the note length) and writes the history row. The title travels
-- in a transaction-local setting that is cleared again before returning.
create or replace function public.post_project_status_update(
  target_project uuid,
  new_status text,
  update_title text default null,
  summary text default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cleaned_title text := nullif(trim(coalesce(update_title, '')), '');
begin
  if char_length(cleaned_title) > 200 then
    raise exception 'The status update title is too long' using errcode = 'check_violation';
  end if;
  perform set_config('alhc.status_title', coalesce(cleaned_title, ''), true);
  perform public.set_project_status(target_project, new_status, summary);
  perform set_config('alhc.status_title', '', true);
end;
$$;

select public.alhc_revoke_anon_execute(array['post_project_status_update(uuid,text,text,text)']);
grant execute on function public.post_project_status_update(uuid, text, text, text) to authenticated;

comment on function public.post_project_status_update(uuid, text, text, text) is
  'Posts a project status update with a title and a summary (the status panel). Invoker: '
  'set_project_status() checks Editor+ and writes the status and the history row.';

-- ---------------------------------------------------------------------------
-- Project due date
-- ---------------------------------------------------------------------------

alter table public.projects add column due_on date;

comment on column public.projects.due_on is
  'Optional project due date (the Overview tab). Written like the name and description: Admin+ through '
  'projects_update_admin. Not copied by templates or Duplicate project.';

-- ---------------------------------------------------------------------------
-- Comment counts (List rows, Board cards)
-- ---------------------------------------------------------------------------

-- One grouped count instead of downloading every comment row. Invoker: comments RLS (has_task_role
-- viewer, subtasks through their root, private tasks for their creator and assignee) limits the count to
-- tasks the caller can read; others come back with no row.
create or replace function public.task_comment_counts(task_ids uuid[])
returns table (task_id uuid, comment_count integer)
language sql
stable
security invoker
set search_path = ''
as $$
  select c.task_id, count(*)::integer
  from public.comments c
  where c.task_id = any (task_ids)
    and c.deleted_at is null
  group by c.task_id
$$;

select public.alhc_revoke_anon_execute(array['task_comment_counts(uuid[])']);
grant execute on function public.task_comment_counts(uuid[]) to authenticated;

-- TAIL
-- Applied by hand (the connector refuses these keywords). Retires the old status CHECKs so on_hold saves,
-- then gives the wider ones the old names. Nothing above depends on this section.
alter table public.projects drop constraint projects_status_check;
alter table public.projects rename constraint projects_status_check_v2 to projects_status_check;
alter table public.project_status_updates drop constraint project_status_updates_status_check;
alter table public.project_status_updates
  rename constraint project_status_updates_status_check_v2 to project_status_updates_status_check;
