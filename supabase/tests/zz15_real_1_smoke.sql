-- Behavioural checks for Phase: Real features 1 (invites and email-in): invites by email that allowlist
-- (workspace admins only) and email the invitee with Resend / Cancel (pending_memberships.resent_at,
-- the invite email trigger, invite_email_block_reason, the outbox policy), attachment questions on forms
-- (form_upload_allowed + the anon Storage insert policy, submit_form), and forwarding addresses
-- (email_forwarding_addresses, post_email_forward, attach_forwarded_file, email_forwards).
-- Fresh people for this suite:
--   abab…01 r1-admin@example.com   workspace admin; owner of R1 Admin P, R1 Admin Portfolio; lead of R1 Admin Team;
--                                  not in R1 P
--   abab…02 r1-owner@example.com   owner of R1 P (private) and its forms; lead of R1 Team; not a workspace admin
--   abab…03 r1-viewer@example.com  Viewer of R1 P
--   abab…04 r1-editor@example.com  Editor of R1 P (forwards emails)
--   abab…05 r1-gone@example.com    signed in once, then removed from the workspace
-- Addresses that never signed in: r1-later@ (allowlisted), r1-new@ / r1-team-new@ / r1-folio-new@ (not).

\set ON_ERROR_STOP 1

create temporary table r1_ids (name text primary key, id uuid) on commit preserve rows;
grant all on r1_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('r1-admin@example.com', 'real 1 suite'),
  ('r1-owner@example.com', 'real 1 suite'),
  ('r1-viewer@example.com', 'real 1 suite'),
  ('r1-editor@example.com', 'real 1 suite'),
  ('r1-gone@example.com', 'real 1 suite'),
  ('r1-later@example.com', 'real 1 suite');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('abababab-0000-4000-8000-000000000001', 'r1-admin@example.com', now(), '{"full_name":"Ada Admin"}'),
  ('abababab-0000-4000-8000-000000000002', 'r1-owner@example.com', now(), '{"full_name":"Owen Owner"}'),
  ('abababab-0000-4000-8000-000000000003', 'r1-viewer@example.com', now(), '{"full_name":"Vera Viewer"}'),
  ('abababab-0000-4000-8000-000000000004', 'r1-editor@example.com', now(), '{"full_name":"Eddie Editor"}'),
  ('abababab-0000-4000-8000-000000000005', 'r1-gone@example.com', now(), '{"full_name":"Gil Gone"}');
insert into public.workspace_admins (workspace_id, profile_id)
values ('00000000-0000-4000-8000-000000000001', 'abababab-0000-4000-8000-000000000001');

-- EXECUTE surface and grants --------------------------------------------------------------------------

