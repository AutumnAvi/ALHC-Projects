-- ALHC Projects — Nov 4 notes, batch 23 (medium fix M2: per-query permission checks). Additive: no table,
-- column, or row removed or changed; two new functions, one guard widened, three covering indexes, and
-- the read / write policies below rewritten to the same access. The release still on main keeps
-- working once this is applied (same rows, same function signatures and grants). No TAIL.
--
-- Why. Almost every RLS policy asked has_project_role(project_id, …), has_task_role(task_id, …),
-- has_portfolio_role(…), or custom_field_has_role(…) for each row it looked at. Those are nested SECURITY
-- DEFINER functions with their own search_path (four levels for a task), so a statement reading 10,000
-- rows made 10,000+ definer calls. Batch 18 fixed the three hottest policies (tasks, task_projects,
-- rule_runs) with viewer_project_ids(); this does the same for every other policy that called them.
--
--   project_ids_with_role(min_role)    the projects where the caller's role is at least min_role (an
--                                      active membership while allowlisted; an archived project counts
--                                      every member as Viewer) — exactly where has_project_role is true.
--   portfolio_ids_with_role(min_role)  the same for portfolios (has_portfolio_role).
--
-- Both are STABLE SECURITY DEFINER, about the caller only, and called as (select …) with a constant role,
-- so each is an InitPlan: computed once per statement. The policies change like this:
--
--   has_project_role(x, 'r')       ->  x = any ((select project_ids_with_role('r'))::uuid[])      (the same boolean)
--   has_portfolio_role(x, 'r')     ->  x = any ((select portfolio_ids_with_role('r'))::uuid[])    (the same boolean)
--   rule_has_role(x, 'viewer')     ->  x = any ((select viewer_rule_ids())::uuid[])                (batch 18's set)
--   custom_field_has_role(x, 'r')  ->  exists (custom_fields cf where cf.id = x and cf.project_id in r's set)
--                                      (custom_fields' own read policy is r's superset, so the same boolean)
--   has_task_role(x, 'r')          ->  exists (an active task_projects row of x in a project of r's set)
--                                      or has_task_role(x, 'r')
--
-- has_task_role keeps its exact rule (a subtask through its top-level task, the home project, a private
-- task's creator and assignee) as the last word; the indexed membership check in front of it answers
-- first for every top-level task in a project the caller can read, so the definer call only runs for
-- subtasks, private tasks, and rows the caller can't read. The check only says yes where has_task_role
-- does: a top-level task's own active membership in a project of r's set is one has_task_role counts,
-- and only top-level tasks have active memberships — task_projects_05_no_subtasks already refused adding
-- a subtask to a project, and now also refuses bringing back a removed membership of a task that has
-- since become a subtask (section 2). Policies on task_projects keep has_task_role alone (a policy can't
-- read its own table). A second check for subtasks (through tasks' own policy) was tried and left out:
-- it made every plan with it much larger, and a task pane read (a re-planned SQL function) 16 ms
-- instead of 8 ms, more than it saved.
--
-- Not changed (small tables, or a different rule): team policies (can_read_team, can_view_team,
-- can_manage_team, …), goals, email designs, Storage policies, profile_can_read_task (about another
-- person). Identical answers are checked by suite zz53 for every rewritten policy, against the old
-- expressions, for every row and a range of people.

-- =================================================================================================
-- 1. The caller's projects and portfolios at a role, once per statement
-- =================================================================================================

create or replace function public.project_ids_with_role(min_role text)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  -- has_project_role(p, min_role) = a known role, allowlisted, and the caller's active membership of p
  -- at that role or above (an archived project counts every member as Viewer). Only the caller's rows.
  select coalesce(array_agg(m.project_id), '{}'::uuid[])
  from public.project_members m
  where m.profile_id = auth.uid()
    and m.deleted_at is null
    and public.project_role_rank(min_role) > 0
    and public.project_role_rank(
          case when exists (
              select 1 from public.projects ap where ap.id = m.project_id and ap.archived_at is not null
            ) then 'viewer' else m.role end
        ) >= public.project_role_rank(min_role)
    and public.is_allowlisted();
$$;

comment on function public.project_ids_with_role(text) is
  'Nov 4 notes (batch 23): the projects where has_project_role(project, min_role) is true for the caller, for policies evaluated once per statement.';

select public.alhc_revoke_anon_execute(array['project_ids_with_role(text)']);
revoke all on function public.project_ids_with_role(text) from public, anon;
grant execute on function public.project_ids_with_role(text) to authenticated;

create or replace function public.portfolio_ids_with_role(min_role text)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  -- has_portfolio_role(p, min_role) = a known role, allowlisted, and the caller's active membership of p
  -- at that role or above. Only the caller's rows.
  select coalesce(array_agg(m.portfolio_id), '{}'::uuid[])
  from public.portfolio_members m
  where m.profile_id = auth.uid()
    and m.deleted_at is null
    and public.portfolio_role_rank(min_role) > 0
    and public.portfolio_role_rank(m.role) >= public.portfolio_role_rank(min_role)
    and public.is_allowlisted();
$$;

comment on function public.portfolio_ids_with_role(text) is
  'Nov 4 notes (batch 23): the portfolios where has_portfolio_role(portfolio, min_role) is true for the caller, for policies evaluated once per statement.';

select public.alhc_revoke_anon_execute(array['portfolio_ids_with_role(text)']);
revoke all on function public.portfolio_ids_with_role(text) from public, anon;
grant execute on function public.portfolio_ids_with_role(text) to authenticated;

-- =================================================================================================
-- 2. Only top-level tasks have active memberships (what the task check in the policies relies on)
-- =================================================================================================

-- Same function, plus: bringing back a removed membership is refused when the task is now a subtask
-- (converting a task to a subtask removes its memberships; nothing may make them active again).
create or replace function public.guard_task_project_subtask()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and not (old.deleted_at is not null and new.deleted_at is null) then
    return new;
  end if;
  if exists (select 1 from public.tasks t where t.id = new.task_id and t.parent_task_id is not null) then
    raise exception 'Subtasks belong to their parent task’s projects; they can’t be added to a project'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace trigger task_projects_05_no_subtasks
  before insert or update of deleted_at on public.task_projects
  for each row execute function public.guard_task_project_subtask();

-- =================================================================================================
-- 3. Indexes for the new checks (index-only: the caller's memberships, a task's active projects)
-- =================================================================================================

create index if not exists project_members_profile_role_idx
  on public.project_members (profile_id) include (project_id, role) where deleted_at is null;
create index if not exists portfolio_members_profile_role_idx
  on public.portfolio_members (profile_id) include (portfolio_id, role) where deleted_at is null;
create index if not exists task_projects_task_project_active_idx
  on public.task_projects (task_id) include (project_id) where deleted_at is null;

-- =================================================================================================
-- 4. The policies (generated from the live definitions; only the helper calls change)
-- =================================================================================================

alter policy approval_requests_select_viewer on public.approval_requests
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = approval_requests.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(approval_requests.task_id, 'viewer'::text))));

alter policy approval_rounds_select_viewer on public.approval_rounds
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = approval_rounds.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(approval_rounds.task_id, 'viewer'::text))));

