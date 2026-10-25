-- Oct 25 test notes (20261025010000_oct25_notes_a.sql, supabase/manual/20261025010000_avatar_policies.sql).
-- 1. Everyone edits their own name and picture: only full_name / avatar_url / email_comments are
--    writable, only on their own row; the checks; the sign-in sync only fills empty fields; the avatars
--    bucket and its own-folder policies.
--   a1a19025…01 o25-member@example.com   a member
--   a1a19025…02 o25-other@example.com    another member
--   a1a19025…03 o25-google@example.com   signs in with a provider name and picture

\set ON_ERROR_STOP 1

insert into public.allowed_emails (email, note) values
  ('o25-member@example.com', 'oct 25 notes'),
  ('o25-other@example.com', 'oct 25 notes'),
  ('o25-google@example.com', 'oct 25 notes');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a1a19025-0000-4000-8000-000000000001', 'o25-member@example.com', now(), '{}'),
  ('a1a19025-0000-4000-8000-000000000002', 'o25-other@example.com', now(), '{"full_name":"Olga Other"}'),
  ('a1a19025-0000-4000-8000-000000000003', 'o25-google@example.com', now(),
   '{"name":"Gina Google","picture":"https://lh3.googleusercontent.com/a/gina"}');

-- ---------------------------------------------------------------------------------------------
-- 1. Own name and picture
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert has_column_privilege('authenticated', 'public.profiles', 'full_name', 'UPDATE'), 'names are editable';
  assert has_column_privilege('authenticated', 'public.profiles', 'avatar_url', 'UPDATE'), 'pictures are editable';
  assert has_column_privilege('authenticated', 'public.profiles', 'email_comments', 'UPDATE'), 'the comment email switch stays';
  assert not has_column_privilege('authenticated', 'public.profiles', 'email', 'UPDATE'), 'no email edits';
  assert not has_column_privilege('authenticated', 'public.profiles', 'joined_at', 'UPDATE'), 'no join date edits';
  assert not has_column_privilege('authenticated', 'public.profiles', 'id', 'UPDATE'), 'no id edits';
  assert not has_column_privilege('authenticated', 'public.profiles', 'created_at', 'UPDATE'), 'no creation time edits';
  assert not has_table_privilege('anon', 'public.profiles', 'UPDATE'), 'anon edits nothing';
  assert exists (select 1 from pg_policies where tablename = 'profiles' and policyname = 'profiles_update_own'),
    'own row only, as before';
  assert (select full_name from public.profiles where id = 'a1a19025-0000-4000-8000-000000000003') = 'Gina Google',
    'a provider name fills an empty profile';
  assert (select avatar_url from public.profiles where id = 'a1a19025-0000-4000-8000-000000000003')
    = 'https://lh3.googleusercontent.com/a/gina', 'and its picture';
  assert (select public from storage.buckets where id = 'avatars'), 'pictures are public files';
  assert (select file_size_limit from storage.buckets where id = 'avatars') = 2097152, '2 MB';
  assert (select allowed_mime_types from storage.buckets where id = 'avatars')
    = array['image/png', 'image/jpeg', 'image/webp', 'image/gif'], 'images only';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'a1a19025-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  n integer;
begin
  update public.profiles set full_name = 'Mia Member', avatar_url = 'https://example.supabase.co/storage/v1/object/public/avatars/a1a19025-0000-4000-8000-000000000001/x.png'
  where id = 'a1a19025-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  assert n = 1, 'a member renames themselves and sets a picture';
  assert (select full_name from public.profiles where id = 'a1a19025-0000-4000-8000-000000000001') = 'Mia Member', 'saved';

  update public.profiles set full_name = 'Hijacked' where id = 'a1a19025-0000-4000-8000-000000000002';
  get diagnostics n = row_count;
  assert n = 0, 'not someone else''s row';

  update public.profiles set avatar_url = null where id = 'a1a19025-0000-4000-8000-000000000001';
  assert (select avatar_url from public.profiles where id = 'a1a19025-0000-4000-8000-000000000001') is null,
    'and removes the picture';

  begin
    update public.profiles set email = 'someone-else@example.com' where id = 'a1a19025-0000-4000-8000-000000000001';
    raise exception 'changing my own email should have been refused';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.profiles set joined_at = now() - interval '5 years' where id = 'a1a19025-0000-4000-8000-000000000001';
    raise exception 'changing my join date should have been refused';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.profiles set full_name = '   ' where id = 'a1a19025-0000-4000-8000-000000000001';
    raise exception 'a blank name should have been refused';
  exception when check_violation then null;
  end;
  begin
    update public.profiles set full_name = repeat('x', 101) where id = 'a1a19025-0000-4000-8000-000000000001';
    raise exception 'a 101-character name should have been refused';
  exception when check_violation then null;
  end;
  begin
    update public.profiles set avatar_url = 'http://tracker.example.com/p.gif' where id = 'a1a19025-0000-4000-8000-000000000001';
    raise exception 'a non-https picture should have been refused';
  exception when check_violation then null;
  end;
  update public.profiles set full_name = null where id = 'a1a19025-0000-4000-8000-000000000001';
  update public.profiles set full_name = 'Mia Member' where id = 'a1a19025-0000-4000-8000-000000000001';
  assert (select email from public.profiles where id = 'a1a19025-0000-4000-8000-000000000001') = 'o25-member@example.com',
    'the email never moved';
