-- Phase: Review hardening — small fixes from the end-of-build review. No new features, no UI changes.
--
-- 1. anon grants. ALHC's tables are reached by signed-in people (authenticated) and by three
--    SECURITY DEFINER entry points; anon itself never needs a table. Every table this repository's
--    migrations create loses every privilege for anon, and anon keeps EXECUTE only on
--    get_public_form, submit_form, and receive_inbound_webhook. The lists below are this repository's
--    own tables and functions (generated from a database built from supabase/migrations only), so
--    nothing that belongs to the other app sharing the schema (Isaiah Approval) is touched.
--    Supabase's default privileges grant new tables and functions to anon, and the schema is shared,
--    so instead of changing the schema's default privileges, new ALHC tables and functions call the
--    two helpers below in the migration that creates them (AGENTS.md → Conventions), and
--    zz07_review_hardening_smoke.sql fails when any table or function in a locally built database
--    still has an anon grant.
-- 2. Performance advisor: covering indexes for the 17 unindexed foreign keys on ALHC tables, one
--    policy that called auth.uid() per row, and the two tables with duplicate permissive policies
--    (merged into one policy each with the same access: permissive USING and WITH CHECK clauses
--    were already OR-ed together).
-- 3. Log retention: alhc_purge_old_logs() (internal SECURITY DEFINER) deletes rows older than 90 days
--    from inbound_calls and rule_runs, and only sent or permanently failed rows older than 90 days
--    from email_outbox and integration_outbox, daily from the pg_cron job alhc-log-purge.
--    alhc-workflow-tick, fire_rules, notify_with, notify_message, and add_story are untouched.

-- ---------------------------------------------------------------------------
-- 1. anon grants
-- ---------------------------------------------------------------------------

-- Revokes every table privilege (column privileges go with them) from anon on the named public
-- tables. Missing names are skipped. Internal: migrations only.
create or replace function public.alhc_revoke_anon_grants(target_tables text[])
returns integer
language plpgsql
set search_path = ''
as $$
declare
  table_name text;
  rel regclass;
  done integer := 0;
begin
  foreach table_name in array coalesce(target_tables, '{}'::text[]) loop
    rel := to_regclass(format('public.%I', table_name));
    if rel is null then
      continue;
    end if;
    execute format('revoke all on table %s from anon', rel);
    done := done + 1;
  end loop;
  return done;
end;
$$;

revoke all on function public.alhc_revoke_anon_grants(text[]) from public, anon, authenticated;

-- Takes EXECUTE away from anon on the named public functions ('name(arg types)'), except the three
-- public entry points. A function anon reaches through PUBLIC loses the PUBLIC grant too, and
-- authenticated / service_role get an explicit grant when they could execute it before, so their
-- access is unchanged. Missing signatures are skipped. Internal: migrations only.
create or replace function public.alhc_revoke_anon_execute(target_functions text[])
returns integer
language plpgsql
set search_path = ''
as $$
declare
  signature text;
  fn regprocedure;
  had_authenticated boolean;
  had_service_role boolean;
  done integer := 0;
begin
  foreach signature in array coalesce(target_functions, '{}'::text[]) loop
    fn := to_regprocedure('public.' || signature);
    if fn is null
      or (select p.proname from pg_catalog.pg_proc p where p.oid = fn)
        in ('get_public_form', 'submit_form', 'receive_inbound_webhook')
      or not pg_catalog.has_function_privilege('anon', fn, 'execute') then
      continue;
    end if;
    had_authenticated := pg_catalog.has_function_privilege('authenticated', fn, 'execute');
    had_service_role := pg_catalog.has_function_privilege('service_role', fn, 'execute');
    execute format('revoke execute on function %s from public, anon', fn);
    if had_authenticated then
      execute format('grant execute on function %s to authenticated', fn);
    end if;
    if had_service_role then
      execute format('grant execute on function %s to service_role', fn);
    end if;
    done := done + 1;
  end loop;
  return done;
end;
$$;

revoke all on function public.alhc_revoke_anon_execute(text[]) from public, anon, authenticated;