alter policy calendar_events_insert_editor on public.calendar_events
  with check (((created_by = ( SELECT auth.uid() AS uid)) AND (((project_id IS NOT NULL) AND (calendar_events.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[]))) OR ((team_id IS NOT NULL) AND ( SELECT public.can_post_team_message(calendar_events.team_id) AS can_post_team_message)))));

alter policy calendar_events_select_reader on public.calendar_events
  using ((((project_id IS NOT NULL) AND (calendar_events.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))) OR ((team_id IS NOT NULL) AND ( SELECT public.can_read_team(calendar_events.team_id) AS can_read_team))));

alter policy calendar_events_update_editor on public.calendar_events
  using ((((project_id IS NOT NULL) AND (calendar_events.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[]))) OR ((team_id IS NOT NULL) AND ( SELECT public.can_post_team_message(calendar_events.team_id) AS can_post_team_message))))
  with check ((((project_id IS NOT NULL) AND (calendar_events.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[]))) OR ((team_id IS NOT NULL) AND ( SELECT public.can_post_team_message(calendar_events.team_id) AS can_post_team_message))));

alter policy comment_mentions_select_viewer on public.comment_mentions
  using ((EXISTS ( SELECT 1
   FROM public.comments c
  WHERE ((c.id = comment_mentions.comment_id) AND ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = c.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(c.task_id, 'viewer'::text)))))));

alter policy comment_pin_events_select_viewer on public.comment_pin_events
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = comment_pin_events.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(comment_pin_events.task_id, 'viewer'::text))));

alter policy comment_reactions_insert_own_commenter on public.comment_reactions
  with check (((profile_id = ( SELECT auth.uid() AS uid)) AND ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = comment_reactions.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('commenter'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(comment_reactions.task_id, 'commenter'::text))) AND (EXISTS ( SELECT 1
   FROM public.comments c
  WHERE ((c.id = comment_reactions.comment_id) AND (c.task_id = comment_reactions.task_id) AND (c.deleted_at IS NULL))))));

alter policy comment_reactions_select_viewer on public.comment_reactions
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = comment_reactions.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(comment_reactions.task_id, 'viewer'::text))));

alter policy comment_reactions_update_own_commenter on public.comment_reactions
  using (((profile_id = ( SELECT auth.uid() AS uid)) AND ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = comment_reactions.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('commenter'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(comment_reactions.task_id, 'commenter'::text)))))
  with check (((profile_id = ( SELECT auth.uid() AS uid)) AND ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = comment_reactions.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('commenter'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(comment_reactions.task_id, 'commenter'::text)))));

alter policy comments_insert_own_commenter on public.comments
  with check (((author_id = ( SELECT auth.uid() AS uid)) AND ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = comments.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('commenter'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(comments.task_id, 'commenter'::text)))));

alter policy comments_select_viewer on public.comments
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = comments.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(comments.task_id, 'viewer'::text))));

alter policy comments_update_own_commenter on public.comments
  using (((author_id = ( SELECT auth.uid() AS uid)) AND ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = comments.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('commenter'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(comments.task_id, 'commenter'::text)))))
  with check (((author_id = ( SELECT auth.uid() AS uid)) AND ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = comments.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('commenter'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(comments.task_id, 'commenter'::text)))));

alter policy custom_fields_insert_editor on public.custom_fields
  with check ((custom_fields.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])));

alter policy custom_fields_select_viewer on public.custom_fields
  using ((custom_fields.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])));

alter policy custom_fields_update_editor on public.custom_fields
  using ((custom_fields.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])))
  with check ((custom_fields.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])));

alter policy dashboard_widgets_insert_editor on public.dashboard_widgets
  with check ((dashboard_widgets.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])));

