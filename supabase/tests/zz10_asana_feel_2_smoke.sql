-- Behavioural checks for Phase: Asana feel, batch 2: the default team, project teams and visibility,
-- workspace invites with pending memberships applied on first sign-in, removing an email without
-- touching the person's work, browse / join, workspace settings, and the invite email.
-- Fresh people for this suite:
--   fafa…01 af2-admin@example.com    workspace admin (no project memberships of their own)
--   fafa…02 af2-owner@example.com    owner of the suite's projects
--   fafa…03 af2-member@example.com   signed in, no memberships
--   (later) af2-new@example.com      invited, signs up during the suite

\set ON_ERROR_STOP 1

create temporary table af2_ids (name text primary key, id uuid) on commit preserve rows;
grant all on af2_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('af2-admin@example.com', 'asana feel 2 suite'),
  ('af2-owner@example.com', 'asana feel 2 suite'),
  ('af2-member@example.com', 'asana feel 2 suite');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('fafafafa-0000-4000-8000-000000000001', 'af2-admin@example.com', now(), '{"full_name":"Ada Admin"}'),
  ('fafafafa-0000-4000-8000-000000000002', 'af2-owner@example.com', now(), '{"full_name":"Oona Owner"}'),
  ('fafafafa-0000-4000-8000-000000000003', 'af2-member@example.com', now(), '{"full_name":"Milo Member"}');
insert into public.workspace_admins (workspace_id, profile_id)
values ('00000000-0000-4000-8000-000000000001', 'fafafafa-0000-4000-8000-000000000001');

-- The default team ------------------------------------------------------------------------------------

do $$
declare
  team uuid := (select default_team_id from public.workspaces where id = '00000000-0000-4000-8000-000000000001');
begin
  assert team is not null, 'the workspace has a default team';
  assert (select name from public.teams where id = team) = 'Autumn Lake', 'created as Autumn Lake';
  assert not exists (select 1 from public.projects where team_id is null), 'every project has a team';
  assert (select attnotnull from pg_attribute where attrelid = 'public.projects'::regclass and attname = 'team_id'),
    'projects.team_id is required';
  assert (
    select count(*) from public.team_members
    where team_id = team and deleted_at is null and profile_id in (
      'fafafafa-0000-4000-8000-000000000001', 'fafafafa-0000-4000-8000-000000000002', 'fafafafa-0000-4000-8000-000000000003')
  ) = 3, 'new workspace members join the default team on first sign-in';
  insert into af2_ids values ('default_team', team);
end $$;

-- Leaving the default team sticks: a later profile update doesn't put them back.
set role authenticated;
select set_config('request.jwt.claim.sub', 'fafafafa-0000-4000-8000-000000000003', false) is not null as ok \gset
select public.remove_team_member((select id from af2_ids where name = 'default_team'), 'fafafafa-0000-4000-8000-000000000003');
reset role;
update auth.users set raw_user_meta_data = '{"full_name":"Milo M. Member"}' where id = 'fafafafa-0000-4000-8000-000000000003';
do $$
begin
  assert not exists (
    select 1 from public.team_members
    where team_id = (select id from af2_ids where name = 'default_team')
      and profile_id = 'fafafafa-0000-4000-8000-000000000003' and deleted_at is null
  ), 'someone who left the default team isn''t added back';
  -- Re-join for the rest of the suite (the default team is open to everyone: the admin adds them).
  insert into public.team_members (team_id, profile_id, role)
  values ((select id from af2_ids where name = 'default_team'), 'fafafafa-0000-4000-8000-000000000003', 'member');
end $$;

-- Projects pick a team ----------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'fafafafa-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  default_team uuid := (select id from af2_ids where name = 'default_team');
  other_team uuid;
  p_private uuid;
  p_team uuid;
  p_other uuid;
  p_archived uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'AF2 Private') returning id into p_private;
  assert (select team_id from public.projects where id = p_private) = default_team, 'no team chosen: the default team';
  assert (select visibility from public.projects where id = p_private) = 'private', 'projects are private by default';

  insert into public.projects (workspace_id, name, team_id, visibility)
  values (ws, 'AF2 Team', default_team, 'team') returning id into p_team;

  insert into public.teams (name) values ('AF2 Design') returning id into other_team;
  insert into public.projects (workspace_id, name, team_id, visibility)
  values (ws, 'AF2 Design work', other_team, 'team') returning id into p_other;
  insert into public.projects (workspace_id, name, team_id, visibility)
  values (ws, 'AF2 Archived', default_team, 'team') returning id into p_archived;
  perform public.set_project_archived(p_archived, true);

  begin
    update public.projects set visibility = 'everyone' where id = p_team;
    raise exception 'unknown visibility is refused';
  exception when check_violation then null;
  end;

  insert into af2_ids values ('p_private', p_private), ('p_team', p_team), ('p_other', p_other),
    ('p_archived', p_archived), ('other_team', other_team);
