-- ALHC Projects: project email logo uploads (email designs, 20261019010000_email_designs.sql).
--
-- RUN BY HAND as the storage owner in the Supabase dashboard SQL editor. This is NOT a migration.
--
-- Why: storage.objects is owned by supabase_storage_admin. The migration role (postgres, which
-- apply_migration and the CLI use) can't create policies on it and fails with
-- "ERROR: 42501: must be owner of table objects". Run this once, after
-- supabase/migrations/20261019010000_email_designs.sql is applied (it defines
-- public.workspace_asset_email_project).
--
-- What it does: project Admins+ may upload a logo for their project's email designs into
-- <workspace id>/email/<project id>/<file> of the public workspace-assets bucket (workspace admins
-- already upload anywhere in the workspace's folder). Until it is run, project admins can still
-- pick no logo or keep the workspace's; uploading a project logo fails with a permission error.
--
-- supabase/tests/run.sh applies supabase/manual/*.sql after the migrations, so zz27 checks it.

create policy workspace_assets_objects_insert_project_admin on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'workspace-assets'
    and (select public.has_project_role(public.workspace_asset_email_project(name), 'admin'))
  );
