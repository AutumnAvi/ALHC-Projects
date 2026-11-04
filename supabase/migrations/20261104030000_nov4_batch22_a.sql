-- Nov 4 notes, batch 22 (medium fix M1): one database call per screen ("screen loaders").
--
-- Opening a project used to start about 30 separate API calls (the app frame, the project frame, then
-- the page), several of them waiting on each other. Each function below returns one JSON object with
-- everything one screen (or one frame of a screen) reads, so the app makes one round trip where it made
-- ten or more. They are the same reads as before, moved into SQL:
--
--   * SECURITY INVOKER, STABLE, search_path '' (every name qualified): each read runs as the signed-in
--     person, so row-level security decides exactly as it did for the separate calls; a person who
--     can't read a project gets nothing from it. Nothing here is SECURITY DEFINER, and the existing
--     functions they call (project_role, inbox_unread_count, my_task_cards, …) keep their own rules.
--   * Executable by authenticated only (revoked from public and anon).
--   * Stable, documented JSON shapes (src/lib/screen-shapes.ts mirrors them), so other clients (the
--     desktop and phone apps to come) can call the same functions. Each object carries "version": 1;
--     keys are only ever added.
--   * Row objects use the table's own column names (as PostgREST returns them), so the app maps them
--     with the same code as before.
--
-- Additive only: new functions, no change to any table, policy, or existing function.

-- ---------------------------------------------------------------------------------------------
-- viewer_member(): the signed-in person (getViewer / requireMember), in one call instead of two.
--   { version: 1, id: uuid | null, allowlisted: boolean,
--     profile: { full_name: text | null, avatar_url: text | null } | null }
-- The profile is read through RLS (profiles are readable by allowlisted people only), as before.
-- ---------------------------------------------------------------------------------------------
create or replace function public.viewer_member()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'version', 1,
    'id', auth.uid(),
    'allowlisted', coalesce(public.is_allowlisted(), false),
    'profile', (
      select jsonb_build_object('full_name', p.full_name, 'avatar_url', p.avatar_url)
      from public.profiles p
      where p.id = auth.uid()
    )
  );
$$;

comment on function public.viewer_member() is
  'Batch 22 screen loader: the signed-in person (allowlisted, name and picture). Invoker; RLS applies.';

-- ---------------------------------------------------------------------------------------------
-- app_shell(): the app frame (top bar, sidebar, settings providers) for every signed-in page.
--   { version: 1,
--     workspace: { id, name, default_team_id, logo_path, email_sender_name, tags_enabled, goals_enabled,
--                  work_week } | null,                        -- the oldest live workspace
--     is_workspace_admin: boolean,
--     unread_count: integer,                                  -- inbox_unread_count()
--     projects: [ { id, name, description, sort_order, approval_completes_task, status, status_note,
--                   status_updated_at, status_updated_by, archived_at, team_id, visibility } ],
--                                                             -- readable, not deleted (archived too)
--     own_roles: [ { project_id, role } ],                    -- the person's own active memberships
--     star_ids: [ uuid ],                                     -- starred, oldest first
--     folders: [ { id, name, collapsed, sort_order } ],
--     folder_placements: [ { project_id, folder_id, sort_order } ],
--     preferences: { subtask_hide_completed, subtask_assigned_to_me, subtask_sort, open_personal_view,
--                    expanded_task_ids, my_tasks_checked, work_week } | null,
--     profiles: [ { id, email, full_name, avatar_url } ],     -- everyone the person can read, by name
--     tags: [ { id, name, color, palette_color, archived_at, created_by } ] }   -- every live tag
-- ---------------------------------------------------------------------------------------------
create or replace function public.app_shell()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with ws as (
    select w.id, w.name, w.default_team_id, w.logo_path, w.email_sender_name, w.tags_enabled, w.goals_enabled,
      w.work_week
    from public.workspaces w
    where w.deleted_at is null
    order by w.created_at
    limit 1
  )
  select jsonb_build_object(
    'version', 1,
    'workspace', (select to_jsonb(ws) from ws),
    'is_workspace_admin', coalesce(public.is_workspace_admin(), false),
    'unread_count', coalesce(public.inbox_unread_count(), 0),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', p.id, 'name', p.name, 'description', p.description, 'sort_order', p.sort_order,
          'approval_completes_task', p.approval_completes_task, 'status', p.status, 'status_note', p.status_note,
          'status_updated_at', p.status_updated_at, 'status_updated_by', p.status_updated_by,
          'archived_at', p.archived_at, 'team_id', p.team_id, 'visibility', p.visibility)
        order by p.sort_order, p.created_at)
      from public.projects p
      where p.deleted_at is null
    ), '[]'::jsonb),
    'own_roles', coalesce((
      select jsonb_agg(jsonb_build_object('project_id', m.project_id, 'role', m.role) order by m.created_at)
      from public.project_members m
      where m.profile_id = auth.uid() and m.deleted_at is null
    ), '[]'::jsonb),
    'star_ids', coalesce((
      select jsonb_agg(s.project_id order by s.starred_at)
      from public.project_stars s
      where s.deleted_at is null
    ), '[]'::jsonb),
    'folders', coalesce((
      select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'collapsed', f.collapsed, 'sort_order', f.sort_order)
        order by f.sort_order)
      from public.sidebar_folders f
      where f.deleted_at is null
    ), '[]'::jsonb),
    'folder_placements', coalesce((
      select jsonb_agg(jsonb_build_object('project_id', fp.project_id, 'folder_id', fp.folder_id, 'sort_order', fp.sort_order))
      from public.sidebar_folder_projects fp
      where fp.folder_id is not null
    ), '[]'::jsonb),
    'preferences', (
      select jsonb_build_object(
        'subtask_hide_completed', pp.subtask_hide_completed, 'subtask_assigned_to_me', pp.subtask_assigned_to_me,
        'subtask_sort', pp.subtask_sort, 'open_personal_view', pp.open_personal_view,
        'expanded_task_ids', pp.expanded_task_ids, 'my_tasks_checked', pp.my_tasks_checked, 'work_week', pp.work_week)
      from public.profile_preferences pp
      where pp.profile_id = auth.uid()
    ),
    'profiles', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'email', p.email, 'full_name', p.full_name, 'avatar_url', p.avatar_url)
        order by p.full_name)
      from public.profiles p
    ), '[]'::jsonb),
    'tags', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', t.id, 'name', t.name, 'color', t.color, 'palette_color', t.palette_color,
          'archived_at', t.archived_at, 'created_by', t.created_by)
        order by t.name)
      from public.tags t
      where t.deleted_at is null
    ), '[]'::jsonb)
  );