end $$;

-- Pictures: own folder only.
do $$
declare
  n integer;
begin
  insert into storage.objects (bucket_id, name) values ('avatars', 'a1a19025-0000-4000-8000-000000000001/me.png');
  begin
    insert into storage.objects (bucket_id, name) values ('avatars', 'a1a19025-0000-4000-8000-000000000002/fake.png');
    raise exception 'uploading into someone else''s folder should have been refused';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into storage.objects (bucket_id, name) values ('avatars', 'loose.png');
    raise exception 'uploading outside a folder should have been refused';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
insert into storage.objects (bucket_id, name) values ('avatars', 'a1a19025-0000-4000-8000-000000000002/olga.png');
set role authenticated;

do $$
declare
  n integer;
begin
  delete from storage.objects where bucket_id = 'avatars' and name = 'a1a19025-0000-4000-8000-000000000002/olga.png';
  get diagnostics n = row_count;
  assert n = 0, 'not someone else''s picture';
  update storage.objects set name = 'a1a19025-0000-4000-8000-000000000001/stolen.png'
  where bucket_id = 'avatars' and name = 'a1a19025-0000-4000-8000-000000000002/olga.png';
  get diagnostics n = row_count;
  assert n = 0, 'nor move it';
  delete from storage.objects where bucket_id = 'avatars' and name = 'a1a19025-0000-4000-8000-000000000001/me.png';
  get diagnostics n = row_count;
  assert n = 1, 'a member removes their own old picture';
end $$;

-- Removed from the workspace: no uploads.
reset role;
update public.allowed_emails set removed_at = now() where email = 'o25-other@example.com';
set role authenticated;
select set_config('request.jwt.claim.sub', 'a1a19025-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  insert into storage.objects (bucket_id, name) values ('avatars', 'a1a19025-0000-4000-8000-000000000002/again.png');
  raise exception 'a removed person should not upload';
exception when insufficient_privilege then null;
end $$;
reset role;
update public.allowed_emails set removed_at = null where email = 'o25-other@example.com';

-- Signing in again (metadata changes) never overwrites an edited name or picture, and still fills
-- empty ones.
update auth.users set raw_user_meta_data = '{"full_name":"Provider Name","avatar_url":"https://lh3.googleusercontent.com/a/new"}'
where id = 'a1a19025-0000-4000-8000-000000000001';
update public.profiles set full_name = 'Gina G.' where id = 'a1a19025-0000-4000-8000-000000000003';
update auth.users set raw_user_meta_data = '{"name":"Gina Google","picture":"https://lh3.googleusercontent.com/a/gina2"}'
where id = 'a1a19025-0000-4000-8000-000000000003';
-- A provider name that wouldn't fit the checks doesn't block a sign-in.
update auth.users set raw_user_meta_data = '{"full_name":"   ","picture":"http://insecure.example.com/x.png"}'
where id = 'a1a19025-0000-4000-8000-000000000002';

do $$
begin
  assert (select full_name from public.profiles where id = 'a1a19025-0000-4000-8000-000000000001') = 'Mia Member',
    'an edited name survives the next sign-in';
  assert (select avatar_url from public.profiles where id = 'a1a19025-0000-4000-8000-000000000001')
    = 'https://lh3.googleusercontent.com/a/new', 'a removed picture is filled from the provider again';
  assert (select full_name from public.profiles where id = 'a1a19025-0000-4000-8000-000000000003') = 'Gina G.',
    'an edited name beats the provider';
  assert (select avatar_url from public.profiles where id = 'a1a19025-0000-4000-8000-000000000003')
    = 'https://lh3.googleusercontent.com/a/gina', 'a set picture isn''t replaced';
  assert (select full_name from public.profiles where id = 'a1a19025-0000-4000-8000-000000000002') = 'Olga Other',
    'a blank provider name changes nothing';
end $$;

do $$ begin raise notice 'oct 25 notes smoke: all assertions passed'; end $$;