alter policy dashboard_widgets_select_viewer on public.dashboard_widgets
  using ((dashboard_widgets.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])));

alter policy dashboard_widgets_update_editor on public.dashboard_widgets
  using ((dashboard_widgets.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])))
  with check ((dashboard_widgets.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])));

alter policy email_designs_select_reader on public.email_designs
  using (CASE
    WHEN (project_id IS NULL) THEN ( SELECT public.is_allowlisted() AS is_allowlisted)
    ELSE (email_designs.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))
END);

alter policy email_outbox_select_viewer on public.email_outbox
  using ((((task_id IS NOT NULL) AND ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = email_outbox.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(email_outbox.task_id, 'viewer'::text)))) OR ((task_id IS NULL) AND ((payload ->> 'kind'::text) = 'invite'::text) AND (NOT (payload ? 'pending_id'::text)) AND ( SELECT public.is_workspace_admin() AS is_workspace_admin)) OR ((task_id IS NULL) AND ((payload ->> 'kind'::text) = 'invite'::text) AND (payload ? 'pending_id'::text) AND ( SELECT public.can_manage_pending_invite((email_outbox.payload ->> 'pending_id'::text)) AS can_manage_pending_invite))));

alter policy form_submissions_select_viewer on public.form_submissions
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = form_submissions.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(form_submissions.task_id, 'viewer'::text))));

alter policy forms_insert_admin on public.forms
  with check ((forms.project_id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[])));

alter policy forms_select_viewer on public.forms
  using ((forms.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])));

alter policy forms_update_admin on public.forms
  using ((forms.project_id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[])))
  with check ((forms.project_id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[])));

alter policy goal_links_insert_editor on public.goal_links
  with check ((( SELECT public.can_edit_goal(goal_links.goal_id) AS can_edit_goal) AND ((project_id IS NULL) OR (goal_links.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))) AND ((portfolio_id IS NULL) OR (goal_links.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('viewer'::text))::uuid[])))));

alter policy goal_links_select_viewer on public.goal_links
  using ((( SELECT public.is_allowlisted() AS is_allowlisted) AND ((project_id IS NULL) OR (goal_links.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))) AND ((portfolio_id IS NULL) OR (goal_links.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('viewer'::text))::uuid[])))));

alter policy import_external_ids_select_admin on public.import_external_ids
  using ((import_external_ids.project_id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[])));

alter policy import_runs_select_admin_or_workspace_admin on public.import_runs
  using (((import_runs.project_id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[])) OR ((import_runs.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])) AND (EXISTS ( SELECT 1
   FROM public.projects p
  WHERE ((p.id = import_runs.project_id) AND (p.deleted_at IS NULL) AND ( SELECT public.is_workspace_admin(p.workspace_id) AS is_workspace_admin)))))));

alter policy inbound_calls_select_admin on public.inbound_calls
  using ((inbound_calls.project_id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[])));

alter policy inbound_endpoints_insert_admin on public.inbound_endpoints
  with check (((inbound_endpoints.project_id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[])) AND (created_by = ( SELECT auth.uid() AS uid))));

alter policy inbound_endpoints_select_admin on public.inbound_endpoints
  using ((inbound_endpoints.project_id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[])));

alter policy inbound_endpoints_update_admin on public.inbound_endpoints
  using ((inbound_endpoints.project_id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[])))
  with check ((inbound_endpoints.project_id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[])));

alter policy inbox_items_select_own_viewer on public.inbox_items
  using (((recipient_id = ( SELECT auth.uid() AS uid)) AND (((task_id IS NOT NULL) AND ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = inbox_items.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(inbox_items.task_id, 'viewer'::text)))) OR ((task_id IS NULL) AND (EXISTS ( SELECT 1
   FROM public.project_messages m
  WHERE ((m.id = inbox_items.message_id) AND (m.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])))))) OR ((task_id IS NULL) AND (EXISTS ( SELECT 1
   FROM public.team_messages m
  WHERE ((m.id = inbox_items.team_message_id) AND ( SELECT public.can_read_team(m.team_id) AS can_read_team))))) OR ((task_id IS NULL) AND (EXISTS ( SELECT 1
   FROM public.project_status_updates u
  WHERE ((u.id = inbox_items.status_update_id) AND (u.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])))))) OR ((task_id IS NULL) AND (project_id IS NOT NULL) AND (inbox_items.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))))));

alter policy inbox_items_update_own_viewer on public.inbox_items
  using (((recipient_id = ( SELECT auth.uid() AS uid)) AND (((task_id IS NOT NULL) AND ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = inbox_items.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(inbox_items.task_id, 'viewer'::text)))) OR ((task_id IS NULL) AND (EXISTS ( SELECT 1
   FROM public.project_messages m
  WHERE ((m.id = inbox_items.message_id) AND (m.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])))))) OR ((task_id IS NULL) AND (EXISTS ( SELECT 1
   FROM public.team_messages m
  WHERE ((m.id = inbox_items.team_message_id) AND ( SELECT public.can_read_team(m.team_id) AS can_read_team))))) OR ((task_id IS NULL) AND (EXISTS ( SELECT 1
   FROM public.project_status_updates u
  WHERE ((u.id = inbox_items.status_update_id) AND (u.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])))))) OR ((task_id IS NULL) AND (project_id IS NOT NULL) AND (inbox_items.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))))))
  with check (((recipient_id = ( SELECT auth.uid() AS uid)) AND (((task_id IS NOT NULL) AND ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = inbox_items.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(inbox_items.task_id, 'viewer'::text)))) OR ((task_id IS NULL) AND (EXISTS ( SELECT 1
   FROM public.project_messages m
  WHERE ((m.id = inbox_items.message_id) AND (m.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])))))) OR ((task_id IS NULL) AND (EXISTS ( SELECT 1
   FROM public.team_messages m
  WHERE ((m.id = inbox_items.team_message_id) AND ( SELECT public.can_read_team(m.team_id) AS can_read_team))))) OR ((task_id IS NULL) AND (EXISTS ( SELECT 1
   FROM public.project_status_updates u
  WHERE ((u.id = inbox_items.status_update_id) AND (u.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])))))) OR ((task_id IS NULL) AND (project_id IS NOT NULL) AND (inbox_items.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))))));