$$;

comment on function public.app_shell() is
  'Batch 22 screen loader: the app frame (workspace, sidebar projects, stars, folders, inbox count, preferences, people, tags). Invoker; RLS applies.';

-- ---------------------------------------------------------------------------------------------
-- project_frame(target_project): the project frame (header, tabs, Customize, permissions) every
-- /projects/<id>/… page shares, plus the person's own settings there.
--   { version: 1,
--     project: { id, name, description, sort_order, approval_completes_task, status, status_note,
--                status_updated_at, status_updated_by, archived_at, team_id, visibility, sections_locked }
--              | null,                                     -- null: not found, or not readable
--     role: text | null,                                   -- project_role(): archived caps at viewer
--     access_status: text | null,                          -- project_access_status(), only when the
--                                                          -- project or role is null (the request page)
--     views: [ project_views row ],                        -- by sort_order, created_at
--     view_settings: { default_view_id, hidden_tabs, hidden_view_ids } | null,
--     task_templates: [ { id, project_id, name, title, notes, subtasks, field_values, assignee_id, updated_at } ],
--     fields: [ custom_fields row ],
--     field_sharing: [ project_field_sharing() row ],
--     forms: [ forms row + { submission_count, last_submitted_at } ],
--     rules: [ { id, project_id, name, enabled, trigger_type, trigger_config, conditions, actions, preset_key,
--                owner_id, next_run_at, last_edited_by, last_edited_at, run_on_rule_changes, paused_at,
--                pause_reason, consecutive_failures, paused_until } ],
--     members: [ { profile_id, role, created_at, profile: { email, full_name, avatar_url } } ],
--     sections: [ { id, project_id, name, sort_order } ],
--     status_templates: [ { id, name, status, title, sections, sort_order, created_by } ],
--     numbering: { enabled, prefix, pad_width, add_to_title, assign_to, last_number, template, wrap_brackets,
--                  number_subtasks, subtask_separator, number_scope, section_ids, task_kinds, reuse_deleted,
--                  fill_gaps, reset_period, counter_field_id, project_code, renumber_on_move, time_zone,
--                  start_number } | null,
--     personal: { column_widths: jsonb | null, collapsed_groups: text[] | null, show_completed: boolean | null,
--                 view_configs: [ { view_id, config } ] } }   -- the person's own rows here
-- ---------------------------------------------------------------------------------------------
create or replace function public.project_frame(target_project uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with proj as (
    select p.id, p.name, p.description, p.sort_order, p.approval_completes_task, p.status, p.status_note,
      p.status_updated_at, p.status_updated_by, p.archived_at, p.team_id, p.visibility, p.sections_locked
    from public.projects p
    where p.id = target_project and p.deleted_at is null
  ), viewer as (
    select public.project_role(target_project) as role
  )
  select jsonb_build_object(
    'version', 1,
    'project', (select to_jsonb(proj) from proj),
    'role', (select v.role from viewer v),
    'access_status', case
      when not exists (select 1 from proj) or (select v.role from viewer v) is null
        then public.project_access_status(target_project)
    end,
    'views', coalesce((
      select jsonb_agg(to_jsonb(v) order by v.sort_order, v.created_at)
      from public.project_views v
      where v.project_id = target_project and v.deleted_at is null
    ), '[]'::jsonb),
    'view_settings', (
      select jsonb_build_object('default_view_id', s.default_view_id, 'hidden_tabs', s.hidden_tabs,
        'hidden_view_ids', s.hidden_view_ids)
      from public.project_view_settings s
      where s.project_id = target_project
    ),
    'task_templates', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', t.id, 'project_id', t.project_id, 'name', t.name, 'title', t.title, 'notes', t.notes,
          'subtasks', t.subtasks, 'field_values', t.field_values, 'assignee_id', t.assignee_id,
          'updated_at', t.updated_at)
        order by t.sort_order, t.created_at)
      from public.task_templates t
      where t.project_id = target_project and t.deleted_at is null
    ), '[]'::jsonb),
    'fields', coalesce((
      select jsonb_agg(to_jsonb(f) order by f.sort_order, f.created_at)
      from public.custom_fields f
      where f.project_id = target_project and f.deleted_at is null
    ), '[]'::jsonb),
    'field_sharing', coalesce((
      select jsonb_agg(to_jsonb(fs) order by fs.field_id)
      from public.project_field_sharing(target_project) fs
    ), '[]'::jsonb),
    'forms', coalesce((
      select jsonb_agg(to_jsonb(f) || jsonb_build_object(
          'submission_count', (
            select count(*) from public.form_submissions fs where fs.form_id = f.id and fs.deleted_at is null),
          'last_submitted_at', (
            select max(fs.created_at) from public.form_submissions fs where fs.form_id = f.id and fs.deleted_at is null))
        order by f.created_at)
      from public.forms f
      where f.project_id = target_project and f.deleted_at is null
    ), '[]'::jsonb),
    'rules', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', r.id, 'project_id', r.project_id, 'name', r.name, 'enabled', r.enabled,
          'trigger_type', r.trigger_type, 'trigger_config', r.trigger_config, 'conditions', r.conditions,
          'actions', r.actions, 'preset_key', r.preset_key, 'owner_id', r.owner_id, 'next_run_at', r.next_run_at,
          'last_edited_by', r.last_edited_by, 'last_edited_at', r.last_edited_at,
          'run_on_rule_changes', r.run_on_rule_changes, 'paused_at', r.paused_at, 'pause_reason', r.pause_reason,
          'consecutive_failures', r.consecutive_failures, 'paused_until', r.paused_until)
        order by r.sort_order, r.created_at)
      from public.rules r
      where r.project_id = target_project and r.deleted_at is null
    ), '[]'::jsonb),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
          'profile_id', m.profile_id, 'role', m.role, 'created_at', m.created_at,
          'profile', jsonb_build_object('email', pr.email, 'full_name', pr.full_name, 'avatar_url', pr.avatar_url))
        order by m.created_at)
      from public.project_members m
      join public.profiles pr on pr.id = m.profile_id
      where m.project_id = target_project and m.deleted_at is null
    ), '[]'::jsonb),
    'sections', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'project_id', s.project_id, 'name', s.name, 'sort_order', s.sort_order)
        order by s.sort_order, s.created_at)
      from public.sections s
      where s.project_id = target_project and s.deleted_at is null
    ), '[]'::jsonb),
    'status_templates', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', st.id, 'name', st.name, 'status', st.status, 'title', st.title, 'sections', st.sections,
          'sort_order', st.sort_order, 'created_by', st.created_by)
        order by st.sort_order, st.created_at)
      from public.project_status_templates st
      where st.project_id = target_project and st.deleted_at is null
    ), '[]'::jsonb),
    'numbering', (
      select jsonb_build_object(
        'enabled', rs.enabled, 'prefix', rs.prefix, 'pad_width', rs.pad_width, 'add_to_title', rs.add_to_title,
        'assign_to', rs.assign_to, 'last_number', rs.last_number, 'template', rs.template,
        'wrap_brackets', rs.wrap_brackets, 'number_subtasks', rs.number_subtasks,
        'subtask_separator', rs.subtask_separator, 'number_scope', rs.number_scope, 'section_ids', rs.section_ids,
        'task_kinds', rs.task_kinds, 'reuse_deleted', rs.reuse_deleted, 'fill_gaps', rs.fill_gaps,
        'reset_period', rs.reset_period, 'counter_field_id', rs.counter_field_id, 'project_code', rs.project_code,
        'renumber_on_move', rs.renumber_on_move, 'time_zone', rs.time_zone, 'start_number', rs.start_number)
      from public.request_sequences rs
      where rs.project_id = target_project and rs.deleted_at is null
      limit 1
    ),
    'personal', jsonb_build_object(
      'column_widths', (
        select w.widths from public.list_column_widths w
        where w.project_id = target_project and w.profile_id = auth.uid()
        limit 1),
      'collapsed_groups', (
        select g.group_keys from public.list_collapsed_groups g
        where g.project_id = target_project and g.profile_id = auth.uid()
        limit 1),
      'show_completed', (
        select ps.show_completed from public.project_person_settings ps
        where ps.project_id = target_project and ps.profile_id = auth.uid()
        limit 1),
      'view_configs', coalesce((
        select jsonb_agg(jsonb_build_object('view_id', c.view_id, 'config', c.config))
        from public.project_view_personal_configs c
        where c.project_id = target_project and c.profile_id = auth.uid()
      ), '[]'::jsonb)
    )
  );
