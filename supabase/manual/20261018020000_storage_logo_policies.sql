-- ALHC Projects: workspace logo storage policies (security review pass 2, finding 6, low).
--
-- RUN BY HAND as the storage owner in the Supabase dashboard SQL editor. This is NOT a migration.
--
-- Why: storage.objects is owned by supabase_storage_admin. The migration role (postgres, which
-- apply_migration and the CLI use) can't alter or create policies on it and fails with
-- "ERROR: 42501: must be owner of table objects". These statements were split out of
-- supabase/migrations/20261018020000_security_review_fixes.sql so the rest of that migration
-- can ship. Run this once, after that migration is applied.
--
-- What it does: logo files stay public (getPublicUrl keeps working), but only workspace admins
-- can list the workspace-assets bucket, and admins can delete replaced logos (setWorkspaceLogo
-- removes the previous file). Until it is run, any allowlisted user can list the bucket and old
-- logo files are left behind when a logo is replaced.
--
-- supabase/tests/run.sh applies supabase/manual/*.sql after the migrations, so zz24 still checks it.

alter policy workspace_assets_objects_select_allowlisted on storage.objects
  using (
    bucket_id = 'workspace-assets'
    and (select public.is_workspace_admin(public.workspace_asset_workspace(name)))
  );
alter policy workspace_assets_objects_select_allowlisted on storage.objects
  rename to workspace_assets_objects_select_admin;

create policy workspace_assets_objects_delete_admin on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'workspace-assets'
    and (select public.is_workspace_admin(public.workspace_asset_workspace(name)))
  );
