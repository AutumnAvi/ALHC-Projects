-- ALHC Projects: profile picture storage policies (Oct 25 test notes, note 1).
--
-- RUN BY HAND as the storage owner in the Supabase dashboard SQL editor. This is NOT a migration.
--
-- Why: storage.objects is owned by supabase_storage_admin. The migration role (postgres, which
-- apply_migration and the CLI use) can't create policies on it and fails with
-- "ERROR: 42501: must be owner of table objects". Run this once, after
-- supabase/migrations/20261025010000_oct25_notes_a.sql is applied (it creates the avatars bucket).
--
-- What it does: everyone allowlisted uploads, replaces, and removes files only in their own folder of
-- the public avatars bucket (avatars/<their user id>/<file>). Pictures are shown through public URLs,
-- which need no policy; listing the bucket is limited to people signed in to the workspace. Until this
-- is run, uploading a picture fails with a permission error (editing your name already works).
--
-- supabase/tests/run.sh applies supabase/manual/*.sql after the migrations, so zz31 checks it.

create policy avatars_objects_select_allowlisted on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (select public.is_allowlisted()));

create policy avatars_objects_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select public.is_allowlisted())
  );

create policy avatars_objects_update_own on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select public.is_allowlisted())
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select public.is_allowlisted())
  );

create policy avatars_objects_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select public.is_allowlisted())
  );