$$;

comment on function public.project_frame(uuid) is
  'Batch 22 screen loader: the project frame (project, role, views, tab settings, templates, fields, forms, automations, members, sections, numbering, the person''s own settings). Invoker; RLS applies.';

-- ---------------------------------------------------------------------------------------------
-- project_view_page(…): one page of List / Board cards with the labels this project shows and the
-- section counts (a section can be removed only while it is empty).
--   { version: 1,
--     page: project_task_card_page(…) (its own shape: { groups: [ { key, total, next_id, next_sort_order,
--           cards } ] }),
--     labels: task_request_labels_in(target_project, <the page's task ids>),   -- { task id: label }
--     section_counts: project_section_task_counts(target_project) }            -- { section id: count }
-- Same arguments as project_task_card_page.
-- ---------------------------------------------------------------------------------------------
create or replace function public.project_view_page(
  target_project uuid,
  filters jsonb,
  tz text,
  group_by text,
  sorts jsonb,
  page_size integer,
  limits jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  card_page jsonb := public.project_task_card_page(target_project, filters, tz, group_by, sorts, page_size, limits);
  ids uuid[];
begin
  select coalesce(array_agg(distinct (c ->> 'id')::uuid), '{}')
    into ids
  from jsonb_array_elements(
      case when jsonb_typeof(card_page -> 'groups') = 'array' then card_page -> 'groups' else '[]'::jsonb end) g,
    jsonb_array_elements(case when jsonb_typeof(g -> 'cards') = 'array' then g -> 'cards' else '[]'::jsonb end) c
  where jsonb_typeof(c -> 'id') = 'string';

  return jsonb_build_object(
    'version', 1,
    'page', card_page,
    'labels', case when cardinality(ids) > 0 then public.task_request_labels_in(target_project, ids) else '{}'::jsonb end,
    'section_counts', public.project_section_task_counts(target_project)
  );
end;
$$;

comment on function public.project_view_page(uuid, jsonb, text, text, jsonb, integer, jsonb) is
  'Batch 22 screen loader: a List / Board page of cards with their labels in this project and the section counts. Invoker; RLS applies.';

-- ---------------------------------------------------------------------------------------------
-- my_task_bundle(extra_label_ids): the tasks assigned to the person (My tasks' checklist and Home's
-- Today) with everything their rows need, and the approvals waiting on them.
--   { version: 1,
--     cards: my_task_cards() (its own shape: { open: [card], completed: [card] }),
--     labels: task_project_labels(<every task here, plus extra_label_ids>),   -- numbers and places
--     access_tasks: [ { id, root_task_id, home_project_id, created_by, assignee_id } ],
--                   -- the tasks (and their top-level tasks) whose edit / comment rights the rows show
--     access_memberships: [ { task_id, project_id } ],   -- those top-level tasks' live projects
--     blocker_counts: open_blocker_counts(<open tasks>), -- { task id: count }
--     children: [ { parent_task_id, completed_at } ],    -- live subtasks of the open tasks
--     approval_states: task_approval_states(<open approval tasks>),
--     awaiting: { requests: [ { id, task_id, round_id, created_at } ],   -- pending, the person approves,
--                                                                          -- newest first, at most 200
--                 tasks: [ { id, title, kind, due_on, completed_at } ],
--                 rounds: [ { id, status, due_on, round_number } ] } }
-- The app combines these exactly as before (src/lib/data.ts: labelMyTasks, taskAccessSets,
-- listAwaitingMyApproval).
-- ---------------------------------------------------------------------------------------------
create or replace function public.my_task_bundle(extra_label_ids uuid[] default '{}')
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  cards jsonb := public.my_task_cards();
  open_ids uuid[];
  done_ids uuid[];
  approval_ids uuid[];
  awaiting_requests jsonb;
  awaiting_ids uuid[];
  access_ids uuid[];
  first_read jsonb;
  root_ids uuid[];
  access_rows jsonb;
begin
  select coalesce(array_agg((e ->> 'id')::uuid), '{}'),
    coalesce(array_agg((e ->> 'id')::uuid) filter (where e ->> 'kind' = 'approval'), '{}')
    into open_ids, approval_ids
  from jsonb_array_elements(case when jsonb_typeof(cards -> 'open') = 'array' then cards -> 'open' else '[]'::jsonb end) e
  where jsonb_typeof(e -> 'id') = 'string';
  select coalesce(array_agg((e ->> 'id')::uuid), '{}')
    into done_ids
  from jsonb_array_elements(case when jsonb_typeof(cards -> 'completed') = 'array' then cards -> 'completed' else '[]'::jsonb end) e
  where jsonb_typeof(e -> 'id') = 'string';

  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'task_id', r.task_id, 'round_id', r.round_id,
      'created_at', r.created_at) order by r.created_at desc), '[]'::jsonb),
    coalesce(array_agg(distinct r.task_id), '{}')
    into awaiting_requests, awaiting_ids
  from (
    select a.id, a.task_id, a.round_id, a.created_at
    from public.approval_requests a
    where a.approver_id = me and a.status = 'pending' and a.deleted_at is null
    order by a.created_at desc
    limit 200
  ) r;

  access_ids := array(select distinct x from unnest(open_ids || done_ids || awaiting_ids) x);

  -- The rows the person can read, then the top-level tasks of those that aren't among them.
  with first as (
    select t.id, t.root_task_id, t.home_project_id, t.created_by, t.assignee_id
    from public.tasks t
    where t.id = any(access_ids)
  ), roots as (
    select distinct coalesce(f.root_task_id, f.id) as id from first f
  ), extra as (
    select t.id, t.root_task_id, t.home_project_id, t.created_by, t.assignee_id
    from public.tasks t
    where t.id in (select r.id from roots r) and t.id not in (select f.id from first f)
  )
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb), (select coalesce(array_agg(r.id), '{}') from roots r)
    into access_rows, root_ids
  from (select * from first union all select * from extra) x;

  return jsonb_build_object(
    'version', 1,
    'cards', cards,
    'labels', public.task_project_labels(array(select distinct x from unnest(access_ids || extra_label_ids) x)),
    'access_tasks', access_rows,
    'access_memberships', coalesce((
      select jsonb_agg(jsonb_build_object('task_id', tp.task_id, 'project_id', tp.project_id))
      from public.task_projects tp
      where tp.task_id = any(root_ids) and tp.deleted_at is null
    ), '[]'::jsonb),
    'blocker_counts', case when cardinality(open_ids) > 0 then public.open_blocker_counts(open_ids) else '{}'::jsonb end,
    'children', coalesce((
      select jsonb_agg(jsonb_build_object('parent_task_id', c.parent_task_id, 'completed_at', c.completed_at))
      from public.tasks c
      where c.parent_task_id = any(open_ids) and c.deleted_at is null
    ), '[]'::jsonb),
    'approval_states', case when cardinality(approval_ids) > 0 then public.task_approval_states(approval_ids) else '{}'::jsonb end,
    'awaiting', jsonb_build_object(
      'requests', awaiting_requests,
      'tasks', coalesce((
        select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'kind', t.kind, 'due_on', t.due_on,
          'completed_at', t.completed_at))
        from public.tasks t
        where t.id = any(awaiting_ids) and t.deleted_at is null
      ), '[]'::jsonb),
      'rounds', coalesce((
        select jsonb_agg(jsonb_build_object('id', ar.id, 'status', ar.status, 'due_on', ar.due_on,
          'round_number', ar.round_number))
        from public.approval_rounds ar
        where ar.id in (select (q ->> 'round_id')::uuid from jsonb_array_elements(awaiting_requests) q
                        where jsonb_typeof(q -> 'round_id') = 'string')
      ), '[]'::jsonb)
    )
  );