-- Every table created by supabase/migrations (67).
select public.alhc_revoke_anon_grants(array[
  'allowed_emails', 'approval_requests', 'comment_mentions', 'comment_reactions', 'comments',
  'custom_fields', 'dashboard_widgets', 'email_outbox', 'form_submissions', 'forms', 'goal_links',
  'goal_status_updates', 'goals', 'import_external_ids', 'import_runs', 'inbound_calls',
  'inbound_endpoints', 'inbox_items', 'integration_outbox', 'integration_secrets',
  'my_task_placements', 'my_task_sections', 'personal_dashboard_widgets', 'personal_dashboards',
  'portfolio_children', 'portfolio_field_values', 'portfolio_fields', 'portfolio_members',
  'portfolio_projects', 'portfolios', 'profiles', 'project_integrations', 'project_members',
  'project_message_mentions', 'project_message_reactions', 'project_messages',
  'project_status_updates', 'project_stories', 'project_templates', 'project_views', 'projects',
  'request_sequences', 'rule_presets', 'rule_runs', 'rules', 'scheduled_rule_actions', 'sections',
  'subtasks', 'tag_field_migrations', 'tags', 'task_attachment_links', 'task_attachments',
  'task_dependencies', 'task_field_values', 'task_followers', 'task_likes', 'task_projects',
  'task_stories', 'task_tags', 'task_templates', 'tasks', 'team_members', 'team_projects', 'teams',
  'workload_capacities', 'workspace_admins', 'workspaces'
]);

-- Every function created by supabase/migrations (329), in five batches.
select public.alhc_revoke_anon_execute(array[
  'add_portfolio_child(uuid,uuid)', 'add_portfolio_member(uuid,text,text)',
  'add_portfolio_owner()', 'add_portfolio_project(uuid,uuid)',
  'add_project_member(uuid,text,text)', 'add_project_owner()', 'add_story(uuid,text,jsonb)',
  'add_task_dependency(uuid,uuid)', 'add_team_creator_lead()', 'add_team_member(uuid,text,text)',
  'add_team_to_project(uuid,uuid,text)', 'add_workspace_admin(uuid,text)', 'adopt_private_task()',
  'all_projects_report(text)', 'apply_dependency_shift(uuid,date,date,uuid[])',
  'apply_dependency_shifts(jsonb,uuid[],boolean)', 'apply_goal_status_update()',
  'apply_task_tags(uuid,jsonb)', 'assign_request_number(uuid)',
  'assign_request_number_on_insert()', 'attachment_object_task(text)',
  'backfill_project_members()', 'bulk_skip_reason(text,text,text)',
  'bulk_update_tasks(uuid[],jsonb)', 'can_edit_goal(uuid)', 'can_manage_project_template(uuid)',
  'can_manage_tag(uuid)', 'can_manage_team(uuid)', 'cancel_approval(uuid)',
  'cancel_integration_delivery(uuid)', 'cascade_task_to_subtasks()',
  'claim_email_outbox(integer,uuid)', 'claim_integration_outbox(integer,uuid)',
  'comment_mention_ids(uuid,uuid,text)', 'complete_approval_task()',
  'complete_email_outbox(uuid,text,text,text)',
  'complete_integration_outbox(uuid,text,jsonb,text)', 'convert_to_subtask(uuid,uuid)',
  'convert_to_task(uuid,uuid,uuid)', 'copy_context_id()', 'copy_subtask_tree(uuid,uuid,integer)',
  'copy_task_tags(uuid,uuid)', 'create_approval(uuid,uuid,text,boolean,text)',
  'create_default_project_views()', 'create_inbound_endpoint(uuid,text,uuid,uuid,uuid[],boolean)',
  'create_private_task(text)', 'create_project_from_template(uuid,text,date)',
  'create_subtask(uuid,text,uuid)', 'create_task(uuid,uuid,text)',
  'create_task_from_template(uuid,uuid,text)', 'current_actor_id()', 'current_profile_id()',
  'custom_field_project(uuid)', 'decide_approval(uuid,text,text)', 'default_workspace_id()',
  'delete_project_template(uuid)', 'dependency_story_data(uuid,uuid,text,jsonb)',
  'disable_copied_rule()', 'disable_imported_rule()', 'duplicate_option(jsonb,text)',
  'duplicate_project(uuid,text,jsonb)', 'duplicate_subtask_tree(uuid,uuid,jsonb)',
  'duplicate_task(uuid,jsonb)', 'enqueue_email(text,text,text,jsonb,uuid)',
  'enqueue_integration(rules,uuid,jsonb,jsonb)', 'ensure_home_membership()',
  'ensure_my_task_sections()', 'ensure_tag(uuid,text,text,uuid)',
  'execute_rule_actions(rules,uuid,jsonb,jsonb)'
]);

