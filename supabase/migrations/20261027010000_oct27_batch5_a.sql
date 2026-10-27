-- ALHC Projects — Oct 27 notes, batch 5.
--
-- 1. Owner settings: "Lock section order". projects.sections_locked (default off). Only the project's
--    Owners turn it on or off (the invoker guard projects_09_sections_lock, by the caller's own role; an
--    archived project caps everyone at Viewer). While it's on, nobody but an Owner adds, renames,
--    reorders, or removes the project's sections (the invoker guard sections_06_lock, for people's own
--    writes and for imports run by someone who isn't an Owner); moving tasks between sections is
--    unchanged.
--
-- 2. Show / Hide completed, remembered per person per project (project_person_settings: own rows, Viewer+
--    of the project; set_project_show_completed, invoker). Null = what the view says.
--
-- 3. Attachment counts on List rows: project_task_cards (asserted patch) adds attachment_count (the task's
--    files and attachment links, not removed) next to comment_count. Same access as before.
--
-- 4. The task pane's Subtasks organize menu, remembered per person: profile_preferences gains
--    subtask_hide_completed, subtask_assigned_to_me, subtask_sort (manual | assignee | due_asc |
--    due_desc); set_subtask_preferences (invoker, own row).
--
-- 8. Review checks, for the reviewer:
--      * review_checks.draft (the reviewer's pins, note, and chosen answer, saved as they go; never readable
--        by clients), draft_saved_at, walkthrough_seen_at (the page's "How it works" was closed once), and a
--        save counter of its own (2,000 saves an hour per link; saving doesn't count toward the 600 page
--        requests).
--      * review_check_save(token, progress, walkthrough_seen) — the one new anon function (pinned in suites
--        50, 60, zz06, zz07, zz24): only while the round is open, only pins on the round's own files.
--      * review_check_view (asserted patch) also returns the draft (open rounds), whether the walkthrough
--        was seen, and the previous round sent to the same address that was answered (its files and pins),
--        shown collapsed on the page; review_check_file (asserted patch) serves that round's files too
--        (nothing of any other round or task).
--      * review_check_decide (asserted patch) clears the draft and says "round 2", not "v2".
--
-- 12. Followers: validate_rule's messages say "followers" (asserted patch); nothing else changes.
--
-- No new client SECURITY DEFINER function for authenticated. Additive: no tail.

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
-- 1. Lock section order (Owners)
-- ---------------------------------------------------------------------------

alter table public.projects add column if not exists sections_locked boolean not null default false;

comment on column public.projects.sections_locked is
  'Oct 27 notes (batch 5): while true, only the project''s Owners add, rename, reorder, or remove its '
  'sections. Only Owners change it.';

create or replace function public.guard_project_sections_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.sections_locked is distinct from old.sections_locked
     and public.is_client_role()
     and not public.has_project_role(new.id, 'owner') then
    raise exception 'Only the project''s owners can lock or unlock its sections' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

select public.alhc_revoke_anon_execute(array['guard_project_sections_lock()']);
grant execute on function public.guard_project_sections_lock() to authenticated;

create trigger projects_09_sections_lock
  before update of sections_locked on public.projects
  for each row execute function public.guard_project_sections_lock();

-- A locked project's sections change only by an Owner's hand. People's own writes (RLS already makes them
-- Editors+) and imports are checked; the copy engine and other system code making a new project's
-- sections are not (a new project isn't locked).
create or replace function public.guard_section_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not (public.is_client_role() or public.import_context_id() is not null) then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.name is not distinct from old.name
     and new.sort_order is not distinct from old.sort_order
     and new.deleted_at is not distinct from old.deleted_at then
    return new;
  end if;
  if exists (select 1 from public.projects p where p.id = new.project_id and p.sections_locked)
     and not public.has_project_role(new.project_id, 'owner') then
    raise exception 'The project''s owner locked its sections'
      using errcode = 'insufficient_privilege',
            hint = 'Only the project''s owners can add, rename, reorder, or delete sections while they''re locked.';
  end if;
  return new;
end;
$$;

select public.alhc_revoke_anon_execute(array['guard_section_lock()']);
grant execute on function public.guard_section_lock() to authenticated;

create trigger sections_06_lock
  before insert or update on public.sections
  for each row execute function public.guard_section_lock();

-- ---------------------------------------------------------------------------
-- 2. Show / Hide completed, per person per project
-- ---------------------------------------------------------------------------

create table if not exists public.project_person_settings (
  profile_id uuid not null default auth.uid() references public.profiles (id),
  project_id uuid not null references public.projects (id),
  show_completed boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (profile_id, project_id)
);

create index if not exists project_person_settings_project_idx on public.project_person_settings (project_id);

alter table public.project_person_settings enable row level security;
revoke all on public.project_person_settings from anon, authenticated;
select public.alhc_revoke_anon_grants(array['project_person_settings']);
select public.alhc_revoke_client_truncate(array['project_person_settings']);
grant insert (project_id, show_completed) on public.project_person_settings to authenticated;
grant update (show_completed) on public.project_person_settings to authenticated;

comment on table public.project_person_settings is
  'Oct 27 notes (batch 5): a person''s own settings for one project (show_completed: Show / Hide completed '
  'in List and Board; null = what the view says). Own rows only.';

create trigger project_person_settings_set_updated_at
  before update on public.project_person_settings
  for each row execute function public.set_updated_at();

create policy project_person_settings_select_own on public.project_person_settings
  for select to authenticated using (profile_id = (select auth.uid()));
create policy project_person_settings_insert_own_viewer on public.project_person_settings
  for insert to authenticated
  with check (profile_id = (select auth.uid()) and (select public.has_project_role(project_id, 'viewer')));
create policy project_person_settings_update_own_viewer on public.project_person_settings
  for update to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()) and (select public.has_project_role(project_id, 'viewer')));

