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
--   * A public "avatars" bucket (2 MB, PNG / JPEG / WebP / GIF) with storage.objects policies: public
--     select; allowlisted people insert / update / delete only <their id>/… . Created
--     with CREATE POLICY only (storage.objects can't be ALTERed); if the hosted migration role is refused
--     ("must be owner of table objects", as for the email logo policy), run that block as the storage
--     owner.
--
-- Note 2: role clarity. Each person gets a default project role (allowed_emails.default_project_role,
-- set by workspace admins through set_default_project_role — the one new client definer, pinned in
-- suite 60), used when they're added to a project with the role "default", one by one or through a
-- team (add_project_member / add_team_to_project, asserted patches; team_projects.uses_default_roles).
--
-- Additive: no tail. The release still on main never writes these columns from the client except
-- email_comments, which stays grantable, and never passes the role "default".

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

-- Profile pictures: a public bucket (every avatar is shown through its public URL).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

-- Its policies: public select; each allowlisted person writes only their own folder (avatars/<user id>/…).
-- Each is created once (no DROP above the tail, so a re-run skips existing ones).
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                 and policyname = 'avatars_objects_select_public') then
    -- Public select, avatars bucket only (profile pictures are public files). The one Storage read anon
    -- has; zz15 pins that it stays limited to this bucket.
    create policy avatars_objects_select_public on storage.objects
      for select to anon, authenticated
      using (bucket_id = 'avatars');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                 and policyname = 'avatars_objects_insert_own') then
    create policy avatars_objects_insert_own on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = (select auth.uid())::text
        and (select public.is_allowlisted())
      );
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                 and policyname = 'avatars_objects_update_own') then
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
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                 and policyname = 'avatars_objects_delete_own') then
    create policy avatars_objects_delete_own on storage.objects
      for delete to authenticated
      using (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = (select auth.uid())::text
        and (select public.is_allowlisted())
      );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Note 2: a default project role per person
-- ---------------------------------------------------------------------------
-- Workspace admins pick each person's default project role (Viewer, Commenter, or Editor; null = Editor,
-- today's default). It is used whenever someone is added to a project with the role "default": the
-- Share dialog and Members page offer it first, and adding a team that way gives each member their own
-- default. Nothing changes for existing memberships, and an explicit role still wins. While the
-- workspace's Commenter switch is off, a Commenter default adds the person as a Viewer (never more).

alter table public.allowed_emails add column if not exists default_project_role text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'allowed_emails_default_project_role_check') then
    alter table public.allowed_emails add constraint allowed_emails_default_project_role_check
      check (default_project_role is null or default_project_role in ('viewer', 'commenter', 'editor'));
  end if;
end $$;

comment on column public.allowed_emails.default_project_role is
  'The project role this person gets when added to a project with role "default" (Share, Members, a '
  'team added that way): viewer | commenter | editor, null = editor. Set by workspace admins through '
  'set_default_project_role(); a commenter default counts as viewer while the Commenter role is off.';

-- The role "default" means for one address in one workspace (internal; definer callers only).
create or replace function public.default_project_role_for(address text, target_workspace uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when r.role = 'commenter' and not public.commenter_role_allowed(target_workspace) then 'viewer'
    else r.role
  end
  from (
    select coalesce(
      (select a.default_project_role from public.allowed_emails a
       where a.email = lower(btrim(coalesce(address, ''))) and a.removed_at is null),
      'editor'
    ) as role
  ) r;
$$;

revoke all on function public.default_project_role_for(text, uuid) from public, anon, authenticated;

-- Workspace admins set (or clear, with null) someone's default project role.
create or replace function public.set_default_project_role(member_email text, new_role text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  address text := lower(btrim(coalesce(member_email, '')));
  ws uuid := public.default_workspace_id();
  role_value text := nullif(btrim(coalesce(new_role, '')), '');
begin
  if not public.is_workspace_admin(ws) then
    raise exception 'Only workspace admins can change default project roles' using errcode = 'insufficient_privilege';
  end if;
  if role_value is not null and role_value not in ('viewer', 'commenter', 'editor') then
    raise exception 'Choose Viewer, Commenter, or Editor' using errcode = 'check_violation';
  end if;
  if role_value = 'commenter' and not public.commenter_role_allowed(ws) then
    raise exception 'The Commenter role is turned off in this workspace' using errcode = 'check_violation',
      hint = 'Turn it on in Admin console → Security first.';
  end if;
  update public.allowed_emails a set default_project_role = role_value
  where a.email = address and a.removed_at is null;
  if not found then
    raise exception '% isn''t in this workspace', coalesce(nullif(address, ''), 'That address')
      using errcode = 'no_data_found';
  end if;
  return coalesce(role_value, 'editor');
end;
$$;

revoke all on function public.set_default_project_role(text, text) from public, anon;
grant execute on function public.set_default_project_role(text, text) to authenticated;

-- add_project_member: the role "default" becomes the person's default project role, before any check.
select public.alhc_patch_function('public.add_project_member(uuid, text, text)'::regprocedure,
$p$begin
  if public.project_role_rank(caller_role) < public.project_role_rank('admin') then$p$,
$p$begin
  if member_role = 'default' then
    member_role := public.default_project_role_for(
      address, (select p.workspace_id from public.projects p where p.id = target_project)
    );
  end if;
  if public.project_role_rank(caller_role) < public.project_role_rank('admin') then$p$);

-- A team added with "default": each member who isn't in the project yet joins with their own default.
alter table public.team_projects add column if not exists uses_default_roles boolean not null default false;

comment on column public.team_projects.uses_default_roles is
  'True when the team was added with each person''s default project role (role then holds editor, '
  'the fallback default).';

select public.alhc_patch_function('public.add_team_to_project(uuid, uuid, text)'::regprocedure,
$p$  if member_role is null or member_role not in ('admin', 'editor', 'commenter', 'viewer') then
    raise exception 'Choose admin, editor, commenter, or viewer' using errcode = 'check_violation';$p$,
$p$  if member_role is null or member_role not in ('admin', 'editor', 'commenter', 'viewer', 'default') then
    raise exception 'Choose admin, editor, commenter, viewer, or each person''s default' using errcode = 'check_violation';$p$,
$p$  set role = member_role
  where tp.team_id = target_team and tp.project_id = target_project and tp.deleted_at is null;
  if not found then
    insert into public.team_projects (team_id, project_id, role) values (target_team, target_project, member_role);
  end if;$p$,
$p$  set role = case when member_role = 'default' then 'editor' else member_role end,
      uses_default_roles = (member_role = 'default')
  where tp.team_id = target_team and tp.project_id = target_project and tp.deleted_at is null;
  if not found then
    insert into public.team_projects (team_id, project_id, role, uses_default_roles)
    values (target_team, target_project, case when member_role = 'default' then 'editor' else member_role end, member_role = 'default');
  end if;$p$);