alter policy list_collapsed_groups_insert_own_viewer on public.list_collapsed_groups
  with check (((profile_id = ( SELECT auth.uid() AS uid)) AND (list_collapsed_groups.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))));

alter policy list_collapsed_groups_update_own_viewer on public.list_collapsed_groups
  using ((profile_id = ( SELECT auth.uid() AS uid)))
  with check (((profile_id = ( SELECT auth.uid() AS uid)) AND (list_collapsed_groups.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))));

alter policy list_column_widths_insert_own_viewer on public.list_column_widths
  with check (((profile_id = ( SELECT auth.uid() AS uid)) AND (list_column_widths.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))));

alter policy list_column_widths_update_own_viewer on public.list_column_widths
  using ((profile_id = ( SELECT auth.uid() AS uid)))
  with check (((profile_id = ( SELECT auth.uid() AS uid)) AND (list_column_widths.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))));

alter policy my_task_placements_insert_own_viewer on public.my_task_placements
  with check (((profile_id = ( SELECT auth.uid() AS uid)) AND ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = my_task_placements.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(my_task_placements.task_id, 'viewer'::text))) AND (EXISTS ( SELECT 1
   FROM public.my_task_sections s
  WHERE ((s.id = my_task_placements.section_id) AND (s.profile_id = ( SELECT auth.uid() AS uid)) AND (s.deleted_at IS NULL))))));

alter policy pending_memberships_select_viewer on public.pending_memberships
  using ((((project_id IS NOT NULL) AND (pending_memberships.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))) OR ((portfolio_id IS NOT NULL) AND (pending_memberships.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('viewer'::text))::uuid[]))) OR ((team_id IS NOT NULL) AND ( SELECT public.can_view_team(pending_memberships.team_id) AS can_view_team))));

alter policy pending_memberships_update_admin on public.pending_memberships
  using ((((project_id IS NOT NULL) AND (pending_memberships.project_id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[]))) OR ((portfolio_id IS NOT NULL) AND (pending_memberships.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('admin'::text))::uuid[]))) OR ((team_id IS NOT NULL) AND ( SELECT public.can_manage_team(pending_memberships.team_id) AS can_manage_team))))
  with check ((((project_id IS NOT NULL) AND (pending_memberships.project_id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[]))) OR ((portfolio_id IS NOT NULL) AND (pending_memberships.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('admin'::text))::uuid[]))) OR ((team_id IS NOT NULL) AND ( SELECT public.can_manage_team(pending_memberships.team_id) AS can_manage_team))));

alter policy portfolio_children_insert_editor on public.portfolio_children
  with check (((portfolio_children.parent_id = ANY ((SELECT public.portfolio_ids_with_role('editor'::text))::uuid[])) AND (portfolio_children.child_id = ANY ((SELECT public.portfolio_ids_with_role('viewer'::text))::uuid[]))));

alter policy portfolio_children_select_viewer on public.portfolio_children
  using (((portfolio_children.parent_id = ANY ((SELECT public.portfolio_ids_with_role('viewer'::text))::uuid[])) AND (portfolio_children.child_id = ANY ((SELECT public.portfolio_ids_with_role('viewer'::text))::uuid[]))));

alter policy portfolio_children_update_editor on public.portfolio_children
  using ((portfolio_children.parent_id = ANY ((SELECT public.portfolio_ids_with_role('editor'::text))::uuid[])))
  with check ((portfolio_children.parent_id = ANY ((SELECT public.portfolio_ids_with_role('editor'::text))::uuid[])));

alter policy portfolio_field_values_insert_editor on public.portfolio_field_values
  with check (((portfolio_field_values.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('editor'::text))::uuid[])) AND (portfolio_field_values.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))));

alter policy portfolio_field_values_select_viewer on public.portfolio_field_values
  using (((portfolio_field_values.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('viewer'::text))::uuid[])) AND (portfolio_field_values.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))));

alter policy portfolio_field_values_update_editor on public.portfolio_field_values
  using (((portfolio_field_values.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('editor'::text))::uuid[])) AND (portfolio_field_values.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))))
  with check (((portfolio_field_values.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('editor'::text))::uuid[])) AND (portfolio_field_values.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))));

alter policy portfolio_fields_insert_editor on public.portfolio_fields
  with check ((portfolio_fields.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('editor'::text))::uuid[])));

alter policy portfolio_fields_select_viewer on public.portfolio_fields
  using ((portfolio_fields.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('viewer'::text))::uuid[])));

alter policy portfolio_fields_update_editor on public.portfolio_fields
  using ((portfolio_fields.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('editor'::text))::uuid[])))
  with check ((portfolio_fields.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('editor'::text))::uuid[])));