-- Saves the caller's Show / Hide completed for a project (null = follow the view). Invoker: RLS decides.
create or replace function public.set_project_show_completed(target_project uuid, show boolean)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  stored boolean;
begin
  if target_project is null or not public.has_project_role(target_project, 'viewer') then
    raise exception 'Project not found' using errcode = 'no_data_found';
  end if;
  insert into public.project_person_settings as s (project_id, show_completed)
  values (target_project, show)
  on conflict (profile_id, project_id) do update set show_completed = excluded.show_completed
  returning s.show_completed into stored;
  return stored;
end;
$$;

select public.alhc_revoke_anon_execute(array['set_project_show_completed(uuid, boolean)']);
grant execute on function public.set_project_show_completed(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Attachment counts on List rows
-- ---------------------------------------------------------------------------

select public.alhc_patch_function('public.project_task_cards(uuid, uuid[])'::regprocedure,
$p$  comments as (
    select c.task_id, count(*)::integer as comment_count$p$,
$p$  attachment_counts as (
    select x.task_id, count(*)::integer as attachment_count
    from (
      select a.task_id
      from public.task_attachments a
      join member m on m.task_id = a.task_id
      where a.deleted_at is null
      union all
      select l.task_id
      from public.task_attachment_links l
      join member m on m.task_id = l.task_id
      where l.deleted_at is null
    ) x
    group by x.task_id
  ),
  comments as (
    select c.task_id, count(*)::integer as comment_count$p$,
$p$'comment_count', coalesce(c.comment_count, 0),$p$,
$p$'comment_count', coalesce(c.comment_count, 0),
      'attachment_count', coalesce(ac.attachment_count, 0),$p$,
$p$left join comments c on c.task_id = m.task_id$p$,
$p$left join comments c on c.task_id = m.task_id
  left join attachment_counts ac on ac.task_id = m.task_id$p$
);

-- ---------------------------------------------------------------------------
-- 4. Subtasks organize menu, per person
-- ---------------------------------------------------------------------------

alter table public.profile_preferences add column if not exists subtask_hide_completed boolean not null default false;
alter table public.profile_preferences add column if not exists subtask_assigned_to_me boolean not null default false;
alter table public.profile_preferences add column if not exists subtask_sort text not null default 'manual'
  constraint profile_preferences_subtask_sort_check check (subtask_sort in ('manual', 'assignee', 'due_asc', 'due_desc'));
grant insert (subtask_hide_completed, subtask_assigned_to_me, subtask_sort) on public.profile_preferences to authenticated;
grant update (subtask_hide_completed, subtask_assigned_to_me, subtask_sort) on public.profile_preferences to authenticated;

comment on column public.profile_preferences.subtask_sort is
  'Oct 27 notes (batch 5): how the task pane lists subtasks for this person (manual | assignee | due_asc | '
  'due_desc); subtask_hide_completed / subtask_assigned_to_me filter them.';

-- Saves the caller's Subtasks filter and sort. Invoker: own row only (RLS).
create or replace function public.set_subtask_preferences(hide_completed boolean, assigned_to_me boolean, sort_key text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  p public.profile_preferences;
begin
  if auth.uid() is null or not public.is_allowlisted() then
    raise exception 'Sign in to change your settings' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(sort_key, 'manual') not in ('manual', 'assignee', 'due_asc', 'due_desc') then
    raise exception 'Unknown subtask order' using errcode = 'check_violation';
  end if;
  insert into public.profile_preferences as x (subtask_hide_completed, subtask_assigned_to_me, subtask_sort)
  values (coalesce(hide_completed, false), coalesce(assigned_to_me, false), coalesce(sort_key, 'manual'))
  on conflict (profile_id) do update set
    subtask_hide_completed = excluded.subtask_hide_completed,
    subtask_assigned_to_me = excluded.subtask_assigned_to_me,
    subtask_sort = excluded.subtask_sort
  returning * into p;
  return jsonb_build_object(
    'hide_completed', p.subtask_hide_completed, 'assigned_to_me', p.subtask_assigned_to_me, 'sort', p.subtask_sort
  );
end;
$$;

select public.alhc_revoke_anon_execute(array['set_subtask_preferences(boolean, boolean, text)']);
grant execute on function public.set_subtask_preferences(boolean, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Review checks: saved as the reviewer goes, the walkthrough, the previous round
-- ---------------------------------------------------------------------------

alter table public.review_checks add column if not exists draft jsonb;
alter table public.review_checks add column if not exists draft_saved_at timestamptz;
alter table public.review_checks add column if not exists draft_saves integer not null default 0;
alter table public.review_checks add column if not exists draft_window_started_at timestamptz;
alter table public.review_checks add column if not exists walkthrough_seen_at timestamptz;

comment on column public.review_checks.draft is
  'Oct 27 notes (batch 5): the reviewer''s work in progress (pins, note, chosen answer), saved by '
  'review_check_save as they go and cleared by the decision. Not readable by clients.';

-- The team sees when the reviewer last worked on an open round (not what they wrote).
grant select (draft_saved_at) on public.review_checks to authenticated;

-- The round before this one that went to the same address and was answered: shown (collapsed, with its
-- pins) on this round's page. Null when there is none.
create or replace function public.review_check_previous(r public.review_checks)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select x.id
  from public.review_checks x
  where r.id is not null
    and x.task_id = r.task_id
    and x.round < r.round
    and x.recipient_email = r.recipient_email
    and x.status in ('approved', 'changes_requested')
  order by x.round desc
  limit 1;
$$;

revoke all on function public.review_check_previous(public.review_checks) from public, anon, authenticated;

create or replace function public.review_check_previous_json(r public.review_checks)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  prev public.review_checks;
begin
  select * into prev from public.review_checks x where x.id = public.review_check_previous(r);
  if prev.id is null then
    return null;
  end if;
  return jsonb_build_object(
    'id', prev.id, 'round', prev.round, 'status', prev.status, 'decided_at', prev.decided_at,
    'decision_note', prev.decision_note,
    'assets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'name', ta.file_name, 'content_type', ta.content_type, 'size', ta.size_bytes
      ) order by a.sort_order, a.created_at)
      from public.review_check_assets a
      join public.task_attachments ta on ta.id = a.attachment_id and ta.deleted_at is null
      where a.review_id = prev.id
    ), '[]'::jsonb),
    'pins', coalesce((
      select jsonb_agg(jsonb_build_object(
        'number', p.number, 'asset_id', p.asset_id, 'page', p.page, 'x', p.x, 'y', p.y,
        'time', p.time_seconds, 'body', p.body
      ) order by p.number)
      from public.review_check_pins p where p.review_id = prev.id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.review_check_previous_json(public.review_checks) from public, anon, authenticated;

select public.alhc_patch_function('public.review_check_view(text)'::regprocedure,
$p$      from public.review_check_files f where f.review_id = r.id and f.status = 'ready'
    ), '[]'::jsonb)
  );$p$,
$p$      from public.review_check_files f where f.review_id = r.id and f.status = 'ready'
    ), '[]'::jsonb),
    -- Oct 27 notes (batch 5): the reviewer's saved progress (open rounds only), the walkthrough, and the
    -- previous answered round to the same address.
    'draft', case when r.status = 'pending' then r.draft end,
    'walkthrough_seen', r.walkthrough_seen_at is not null,
    'previous', public.review_check_previous_json(r)
  );$p$
);

