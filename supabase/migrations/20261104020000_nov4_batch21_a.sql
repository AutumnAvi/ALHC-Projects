-- Nov 4 notes, batch 21 (efficiency quick wins). Additive: no object or row is removed, no tail.
--
-- QW5. Covering indexes for foreign keys the Supabase advisor flags (lint 0001 unindexed_foreign_keys) on
--      ALHC's own tables. A fresh build of every migration in this repository already covers all of them,
--      so the hosted list can't be written out here by name: the block below applies the advisor's own rule
--      at apply time — a foreign key is covered when a valid index's leading columns are exactly the key's
--      columns, in order — to every foreign key of the tables these migrations create (the list below; the
--      other app's tables in this shared schema are never touched) and adds one plain btree index for each
--      key that isn't (create index if not exists, named alhc_fk_<table>_<columns> plus a short hash so it
--      never meets an existing name). Each one is reported in a NOTICE. Running it again adds nothing.
--
-- QW4 needed nothing from the database: the rejected Realtime subscriptions ("invalid column for filter"
--      on inbox_items.recipient_id and rule_runs.actor_id) were channels joining with only the anon key
--      before the browser had the person's session token. Realtime checks a filter column as the joining
--      role (has_column_privilege), and anon holds no privilege on any ALHC table since Review hardening.
--      The app now waits for the session before it joins (src/lib/realtime.ts).

do $$
declare
  alhc_tables text[] := array[
    'allowed_emails', 'approval_requests', 'approval_rounds', 'calendar_events', 'calendar_feeds',
    'comment_mentions', 'comment_pin_events', 'comment_reactions', 'comment_removed_bodies', 'comments',
    'custom_fields', 'dashboard_widgets', 'email_conversation_overrides', 'email_designs',
    'email_forwarding_addresses', 'email_forwards', 'email_outbox', 'email_preferences', 'email_replies',
    'email_reply_tokens', 'email_suppressions', 'form_submissions', 'forms', 'goal_links',
    'goal_status_updates', 'goals', 'import_external_ids', 'import_runs', 'inbound_calls',
    'inbound_endpoints', 'inbox_items', 'integration_outbox', 'integration_secrets',
    'library_field_link_conflicts', 'library_field_links', 'list_collapsed_groups', 'list_column_widths',
    'my_task_placements', 'my_task_rule_runs', 'my_task_rules', 'my_task_sections', 'notification_settings',
    'pending_memberships', 'personal_dashboard_widgets', 'personal_dashboards', 'portfolio_children',
    'portfolio_field_values', 'portfolio_fields', 'portfolio_members', 'portfolio_projects',
    'portfolio_rule_runs', 'portfolio_rules', 'portfolios', 'profile_preferences', 'profiles',
    'project_access_requests', 'project_integrations', 'project_members', 'project_message_mentions',
    'project_message_reactions', 'project_messages', 'project_person_settings', 'project_roles',
    'project_stars', 'project_status_templates', 'project_status_updates', 'project_stories',
    'project_templates', 'project_view_personal_configs', 'project_view_settings', 'project_views',
    'projects', 'report_schedules', 'request_counters', 'request_number_gaps', 'request_sequences',
    'review_check_assets', 'review_check_files', 'review_check_pins', 'review_checks',
    'rule_assignment_cursors', 'rule_presets', 'rule_runs', 'rules', 'scheduled_rule_actions', 'sections',
    'sidebar_folder_projects', 'sidebar_folders', 'slack_connections', 'slack_destinations',
    'submitter_reply_threads', 'subtasks', 'tag_field_migrations', 'tags', 'task_approval_settings',
    'task_approvers', 'task_attachment_links', 'task_attachments', 'task_dependencies',
    'task_email_activity', 'task_field_values', 'task_followers', 'task_likes', 'task_project_numbers',
    'task_projects', 'task_role_links', 'task_stories', 'task_tags', 'task_templates', 'tasks',
    'team_curated_work', 'team_join_requests', 'team_members', 'team_message_followers',
    'team_message_mentions', 'team_message_reactions', 'team_messages', 'team_projects', 'teams',
    'trash_purge_runs', 'trash_purged_items', 'trash_storage_purges', 'verified_email_domains',
    'workload_capacities', 'workspace_admins', 'workspaces'
  ];
  fk record;
  index_name text;
  column_list text;
  added int := 0;
begin
  for fk in
    select cl.oid as table_oid, cl.relname as table_name, ct.conname as fkey_name, ct.conkey as col_attnums
    from pg_catalog.pg_constraint ct
    join pg_catalog.pg_class cl on cl.oid = ct.conrelid
    where ct.contype = 'f'
      and cl.relnamespace = 'public'::regnamespace
      and cl.relname = any (alhc_tables)
      and not exists (
        select 1
        from pg_catalog.pg_index pi
        where pi.indrelid = ct.conrelid
          and pi.indisvalid
          and (string_to_array(pi.indkey::text, ' ')::smallint[])[1:array_length(ct.conkey, 1)] = ct.conkey
      )
    order by cl.relname, ct.conname
  loop
    select string_agg(format('%I', a.attname), ', ' order by k.ord)
      into column_list
      from unnest(fk.col_attnums) with ordinality as k(attnum, ord)
      join pg_catalog.pg_attribute a on a.attrelid = fk.table_oid and a.attnum = k.attnum;
    index_name := left('alhc_fk_' || fk.table_name || '_' || replace(replace(column_list, '"', ''), ', ', '_'), 54)
      || '_' || left(md5(fk.table_name || ':' || fk.fkey_name), 8);
    execute format('create index if not exists %I on public.%I (%s)', index_name, fk.table_name, column_list);
    raise notice 'nov4_batch21_a: covering index % on %(%) for %', index_name, fk.table_name, column_list, fk.fkey_name;
    added := added + 1;
  end loop;
  raise notice 'nov4_batch21_a: % foreign key index(es) added', added;
end
$$;