select public.alhc_revoke_anon_execute(array[
  'fill_slots(jsonb,jsonb)', 'filter_project_tasks(uuid,jsonb,text)',
  'finish_import_run(uuid,text,jsonb)', 'fire_rules(text,uuid,uuid,jsonb)',
  'follow_task(uuid,uuid)', 'form_answer_text(jsonb,jsonb)', 'form_option_label(jsonb,text)',
  'format_request_label(uuid,bigint)', 'get_project_integrations(uuid)', 'get_public_form(uuid)',
  'goal_editable(uuid,uuid,uuid)', 'goal_hidden_project_count(uuid)', 'goal_progress(uuid)',
  'goal_task_counts(uuid)', 'guard_approval_subtask()', 'guard_comment_reaction()',
  'guard_comment_update()', 'guard_goal()', 'guard_goal_link()', 'guard_goal_status_update()',
  'guard_home_membership()', 'guard_inbound_endpoint()', 'guard_my_task_placement()',
  'guard_my_task_section()', 'guard_personal_dashboard()', 'guard_personal_dashboard_widget()',
  'guard_portfolio_child()', 'guard_portfolio_columns()', 'guard_portfolio_field()',
  'guard_portfolio_field_value()', 'guard_portfolio_member()', 'guard_portfolio_project()',
  'guard_private_task()', 'guard_project_archive()', 'guard_project_columns()',
  'guard_project_member()', 'guard_project_message()', 'guard_project_message_reaction()',
  'guard_project_status()', 'guard_request_sequence()', 'guard_tag()', 'guard_task_dependencies()',
  'guard_task_kind()', 'guard_task_like()', 'guard_task_parent()', 'guard_task_project_subtask()',
  'guard_task_recurrence_columns()', 'guard_task_system_columns()', 'guard_task_tag()',
  'guard_task_template()', 'guard_team()', 'guard_team_member()', 'guard_team_project()',
  'guard_workload_capacity()', 'guard_workspace_admin()', 'handle_allowed_email_insert()',
  'handle_auth_user_change()', 'has_portfolio_role(uuid,text)', 'has_project_role(uuid,text)',
  'has_task_role(uuid,text)', 'import_batch(uuid,jsonb)', 'import_context_id()',
  'import_date(text)', 'import_local_id(uuid,text,text,text)', 'import_lookup(text,text[])',
  'import_member(uuid,text)', 'import_object_project(text)',
  'import_remember(uuid,text,text,text,uuid,uuid)',
  'import_subtasks(uuid,text,uuid,uuid,jsonb,integer)', 'import_task_tags(uuid,uuid,jsonb,uuid)',
  'import_timestamp(text)', 'inbound_hmac_sha256(bytea,bytea)', 'inbound_random_hex()',
  'inbound_token_hash(text)', 'install_rule_preset(uuid,text,jsonb,boolean)',
  'instantiate_project_snapshot(jsonb,text,date,uuid,text,jsonb)',
  'instantiate_subtasks(uuid,jsonb,date,jsonb,uuid,uuid,integer)',
  'instantiate_task_fields(uuid,jsonb,jsonb,date)'
]);

