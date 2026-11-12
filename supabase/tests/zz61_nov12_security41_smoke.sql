-- Nov 12 batch 41 (security audit 2), AI builder branch: no migration. The AI tools' pilot lock
-- (packages/core/src/api/capabilities/pilot-lock.ts) reads these columns as the signed-in person to learn
-- which workspace a named thing is in, and it fails closed: if `authenticated` lost SELECT on any of them,
-- every assistant and MCP call would be refused. This pins the privileges the lock relies on (keep the list
-- in step with pilot-lock.ts), and that anon still reads none of them.

\set ON_ERROR_STOP 1

do $$
declare
  pair text[];
  pairs text[] := array[
    array['workspaces', 'id'],
    array['projects', 'workspace_id'], array['tasks', 'workspace_id'], array['tags', 'workspace_id'],
    array['portfolios', 'workspace_id'], array['goals', 'workspace_id'], array['teams', 'workspace_id'],
    array['project_templates', 'workspace_id'],
    array['sections', 'project_id'], array['custom_fields', 'project_id'], array['rules', 'project_id'],
    array['project_views', 'project_id'], array['dashboard_widgets', 'project_id'], array['forms', 'project_id'],
    array['project_roles', 'project_id'], array['task_templates', 'project_id'],
    array['comments', 'task_id'], array['task_attachments', 'task_id'], array['approval_requests', 'task_id'],
    array['portfolio_rules', 'portfolio_id'], array['portfolio_fields', 'portfolio_id'],
    array['task_dependencies', 'predecessor_id'], array['task_dependencies', 'successor_id'],
    array['inbox_items', 'task_id'], array['inbox_items', 'project_id']
  ];
  checked int := 0;
begin
  foreach pair slice 1 in array pairs loop
    if not has_column_privilege('authenticated', format('public.%I', pair[1]), 'id', 'SELECT')
      or not has_column_privilege('authenticated', format('public.%I', pair[1]), pair[2], 'SELECT') then
      raise exception 'pilot lock: authenticated can''t read %.(id, %)', pair[1], pair[2];
    end if;
    if has_table_privilege('anon', format('public.%I', pair[1]), 'SELECT') then
      raise exception 'pilot lock: anon can read %', pair[1];
    end if;
    -- Every lock table keeps row level security (the lock reads through RLS, as the person).
    if not (select c.relrowsecurity from pg_class c where c.oid = format('public.%I', pair[1])::regclass) then
      raise exception 'pilot lock: % has no row level security', pair[1];
    end if;
    checked := checked + 1;
  end loop;
  raise notice 'zz61: % lock columns readable by authenticated, none by anon', checked;
end;
$$;