end;
$$;

comment on function public.my_task_bundle(uuid[]) is
  'Batch 22 screen loader part: the person''s assigned tasks with their labels, access rows, blockers, subtask counts, approval states, and the approvals waiting on them. Invoker; RLS applies.';

-- ---------------------------------------------------------------------------------------------
-- my_tasks_screen(): My tasks (both the checklist and the classic views).
--   { version: 1,
--     tasks: my_task_bundle(),
--     rules: [ { id, name, enabled, trigger_type, trigger_config, conditions, actions } ] | null,
--                                                     -- My Tasks automations (own rows), oldest first
--     rules_v2: boolean,                              -- my_task_rules_batch20_ready()
--     editable_sections: [ { id, name, project_id, sort_order } ] }
--                                                     -- sections of live projects the person is an
--                                                     -- Owner / Admin / Editor member of
-- my_tasks_layout() (it writes: it seeds the person's sections and places new tasks) stays its own call.
-- ---------------------------------------------------------------------------------------------
create or replace function public.my_tasks_screen()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'version', 1,
    'tasks', public.my_task_bundle('{}'::uuid[]),
    'rules', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', r.id, 'name', r.name, 'enabled', r.enabled, 'trigger_type', r.trigger_type,
          'trigger_config', r.trigger_config, 'conditions', r.conditions, 'actions', r.actions)
        order by r.created_at)
      from public.my_task_rules r
      where r.deleted_at is null
    ), '[]'::jsonb),
    'rules_v2', coalesce(public.my_task_rules_batch20_ready(), false),
    'editable_sections', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'project_id', s.project_id, 'sort_order', s.sort_order)
        order by s.sort_order)
      from public.sections s
      join public.projects p on p.id = s.project_id and p.deleted_at is null and p.archived_at is null
      where s.deleted_at is null
        and exists (
          select 1 from public.project_members m
          where m.project_id = s.project_id and m.profile_id = auth.uid() and m.deleted_at is null
            and m.role in ('owner', 'admin', 'editor'))
    ), '[]'::jsonb)
  );