select public.alhc_revoke_anon_execute(array[
  'integration_delivery_for_admin(uuid)', 'integration_header_ok(text)',
  'integration_retry_delay(integer)', 'integration_url_hint(text)', 'integration_url_host(text)',
  'integration_url_ok(text)', 'is_allowlisted()', 'is_client_role()', 'is_email(text)',
  'is_iso_date(text)', 'is_team_lead(uuid)', 'is_workspace_admin(uuid)',
  'list_integration_deliveries(uuid,integer)', 'list_portfolio_progress()',
  'log_inbound_call(inbound_endpoints,text,integer,text,uuid,jsonb,text,text)',
  'match_field_option(jsonb,text,text)', 'match_section(uuid,text,text)',
  'message_mention_ids(uuid,uuid,text)', 'migrate_imported_tag_fields()', 'min_order_gap()',
  'move_my_tasks(uuid[],uuid)', 'move_portfolio_project(uuid,uuid,double precision)',
  'move_task_to_section(uuid,uuid,uuid)',
  'my_task_placement_valid(uuid,timestamp with time zone,uuid,timestamp with time zone)',
  'my_tasks_layout()', 'next_request_number(uuid)', 'normalize_allowed_email()',
  'normalize_form_answer(jsonb,jsonb)', 'normalize_recurrence(jsonb)',
  'notify(uuid,uuid,text,uuid)', 'notify_message(uuid,uuid,text,jsonb)',
  'notify_with(uuid,uuid,text,uuid,jsonb)', 'oldest_workspace_id()', 'on_approval_insert()',
  'on_approval_status_change()', 'on_attachment_insert()', 'on_comment_edit()',
  'on_comment_insert()', 'on_comment_soft_delete()', 'on_my_task_section_deleted()',
  'on_project_message_insert()', 'on_project_message_update()', 'on_task_converted()',
  'on_task_field_value_change()', 'on_task_insert_collab()', 'on_task_project_change()',
  'on_task_recurrence_change()', 'on_task_restore()', 'on_task_start_change()',
  'on_task_tag_story()', 'on_task_update_collab()', 'open_blocker_count(uuid)',
  'place_my_task(uuid,uuid,uuid)', 'place_my_task_section(uuid,uuid)', 'place_section(uuid,uuid)',
  'place_subtask(uuid,uuid,uuid)', 'place_task(uuid,uuid,uuid,uuid)',
  'portfolio_hidden_project_count(uuid)', 'portfolio_milestones(uuid)',
  'portfolio_report(uuid,text,text)', 'portfolio_role(uuid)', 'portfolio_role_rank(text)',
  'portfolio_rollup_projects(uuid)', 'portfolio_timeline(uuid)', 'portfolio_tree(uuid)',
  'portfolio_workload(uuid,date,date,text)', 'preview_dependency_shift(uuid,date,date)',
  'preview_dependency_shifts(jsonb,boolean)', 'profile_can_read_task(uuid,uuid)',
  'profile_handle(uuid)', 'profile_in_workspace(uuid)', 'profile_is_allowlisted(uuid)',
  'profile_is_workspace_admin(uuid,uuid)', 'profile_portfolio_role(uuid,uuid)'
]);

select public.alhc_revoke_anon_execute(array[
  'profile_project_role(uuid,uuid)', 'profile_task_role(uuid,uuid)', 'project_critical_path(uuid)',
  'project_dependencies(uuid)', 'project_metrics(uuid,jsonb,text,text)', 'project_role(uuid)',
  'project_role_rank(text)', 'project_snapshot(uuid,jsonb)',
  'project_workload(uuid,date,date,uuid)', 'receive_inbound_webhook(text,text,text,text,text)',
  'recurrence_next_date(jsonb,date)', 'regex_escape(text)', 'reindex_my_task_section(uuid)',
  'reindex_my_task_sections()', 'reindex_section_order(uuid)', 'reindex_subtask_order(uuid)',
  'reindex_task_order(uuid,uuid)', 'release_section_memberships()',
  'remove_portfolio_child(uuid,uuid)', 'remove_portfolio_member(uuid,uuid)',
  'remove_portfolio_project(uuid,uuid)', 'remove_project_member(uuid,uuid)',
  'remove_task_dependency(uuid)', 'remove_team_member(uuid,uuid)',
  'remove_workspace_admin(uuid,uuid)', 'render_rule_text(text,uuid,uuid,jsonb)',
  'render_rule_text_as(text,uuid,uuid,jsonb,text)', 'report_completed_series(jsonb,text,text)',
  'report_overdue_tasks(jsonb,text,integer)', 'report_task_rows(jsonb,text)',
  'request_approval(uuid,uuid,text,boolean,text)', 'resolve_rule_person(jsonb,uuid)',
  'restore_task(uuid)', 'resubmit_approval(uuid,text)', 'retry_integration_delivery(uuid)',
  'rotate_inbound_token(uuid)', 'rule_conditions_pass(rules,uuid)', 'rule_context_id()',
  'rule_field(uuid,text)', 'rule_person_ok(jsonb)', 'rule_project(uuid)',
  'rule_section_ok(uuid,text)', 'rules_on_field_value_change()', 'rules_on_task_created()',
  'rules_on_task_project_update()', 'rules_on_task_update()',
  'run_rule(rules,uuid,jsonb,jsonb,text)', 'safe_timezone(text)',
  'save_project_as_template(uuid,text,text,date,uuid)',
  'save_task_as_template(uuid,uuid,text,boolean)', 'search_tasks(text,integer)',
  'seed_workspace_admin(text)', 'set_inbound_signing_secret(uuid,boolean)',
  'set_portfolio_field_value(uuid,uuid,jsonb)', 'set_project_archived(uuid,boolean)',
  'set_project_integration(uuid,text,text)', 'set_project_status(uuid,text,text)',
  'set_task_dependency(uuid,uuid,text,integer)', 'set_task_workspace()', 'set_updated_at()',
  'set_workload_capacity(uuid,uuid,uuid,numeric)', 'slack_block_payload(text,uuid,uuid)',
  'slack_escape(text)', 'slack_task_link(uuid,uuid)',
  'snapshot_subtasks(uuid,uuid,date,boolean,boolean,boolean)',
  'snapshot_task_fields(uuid,uuid,date,boolean,boolean)', 'spawn_next_occurrence()',
  'stamp_task_assigned_at()'
]);