do $$
begin
  assert has_function_privilege('anon', 'alhc_storage.form_upload_allowed(text)', 'execute')
    and has_schema_privilege('anon', 'alhc_storage', 'usage')
    and not has_function_privilege('authenticated', 'alhc_storage.form_upload_allowed(text)', 'execute')
    and (select prosecdef from pg_proc where oid = 'alhc_storage.form_upload_allowed(text)'::regprocedure),
    'form_upload_allowed: definer, anon only (the Storage insert check for anonymous form uploads)';
  assert to_regprocedure('public.form_upload_allowed(text)') is null
    and not has_schema_privilege('authenticated', 'alhc_storage', 'usage'),
    'it lives outside public, so the API can''t call it as an RPC';
  assert not has_function_privilege('authenticated', 'public.list_stale_form_uploads(integer)', 'execute')
    and not has_function_privilege('anon', 'public.list_stale_form_uploads(integer)', 'execute')
    and has_function_privilege('service_role', 'public.list_stale_form_uploads(integer)', 'execute'),
    'the stale-upload list is service_role only';
  assert not has_function_privilege('authenticated', 'public.form_upload_display_name(text, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.form_upload_size(jsonb)', 'execute'), 'form upload helpers are internal';
  assert exists (
    select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'task_attachments_objects_insert_form_upload' and roles = '{anon}' and cmd = 'INSERT'
  ), 'anon may only insert form uploads';
  -- Oct 25 notes: the one exception is public select on profile pictures (avatars bucket only).
  assert not exists (
    select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and 'anon' = any (roles) and cmd <> 'INSERT'
      and not (policyname = 'avatars_objects_select_public' and cmd = 'SELECT' and qual = '(bucket_id = ''avatars''::text)')
  ), 'anon reads nothing in Storage but profile pictures';
  assert not has_function_privilege('authenticated', 'public.post_email_forward(text, text, boolean, text, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.post_email_forward(text, text, boolean, text, text, text)', 'execute')
    and has_function_privilege('service_role', 'public.post_email_forward(text, text, boolean, text, text, text)', 'execute'),
    'post_email_forward is service_role only';
  assert not has_function_privilege('authenticated', 'public.attach_forwarded_file(uuid, text, text, text, bigint)', 'execute')
    and not has_function_privilege('anon', 'public.attach_forwarded_file(uuid, text, text, text, bigint)', 'execute')
    and has_function_privilege('service_role', 'public.attach_forwarded_file(uuid, text, text, text, bigint)', 'execute'),
    'attach_forwarded_file is service_role only';
  assert not has_function_privilege('authenticated', 'public.log_email_forward(text, uuid, uuid, uuid, uuid, text, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.queue_pending_invite_email(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.on_pending_membership_invite()', 'execute')
    and not has_function_privilege('anon', 'public.queue_pending_invite_email(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.form_upload_file_name(text)', 'execute')
    and not has_function_privilege('authenticated', 'public.form_upload_extension_ok(text)', 'execute'),
    'internal helpers are revoked';
  assert has_function_privilege('authenticated', 'public.my_forwarding_address()', 'execute')
    and has_function_privilege('authenticated', 'public.rotate_forwarding_address()', 'execute')
    and has_function_privilege('authenticated', 'public.allowlist_for_invite(text, uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.can_manage_pending_invite(text)', 'execute')
    and not has_function_privilege('anon', 'public.my_forwarding_address()', 'execute')
    and not has_function_privilege('anon', 'public.allowlist_for_invite(text, uuid)', 'execute'),
    'the invoker RPCs are for signed-in people';
  assert not (select prosecdef from pg_proc where oid = 'public.my_forwarding_address()'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.rotate_forwarding_address()'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.allowlist_for_invite(text, uuid)'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.can_manage_pending_invite(text)'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.guard_email_forwarding_address()'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.guard_task_attachment_source()'::regprocedure),
    'everything signed-in people call is invoker';
  assert not has_column_privilege('authenticated', 'public.email_forwarding_addresses', 'token', 'insert')
    and not has_column_privilege('authenticated', 'public.email_forwarding_addresses', 'token', 'update')
    and not has_column_privilege('authenticated', 'public.email_forwarding_addresses', 'profile_id', 'update')
    and has_column_privilege('authenticated', 'public.email_forwarding_addresses', 'default_project_id', 'update')
    and not has_table_privilege('authenticated', 'public.email_forwarding_addresses', 'delete'),
    'forwarding addresses: the token is never the client''s';
  assert not has_column_privilege('authenticated', 'public.email_forwards', 'provider_id', 'select')
    and not has_column_privilege('authenticated', 'public.email_forwards', 'address_id', 'select')
    and has_column_privilege('authenticated', 'public.email_forwards', 'status', 'select')
    and not has_table_privilege('authenticated', 'public.email_forwards', 'insert')
    and not has_table_privilege('authenticated', 'public.email_forwards', 'update'),
    'the forward log: read own status rows only, never written by clients';
  assert has_column_privilege('authenticated', 'public.pending_memberships', 'resent_at', 'update')
    and not has_column_privilege('authenticated', 'public.pending_memberships', 'resent_at', 'insert'),
    'Resend is an update of resent_at';
  assert (select relrowsecurity from pg_class where oid = 'public.email_forwarding_addresses'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.email_forwards'::regclass), 'RLS is on';
end $$;

-- Setup ------------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'abababab-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  team uuid;
  p uuid;
  pf uuid;
  f uuid;
begin
  insert into public.teams (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'R1 Team') returning id into team;
  insert into r1_ids values ('team', team);
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'R1 P') returning id into p;
  perform public.add_project_member(p, 'r1-viewer@example.com', 'viewer');
  perform public.add_project_member(p, 'r1-editor@example.com', 'editor');
  insert into r1_ids values ('p', p);
  insert into public.sections (project_id, name, sort_order) values (p, 'Inbox', 1024);
  insert into public.sections (project_id, name, sort_order) values (p, 'Doing', 2048);

  insert into public.forms (project_id, title, accepting_responses, questions) values (p, 'R1 Form', true,
    '[{"id": "q1", "type": "short_text", "label": "What do you need?", "maps_to": {"target": "title"}},
      {"id": "files", "type": "attachment", "label": "Files", "required": true}]')
  returning id into f;
  insert into r1_ids values ('form', f);
  insert into public.forms (project_id, title, accepting_responses, questions) values (p, 'R1 No files', true,
    '[{"id": "q1", "type": "short_text", "label": "What?"}]')
  returning id into f;
  insert into r1_ids values ('form_plain', f);
  insert into public.forms (project_id, title, accepting_responses, questions) values (p, 'R1 Closed', false,
    '[{"id": "files", "type": "attachment", "label": "Files"}]')
  returning id into f;
  insert into r1_ids values ('form_closed', f);

  insert into public.portfolios (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'R1 Portfolio') returning id into pf;
  insert into r1_ids values ('portfolio', pf);
end $$;

select set_config('request.jwt.claim.sub', 'abababab-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  team uuid;
  p uuid;
  pf uuid;
begin
  insert into public.teams (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'R1 Admin Team') returning id into team;
  insert into r1_ids values ('admin_team', team);
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'R1 Admin P') returning id into p;
  insert into r1_ids values ('admin_p', p);
  insert into public.portfolios (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'R1 Admin Portfolio') returning id into pf;
  insert into r1_ids values ('admin_portfolio', pf);
  perform public.add_team_member(team, 'r1-gone@example.com', 'member');
  perform public.remove_workspace_member('r1-gone@example.com');
end $$;
reset role;

-- Invites ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'abababab-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from r1_ids where name = 'p');
  pm public.pending_memberships;
  o public.email_outbox;
begin
  -- Someone who isn't a workspace admin still can't bring a new address into the workspace.
  begin
    perform public.add_project_member(p, 'r1-stranger@example.com', 'editor');
    raise exception 'a non-admin added a stranger';
  exception when check_violation then
    assert sqlerrm like '%isn''t in this workspace yet%', sqlerrm;
  end;
  assert not exists (select 1 from public.allowed_emails where email = 'r1-stranger@example.com'), 'nothing was allowlisted';
  assert not public.allowlist_for_invite('r1-stranger@example.com', '00000000-0000-4000-8000-000000000001'),
    'the helper refuses non-admins too';
  begin
    perform public.add_project_member(p, 'r1-gone@example.com', 'editor');
    raise exception 'a non-admin brought back a removed member';
  exception when check_violation then null;
  end;

  -- An allowlisted address that hasn't signed in: a pending invite and one invite email about R1 P.
  assert public.add_project_member(p, 'r1-later@example.com', 'commenter') is null, 'pending invite';
  select * into pm from public.pending_memberships where project_id = p and email = 'r1-later@example.com' and deleted_at is null;
  assert pm.role = 'commenter' and pm.resent_at is null, 'the pending row';
  assert (select count(*) from public.email_outbox where to_email = 'r1-later@example.com') = 1, 'one invite email';
  select * into o from public.email_outbox where to_email = 'r1-later@example.com';
  assert o.task_id is null and o.template = 'custom' and o.status = 'pending', 'queued like a workspace invite';
  assert o.payload ->> 'kind' = 'invite' and o.payload ->> 'pending_id' = pm.id::text
    and o.payload ->> 'target_kind' = 'project' and o.payload ->> 'target_name' = 'R1 P'
    and o.payload ->> 'target_path' = '/projects/' || p::text and o.payload ->> 'role' = 'commenter'
    and o.payload ->> 'inviter_name' = 'Owen Owner', o.payload::text;
  assert position('@' in o.payload::text) = 0, 'no address in the payload';
  assert o.subject = 'Owen Owner invited you to R1 P', o.subject;

  -- Re-inviting with another role re-roles the same invite and sends nothing new.
  assert public.add_project_member(p, 'r1-later@example.com', 'editor') is null, 'still pending';
  assert (select count(*) from public.pending_memberships where project_id = p and email = 'r1-later@example.com' and deleted_at is null) = 1
    and (select role from public.pending_memberships where id = pm.id) = 'editor', 'one invite, new role';
  assert (select count(*) from public.email_outbox where to_email = 'r1-later@example.com') = 1, 'no second email';

  -- Resend right away: refused (one email every 10 minutes).
  begin
    update public.pending_memberships set resent_at = now() where id = pm.id;
    raise exception 'an immediate resend went through';
  exception when check_violation then
    assert sqlerrm like 'An invite was just sent%', sqlerrm;
  end;
  insert into r1_ids values ('later_invite', pm.id);
end $$;

-- Viewers can't resend (the update policy is for managers); nor read the invite email.
select set_config('request.jwt.claim.sub', 'abababab-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  n integer;
begin
  update public.pending_memberships set resent_at = now() where id = (select id from r1_ids where name = 'later_invite');
  get diagnostics n = row_count;
  assert n = 0, 'a viewer can''t resend';
  assert not exists (select 1 from public.email_outbox where to_email = 'r1-later@example.com'), 'a viewer can''t read the invite email';
  assert not public.can_manage_pending_invite((select id::text from r1_ids where name = 'later_invite')), 'not a manager';
end $$;

-- A workspace admin who isn't in the private project gets nothing: no invite, no email, no invite row.
select set_config('request.jwt.claim.sub', 'abababab-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  begin
    perform public.add_project_member((select id from r1_ids where name = 'p'), 'r1-new@example.com', 'editor');
    raise exception 'a workspace admin invited into a project they aren''t in';
  exception when insufficient_privilege then null;
  end;
  assert not exists (select 1 from public.allowed_emails where email = 'r1-new@example.com'), 'and nothing was allowlisted';
  assert not exists (select 1 from public.email_outbox where to_email = 'r1-later@example.com'),
    'workspace admins don''t read project invite emails of projects they aren''t in';
  assert not exists (select 1 from public.pending_memberships where id = (select id from r1_ids where name = 'later_invite')),
    'nor the pending invite itself';
  update public.pending_memberships set resent_at = now() where id = (select id from r1_ids where name = 'later_invite');
end $$;
reset role;

-- Ten minutes later the owner may resend: a second email, resent_at stamped.
set session_replication_role = replica;
update public.pending_memberships set created_at = now() - interval '11 minutes'
where id = (select id from r1_ids where name = 'later_invite');
set session_replication_role = origin;

set role authenticated;
select set_config('request.jwt.claim.sub', 'abababab-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  n integer;
begin
  update public.pending_memberships set resent_at = '2000-01-01' where id = (select id from r1_ids where name = 'later_invite');
  get diagnostics n = row_count;
  assert n = 1, 'the owner resends';
  assert (select resent_at > now() - interval '1 minute' from public.pending_memberships where id = (select id from r1_ids where name = 'later_invite')),
    'the time is the database''s';
  assert (select count(*) from public.email_outbox where to_email = 'r1-later@example.com') = 2, 'a second invite email';
  assert (select count(*) from public.email_outbox where to_email = 'r1-later@example.com' and payload ->> 'role' = 'editor') = 1,
    'the resent email has the current role';
  begin
    update public.pending_memberships set resent_at = '2001-01-01' where id = (select id from r1_ids where name = 'later_invite');
    raise exception 'a second immediate resend went through';
  exception when check_violation then null;
  end;
  assert (select count(*) from public.email_outbox where to_email = 'r1-later@example.com') = 2, 'the inviter reads both emails';

  -- Cancelling: the invite can't be resent, and its queued emails don't go out.
  update public.pending_memberships set deleted_at = now() where id = (select id from r1_ids where name = 'later_invite');
  begin
    update public.pending_memberships set resent_at = now() where id = (select id from r1_ids where name = 'later_invite');
    raise exception 'a cancelled invite was resent';
  exception when check_violation then null;
  end;
end $$;
reset role;

set role service_role;
select count(*) >= 0 as claimed from public.claim_email_deliveries(100, (select id from public.email_outbox where to_email = 'r1-later@example.com' order by created_at limit 1));
select count(*) >= 0 as claimed from public.claim_email_deliveries(100, (select id from public.email_outbox where to_email = 'r1-later@example.com' order by created_at desc limit 1));
reset role;
do $$
begin
  assert not exists (
    select 1 from public.email_outbox where to_email = 'r1-later@example.com'
      and (status <> 'failed' or last_error <> 'Not sent: the invite was canceled')
  ), 'a cancelled invite''s emails fail at claim';
end $$;

-- A workspace admin's invite to their own project, portfolio, or team adds a new address to the
-- workspace and sends one email (the target invite, not a second workspace email).
set role authenticated;
select set_config('request.jwt.claim.sub', 'abababab-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  a public.allowed_emails;
begin
  assert public.add_project_member((select id from r1_ids where name = 'admin_p'), 'R1-New@Example.com', 'editor') is null, 'pending';
  select * into a from public.allowed_emails where email = 'r1-new@example.com';
  assert a.email is not null and a.removed_at is null and a.invited_by = 'abababab-0000-4000-8000-000000000001'
    and a.invited_at is not null, 'the address joined the allowlist, credited to the admin';
  assert (select count(*) from public.email_outbox where to_email = 'r1-new@example.com') = 1
    and (select payload ->> 'target_kind' from public.email_outbox where to_email = 'r1-new@example.com') = 'project',
    'one email: the project invite';
  assert public.add_team_member((select id from r1_ids where name = 'admin_team'), 'r1-team-new@example.com', 'member') is null, 'team pending';
  assert exists (select 1 from public.allowed_emails where email = 'r1-team-new@example.com' and removed_at is null), 'allowlisted by a team invite';
  assert (select count(*) from public.email_outbox where to_email = 'r1-team-new@example.com') = 1
    and (select payload ->> 'target_path' from public.email_outbox where to_email = 'r1-team-new@example.com')
      = '/teams/' || (select id from r1_ids where name = 'admin_team')::text, 'one email: the team invite';
  assert public.add_portfolio_member((select id from r1_ids where name = 'admin_portfolio'), 'r1-folio-new@example.com', 'viewer') is null, 'portfolio pending';
  assert (select count(*) from public.email_outbox where to_email = 'r1-folio-new@example.com') = 1
    and (select payload ->> 'target_kind' from public.email_outbox where to_email = 'r1-folio-new@example.com') = 'portfolio',
    'one email: the portfolio invite';

  -- Someone removed from the workspace isn't brought back by an invite (Admin console → Add back is how).
  begin
    perform public.add_project_member((select id from r1_ids where name = 'admin_p'), 'r1-gone@example.com', 'viewer');
    raise exception 'an invite restored a removed member';
  exception when check_violation then
    assert sqlerrm like '%was removed from the workspace%', sqlerrm;
  end;
  assert (select removed_at is not null from public.allowed_emails where email = 'r1-gone@example.com'), 'still removed';
  -- Nor by adding a team they're still listed on to a project.
  assert (public.add_team_to_project((select id from r1_ids where name = 'admin_p'), (select id from r1_ids where name = 'admin_team'), 'editor')
    -> 'skipped' -> 0 ->> 'profile_id') = 'abababab-0000-4000-8000-000000000005', 'the removed team member is skipped';
  assert (select removed_at is not null from public.allowed_emails where email = 'r1-gone@example.com'), 'and stays removed';
  assert not exists (select 1 from public.email_outbox where to_email = 'r1-gone@example.com'), 'and not emailed';
end $$;

-- A team lead who isn't a workspace admin can't bring in a new address either.
select set_config('request.jwt.claim.sub', 'abababab-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  begin
    perform public.add_team_member((select id from r1_ids where name = 'team'), 'r1-stranger2@example.com', 'member');
    raise exception 'a team lead added a stranger';
  exception when check_violation then null;
  end;
  begin
    perform public.add_portfolio_member((select id from r1_ids where name = 'portfolio'), 'r1-stranger3@example.com', 'viewer');
    raise exception 'a portfolio owner added a stranger';
  exception when check_violation then null;
  end;
  -- A team invite inserted directly can't carry a resend time.
  insert into public.pending_memberships (workspace_id, email, team_id, role)
  values ('00000000-0000-4000-8000-000000000001', 'r1-later@example.com', (select id from r1_ids where name = 'team'), 'member');
  assert (select resent_at from public.pending_memberships where team_id = (select id from r1_ids where name = 'team') and email = 'r1-later@example.com') is null,
    'client inserts never carry resent_at';
  assert (select count(*) from public.email_outbox where to_email = 'r1-later@example.com' and payload ->> 'target_kind' = 'team') = 1,
    'a direct team invite emails too';
  -- Three invite emails to that address this hour: a fourth invite waits for the sign-in without one.
  assert public.add_portfolio_member((select id from r1_ids where name = 'portfolio'), 'r1-later@example.com', 'viewer') is null,
    'the portfolio invite is made';
  assert (select count(*) from public.email_outbox where to_email = 'r1-later@example.com') = 3,
    'but no inbox gets more than 3 invite emails an hour';
  -- Someone who already signed in is never invited by email (a direct insert can't make one either).
  begin
    insert into public.pending_memberships (workspace_id, email, team_id, role)
    values ('00000000-0000-4000-8000-000000000001', 'r1-viewer@example.com', (select id from r1_ids where name = 'team'), 'member');
    raise exception 'a pending invite for someone who already signed in';
  exception when check_violation then
    assert sqlerrm like '%has already signed in%', sqlerrm;
  end;
end $$;
reset role;

-- First sign-in applies the invite; an email still queued for it is dropped.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
values ('abababab-0000-4000-8000-000000000006', 'r1-new@example.com', now(), '{"full_name":"Nia New"}');
set role service_role;
select count(*) >= 0 as claimed from public.claim_email_deliveries(100, (select id from public.email_outbox where to_email = 'r1-new@example.com'));
reset role;
do $$
begin
  assert exists (
    select 1 from public.project_members
    where project_id = (select id from r1_ids where name = 'admin_p') and profile_id = 'abababab-0000-4000-8000-000000000006'
      and role = 'editor' and created_by = 'abababab-0000-4000-8000-000000000001' and deleted_at is null
  ), 'the invite became a membership on first sign-in';
  assert (select status from public.email_outbox where to_email = 'r1-new@example.com') = 'failed'
    and (select last_error from public.email_outbox where to_email = 'r1-new@example.com') = 'Not sent: they already joined',
    'an invite email for someone who already joined isn''t sent';
end $$;

-- Forms: attachment questions ---------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'abababab-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  begin
    insert into public.forms (project_id, title, questions) values ((select id from r1_ids where name = 'p'), 'Bad',
      '[{"id": "f", "type": "attachment", "label": "Files", "maps_to": {"target": "notes"}}]');
    raise exception 'a file question filled in a task detail';
  exception when check_violation then null;
  end;
end $$;
reset role;

-- The upload check (as anon, like Storage would ask it).
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
declare
  form text := (select id::text from r1_ids where name = 'form');
  k text := '11111111-1111-4111-8111-111111111111';
  u text := '22222222-2222-4222-8222-222222222222';
begin
  assert alhc_storage.form_upload_allowed(k || '/' || form || '/' || u || '-brand.pdf'), 'a PDF for an open form with a file question';
  assert alhc_storage.form_upload_allowed(k || '/' || form || '/' || u || '-Logo_v2.PNG'), 'extensions in any case';
  assert not alhc_storage.form_upload_allowed(k || '/' || form || '/' || u || '-setup.exe'), 'not a program';
  assert not alhc_storage.form_upload_allowed(k || '/' || form || '/' || u || '-page.html'), 'not a web page';
  assert not alhc_storage.form_upload_allowed(k || '/' || form || '/brand.pdf'), 'the file needs its unique prefix';
  assert not alhc_storage.form_upload_allowed(k || '/' || u || '-brand.pdf'), 'the form folder is required';
  assert not alhc_storage.form_upload_allowed(k || '/' || form || '/x/' || u || '-brand.pdf'), 'no deeper folders';
  assert not alhc_storage.form_upload_allowed(k || '/' || form || '/' || u || '-a b.pdf'), 'safe names only';
  assert not alhc_storage.form_upload_allowed(k || '/' || (select id::text from r1_ids where name = 'form_plain') || '/' || u || '-brand.pdf'),
    'not for a form without a file question';
  assert not alhc_storage.form_upload_allowed(k || '/' || (select id::text from r1_ids where name = 'form_closed') || '/' || u || '-brand.pdf'),
    'not for a closed form';
  assert not alhc_storage.form_upload_allowed(k || '/00000000-0000-4000-8000-00000000dead/' || u || '-brand.pdf'), 'not for an unknown form';
  assert not alhc_storage.form_upload_allowed(null), 'not for nothing';
end $$;

-- Anonymous uploads through the Storage policy: only into an open form's folder.
insert into storage.objects (bucket_id, name, metadata) values
  ('task-attachments', '11111111-1111-4111-8111-111111111111/' || (select id::text from r1_ids where name = 'form') || '/22222222-2222-4222-8222-222222222222-Brand_Guide.pdf',
   '{"size": 1234, "mimetype": "application/pdf"}'),
  ('task-attachments', '11111111-1111-4111-8111-111111111111/' || (select id::text from r1_ids where name = 'form') || '/33333333-3333-4333-8333-333333333333-logo.png',
   '{"size": 99, "mimetype": "image/png"}');
do $$
begin
  begin
    insert into storage.objects (bucket_id, name) values ('task-attachments',
      '11111111-1111-4111-8111-111111111111/' || (select id::text from r1_ids where name = 'form_closed') || '/44444444-4444-4444-8444-444444444444-x.pdf');
    raise exception 'anon uploaded to a closed form';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into storage.objects (bucket_id, name) values ('task-attachments', (select id::text from r1_ids where name = 'p') || '/x.pdf');
    raise exception 'anon uploaded into a project folder';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into storage.objects (bucket_id, name) values ('imports',
      '11111111-1111-4111-8111-111111111111/' || (select id::text from r1_ids where name = 'form') || '/44444444-4444-4444-8444-444444444444-x.pdf');
    raise exception 'anon uploaded to another bucket';
  exception when insufficient_privilege then null;
  end;
  assert not exists (select 1 from storage.objects), 'anon reads nothing back';
end $$;

-- A file the submitter removes before sending stays in Storage but never becomes readable.
insert into storage.objects (bucket_id, name, metadata) values
  ('task-attachments', '11111111-1111-4111-8111-111111111111/' || (select id::text from r1_ids where name = 'form') || '/88888888-8888-4888-8888-888888888888-removed.pdf',
   '{"size": 5, "mimetype": "application/pdf"}');

-- At most 10 files under one key.
do $$
declare
  form text := (select id::text from r1_ids where name = 'form');
begin
  for i in 1 .. 10 loop
    insert into storage.objects (bucket_id, name) values ('task-attachments',
      '55555555-5555-4555-8555-555555555555/' || form || '/' || gen_random_uuid()::text || '-f' || i || '.pdf');
  end loop;
  begin
    insert into storage.objects (bucket_id, name) values ('task-attachments',
      '55555555-5555-4555-8555-555555555555/' || form || '/' || gen_random_uuid()::text || '-f11.pdf');
    raise exception 'an 11th file went in';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Submitting: the key becomes the task, the files its attachments.
do $$
declare
  form uuid := (select id from r1_ids where name = 'form');
  k text := '11111111-1111-4111-8111-111111111111';
  pdf text := k || '/' || form::text || '/22222222-2222-4222-8222-222222222222-Brand_Guide.pdf';
  png text := k || '/' || form::text || '/33333333-3333-4333-8333-333333333333-logo.png';
  result jsonb;
begin
  begin
    perform public.submit_form(form, 'guest@example.org', '{"q1": "Logo refresh"}');
    raise exception 'a required file question was skipped';
  exception when check_violation then
    assert sqlerrm like 'Please answer%', sqlerrm;
  end;
  begin
    perform public.submit_form(form, 'guest@example.org', jsonb_build_object('q1', 'x', 'files',
      jsonb_build_array(jsonb_build_object('path', k || '/' || form::text || '/66666666-6666-4666-8666-666666666666-missing.pdf', 'name', 'missing.pdf'))));
    raise exception 'a file that never uploaded was accepted';
  exception when check_violation then
    assert sqlerrm like 'A file didn’t finish uploading%', sqlerrm;
  end;
  begin
    perform public.submit_form(form, 'guest@example.org', jsonb_build_object('q1', 'x', 'files',
      jsonb_build_array(jsonb_build_object('path', k || '/' || (select id::text from r1_ids where name = 'form_plain') || '/22222222-2222-4222-8222-222222222222-Brand_Guide.pdf', 'name', 'x.pdf'))));
    raise exception 'another form''s path was accepted';
  exception when check_violation then null;
  end;
  begin
    perform public.submit_form(form, 'guest@example.org', jsonb_build_object('q1', 'x', 'files', jsonb_build_array('just-a-string')));
    raise exception 'a malformed file answer was accepted';
  exception when check_violation then null;
  end;

  result := public.submit_form(form, 'guest@example.org', jsonb_build_object('q1', 'Logo refresh', 'files',
    jsonb_build_array(
      jsonb_build_object('path', pdf, 'name', '  Brand Guide v2.pdf '),
      jsonb_build_object('path', png, 'name', 'logo.png')
    )));
  assert result ->> 'task_id' = k, 'the response''s task takes the key as its id';

  begin
    perform public.submit_form(form, 'guest@example.org', jsonb_build_object('q1', 'Again', 'files',
      jsonb_build_array(jsonb_build_object('path', pdf, 'name', 'again.pdf'))));
    raise exception 'the same files were sent twice';
  exception when check_violation then
    assert sqlerrm like 'These files were already sent%', sqlerrm;
  end;
  assert not alhc_storage.form_upload_allowed(k || '/' || form::text || '/77777777-7777-4777-8777-777777777777-late.pdf'),
    'nothing more can be uploaded under a key once its task exists';
end $$;

-- A listed name keeps the stored file's extension: an allowed .pdf can't show up as "Invoice.exe".
insert into storage.objects (bucket_id, name, metadata) values
  ('task-attachments', '99999999-9999-4999-8999-999999999999/' || (select id::text from r1_ids where name = 'form') || '/aaaaaaaa-1111-4111-8111-111111111111-report.pdf', '{"size": 7}'),
  ('task-attachments', '99999999-9999-4999-8999-999999999999/' || (select id::text from r1_ids where name = 'form') || '/aaaaaaaa-2222-4222-8222-222222222222-brief.pdf', '{"size": 7}');
do $$
declare
  form text := (select id::text from r1_ids where name = 'form');
  k text := '99999999-9999-4999-8999-999999999999';
begin
  perform public.submit_form(form::uuid, 'guest@example.org', jsonb_build_object('q1', 'Names', 'files', jsonb_build_array(
    jsonb_build_object('path', k || '/' || form || '/aaaaaaaa-1111-4111-8111-111111111111-report.pdf', 'name', 'Invoice.exe'),
    jsonb_build_object('path', k || '/' || form || '/aaaaaaaa-2222-4222-8222-222222222222-brief.pdf', 'name', E'Brief\u0007 final.pdf')
  )));
end $$;
reset role;
do $$
begin
  assert (select string_agg(file_name, ', ' order by file_name) from public.task_attachments where task_id = '99999999-9999-4999-8999-999999999999')
    = 'Brief final.pdf, report.pdf', (select string_agg(file_name, ', ') from public.task_attachments where task_id = '99999999-9999-4999-8999-999999999999');
end $$;

do $$
declare
  t uuid := '11111111-1111-4111-8111-111111111111';
begin
  assert (select count(*) from public.task_attachments where task_id = t and source = 'form' and deleted_at is null) = 2, 'two form attachments';
  assert exists (
    select 1 from public.task_attachments where task_id = t and file_name = 'Brand Guide v2.pdf'
      and content_type = 'application/pdf' and size_bytes = 1234 and uploaded_by = 'abababab-0000-4000-8000-000000000002'
  ), 'named as submitted, typed and sized from Storage, recorded under the form''s creator';
  assert (select notes from public.tasks where id = t) like '%Files: Brand Guide v2.pdf, logo.png%', 'the description lists the files';
  assert (select count(*) from public.task_stories where task_id = t and kind = 'attachment_added' and data ->> 'source' = 'form') = 2,
    'the activity says they came with the form';
  assert (select answers -> 'files' -> 0 ->> 'name' from public.form_submissions where task_id = t) = 'Brand Guide v2.pdf', 'the response keeps them';
end $$;

-- Task readers can open the files (the existing Storage read policy); people can't fake a source.
set role authenticated;
select set_config('request.jwt.claim.sub', 'abababab-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  assert (select count(*) from storage.objects where name like '11111111-1111-4111-8111-111111111111/%') = 2,
    'a viewer of the project reads the submitted files, not the one removed before sending';
end $$;
select set_config('request.jwt.claim.sub', 'abababab-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  insert into public.task_attachments (task_id, storage_path, file_name, size_bytes, source)
  values ('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111/own-upload.pdf', 'own.pdf', 1, 'email');
  assert (select source from public.task_attachments where storage_path = '11111111-1111-4111-8111-111111111111/own-upload.pdf') = 'upload',
    'an upload in the app is always an upload';
  update public.task_attachments set source = 'form' where storage_path = '11111111-1111-4111-8111-111111111111/own-upload.pdf';
  assert (select source from public.task_attachments where storage_path = '11111111-1111-4111-8111-111111111111/own-upload.pdf') = 'upload',
    'and stays one';
end $$;
reset role;

-- Stale uploads: a day later the cron route removes what no response kept.
update storage.objects set created_at = now() - interval '2 days' where name like '11111111-1111-4111-8111-111111111111/%';
set role service_role;
do $$
begin
  assert exists (select 1 from public.list_stale_form_uploads(1000) n where n like '%-removed.pdf'), 'the removed file is listed';
  assert not exists (select 1 from public.list_stale_form_uploads(1000) n where n like '%-Brand_Guide.pdf' or n like '%-logo.png'),
    'submitted files never are';
  assert exists (select 1 from public.list_stale_form_uploads(1000) n where n like '55555555-%') is false,
    'unsubmitted uploads younger than a day aren''t listed yet';
end $$;
reset role;

-- Byte budgets: 500 MB per form in 10 minutes, 5 GB of unsubmitted uploads a day.
insert into storage.objects (bucket_id, name, metadata) values
  ('task-attachments', 'bbbbbbbb-0000-4000-8000-000000000001/' || (select id::text from r1_ids where name = 'form') || '/cccccccc-0000-4000-8000-000000000001-big.zip',
   jsonb_build_object('size', 600 * 1024 * 1024));
do $$
begin
  assert not alhc_storage.form_upload_allowed('dddddddd-0000-4000-8000-000000000001/' || (select id::text from r1_ids where name = 'form')
    || '/eeeeeeee-0000-4000-8000-000000000001-small.pdf'), 'a form that took 500 MB in 10 minutes takes no more';
end $$;
update storage.objects set created_at = now() - interval '20 minutes' where name like 'bbbbbbbb-0000-4000-8000-000000000001/%';
do $$
begin
  assert alhc_storage.form_upload_allowed('dddddddd-0000-4000-8000-000000000001/' || (select id::text from r1_ids where name = 'form')
    || '/eeeeeeee-0000-4000-8000-000000000001-small.pdf'), 'ten minutes later it takes files again';
end $$;
update storage.objects set metadata = jsonb_build_object('size', 6::bigint * 1024 * 1024 * 1024) where name like 'bbbbbbbb-0000-4000-8000-000000000001/%';
do $$
begin
  assert not alhc_storage.form_upload_allowed('dddddddd-0000-4000-8000-000000000001/' || (select id::text from r1_ids where name = 'form')
    || '/eeeeeeee-0000-4000-8000-000000000001-small.pdf'), 'over 5 GB of unsubmitted uploads in a day: no form takes more';
end $$;
delete from storage.objects where name like 'bbbbbbbb-0000-4000-8000-000000000001/%';

-- Forwarding addresses --------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'abababab-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
declare
  a public.email_forwarding_addresses;
  b public.email_forwarding_addresses;
begin
  a := public.my_forwarding_address();
  assert a.profile_id = 'abababab-0000-4000-8000-000000000004' and a.token ~ '^[0-9a-f]{40}$' and a.revoked_at is null, 'made on first use';
  b := public.my_forwarding_address();
  assert b.id = a.id and b.token = a.token, 'the same address afterwards';
  insert into r1_ids values ('addr_old', a.id);
  begin
    update public.email_forwarding_addresses set token = repeat('0', 40) where id = a.id;
    raise exception 'a token was chosen by a client';
  exception when insufficient_privilege then null;
  end;
  update public.email_forwarding_addresses set default_project_id = (select id from r1_ids where name = 'p') where id = a.id;
  assert (select default_project_id from public.email_forwarding_addresses where id = a.id) = (select id from r1_ids where name = 'p'),
    'an Editor picks the project';
  begin
    update public.email_forwarding_addresses set default_project_id = (select id from r1_ids where name = 'admin_p') where id = a.id;
    raise exception 'a project they aren''t in was picked';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.email_forwarding_addresses (profile_id) values (auth.uid());
    raise exception 'a second active address';
  exception when unique_violation then null;
  end;

  b := public.rotate_forwarding_address();
  assert b.id <> a.id and b.token <> a.token and b.default_project_id = (select id from r1_ids where name = 'p'), 'rotated, project kept';
  assert (select revoked_at is not null from public.email_forwarding_addresses where id = a.id), 'the old one is revoked';
  begin
    update public.email_forwarding_addresses set revoked_at = null where id = a.id;
    raise exception 'a revoked address came back';
  exception when check_violation then null;
  end;
  insert into r1_ids values ('addr', b.id);
end $$;

-- Viewers can't send to a project they can't add tasks to; nobody else sees an address.
select set_config('request.jwt.claim.sub', 'abababab-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  a public.email_forwarding_addresses;
begin
  a := public.my_forwarding_address();
  begin
    update public.email_forwarding_addresses set default_project_id = (select id from r1_ids where name = 'p') where id = a.id;
    raise exception 'a viewer sends tasks to the project';
  exception when insufficient_privilege then null;
  end;
  assert not exists (select 1 from public.email_forwarding_addresses where profile_id = 'abababab-0000-4000-8000-000000000004'),
    'someone else''s address is invisible';
end $$;
select set_config('request.jwt.claim.sub', 'abababab-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.email_forwarding_addresses where profile_id <> auth.uid()),
    'workspace admins don''t see other people''s addresses';
end $$;
reset role;

-- Receiving (the inbound route, as service_role: no signed-in person).
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
set role service_role;
do $$
declare
  fwd_token text := (select a.token from public.email_forwarding_addresses a where id = (select id from r1_ids where name = 'addr'));
  old_token text := (select a.token from public.email_forwarding_addresses a where id = (select id from r1_ids where name = 'addr_old'));
  result jsonb;
  again jsonb;
  t public.tasks;
  att uuid;
begin
  result := public.post_email_forward(repeat('a', 40), 'r1-editor@example.com', true, 'Hi', 'Body', 'fw-unknown');
  assert result ->> 'status' = 'rejected' and result ->> 'reason' = 'unknown_token', result::text;
  result := public.post_email_forward('nope', 'r1-editor@example.com', true, 'Hi', 'Body', 'fw-malformed');
  assert result ->> 'reason' = 'unknown_token', result::text;
  result := public.post_email_forward(old_token, 'r1-editor@example.com', true, 'Hi', 'Body', 'fw-rotated');
  assert result ->> 'reason' = 'rotated', 'a rotated address stops at once';
  result := public.post_email_forward(fwd_token, 'someone@else.example', true, 'Hi', 'Body', 'fw-spoof');
  assert result ->> 'reason' = 'sender_mismatch', 'only the person''s own address may send';
  result := public.post_email_forward(fwd_token, 'r1-editor@example.com', false, 'Hi', 'Body', 'fw-unverified');
  assert result ->> 'reason' = 'not_authenticated'
    and (select profile_id from public.email_forwards where provider_id = 'fw-unverified') = 'abababab-0000-4000-8000-000000000004',
    'mail that failed sender checks is refused and logged for its person';

  result := public.post_email_forward(fwd_token, 'R1-Editor@Example.com', true, 'Fwd: RE: Brief for Q4', E'Can you take this?\n\n---------- Forwarded message ---------\nFrom: Client', 'fw-1');
  assert result ->> 'status' = 'created' and result ->> 'project_id' = (select id::text from r1_ids where name = 'p'), result::text;
  select * into t from public.tasks where id = (result ->> 'task_id')::uuid;
  assert t.title = 'Brief for Q4' and t.notes like 'Can you take this?%Forwarded message%', 'subject = name, body = description';
  assert t.created_by = 'abababab-0000-4000-8000-000000000004' and t.assignee_id = t.created_by and t.source = 'manual'
    and t.home_project_id = (select id from r1_ids where name = 'p'), 'created as them, assigned to them, in their project';
  assert (select s.name from public.task_projects tp join public.sections s on s.id = tp.section_id where tp.task_id = t.id) = 'Inbox',
    'at the top section';
  assert exists (select 1 from public.task_stories where task_id = t.id and kind = 'created' and data ->> 'via' = 'email'
    and actor_id = 'abababab-0000-4000-8000-000000000004'), 'the activity says it came by email, from them';
  assert coalesce(current_setting('request.jwt.claim.sub', true), '') = '', 'the impersonation is undone';

  again := public.post_email_forward(fwd_token, 'r1-editor@example.com', true, 'Brief for Q4', 'x', 'fw-1');
  assert again ->> 'status' = 'duplicate' and again ->> 'task_id' = result ->> 'task_id', 'a retried webhook makes no second task';

  att := public.attach_forwarded_file((result ->> 'forward_id')::uuid, t.id::text || '/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-brief.pdf', 'brief.pdf', 'application/pdf', 2048);
  assert exists (select 1 from public.task_attachments where id = att and source = 'email' and uploaded_by = t.created_by and size_bytes = 2048),
    'attachments are recorded as theirs';
  assert exists (select 1 from public.task_stories where task_id = t.id and kind = 'attachment_added' and data ->> 'source' = 'email'
    and actor_id = t.created_by), 'and in the activity';
  begin
    perform public.attach_forwarded_file((result ->> 'forward_id')::uuid, (select id::text from r1_ids where name = 'p') || '/x.pdf', 'x.pdf', null, 1);
    raise exception 'an attachment outside the task''s folder';
  exception when check_violation then null;
  end;
  begin
    perform public.attach_forwarded_file(gen_random_uuid(), t.id::text || '/x.pdf', 'x.pdf', null, 1);
    raise exception 'an attachment for no forward';
  exception when no_data_found then null;
  end;
  insert into r1_ids values ('fw_task', t.id), ('fw_forward', (result ->> 'forward_id')::uuid);
end $$;
reset role;

-- An old forward takes no more files.
update public.email_forwards set created_at = now() - interval '2 hours' where id = (select id from r1_ids where name = 'fw_forward');
set role service_role;
do $$
begin
  begin
    perform public.attach_forwarded_file((select id from r1_ids where name = 'fw_forward'),
      (select id::text from r1_ids where name = 'fw_task') || '/late.pdf', 'late.pdf', null, 1);
    raise exception 'a late attachment went in';
  exception when no_data_found then null;
  end;
end $$;
reset role;

-- Losing Editor in the default project: the email becomes their private task instead.
set role authenticated;
select set_config('request.jwt.claim.sub', 'abababab-0000-4000-8000-000000000002', false) is not null as ok \gset
select public.update_project_member_role((select id from r1_ids where name = 'p'), 'abababab-0000-4000-8000-000000000004', 'viewer');
reset role;
set role service_role;
do $$
declare
  fwd_token text := (select a.token from public.email_forwarding_addresses a where id = (select id from r1_ids where name = 'addr'));
  result jsonb;
begin
  result := public.post_email_forward(fwd_token, 'r1-editor@example.com', true, '', '', 'fw-2');
  assert result ->> 'status' = 'created' and result -> 'project_id' = 'null'::jsonb, result::text;
  assert (select home_project_id is null and title = 'Forwarded email' and notes is null and assignee_id = 'abababab-0000-4000-8000-000000000004'
          from public.tasks where id = (result ->> 'task_id')::uuid), 'a private task in their My tasks';
  assert (select reason from public.email_forwards where id = (result ->> 'forward_id')::uuid) = 'project_unavailable', 'logged why';
end $$;
reset role;

-- No longer in the workspace: nothing is created.
update public.allowed_emails set removed_at = now() where email = 'r1-editor@example.com';
set role service_role;
do $$
begin
  assert public.post_email_forward((select token from public.email_forwarding_addresses where id = (select id from r1_ids where name = 'addr')), 'r1-editor@example.com', true, 'Hi', 'Body', 'fw-3'
  ) ->> 'reason' = 'no_access', 'removed people can''t create tasks by email';
end $$;
reset role;
update public.allowed_emails set removed_at = null where email = 'r1-editor@example.com';

-- The log: each person reads their own outcomes (never the provider id).
set role authenticated;
select set_config('request.jwt.claim.sub', 'abababab-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
begin
  assert (select count(*) from public.email_forwards where status = 'created') = 2, 'their created tasks';
  assert exists (select 1 from public.email_forwards where reason = 'sender_mismatch'), 'and the rejected emails sent to their address';
  begin
    perform (select provider_id from public.email_forwards limit 1);
    raise exception 'the provider id was readable';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', 'abababab-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.email_forwards), 'nobody else reads them, workspace admins included';
end $$;
reset role;

select 'zz15 real 1 smoke: ok' as result;