end $$;

-- Someone outside a team can't put a project in it, but the default team is open to everyone.
select set_config('request.jwt.claim.sub', 'fafafafa-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  mine uuid;
begin
  begin
    insert into public.projects (workspace_id, name, team_id) values (ws, 'AF2 Not mine', (select id from af2_ids where name = 'other_team'));
    raise exception 'a team you aren''t in is refused';
  exception when insufficient_privilege then null;
  end;
  insert into public.projects (workspace_id, name, team_id)
  values (ws, 'AF2 Member project', (select id from af2_ids where name = 'default_team')) returning id into mine;
  begin
    update public.projects set team_id = (select id from af2_ids where name = 'other_team') where id = mine;
    raise exception 'moving into a team you aren''t in is refused';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Browse and join -----------------------------------------------------------------------------------------

do $$
declare
  p_private uuid := (select id from af2_ids where name = 'p_private');
  p_team uuid := (select id from af2_ids where name = 'p_team');
  p_other uuid := (select id from af2_ids where name = 'p_other');
  p_archived uuid := (select id from af2_ids where name = 'p_archived');
begin
  assert exists (select 1 from public.browse_projects() where project_id = p_team and my_role is null),
    'a team-visible project of my team is listed, not joined yet';
  assert not exists (select 1 from public.browse_projects() where project_id = p_private), 'private projects stay hidden';
  assert not exists (select 1 from public.browse_projects() where project_id = p_other), 'other teams'' projects stay hidden';
  assert exists (select 1 from public.browse_projects((select id from af2_ids where name = 'default_team')) where project_id = p_team),
    'filtering by team works';
  assert not exists (select 1 from public.browse_projects((select id from af2_ids where name = 'other_team'))),
    'nothing from a team I''m not in';

  begin
    perform public.join_project(p_private);
    raise exception 'private projects can''t be joined';
  exception when no_data_found then null;
  end;
  begin
    perform public.join_project(p_other);
    raise exception 'another team''s project can''t be joined';
  exception when no_data_found then null;
  end;
  begin
    perform public.join_project(p_archived);
    raise exception 'archived projects can''t be joined';
  exception when check_violation then null;
  end;

  assert public.join_project(p_team) = 'editor', 'joining makes you an Editor';
  assert public.project_role(p_team) = 'editor', 'and the project is open to you';
  assert public.join_project(p_team) = 'editor', 'joining again changes nothing';
  assert (select my_role from public.browse_projects() where project_id = p_team) = 'editor', 'browse shows the role';
end $$;

-- A workspace admin doesn't see private projects they aren't in, nor join them.
select set_config('request.jwt.claim.sub', 'fafafafa-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
begin
  assert public.is_workspace_admin(), 'the suite''s admin is a workspace admin';
  assert not exists (select 1 from public.browse_projects() where project_id = (select id from af2_ids where name = 'p_private')),
    'workspace admins don''t see private projects';
  begin
    perform public.join_project((select id from af2_ids where name = 'p_private'));
    raise exception 'workspace admins can''t join private projects';
  exception when no_data_found then null;
  end;
  assert not exists (select 1 from public.projects where id = (select id from af2_ids where name = 'p_private')),
    'and still can''t read them';
end $$;

-- Workspace invites -----------------------------------------------------------------------------------------

do $$
declare
  result jsonb;
  outbox public.email_outbox;
begin
  result := public.invite_to_workspace('  AF2-New@Example.com ');
  assert result ->> 'status' = 'invited' and result ->> 'email' = 'af2-new@example.com', 'the admin invites an email';
  assert (select invited_by from public.allowed_emails where email = 'af2-new@example.com') = 'fafafafa-0000-4000-8000-000000000001',
    'the allowlist records who invited them';

  select * into outbox from public.email_outbox where id = (result ->> 'email_id')::uuid;
  assert outbox.to_email = 'af2-new@example.com' and outbox.template = 'custom' and outbox.task_id is null
    and outbox.payload ->> 'kind' = 'invite' and outbox.subject = 'You''ve been invited to ALHC Projects',
    'an invite email is queued through the outbox';
  assert outbox.payload ->> 'inviter_name' = 'Ada Admin', 'it names the inviter';
  assert position('@' in outbox.payload::text) = 0, 'the payload carries no email address';
  assert (select count(*) from public.email_outbox where to_email = 'af2-new@example.com') = 1,
    'workspace admins can read invite emails';

  assert public.invite_to_workspace('af2-new@example.com') ->> 'status' = 'already_invited', 'inviting twice changes nothing';
  assert public.invite_to_workspace('af2-member@example.com') ->> 'status' = 'already_member', 'members are left as they are';
  begin
    perform public.resend_workspace_invite('af2-new@example.com');
    raise exception 'resending right away is refused';
  exception when check_violation then null;
  end;
  begin
    perform public.resend_workspace_invite('af2-member@example.com');
    raise exception 'someone who signed in gets no invite';
  exception when check_violation then null;
  end;
  begin
    perform public.invite_to_workspace('not an email');
    raise exception 'bad addresses are refused';
  exception when check_violation then null;
  end;
  begin
    perform public.add_workspace_admin(null, 'af2-new@example.com');
    raise exception 'admins must have signed in';
  exception when check_violation then null;
  end;
end $$;

-- Pending memberships: a project owner, a team lead / workspace admin, and a portfolio admin add the
-- invitee before they sign in.
do $$
declare
  team uuid := (select id from af2_ids where name = 'other_team');
begin
  assert public.add_team_member(team, 'af2-new@example.com', 'lead') is null, 'a pending team invite (workspace admin)';
  assert (select role from public.pending_memberships where team_id = team and email = 'af2-new@example.com') = 'lead',
    'stored with its role';
end $$;

select set_config('request.jwt.claim.sub', 'fafafafa-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from af2_ids where name = 'p_private');
  pf uuid;
begin
  assert public.add_project_member(p, 'af2-new@example.com', 'commenter') is null, 'a pending project invite';
  assert public.add_project_member(p, 'af2-new@example.com', 'editor') is null, 'inviting again changes the role';
  assert (select count(*) from public.pending_memberships where project_id = p and applied_at is null and deleted_at is null) = 1
    and (select role from public.pending_memberships where project_id = p and applied_at is null) = 'editor',
    'one pending row, with the new role';
  begin
    perform public.add_project_member(p, 'af2-new@example.com', 'owner');
    raise exception 'pending owners are refused';
  exception when check_violation then null;
  end;
  begin
    perform public.add_project_member(p, 'nobody@example.com', 'editor');
    raise exception 'people outside the workspace are refused';
  exception when check_violation then null;
  end;

  insert into public.portfolios (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'AF2 Portfolio') returning id into pf;
  assert public.add_portfolio_member(pf, 'af2-new@example.com', 'editor') is null, 'a pending portfolio invite';
  insert into af2_ids values ('pf', pf);
end $$;

-- Pending invites are visible with the project; not to outsiders. Invite emails stay admin-only.
select set_config('request.jwt.claim.sub', 'fafafafa-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
begin
  assert not exists (select 1 from public.pending_memberships where project_id = (select id from af2_ids where name = 'p_private')),
    'non-members don''t see a project''s pending invites';
  assert exists (select 1 from public.pending_memberships where team_id = (select id from af2_ids where name = 'other_team')),
    'team invites are visible like the team';
  assert not exists (select 1 from public.email_outbox where to_email = 'af2-new@example.com'), 'members can''t read invite emails';
  begin
    perform public.invite_to_workspace('someone@example.com');
    raise exception 'members can''t invite to the workspace';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.remove_workspace_member('af2-owner@example.com');
    raise exception 'members can''t remove people';
  exception when insufficient_privilege then null;
  end;
  update public.pending_memberships set deleted_at = now() where team_id = (select id from af2_ids where name = 'other_team');
  assert (select deleted_at from public.pending_memberships where team_id = (select id from af2_ids where name = 'other_team')) is null,
    'only team managers cancel team invites';
end $$;

-- First sign-in: unconfirmed does nothing; confirming applies every pending invite.
reset role;
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
values ('fafafafa-0000-4000-8000-000000000004', 'af2-new@example.com', null, '{"full_name":"Nia New"}');

do $$
declare
  newbie uuid := 'fafafafa-0000-4000-8000-000000000004';
begin
  assert not exists (select 1 from public.project_members where profile_id = newbie), 'nothing before the email is confirmed';
  assert not exists (select 1 from public.team_members where profile_id = newbie), 'not even the default team';
end $$;

update auth.users set email_confirmed_at = now() where id = 'fafafafa-0000-4000-8000-000000000004';

do $$
declare
  newbie uuid := 'fafafafa-0000-4000-8000-000000000004';
begin
  assert (select role from public.project_members where profile_id = newbie and project_id = (select id from af2_ids where name = 'p_private')
          and deleted_at is null) = 'editor', 'the project invite became a membership';
  assert (select created_by from public.project_members where profile_id = newbie and deleted_at is null
          and project_id = (select id from af2_ids where name = 'p_private')) = 'fafafafa-0000-4000-8000-000000000002',
    'credited to the inviter';
  assert (select role from public.team_members where profile_id = newbie and team_id = (select id from af2_ids where name = 'other_team')
          and deleted_at is null) = 'lead', 'the team invite applied';
  assert (select role from public.portfolio_members where profile_id = newbie and portfolio_id = (select id from af2_ids where name = 'pf')
          and deleted_at is null) = 'editor', 'the portfolio invite applied';
  assert exists (select 1 from public.team_members where profile_id = newbie and deleted_at is null
                 and team_id = (select id from af2_ids where name = 'default_team')), 'and they joined the default team';
  assert not exists (select 1 from public.pending_memberships where email = 'af2-new@example.com' and applied_at is null and deleted_at is null),
    'every pending invite is used';
  assert (select count(*) from public.pending_memberships where applied_profile_id = newbie) = 3, 'and records who used it';
end $$;

-- Removing an email: sign-in stops, the work stays; re-adding restores access.
set role authenticated;
select set_config('request.jwt.claim.sub', 'fafafafa-0000-4000-8000-000000000004', false) is not null as ok \gset

do $$
declare
  t uuid;
begin
  assert public.is_allowlisted(), 'the new person is in';
  t := public.create_task((select id from af2_ids where name = 'p_private'), null, 'AF2 by Nia');
  insert into af2_ids values ('nia_task', t);
end $$;

select set_config('request.jwt.claim.sub', 'fafafafa-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
begin
  begin
    perform public.remove_workspace_member('af2-admin@example.com');
    raise exception 'admins can''t remove themselves';
  exception when check_violation then null;
  end;
  perform public.remove_workspace_member('af2-new@example.com');
  assert (select removed_at from public.allowed_emails where email = 'af2-new@example.com') is not null, 'the email is marked removed';
  assert (select removed_by from public.allowed_emails where email = 'af2-new@example.com') = 'fafafafa-0000-4000-8000-000000000001',
    'by whom';
  begin
    perform public.remove_workspace_member('af2-new@example.com');
    raise exception 'removing twice reports it';
  exception when no_data_found then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'fafafafa-0000-4000-8000-000000000004', false) is not null as ok \gset

do $$
begin
  assert not public.is_allowlisted(), 'a removed email can''t use the app';
  assert not exists (select 1 from public.projects), 'and reads nothing';
end $$;

reset role;

do $$
begin
  assert exists (select 1 from public.profiles where id = 'fafafafa-0000-4000-8000-000000000004'), 'their profile stays';
  assert exists (select 1 from public.tasks where id = (select id from af2_ids where name = 'nia_task') and deleted_at is null),
    'their tasks stay';
  assert exists (select 1 from public.project_members where profile_id = 'fafafafa-0000-4000-8000-000000000004' and deleted_at is null),
    'their memberships stay (re-adding restores access)';
  assert not public.profile_in_workspace('fafafafa-0000-4000-8000-000000000004'), 'they no longer count as in the workspace';
end $$;

-- A pending invite for a removed email is cancelled, and its queued email isn't sent.
set role authenticated;
select set_config('request.jwt.claim.sub', 'fafafafa-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  perform public.invite_to_workspace('af2-later@example.com');
end $$;
select set_config('request.jwt.claim.sub', 'fafafafa-0000-4000-8000-000000000002', false) is not null as ok \gset
select public.add_project_member((select id from af2_ids where name = 'p_team'), 'af2-later@example.com', 'viewer') is null as pending;
select set_config('request.jwt.claim.sub', 'fafafafa-0000-4000-8000-000000000001', false) is not null as ok \gset
select public.remove_workspace_member('af2-later@example.com');
reset role;

do $$
begin
  assert (select deleted_at from public.pending_memberships where email = 'af2-later@example.com') is not null,
    'removing an email cancels its pending invites';
end $$;

set role service_role;
select count(*) >= 0 as claimed from public.claim_email_deliveries(100, null);
reset role;

do $$
begin
  assert (select status from public.email_outbox where to_email = 'af2-later@example.com') = 'failed'
    and (select last_error from public.email_outbox where to_email = 'af2-later@example.com') = 'Not sent: the invite was withdrawn',
    'a withdrawn invite email fails at claim instead of going out';
end $$;

-- Adding the email back restores access (and emails a fresh invite).
set role authenticated;
select set_config('request.jwt.claim.sub', 'fafafafa-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  assert public.invite_to_workspace('af2-new@example.com') ->> 'status' = 'restored', 're-adding a removed email restores it';
end $$;
select set_config('request.jwt.claim.sub', 'fafafafa-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  assert public.is_allowlisted(), 'access is back';
  assert public.project_role((select id from af2_ids where name = 'p_private')) = 'editor', 'with the same memberships';
end $$;

-- Teams: the default team can't be removed; removing another team moves its projects ------------------

select set_config('request.jwt.claim.sub', 'fafafafa-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  default_team uuid := (select id from af2_ids where name = 'default_team');
  other_team uuid := (select id from af2_ids where name = 'other_team');
begin
  begin
    update public.teams set deleted_at = now() where id = default_team;
    raise exception 'the default team can''t be removed';
  exception when check_violation then null;
  end;
  update public.teams set deleted_at = now() where id = other_team;
end $$;

reset role;

do $$
begin
  assert (select team_id from public.projects where id = (select id from af2_ids where name = 'p_other'))
    = (select id from af2_ids where name = 'default_team'), 'a removed team''s projects move to the default team';
end $$;

-- Workspace settings ----------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'fafafafa-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
begin
  update public.workspaces set name = 'Hijacked' where id = '00000000-0000-4000-8000-000000000001';
  assert (select name from public.workspaces where id = '00000000-0000-4000-8000-000000000001') = 'ALHC',
    'members can''t change workspace settings';
end $$;

select set_config('request.jwt.claim.sub', 'fafafafa-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  team uuid;
begin
  update public.workspaces
  set name = '  Autumn Lake Marketing ', email_sender_name = ' ALHC Marketing ', logo_path = ws::text || '/logo.png'
  where id = ws;
  assert (select name from public.workspaces where id = ws) = 'Autumn Lake Marketing', 'admins rename the workspace';
  assert (select email_sender_name from public.workspaces where id = ws) = 'ALHC Marketing', 'and set the sender name';
  begin
    update public.workspaces set email_sender_name = 'Evil <x@example.com>' where id = ws;
    raise exception 'sender names can''t carry an address';
  exception when check_violation then null;
  end;
  begin
    update public.workspaces set logo_path = '11111111-1111-4111-8111-111111111111/logo.png' where id = ws;
    raise exception 'the logo lives in the workspace''s folder';
  exception when check_violation then null;
  end;
  begin
    update public.workspaces set default_team_id = (select id from af2_ids where name = 'other_team') where id = ws;
    raise exception 'a removed team can''t be the default';
  exception when check_violation then null;
  end;
  begin
    update public.workspaces set deleted_at = now() where id = ws;
    raise exception 'only the settings columns are writable';
  exception when insufficient_privilege then null;
  end;
  insert into public.teams (name) values ('AF2 New default') returning id into team;
  update public.workspaces set default_team_id = team where id = ws;
  assert (select default_team_id from public.workspaces where id = ws) = team, 'admins pick another default team';
  update public.workspaces set default_team_id = (select id from af2_ids where name = 'default_team'), name = 'ALHC', email_sender_name = null,
    logo_path = null
  where id = ws;
end $$;

reset role;

-- anon and the definer surface -------------------------------------------------------------------------------

do $$
begin
  assert not has_table_privilege('anon', 'public.pending_memberships', 'select, insert, update'), 'anon gets nothing';
  assert not has_function_privilege('anon', 'public.browse_projects(uuid)', 'execute'), 'anon can''t browse';
  assert not has_function_privilege('anon', 'public.join_project(uuid)', 'execute'), 'anon can''t join';
  assert not has_function_privilege('anon', 'public.invite_to_workspace(text)', 'execute'), 'anon can''t invite';
  assert not has_function_privilege('authenticated', 'public.apply_pending_memberships(uuid)', 'execute'),
    'applying invites is internal';
  assert not has_function_privilege('authenticated', 'public.queue_pending_membership(text,text,uuid,text)', 'execute'),
    'queueing invites is internal';
  assert not has_function_privilege('authenticated', 'public.ensure_default_team(uuid)', 'execute'), 'internal';
  assert exists (select 1 from storage.buckets where id = 'workspace-assets' and public), 'the logo bucket is public';
end $$;

select 'zz10 asana feel 2 smoke: ok' as result;