alter policy portfolio_members_select_viewer on public.portfolio_members
  using ((portfolio_members.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('viewer'::text))::uuid[])));

alter policy portfolio_projects_select_viewer on public.portfolio_projects
  using (((portfolio_projects.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('viewer'::text))::uuid[])) AND (portfolio_projects.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))));

alter policy portfolio_rule_runs_select_viewer on public.portfolio_rule_runs
  using (((portfolio_rule_runs.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('viewer'::text))::uuid[])) AND ((project_id IS NULL) OR (portfolio_rule_runs.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])))));

alter policy portfolio_rules_insert_admin on public.portfolio_rules
  with check (((created_by = ( SELECT auth.uid() AS uid)) AND (portfolio_rules.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('admin'::text))::uuid[]))));

alter policy portfolio_rules_select_viewer on public.portfolio_rules
  using ((portfolio_rules.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('viewer'::text))::uuid[])));

alter policy portfolio_rules_update_admin on public.portfolio_rules
  using ((portfolio_rules.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('admin'::text))::uuid[])))
  with check ((portfolio_rules.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('admin'::text))::uuid[])));

alter policy portfolios_select_viewer on public.portfolios
  using (((portfolios.id = ANY ((SELECT public.portfolio_ids_with_role('viewer'::text))::uuid[])) OR ((created_by = ( SELECT auth.uid() AS uid)) AND (created_at = now()) AND ( SELECT public.is_allowlisted() AS is_allowlisted))));

alter policy portfolios_update_editor on public.portfolios
  using ((portfolios.id = ANY ((SELECT public.portfolio_ids_with_role('editor'::text))::uuid[])))
  with check ((portfolios.id = ANY ((SELECT public.portfolio_ids_with_role('editor'::text))::uuid[])));

alter policy project_access_requests_select_own_or_admin on public.project_access_requests
  using ((( SELECT public.is_allowlisted() AS is_allowlisted) AND ((requester_id = ( SELECT auth.uid() AS uid)) OR (project_access_requests.project_id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[])))));

alter policy project_members_select_viewer on public.project_members
  using ((project_members.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])));

alter policy project_message_mentions_select_viewer on public.project_message_mentions
  using ((EXISTS ( SELECT 1
   FROM public.project_messages m
  WHERE ((m.id = project_message_mentions.message_id) AND (m.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))))));

alter policy project_message_reactions_insert_own_commenter on public.project_message_reactions
  with check (((profile_id = ( SELECT auth.uid() AS uid)) AND (project_message_reactions.project_id = ANY ((SELECT public.project_ids_with_role('commenter'::text))::uuid[])) AND (EXISTS ( SELECT 1
   FROM public.project_messages m
  WHERE ((m.id = project_message_reactions.message_id) AND (m.project_id = project_message_reactions.project_id) AND (m.deleted_at IS NULL))))));

alter policy project_message_reactions_select_viewer on public.project_message_reactions
  using ((project_message_reactions.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])));

alter policy project_message_reactions_update_own_commenter on public.project_message_reactions
  using (((profile_id = ( SELECT auth.uid() AS uid)) AND (project_message_reactions.project_id = ANY ((SELECT public.project_ids_with_role('commenter'::text))::uuid[]))))
  with check (((profile_id = ( SELECT auth.uid() AS uid)) AND (project_message_reactions.project_id = ANY ((SELECT public.project_ids_with_role('commenter'::text))::uuid[]))));

alter policy project_messages_insert_own_commenter on public.project_messages
  with check (((author_id = ( SELECT auth.uid() AS uid)) AND (project_messages.project_id = ANY ((SELECT public.project_ids_with_role('commenter'::text))::uuid[]))));

alter policy project_messages_select_viewer on public.project_messages
  using ((project_messages.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])));

alter policy project_messages_update_own_commenter on public.project_messages
  using (((author_id = ( SELECT auth.uid() AS uid)) AND (project_messages.project_id = ANY ((SELECT public.project_ids_with_role('commenter'::text))::uuid[]))))
  with check (((author_id = ( SELECT auth.uid() AS uid)) AND (project_messages.project_id = ANY ((SELECT public.project_ids_with_role('commenter'::text))::uuid[]))));

alter policy project_person_settings_insert_own_viewer on public.project_person_settings
  with check (((profile_id = ( SELECT auth.uid() AS uid)) AND (project_person_settings.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))));

alter policy project_person_settings_update_own_viewer on public.project_person_settings
  using ((profile_id = ( SELECT auth.uid() AS uid)))
  with check (((profile_id = ( SELECT auth.uid() AS uid)) AND (project_person_settings.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))));

alter policy project_roles_insert_editor on public.project_roles
  with check ((project_roles.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])));

alter policy project_roles_select_viewer on public.project_roles
  using ((project_roles.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])));

alter policy project_roles_update_editor on public.project_roles
  using ((project_roles.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])))
  with check ((project_roles.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])));

alter policy project_stars_insert_own_viewer on public.project_stars
  with check (((profile_id = ( SELECT auth.uid() AS uid)) AND (project_stars.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))));

alter policy project_stars_update_own on public.project_stars
  using ((profile_id = ( SELECT auth.uid() AS uid)))
  with check (((profile_id = ( SELECT auth.uid() AS uid)) AND ((deleted_at IS NOT NULL) OR (project_stars.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])))));

alter policy project_status_templates_insert_editor on public.project_status_templates
  with check (((project_status_templates.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])) AND (created_by = ( SELECT auth.uid() AS uid))));