$$;

comment on function public.my_tasks_screen() is
  'Batch 22 screen loader: My tasks (assigned tasks, approvals waiting, My Tasks automations, sections the person can add tasks to). Invoker; RLS applies.';

-- ---------------------------------------------------------------------------------------------
-- home_screen(tz): Home.
--   { version: 1,
--     tasks: my_task_bundle(<the inbox's task ids>),  -- labels also cover the inbox items' tasks
--     dashboard: home_dashboard(tz),
--     inbox: inbox_page('activity') }
-- ---------------------------------------------------------------------------------------------
create or replace function public.home_screen(tz text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  inbox jsonb := public.inbox_page('activity');
  inbox_task_ids uuid[];
begin
  select coalesce(array_agg(distinct (i ->> 'task_id')::uuid), '{}')
    into inbox_task_ids
  from jsonb_array_elements(case when jsonb_typeof(inbox) = 'array' then inbox else '[]'::jsonb end) i
  where jsonb_typeof(i -> 'task_id') = 'string';

  return jsonb_build_object(
    'version', 1,
    'tasks', public.my_task_bundle(inbox_task_ids),
    'dashboard', public.home_dashboard(tz),
    'inbox', inbox
  );
end;
$$;

comment on function public.home_screen(text) is
  'Batch 22 screen loader: Home (assigned tasks, approvals waiting, the dashboard, the Inbox''s Activity tab). Invoker; RLS applies.';

-- ---------------------------------------------------------------------------------------------
-- task_pane_rows(target_task, comment_page_size): the task pane's reads (getTaskDetail) in one call.
-- Each key is the rows one of the pane's separate reads returned, under the same column names:
--   { version: 1,
--     task: { id, title, kind, notes, completed_at, start_on, due_on, start_at, due_at, time_zone, recurrence,
--             recurrence_seq, recurrence_next_id, assignee_id, home_project_id, created_at, updated_at, source,
--             req_project_id, req_number, parent_task_id, root_task_id } | null,   -- null: not readable
--     subtasks: [ { id, parent_task_id, title, completed_at, assignee_id, start_on, due_on, kind, subtask_order } ],
--     memberships: [ { project_id, section_id, project: { id, name, sections: [ { id, name, sort_order, deleted_at } ] } } ],
--     tree: [ { id, title, completed_at, parent_task_id, deleted_at } ],           -- the task tree, ≤ 500
--     fields: [ custom_fields row ],                                              -- of the task's projects
--     values: [ { field_id, value } ], followers: [ { profile_id } ],
--     attachments: [ { id, file_name, content_type, size_bytes, uploaded_by, created_at, source } ],
--     comment_page: task_comment_page(target_task, null, null, comment_page_size),
--     stories: [ { id, actor_id, kind, data, created_at } ],
--     approvals: [ approval_requests row ],
--     submission: { form_id, submitter_email, created_at, answers } | null,       -- the latest
--     request_label: text | null,                                                 -- format_request_label()
--     numbering: request_sequences row | null,                                    -- enabled, of the home project
--     task_role: text | null,
--     project_members: [ { profile_id, role } ],                                  -- of the task's projects
--     dependencies: [ { id, predecessor_id, successor_id, kind, lag_days,
--                       predecessor: { id, title, completed_at, parent_task_id }, successor: { … } } ],
--     next_occurrence: { id } | null,
--     attachment_links: [ { id, source, name, url, attachment_id } ],
--     comment_emails: [ { id, email_direction, email_address, email_subject } ],
--     response_emails: [ { status, delivery_status, last_error, comment_id } ],
--     blocker_count: integer,                                                     -- open_blocker_count()
--     private_root: { created_by, assignee_id } | null,                           -- private tasks only
--     tag_ids: [ uuid ],
--     labels: task_project_labels([target_task]),
--     task_numbers: task_numbers(target_task),
--     reply_thread: submitter_thread_status(target_task),
--     pinned_comments: task_pinned_comments(target_task),
--     pin_events: [ { id, comment_id, actor_id, pinned, created_at } ],
--     rule_runs: [ { id, rule_id, status, detail, created_at, rule: { name, project_id } | null } ],
--                                                                        -- newest first, ≤ run_limit
--     email_activity: [ { id, kind, sender_email, sender_profile_id, subject, comment_id, created_at } ] }  -- ≤ 200
-- ---------------------------------------------------------------------------------------------
create or replace function public.task_pane_rows(
  target_task uuid,
  comment_page_size integer default 100,
  run_limit integer default 100
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  t record;
  scope uuid;
  project_ids uuid[];
begin
  select x.id, x.title, x.kind, x.notes, x.completed_at, x.start_on, x.due_on, x.start_at, x.due_at, x.time_zone,
      x.recurrence, x.recurrence_seq, x.recurrence_next_id, x.assignee_id, x.home_project_id, x.created_at,
      x.updated_at, x.source, x.req_project_id, x.req_number, x.parent_task_id, x.root_task_id
    into t
  from public.tasks x
  where x.id = target_task and x.deleted_at is null;
  if not found then
    return jsonb_build_object('version', 1, 'task', null);
  end if;
  scope := coalesce(t.root_task_id, t.id);

  select coalesce(array_agg(tp.project_id), '{}')
    into project_ids
  from public.task_projects tp
  join public.projects p on p.id = tp.project_id and p.deleted_at is null
  where tp.task_id = scope and tp.deleted_at is null;

  return jsonb_build_object(
    'version', 1,
    'task', to_jsonb(t),
    'subtasks', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'parent_task_id', s.parent_task_id, 'title', s.title,
          'completed_at', s.completed_at, 'assignee_id', s.assignee_id, 'start_on', s.start_on, 'due_on', s.due_on,
          'kind', s.kind, 'subtask_order', s.subtask_order)
        order by s.subtask_order, s.created_at)
      from public.tasks s
      where s.parent_task_id = target_task and s.deleted_at is null
    ), '[]'::jsonb),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object('project_id', tp.project_id, 'section_id', tp.section_id,
          'project', jsonb_build_object('id', p.id, 'name', p.name, 'sections', coalesce((
            select jsonb_agg(jsonb_build_object('id', sec.id, 'name', sec.name, 'sort_order', sec.sort_order,
              'deleted_at', sec.deleted_at))
            from public.sections sec
            where sec.project_id = p.id
          ), '[]'::jsonb)))
        order by tp.created_at, tp.project_id)
      from public.task_projects tp
      join public.projects p on p.id = tp.project_id and p.deleted_at is null
      where tp.task_id = scope and tp.deleted_at is null
    ), '[]'::jsonb),
    'tree', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at)
      from (
        select x.id, x.title, x.completed_at, x.parent_task_id, x.deleted_at, x.created_at
        from public.tasks x
        where x.id = scope or x.root_task_id = scope
        order by x.created_at
        limit 500
      ) r
    ), '[]'::jsonb),
    'fields', coalesce((
      select jsonb_agg(to_jsonb(f) order by f.sort_order, f.created_at)
      from public.custom_fields f
      where f.project_id = any(project_ids) and f.deleted_at is null
    ), '[]'::jsonb),
    'values', coalesce((
      select jsonb_agg(jsonb_build_object('field_id', v.field_id, 'value', v.value))
      from public.task_field_values v
      where v.task_id = target_task
    ), '[]'::jsonb),
    'followers', coalesce((
      select jsonb_agg(jsonb_build_object('profile_id', fo.profile_id) order by fo.created_at)
      from public.task_followers fo
      where fo.task_id = target_task and fo.deleted_at is null
    ), '[]'::jsonb),
    'attachments', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'file_name', a.file_name, 'content_type', a.content_type,
          'size_bytes', a.size_bytes, 'uploaded_by', a.uploaded_by, 'created_at', a.created_at, 'source', a.source)
        order by a.created_at)
      from public.task_attachments a
      where a.task_id = target_task and a.deleted_at is null
    ), '[]'::jsonb),
    'comment_page', public.task_comment_page(target_task, null, null, comment_page_size),
    'stories', coalesce((
      select jsonb_agg(jsonb_build_object('id', st.id, 'actor_id', st.actor_id, 'kind', st.kind, 'data', st.data,
          'created_at', st.created_at)
        order by st.created_at)
      from public.task_stories st
      where st.task_id = target_task
    ), '[]'::jsonb),
    'approvals', coalesce((
      select jsonb_agg(to_jsonb(ar) order by ar.created_at)
      from public.approval_requests ar
      where ar.task_id = target_task and ar.deleted_at is null
    ), '[]'::jsonb),
    'submission', (
      select jsonb_build_object('form_id', fs.form_id, 'submitter_email', fs.submitter_email,
        'created_at', fs.created_at, 'answers', fs.answers)
      from public.form_submissions fs
      where fs.task_id = scope and fs.deleted_at is null
      order by fs.created_at desc
      limit 1
    ),
    'request_label', case
      when t.req_number is not null then public.format_request_label(t.req_project_id, t.req_number)
    end,
    'numbering', (
      select to_jsonb(rs)
      from public.request_sequences rs
      where t.home_project_id is not null and rs.project_id = t.home_project_id and rs.enabled
        and rs.deleted_at is null
      limit 1
    ),
    'task_role', public.task_role(target_task),
    'project_members', coalesce((
      select jsonb_agg(jsonb_build_object('profile_id', m.profile_id, 'role', m.role))
      from public.project_members m
      where m.project_id = any(project_ids) and m.deleted_at is null
    ), '[]'::jsonb),
    'dependencies', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'predecessor_id', d.predecessor_id,
          'successor_id', d.successor_id, 'kind', d.kind, 'lag_days', d.lag_days,
          'predecessor', jsonb_build_object('id', pre.id, 'title', pre.title, 'completed_at', pre.completed_at,
            'parent_task_id', pre.parent_task_id),
          'successor', jsonb_build_object('id', suc.id, 'title', suc.title, 'completed_at', suc.completed_at,
            'parent_task_id', suc.parent_task_id))
        order by d.created_at)
      from public.task_dependencies d
      join public.tasks pre on pre.id = d.predecessor_id and pre.deleted_at is null
      join public.tasks suc on suc.id = d.successor_id and suc.deleted_at is null
      where (d.predecessor_id = target_task or d.successor_id = target_task) and d.deleted_at is null
    ), '[]'::jsonb),
    'next_occurrence', (
      select jsonb_build_object('id', n.id)
      from public.tasks n
      where t.recurrence_next_id is not null and n.id = t.recurrence_next_id and n.deleted_at is null
    ),
    'attachment_links', coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'source', l.source, 'name', l.name, 'url', l.url,
          'attachment_id', l.attachment_id)
        order by l.created_at)
      from public.task_attachment_links l
      where l.task_id = target_task and l.deleted_at is null
    ), '[]'::jsonb),
    'comment_emails', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'email_direction', c.email_direction,
          'email_address', c.email_address, 'email_subject', c.email_subject))
      from public.comments c
      where c.task_id = target_task and c.email_direction is not null
    ), '[]'::jsonb),
    'response_emails', coalesce((
      select jsonb_agg(jsonb_build_object('status', o.status, 'delivery_status', o.delivery_status,
          'last_error', o.last_error, 'comment_id', o.payload ->> 'comment_id')
        order by o.created_at)
      from public.email_outbox o
      where o.task_id = target_task and o.payload ->> 'kind' = 'submitter_response'
    ), '[]'::jsonb),
    'blocker_count', public.open_blocker_count(target_task),
    'private_root', case when t.home_project_id is null then (
      select jsonb_build_object('created_by', r.created_by, 'assignee_id', r.assignee_id)
      from public.tasks r
      where r.id = scope
    ) end,
    'tag_ids', coalesce((
      select jsonb_agg(tt.tag_id)
      from public.task_tags tt
      join public.tags tg on tg.id = tt.tag_id and tg.deleted_at is null
      where tt.task_id = target_task and tt.deleted_at is null
    ), '[]'::jsonb),
    'labels', public.task_project_labels(array[target_task]),
    'task_numbers', public.task_numbers(target_task),
    'reply_thread', public.submitter_thread_status(target_task),
    'pinned_comments', public.task_pinned_comments(target_task),
    'pin_events', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'comment_id', e.comment_id, 'actor_id', e.actor_id,
          'pinned', e.pinned, 'created_at', e.created_at)
        order by e.created_at)
      from public.comment_pin_events e
      where e.task_id = target_task
    ), '[]'::jsonb),
    'rule_runs', coalesce((
      select jsonb_agg(to_jsonb(rr) order by rr.created_at desc)
      from (
        select r.id, r.rule_id, r.status, r.detail, r.created_at,
          (select jsonb_build_object('name', ru.name, 'project_id', ru.project_id)
           from public.rules ru where ru.id = r.rule_id) as rule
        from public.rule_runs r
        where r.task_id = target_task and r.deleted_at is null
        order by r.created_at desc
        limit run_limit
      ) rr
    ), '[]'::jsonb),
    'email_activity', coalesce((
      select jsonb_agg(to_jsonb(ea) order by ea.created_at)
      from (
        select a.id, a.kind, a.sender_email, a.sender_profile_id, a.subject, a.comment_id, a.created_at
        from public.task_email_activity a
        where a.task_id = target_task
        order by a.created_at
        limit 200
      ) ea
    ), '[]'::jsonb)
  );