select public.alhc_revoke_anon_execute(array[
  'start_import_run(uuid,text,text[])', 'stash_rule_integration_secrets()',
  'submit_form(uuid,text,jsonb)', 'subtask_height(uuid)', 'subtask_max_depth()',
  'subtask_order_before(uuid,uuid,uuid)', 'sync_my_task_placements()',
  'sync_profile_for_user(uuid)', 'sync_task_approval()', 'sync_task_times()',
  'task_field_text(uuid,uuid)', 'task_reach_within(uuid,uuid)', 'task_request_label(uuid)',
  'task_role(uuid)', 'task_tag_ids(uuid)', 'template_remap(jsonb,jsonb)',
  'template_summary(jsonb)', 'transfer_portfolio_ownership(uuid,uuid)',
  'transfer_project_ownership(uuid,uuid)', 'undo_dependency_shift(jsonb)',
  'update_portfolio_member_role(uuid,uuid,text)', 'update_project_member_role(uuid,uuid,text)',
  'update_project_template(uuid,text,text)', 'update_team_member_role(uuid,uuid,text)',
  'validate_dashboard_widget()', 'validate_form()', 'validate_project_view()',
  'validate_report_filters(jsonb)', 'validate_rule()', 'validate_task_field_value()',
  'validate_task_recurrence()', 'validate_view_config(uuid,jsonb)',
  'validate_view_filters(uuid,jsonb)', 'view_field_matches(text,boolean,uuid,jsonb,jsonb)',
  'view_field_ref(uuid,text)', 'view_list(jsonb)', 'view_value_is_empty(jsonb)', 'workflow_tick()',
  'workspace_hidden_project_count()', 'workspace_report(jsonb,text,text)'
]);


-- ---------------------------------------------------------------------------
-- 2a. Covering indexes for the foreign keys the performance advisor flags on ALHC tables
-- ---------------------------------------------------------------------------

create index if not exists forms_destination_section_project_idx
  on public.forms (destination_section_id, project_id);
create index if not exists inbound_calls_task_idx on public.inbound_calls (task_id);
create index if not exists inbound_endpoints_assignee_idx on public.inbound_endpoints (assignee_id);
create index if not exists inbound_endpoints_created_by_idx on public.inbound_endpoints (created_by);
create index if not exists inbound_endpoints_section_idx on public.inbound_endpoints (section_id);
create index if not exists personal_dashboard_widgets_profile_idx on public.personal_dashboard_widgets (profile_id);
create index if not exists project_message_mentions_profile_idx on public.project_message_mentions (profile_id);
create index if not exists project_message_reactions_profile_idx on public.project_message_reactions (profile_id);
create index if not exists project_message_reactions_project_idx on public.project_message_reactions (project_id);
create index if not exists project_messages_author_idx on public.project_messages (author_id);
create index if not exists projects_archived_by_idx on public.projects (archived_by);
create index if not exists tags_created_by_idx on public.tags (created_by);
create index if not exists task_attachment_links_attachment_idx on public.task_attachment_links (attachment_id);
create index if not exists task_likes_profile_idx on public.task_likes (profile_id);
create index if not exists task_projects_section_project_idx on public.task_projects (section_id, project_id);
create index if not exists task_tags_created_by_idx on public.task_tags (created_by);