alter policy project_status_templates_select_viewer on public.project_status_templates
  using ((project_status_templates.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])));

alter policy project_status_templates_update_editor on public.project_status_templates
  using ((project_status_templates.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])))
  with check ((project_status_templates.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])));

alter policy project_status_updates_select_viewer on public.project_status_updates
  using ((project_status_updates.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])));

alter policy project_stories_select_viewer on public.project_stories
  using ((project_stories.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])));

alter policy project_view_personal_configs_insert_own_viewer on public.project_view_personal_configs
  with check (((profile_id = ( SELECT auth.uid() AS uid)) AND (project_view_personal_configs.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))));

alter policy project_view_personal_configs_update_own_viewer on public.project_view_personal_configs
  using ((profile_id = ( SELECT auth.uid() AS uid)))
  with check (((profile_id = ( SELECT auth.uid() AS uid)) AND (project_view_personal_configs.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))));

alter policy project_view_settings_insert_editor on public.project_view_settings
  with check ((project_view_settings.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])));

alter policy project_view_settings_select_viewer on public.project_view_settings
  using ((project_view_settings.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])));

alter policy project_view_settings_update_editor on public.project_view_settings
  using ((project_view_settings.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])))
  with check ((project_view_settings.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])));

alter policy project_views_insert_editor on public.project_views
  with check ((((owner_id IS NULL) AND (project_views.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[]))) OR ((owner_id = ( SELECT auth.uid() AS uid)) AND (project_views.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])))));

alter policy project_views_select_viewer on public.project_views
  using (((project_views.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])) AND ((owner_id IS NULL) OR (owner_id = ( SELECT auth.uid() AS uid)))));

alter policy project_views_update_editor on public.project_views
  using ((((owner_id IS NULL) AND (project_views.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[]))) OR ((owner_id = ( SELECT auth.uid() AS uid)) AND (project_views.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])))))
  with check ((((owner_id IS NULL) AND (project_views.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[]))) OR ((owner_id = ( SELECT auth.uid() AS uid)) AND (project_views.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])))));

alter policy projects_select_viewer on public.projects
  using (((projects.id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])) OR ((created_by = ( SELECT auth.uid() AS uid)) AND (created_at = now()) AND ( SELECT public.is_allowlisted() AS is_allowlisted))));

alter policy projects_update_admin on public.projects
  using ((projects.id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[])))
  with check ((projects.id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[])));

alter policy request_counters_select_viewer on public.request_counters
  using ((request_counters.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])));

alter policy request_number_gaps_select_viewer on public.request_number_gaps
  using ((request_number_gaps.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])));

alter policy request_sequences_insert_admin on public.request_sequences
  with check ((request_sequences.project_id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[])));

alter policy request_sequences_select_viewer on public.request_sequences
  using ((request_sequences.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])));

alter policy request_sequences_update_admin on public.request_sequences
  using ((request_sequences.project_id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[])))
  with check ((request_sequences.project_id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[])));

alter policy review_check_assets_select_viewer on public.review_check_assets
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = review_check_assets.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(review_check_assets.task_id, 'viewer'::text))));

alter policy review_check_files_select_viewer on public.review_check_files
  using (((status = 'ready'::text) AND ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = review_check_files.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(review_check_files.task_id, 'viewer'::text)))));

alter policy review_check_pins_select_viewer on public.review_check_pins
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = review_check_pins.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(review_check_pins.task_id, 'viewer'::text))));

alter policy review_checks_select_viewer on public.review_checks
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = review_checks.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(review_checks.task_id, 'viewer'::text))));

alter policy rules_insert_admin on public.rules
  with check ((rules.project_id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[])));

alter policy rules_select_viewer on public.rules
  using ((rules.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])));

alter policy rules_update_admin on public.rules
  using ((rules.project_id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[])))
  with check ((rules.project_id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[])));

alter policy scheduled_rule_actions_select_viewer on public.scheduled_rule_actions
  using ((scheduled_rule_actions.rule_id = ANY ((SELECT public.viewer_rule_ids())::uuid[])));

alter policy sections_insert_editor on public.sections
  with check ((sections.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])));

alter policy sections_select_viewer on public.sections
  using ((sections.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])));

alter policy sections_update_editor on public.sections
  using ((sections.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])))
  with check ((sections.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])));

alter policy sidebar_folder_projects_insert_own_viewer on public.sidebar_folder_projects
  with check (((profile_id = ( SELECT auth.uid() AS uid)) AND ( SELECT public.is_allowlisted() AS is_allowlisted) AND (sidebar_folder_projects.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))));

alter policy subtasks_insert_editor on public.subtasks
  with check (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = subtasks.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('editor'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(subtasks.task_id, 'editor'::text))));

alter policy subtasks_select_viewer on public.subtasks
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = subtasks.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(subtasks.task_id, 'viewer'::text))));

alter policy subtasks_update_editor on public.subtasks
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = subtasks.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('editor'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(subtasks.task_id, 'editor'::text))))
  with check (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = subtasks.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('editor'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(subtasks.task_id, 'editor'::text))));

alter policy task_approval_settings_select_viewer on public.task_approval_settings
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_approval_settings.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_approval_settings.task_id, 'viewer'::text))));

alter policy task_approvers_select_viewer on public.task_approvers
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_approvers.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_approvers.task_id, 'viewer'::text))));

