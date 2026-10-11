-- ALHC Projects — Phase: Asana parity, batch 1 (shell and visual system).
-- Mostly UI. The database only gains what the sidebar's Starred section needs:
--
--   Starred projects per person (project_stars): the star toggle on a project's header adds the project
--   to that person's Starred section in the sidebar, on every device, like Asana. One row per person and
--   project; unstarring sets deleted_at (the row is kept), starring again clears it and restamps
--   starred_at. Own rows only (RLS), and a project can only be starred while the person can read it
--   (Viewer+). The sidebar intersects the stars with the projects RLS lets the person read, so a star on
--   a project they've since lost (or that was archived or deleted) shows nothing. Written through the
--   invoker RPC set_project_starred(target_project, starred) or the same RLS directly.
--
-- No new SECURITY DEFINER function; suite 60's list is unchanged. Nothing for anon (alhc_revoke_*).
-- fire_rules, notify_with, notify_message, and add_story are untouched. Additive: the release still on
-- main keeps working once this is applied (it never reads the new table).
-- No statement here needs a row- or object-removal keyword, so there is no tail section.

create table public.project_stars (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null default auth.uid() references public.profiles (id),
  project_id uuid not null references public.projects (id),
  starred_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint project_stars_one_per_project unique (profile_id, project_id)
);

comment on table public.project_stars is
  'Starred projects per person (the sidebar''s Starred section). Own rows only; Viewer+ of the project to '
  'star. Unstarring sets deleted_at; starring again clears it. Written through set_project_starred.';

create index project_stars_project_idx on public.project_stars (project_id);

alter table public.project_stars enable row level security;
revoke all on public.project_stars from anon, authenticated;
grant select on public.project_stars to authenticated;
grant insert (project_id) on public.project_stars to authenticated;
grant update (deleted_at) on public.project_stars to authenticated;

create policy project_stars_select_own on public.project_stars
  for select to authenticated
  using (project_stars.profile_id = (select auth.uid()));

create policy project_stars_insert_own_viewer on public.project_stars
  for insert to authenticated
  with check (
    project_stars.profile_id = (select auth.uid())
    and (select public.has_project_role(project_stars.project_id, 'viewer'))
  );

-- Unstarring needs no project role (so a star on a project you've lost can still be cleared); starring
-- again (deleted_at back to null) needs Viewer+ like the first star.
create policy project_stars_update_own on public.project_stars
  for update to authenticated
  using (project_stars.profile_id = (select auth.uid()))
  with check (
    project_stars.profile_id = (select auth.uid())
    and (
      project_stars.deleted_at is not null
      or (select public.has_project_role(project_stars.project_id, 'viewer'))
    )
  );

-- Invoker guard: the owner is the caller on client inserts; owner, project, and creation time never
-- change; starred_at is stamped on every (re)star.
create or replace function public.guard_project_star()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if public.is_client_role() then
      new.profile_id := auth.uid();
    end if;
    new.created_at := now();
    new.starred_at := clock_timestamp();
    new.deleted_at := null;
  else
    if new.profile_id is distinct from old.profile_id or new.project_id is distinct from old.project_id
       or new.created_at is distinct from old.created_at then
      raise exception 'A star can’t be moved' using errcode = 'insufficient_privilege';
    end if;
    if old.deleted_at is not null and new.deleted_at is null then
      new.starred_at := clock_timestamp();
    elsif new.starred_at is distinct from old.starred_at then
      new.starred_at := old.starred_at;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

select public.alhc_revoke_anon_execute(array['guard_project_star()']);
grant execute on function public.guard_project_star() to authenticated;

create trigger project_stars_05_guard
  before insert or update on public.project_stars
  for each row execute function public.guard_project_star();

select public.alhc_revoke_anon_grants(array['project_stars']);

-- Star or unstar a project for the caller. Starring needs Viewer+ (no_data_found otherwise, so a
-- project's existence never leaks); unstarring always succeeds (a no-op without a star). Returns
-- whether the project is now starred.
create or replace function public.set_project_starred(target_project uuid, starred boolean)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if starred then
    if not public.has_project_role(target_project, 'viewer') then
      raise exception 'Project not found' using errcode = 'no_data_found';
    end if;
    insert into public.project_stars as s (project_id)
    values (target_project)
    on conflict (profile_id, project_id) do update set deleted_at = null
    where s.deleted_at is not null;
    return true;
  end if;
  update public.project_stars
  set deleted_at = now()
  where profile_id = auth.uid() and project_id = target_project and deleted_at is null;
  return false;
end;
$$;

select public.alhc_revoke_anon_execute(array['set_project_starred(uuid,boolean)']);
grant execute on function public.set_project_starred(uuid, boolean) to authenticated;