-- ---------------------------------------------------------------------------
-- 2b. auth.uid() evaluated once per statement, not per row
-- ---------------------------------------------------------------------------

alter policy inbound_endpoints_insert_admin on public.inbound_endpoints
  with check ((select public.has_project_role(project_id, 'admin')) and created_by = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 2c. One permissive policy per table and command (same access as the two it replaces)
-- ---------------------------------------------------------------------------
-- The merged policy is created before the old ones are dropped, so access never narrows in between.

-- Project Admins+, plus workspace admins for projects they can read (Viewer+).
create policy import_runs_select_admin_or_workspace_admin on public.import_runs
  for select to authenticated
  using (
    (select public.has_project_role(project_id, 'admin'))
    or (
      (select public.has_project_role(project_id, 'viewer'))
      and exists (
        select 1 from public.projects p
        where p.id = project_id and p.deleted_at is null and (select public.is_workspace_admin(p.workspace_id))
      )
    )
  );
drop policy if exists import_runs_select_admin on public.import_runs;
drop policy if exists import_runs_select_workspace_admin on public.import_runs;

-- Team leads / workspace admins manage memberships; anyone may leave (team_members_05_guard limits
-- that to setting deleted_at).
create policy team_members_update_lead_or_own on public.team_members
  for update to authenticated
  using (
    (select public.can_manage_team(team_id))
    or (profile_id = (select auth.uid()) and (select public.is_allowlisted()))
  )
  with check (
    (select public.can_manage_team(team_id))
    or profile_id = (select auth.uid())
  );
drop policy if exists team_members_update_lead on public.team_members;
drop policy if exists team_members_update_own on public.team_members;

-- ---------------------------------------------------------------------------
-- 3. Log retention
-- ---------------------------------------------------------------------------

-- Deletes log rows older than 90 days: inbound_calls and rule_runs by created_at, and from both
-- outboxes only rows whose status is sent or failed (failed = out of attempts) and whose last change
-- (updated_at) is older than 90 days. Pending, sending (retrying), mocked, and cancelled outbox rows
-- are never deleted. A rule run still referenced by a kept integration_outbox row is kept too.
-- Runs daily from pg_cron (alhc-log-purge); no client can execute it.
create or replace function public.alhc_purge_old_logs()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cutoff timestamptz := now() - interval '90 days';
  purged_inbound integer;
  purged_email integer;
  purged_integration integer;
  purged_runs integer;
begin
  delete from public.inbound_calls where created_at < cutoff;
  get diagnostics purged_inbound = row_count;

  delete from public.email_outbox
  where status in ('sent', 'failed') and updated_at < cutoff and created_at < cutoff;
  get diagnostics purged_email = row_count;

  delete from public.integration_outbox
  where status in ('sent', 'failed') and updated_at < cutoff and created_at < cutoff;
  get diagnostics purged_integration = row_count;

  delete from public.rule_runs r
  where r.created_at < cutoff
    and not exists (select 1 from public.integration_outbox o where o.rule_run_id = r.id);
  get diagnostics purged_runs = row_count;

  return jsonb_build_object(
    'inbound_calls', purged_inbound,
    'email_outbox', purged_email,
    'integration_outbox', purged_integration,
    'rule_runs', purged_runs
  );
end;
$$;

revoke all on function public.alhc_purge_old_logs() from public, anon, authenticated;

comment on function public.alhc_purge_old_logs() is
  'Daily log retention (pg_cron alhc-log-purge): deletes inbound_calls and rule_runs older than 90 days, '
  'and sent / failed outbox rows untouched for 90 days. Never pending or retrying outbox rows. Internal.';

-- Daily at 03:17 UTC; a no-op where pg_cron isn't installed. Scheduling an existing job name updates it.
do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('alhc-log-purge', '17 3 * * *', 'select public.alhc_purge_old_logs()');
  end if;
end;
$$;