alter policy task_attachment_links_insert_editor on public.task_attachment_links
  with check (((source = 'duplicate'::text) AND (deleted_at IS NULL) AND ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_attachment_links.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('editor'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_attachment_links.task_id, 'editor'::text))) AND ((attachment_id IS NULL) OR (EXISTS ( SELECT 1
   FROM public.task_attachments a
  WHERE ((a.id = task_attachment_links.attachment_id) AND (a.deleted_at IS NULL)))))));

alter policy task_attachment_links_select_viewer on public.task_attachment_links
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_attachment_links.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_attachment_links.task_id, 'viewer'::text))));

alter policy task_attachments_insert_own_editor on public.task_attachments
  with check (((uploaded_by = ( SELECT auth.uid() AS uid)) AND ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_attachments.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('editor'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_attachments.task_id, 'editor'::text)))));

alter policy task_attachments_select_viewer on public.task_attachments
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_attachments.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_attachments.task_id, 'viewer'::text))));

alter policy task_attachments_update_editor on public.task_attachments
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_attachments.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('editor'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_attachments.task_id, 'editor'::text))))
  with check (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_attachments.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('editor'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_attachments.task_id, 'editor'::text))));

alter policy task_dependencies_select_viewer on public.task_dependencies
  using ((((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_dependencies.predecessor_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_dependencies.predecessor_id, 'viewer'::text))) AND ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_dependencies.successor_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_dependencies.successor_id, 'viewer'::text)))));

alter policy task_email_activity_select_viewer on public.task_email_activity
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_email_activity.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_email_activity.task_id, 'viewer'::text))));

alter policy task_field_values_insert_editor on public.task_field_values
  with check ((EXISTS (SELECT 1 FROM public.custom_fields cf_rls WHERE ((cf_rls.id = task_field_values.field_id) AND (cf_rls.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[]))))));

alter policy task_field_values_select_viewer on public.task_field_values
  using ((EXISTS (SELECT 1 FROM public.custom_fields cf_rls WHERE ((cf_rls.id = task_field_values.field_id) AND (cf_rls.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))))));

alter policy task_field_values_update_editor on public.task_field_values
  using ((EXISTS (SELECT 1 FROM public.custom_fields cf_rls WHERE ((cf_rls.id = task_field_values.field_id) AND (cf_rls.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[]))))))
  with check ((EXISTS (SELECT 1 FROM public.custom_fields cf_rls WHERE ((cf_rls.id = task_field_values.field_id) AND (cf_rls.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[]))))));

alter policy task_followers_insert_commenter on public.task_followers
  with check ((((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_followers.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('commenter'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_followers.task_id, 'commenter'::text))) AND (((deleted_at IS NULL) AND public.profile_can_read_task(profile_id, task_id)) OR ((deleted_at IS NOT NULL) AND ((profile_id = ( SELECT auth.uid() AS uid)) OR ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_followers.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('editor'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_followers.task_id, 'editor'::text))))))));

alter policy task_followers_select_viewer on public.task_followers
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_followers.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_followers.task_id, 'viewer'::text))));

alter policy task_followers_update_commenter on public.task_followers
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_followers.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('commenter'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_followers.task_id, 'commenter'::text))))
  with check ((((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_followers.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('commenter'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_followers.task_id, 'commenter'::text))) AND (((deleted_at IS NULL) AND public.profile_can_read_task(profile_id, task_id)) OR ((deleted_at IS NOT NULL) AND ((profile_id = ( SELECT auth.uid() AS uid)) OR ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_followers.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('editor'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_followers.task_id, 'editor'::text))))))));

alter policy task_likes_insert_own_commenter on public.task_likes
  with check (((profile_id = ( SELECT auth.uid() AS uid)) AND ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_likes.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('commenter'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_likes.task_id, 'commenter'::text)))));

alter policy task_likes_select_viewer on public.task_likes
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_likes.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_likes.task_id, 'viewer'::text))));

alter policy task_likes_update_own_commenter on public.task_likes
  using (((profile_id = ( SELECT auth.uid() AS uid)) AND ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_likes.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('commenter'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_likes.task_id, 'commenter'::text)))))
  with check (((profile_id = ( SELECT auth.uid() AS uid)) AND ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_likes.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('commenter'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_likes.task_id, 'commenter'::text)))));

alter policy task_project_numbers_select_viewer on public.task_project_numbers
  using (((task_project_numbers.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])) AND ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_project_numbers.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_project_numbers.task_id, 'viewer'::text)))));

alter policy task_projects_insert_editor on public.task_projects
  with check (((task_projects.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])) AND ( SELECT public.has_task_role(task_projects.task_id, 'editor'::text) AS has_task_role)));

alter policy task_projects_update_editor on public.task_projects
  using ((task_projects.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])))
  with check ((task_projects.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])));

alter policy task_role_links_insert_editor on public.task_role_links
  with check (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_role_links.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('editor'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_role_links.task_id, 'editor'::text))));

alter policy task_role_links_select_viewer on public.task_role_links
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_role_links.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_role_links.task_id, 'viewer'::text))));

alter policy task_role_links_update_editor on public.task_role_links
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_role_links.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('editor'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_role_links.task_id, 'editor'::text))))
  with check (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_role_links.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('editor'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_role_links.task_id, 'editor'::text))));

alter policy task_stories_select_viewer on public.task_stories
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_stories.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_stories.task_id, 'viewer'::text))));

alter policy task_tags_insert_editor on public.task_tags
  with check (((created_by = ( SELECT auth.uid() AS uid)) AND ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_tags.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('editor'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_tags.task_id, 'editor'::text)))));

