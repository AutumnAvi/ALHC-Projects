-- ALHC Projects — Oct 25 test notes (Avi's notes 1 and 2).
--
-- Note 1: everyone edits their own name and profile picture (Settings → Profile).
--   * Clients may update only full_name, avatar_url, and email_comments on profiles (they could change
--     their own email, join date, or creation time before). profiles_update_own (own row, allowlisted)
--     is unchanged.
--   * full_name is null or 1–100 characters once trimmed; avatar_url is null or an https URL of at most
--     1,000 characters (an <img> source everyone's browser loads).
--   * sync_profile_for_user (every sign-in that updates auth metadata, e.g. Google) only fills a name or
--     picture the person hasn't set, so an edit survives the next sign-in.
--   * A public "avatars" bucket (2 MB, PNG / JPEG / WebP / GIF). Its storage.objects policies (each
--     person writes only <their id>/…) are in supabase/manual/20261025010000_avatar_policies.sql: the
--     migration role can't create policies on storage.objects (see supabase/manual/*).
--
-- Additive: no tail. The release still on main never writes these columns from the client except
-- email_comments, which stays grantable.

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
-- Note 1: own name and picture
-- ---------------------------------------------------------------------------

-- Only the person's own display settings are writable (RLS keeps it to their own row).
revoke update on public.profiles from authenticated;
grant update (full_name, avatar_url, email_comments) on public.profiles to authenticated;

-- Names and pictures already stored that the new checks would refuse (blank or very long names from a
-- sign-in provider, non-https pictures) are cleaned first.
update public.profiles
set full_name = nullif(left(btrim(full_name), 100), '')
where full_name is not null and (btrim(full_name) = '' or char_length(btrim(full_name)) > 100 or full_name <> btrim(full_name));

update public.profiles
set avatar_url = null
where avatar_url is not null and (avatar_url !~ '^https://[^\s]+$' or char_length(avatar_url) > 1000);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_full_name_length') then
    alter table public.profiles add constraint profiles_full_name_length
      check (full_name is null or char_length(btrim(full_name)) between 1 and 100);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_avatar_url_https') then
    alter table public.profiles add constraint profiles_avatar_url_https
      check (avatar_url is null or (avatar_url ~ '^https://[^\s]+$' and char_length(avatar_url) <= 1000));
  end if;
end $$;

-- A name or picture from the sign-in provider only fills an empty field (it used to overwrite an edited
-- one at every sign-in), and is cleaned to fit the checks above.
select public.alhc_patch_function('public.sync_profile_for_user(uuid)'::regprocedure,
$p$    coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name'),
    coalesce(u.raw_user_meta_data ->> 'avatar_url', u.raw_user_meta_data ->> 'picture')$p$,
$p$    nullif(left(btrim(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name')), 100), ''),
    (select v.url
     from (select coalesce(u.raw_user_meta_data ->> 'avatar_url', u.raw_user_meta_data ->> 'picture') as url) v
     where v.url ~ '^https://[^\s]+$' and char_length(v.url) <= 1000)$p$,
$p$        full_name = coalesce(excluded.full_name, public.profiles.full_name),
        avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url);$p$,
$p$        full_name = coalesce(public.profiles.full_name, excluded.full_name),
        avatar_url = coalesce(public.profiles.avatar_url, excluded.avatar_url);$p$);

comment on column public.profiles.full_name is
  'The person''s display name, set by them in Settings → Profile (1–100 characters). A sign-in provider''s '
  'name only fills it while it is empty.';
comment on column public.profiles.avatar_url is
  'Public URL of the person''s picture (their file in the avatars bucket, or the sign-in provider''s picture '
  'while they have none). https only.';

-- Profile pictures: a public bucket (every avatar is shown to everyone signed in through its public URL).
-- Policies: supabase/manual/20261025010000_avatar_policies.sql.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do nothing;