end;
$$;

comment on function public.task_pane_rows(uuid, integer, integer) is
  'Batch 22 screen loader: the task pane''s reads in one call (task, subtasks, projects, fields, comments, activity, approvals, dependencies, …). Invoker; RLS applies.';

-- Authenticated only (Supabase's default privileges would give anon these too).
revoke all on function public.viewer_member() from public, anon;
revoke all on function public.app_shell() from public, anon;
revoke all on function public.project_frame(uuid) from public, anon;
revoke all on function public.project_view_page(uuid, jsonb, text, text, jsonb, integer, jsonb) from public, anon;
revoke all on function public.my_task_bundle(uuid[]) from public, anon;
revoke all on function public.my_tasks_screen() from public, anon;
revoke all on function public.home_screen(text) from public, anon;
revoke all on function public.task_pane_rows(uuid, integer, integer) from public, anon;
grant execute on function public.viewer_member() to authenticated;
grant execute on function public.app_shell() to authenticated;
grant execute on function public.project_frame(uuid) to authenticated;
grant execute on function public.project_view_page(uuid, jsonb, text, text, jsonb, integer, jsonb) to authenticated;
grant execute on function public.my_task_bundle(uuid[]) to authenticated;
grant execute on function public.my_tasks_screen() to authenticated;
grant execute on function public.home_screen(text) to authenticated;
grant execute on function public.task_pane_rows(uuid, integer, integer) to authenticated;