alter policy task_tags_select_viewer on public.task_tags
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_tags.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_tags.task_id, 'viewer'::text))));

alter policy task_tags_update_editor on public.task_tags
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_tags.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('editor'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_tags.task_id, 'editor'::text))))
  with check (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = task_tags.task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('editor'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(task_tags.task_id, 'editor'::text))));

alter policy task_templates_insert_editor on public.task_templates
  with check ((task_templates.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])));

alter policy task_templates_select_viewer on public.task_templates
  using ((task_templates.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])));

alter policy task_templates_update_editor on public.task_templates
  using ((task_templates.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])))
  with check ((task_templates.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])));

alter policy tasks_insert_editor on public.tasks
  with check (CASE
    WHEN (parent_task_id IS NOT NULL) THEN ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = tasks.root_task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('editor'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(tasks.root_task_id, 'editor'::text)))
    WHEN (home_project_id IS NULL) THEN ((created_by = ( SELECT auth.uid() AS uid)) AND ( SELECT public.is_allowlisted() AS is_allowlisted))
    ELSE (tasks.home_project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[]))
END);

alter policy tasks_select_viewer on public.tasks
  using (CASE
    WHEN (root_task_id IS NOT NULL) THEN ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = tasks.root_task_id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY ((CASE
                WHEN (tasks.deleted_at IS NULL) THEN (SELECT public.project_ids_with_role('viewer'::text))
                ELSE (SELECT public.project_ids_with_role('editor'::text))
            END)::uuid[]))))) OR ( SELECT public.has_task_role(tasks.root_task_id, CASE
                WHEN (tasks.deleted_at IS NULL) THEN 'viewer'::text
                ELSE 'editor'::text
            END)))
    WHEN (home_project_id IS NULL) THEN (((( SELECT auth.uid() AS uid) = created_by) OR (( SELECT auth.uid() AS uid) = assignee_id)) AND ( SELECT public.is_allowlisted() AS is_allowlisted))
    WHEN (deleted_at IS NULL) THEN ((home_project_id = ANY (( SELECT public.viewer_project_ids() AS viewer_project_ids)::uuid[])) OR ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = tasks.id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('viewer'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(tasks.id, 'viewer'::text))))
    ELSE ((tasks.home_project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[])) OR ((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = tasks.id) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('editor'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(tasks.id, 'editor'::text))))
END);

alter policy tasks_update_editor on public.tasks
  using (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = COALESCE(tasks.root_task_id, tasks.id)) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('editor'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(COALESCE(tasks.root_task_id, tasks.id), 'editor'::text))))
  with check (((EXISTS (SELECT 1 FROM public.task_projects tp_rls WHERE ((tp_rls.task_id = COALESCE(tasks.root_task_id, tasks.id)) AND (tp_rls.deleted_at IS NULL) AND (tp_rls.project_id = ANY (((SELECT public.project_ids_with_role('editor'::text)))::uuid[]))))) OR ( SELECT public.has_task_role(COALESCE(tasks.root_task_id, tasks.id), 'editor'::text))));

alter policy team_curated_work_insert_curator on public.team_curated_work
  with check (((created_by = ( SELECT auth.uid() AS uid)) AND ( SELECT public.can_curate_team(team_curated_work.team_id) AS can_curate_team) AND (((project_id IS NOT NULL) AND (team_curated_work.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))) OR ((portfolio_id IS NOT NULL) AND (team_curated_work.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('viewer'::text))::uuid[]))))));

alter policy team_curated_work_select_viewer on public.team_curated_work
  using ((( SELECT public.can_view_team(team_curated_work.team_id) AS can_view_team) AND (((project_id IS NOT NULL) AND (team_curated_work.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))) OR ((portfolio_id IS NOT NULL) AND (team_curated_work.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('viewer'::text))::uuid[]))))));

alter policy team_projects_insert_admin on public.team_projects
  with check ((team_projects.project_id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[])));

alter policy team_projects_select_viewer on public.team_projects
  using ((team_projects.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[])));

alter policy team_projects_update_admin on public.team_projects
  using ((team_projects.project_id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[])))
  with check ((team_projects.project_id = ANY ((SELECT public.project_ids_with_role('admin'::text))::uuid[])));

alter policy workload_capacities_insert_editor on public.workload_capacities
  with check ((((project_id IS NOT NULL) AND (workload_capacities.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[]))) OR ((portfolio_id IS NOT NULL) AND (workload_capacities.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('editor'::text))::uuid[])))));

alter policy workload_capacities_select_viewer on public.workload_capacities
  using ((((project_id IS NOT NULL) AND (workload_capacities.project_id = ANY ((SELECT public.project_ids_with_role('viewer'::text))::uuid[]))) OR ((portfolio_id IS NOT NULL) AND (workload_capacities.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('viewer'::text))::uuid[])))));

alter policy workload_capacities_update_editor on public.workload_capacities
  using ((((project_id IS NOT NULL) AND (workload_capacities.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[]))) OR ((portfolio_id IS NOT NULL) AND (workload_capacities.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('editor'::text))::uuid[])))))
  with check ((((project_id IS NOT NULL) AND (workload_capacities.project_id = ANY ((SELECT public.project_ids_with_role('editor'::text))::uuid[]))) OR ((portfolio_id IS NOT NULL) AND (workload_capacities.portfolio_id = ANY ((SELECT public.portfolio_ids_with_role('editor'::text))::uuid[])))));