select public.alhc_patch_function('public.review_check_file(text, uuid)'::regprocedure,
$p$  where a.review_id = r.id and a.id = target_file;$p$,
$p$  where (a.review_id = r.id or a.review_id = public.review_check_previous(r)) and a.id = target_file;$p$
);

select public.alhc_patch_function('public.review_check_decide(text, text, text, jsonb)'::regprocedure,
$p$  set status = decision, decided_at = now(), decision_note = clean_note, updated_at = now()$p$,
$p$  set status = decision, decided_at = now(), decision_note = clean_note, updated_at = now(), draft = null$p$,
$p$subject := 'Review v' || r.round || ': '$p$,
$p$subject := 'Review round ' || r.round || ': '$p$,
$p$|| ' (review v' || r.round || ')'$p$,
$p$|| ' (round ' || r.round || ')'$p$
);

-- The reviewer's progress, saved as they go: pins (on this round's files only; a pin may have no text
-- yet), the overall note, the answer they picked, the file they're on. And / or: they closed the
-- walkthrough. Only while the link works; progress only while the round is open. Never readable by the
-- team; review_check_decide sends what counts.
create or replace function public.review_check_save(
  review_token text,
  progress jsonb default null,
  walkthrough_seen boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.review_checks := public.review_check_by_token(review_token);
  n integer;
  clean_pins jsonb;
  decision text;
  active text;
begin
  if r.id is null then
    return jsonb_build_object('status', 'unknown');
  end if;
  if r.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;
  if not exists (select 1 from public.tasks t where t.id = r.task_id and t.deleted_at is null) then
    return jsonb_build_object('status', 'unknown');
  end if;
  if r.status = 'cancelled' then
    return jsonb_build_object('status', 'withdrawn');
  end if;
  if r.status = 'superseded' then
    return jsonb_build_object('status', 'superseded');
  end if;

  update public.review_checks x
  set draft_saves = case
        when x.draft_window_started_at is null or x.draft_window_started_at < now() - interval '1 hour' then 1
        else x.draft_saves + 1 end,
      draft_window_started_at = case
        when x.draft_window_started_at is null or x.draft_window_started_at < now() - interval '1 hour' then now()
        else x.draft_window_started_at end
  where x.id = r.id
  returning x.draft_saves into n;
  if coalesce(n, 0) > 2000 then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  if coalesce(walkthrough_seen, false) then
    update public.review_checks x set walkthrough_seen_at = coalesce(x.walkthrough_seen_at, now()) where x.id = r.id;
  end if;

  if progress is null then
    return jsonb_build_object('status', 'ok');
  end if;
  if r.status <> 'pending' then
    return jsonb_build_object('status', 'closed');
  end if;
  if jsonb_typeof(progress) <> 'object' or octet_length(progress::text) > 262144
     or (progress ? 'pins' and jsonb_typeof(progress -> 'pins') <> 'array')
     or jsonb_array_length(coalesce(progress -> 'pins', '[]'::jsonb)) > 200
     or (progress ? 'note' and jsonb_typeof(progress -> 'note') not in ('string', 'null')) then
    return jsonb_build_object('status', 'invalid');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'asset_id', p ->> 'asset_id',
    'page', case when jsonb_typeof(p -> 'page') = 'number' and (p ->> 'page')::numeric between 1 and 5000
              then round((p ->> 'page')::numeric)::integer end,
    'x', case when jsonb_typeof(p -> 'x') = 'number' and jsonb_typeof(p -> 'y') = 'number'
              and (p ->> 'x')::numeric between 0 and 1 and (p ->> 'y')::numeric between 0 and 1
              then (p ->> 'x')::double precision end,
    'y', case when jsonb_typeof(p -> 'x') = 'number' and jsonb_typeof(p -> 'y') = 'number'
              and (p ->> 'x')::numeric between 0 and 1 and (p ->> 'y')::numeric between 0 and 1
              then (p ->> 'y')::double precision end,
    'time', case when jsonb_typeof(p -> 'time') = 'number' and (p ->> 'time')::numeric between 0 and 86400
              then (p ->> 'time')::double precision end,
    'body', left(case when jsonb_typeof(p -> 'body') = 'string' then p ->> 'body' else '' end, 2000)
  ) order by e.ord), '[]'::jsonb)
  into clean_pins
  from jsonb_array_elements(coalesce(progress -> 'pins', '[]'::jsonb)) with ordinality e(p, ord)
  where jsonb_typeof(e.p) = 'object'
    and coalesce(e.p ->> 'asset_id', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and exists (
      select 1 from public.review_check_assets a where a.review_id = r.id and a.id = (e.p ->> 'asset_id')::uuid
    );

  decision := case when progress ->> 'decision' in ('approved', 'changes_requested') then progress ->> 'decision' end;
  active := case
    when coalesce(progress ->> 'active_asset', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         and exists (
           select 1 from public.review_check_assets a where a.review_id = r.id and a.id = (progress ->> 'active_asset')::uuid
         )
    then progress ->> 'active_asset' end;

  update public.review_checks x
  set draft = jsonb_build_object(
        'pins', clean_pins,
        'note', left(coalesce(progress ->> 'note', ''), 5000),
        'decision', decision,
        'active_asset', active
      ),
      draft_saved_at = now()
  where x.id = r.id;
  return jsonb_build_object('status', 'ok', 'saved_at', now());
end;
$$;

revoke all on function public.review_check_save(text, jsonb, boolean) from public;
revoke all on function public.review_check_save(text, jsonb, boolean) from authenticated;
grant execute on function public.review_check_save(text, jsonb, boolean) to anon;

-- ---------------------------------------------------------------------------
-- 12. Followers
-- ---------------------------------------------------------------------------

select public.alhc_patch_function('public.validate_rule()'::regprocedure,
$p$'Collaborator is added: choose who, or anyone'$p$,
$p$'A follower is added: choose who, or anyone'$p$,
$p$'Compare people: choose the assignee, the creator, the collaborators, or a People field'$p$,
$p$'Compare people: choose the assignee, the creator, the followers, or a People field'$p$,
$p$'Convert to project: invite nobody, or the task''s assignee and collaborators'$p$,
$p$'Convert to project: invite nobody, or the task''s assignee and followers'$p$
);

-- Readable last, so the app can tell this release's database is there.
grant select on public.project_person_settings to authenticated;
