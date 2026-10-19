-- Behavioural checks for 20261019010000_email_designs.sql: email designs (scopes, who edits, and
-- resolution form → project → workspace), the Editor gate on responses to a form's submitter,
-- responses from subtasks, closing and reopening reply threads, reply attachments, the Commenter
-- switch, and the importer's attachment files.
-- Fresh people for this suite:
--   e2727272…01 ed-owner@example.com    Odalys Overbeck, owner of ED P
--   e2727272…02 ed-editor@example.com   Edmund Eastfield, Editor of ED P
--   e2727272…03 ed-commenter@example.com Cosima Clatterby, Commenter of ED P
--   e2727272…04 ed-admin@example.com    Wystan Wardle, workspace admin, not in ED P
--   e2727272…05 ed-viewer@example.com   Vashti Vellacott, Viewer of ED P
--   e2727272…06 ed-new@example.com      Nell Newbold, allowlisted, no memberships

\set ON_ERROR_STOP 1

create temporary table ed_ids (name text primary key, id uuid) on commit preserve rows;
grant all on ed_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('ed-owner@example.com', 'email designs suite'),
  ('ed-editor@example.com', 'email designs suite'),
  ('ed-commenter@example.com', 'email designs suite'),
  ('ed-admin@example.com', 'email designs suite'),
  ('ed-viewer@example.com', 'email designs suite'),
  ('ed-new@example.com', 'email designs suite');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e2727272-0000-4000-8000-000000000001', 'ed-owner@example.com', now(), '{"full_name":"Odalys Overbeck"}'),
  ('e2727272-0000-4000-8000-000000000002', 'ed-editor@example.com', now(), '{"full_name":"Edmund Eastfield"}'),
  ('e2727272-0000-4000-8000-000000000003', 'ed-commenter@example.com', now(), '{"full_name":"Cosima Clatterby"}'),
  ('e2727272-0000-4000-8000-000000000004', 'ed-admin@example.com', now(), '{"full_name":"Wystan Wardle"}'),
  ('e2727272-0000-4000-8000-000000000005', 'ed-viewer@example.com', now(), '{"full_name":"Vashti Vellacott"}'),
  ('e2727272-0000-4000-8000-000000000006', 'ed-new@example.com', now(), '{"full_name":"Nell Newbold"}');
insert into public.workspace_admins (workspace_id, profile_id)
values ('00000000-0000-4000-8000-000000000001', 'e2727272-0000-4000-8000-000000000004');
insert into ed_ids values ('editor', 'e2727272-0000-4000-8000-000000000002');

-- Fixtures (the Commenter switch is still on from the harness step).
set role authenticated;
select set_config('request.jwt.claim.sub', 'e2727272-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid;
  intake uuid;
  f uuid;
  f2 uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'ED P') returning id into p;
  insert into public.sections (project_id, name, sort_order) values (p, 'Intake', 1024) returning id into intake;
  perform public.add_project_member(p, 'ed-editor@example.com', 'editor');
  perform public.add_project_member(p, 'ed-commenter@example.com', 'commenter');
  perform public.add_project_member(p, 'ed-viewer@example.com', 'viewer');
  insert into public.forms (project_id, title, accepting_responses, send_confirmation, destination_section_id, questions)
  values (p, 'Design Request', true, true, intake,
    '[{"id":"q1","type":"short_text","label":"Your name"}]'::jsonb) returning id into f;
  insert into public.forms (project_id, title, accepting_responses, send_confirmation, destination_section_id)
  values (p, 'Other Form', true, false, intake) returning id into f2;
  insert into ed_ids values ('p', p), ('intake', intake), ('form', f), ('form2', f2);
  insert into ed_ids values ('plain', public.create_task(p, intake, 'ED plain task'));
end $$;
reset role;

set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
insert into ed_ids
select 'formtask', (public.submit_form((select id from ed_ids where name = 'form'), 'Rhea.Requester@Example.org', '{"q1":"Rhea Rowntree"}') ->> 'task_id')::uuid;
reset role;

-- Grants -------------------------------------------------------------------------------------------

do $$
begin
  assert has_table_privilege('authenticated', 'public.email_designs', 'select')
    and not has_table_privilege('anon', 'public.email_designs', 'select')
    and not has_table_privilege('authenticated', 'public.email_designs', 'truncate'),
    'email designs: signed-in readers, nothing for anon, no truncate';
  assert (select relrowsecurity from pg_class where oid = 'public.email_designs'::regclass), 'RLS on email_designs';
  assert not has_function_privilege('authenticated', 'public.email_design_context(uuid)', 'execute')
    and has_function_privilege('service_role', 'public.email_design_context(uuid)', 'execute'),
    'only the drain reads an email''s design context';
  assert not has_function_privilege('authenticated', 'public.attach_reply_file(uuid,text,text,text,bigint)', 'execute')
    and has_function_privilege('service_role', 'public.attach_reply_file(uuid,text,text,text,bigint)', 'execute')
    and not has_function_privilege('authenticated', 'public.note_reply_skipped_files(uuid,jsonb)', 'execute'),
    'reply attachments are recorded by the service role only';
  assert not (select prosecdef from pg_proc where oid = 'public.resolve_email_design(text,uuid,uuid)'::regprocedure),
    'resolve_email_design runs as the caller';
  assert not has_function_privilege('anon', 'public.set_submitter_thread_closed(uuid,boolean)', 'execute')
    and not has_function_privilege('anon', 'public.list_commenter_members()', 'execute')
    and not has_function_privilege('anon', 'public.import_attachment_file(uuid,uuid,text,text,text,text,bigint)', 'execute'),
    'anon gets none of the new functions';
end $$;

-- Email designs: who edits which scope -----------------------------------------------------------

-- The workspace admin sets the workspace defaults of both kinds.
set role authenticated;
select set_config('request.jwt.claim.sub', 'e2727272-0000-4000-8000-000000000004', false) is not null as ok \gset
insert into public.email_designs (workspace_id, kind, accent_color, header_text, footer_text, button_color)
values ('00000000-0000-4000-8000-000000000001', 'requester', '#AA0000', 'Workspace header', 'Workspace footer', '#00aa00');
insert into public.email_designs (workspace_id, kind, accent_color, header_text)
values ('00000000-0000-4000-8000-000000000001', 'internal', '#123456', 'Internal header');
do $$
begin
  -- …but can't override a project they don't administer.
  begin
    insert into public.email_designs (workspace_id, kind, project_id, header_text)
    values ('00000000-0000-4000-8000-000000000001', 'requester', (select id from ed_ids where name = 'p'), 'Sneaky');
    raise exception 'a workspace admin outside the project should not override its design';
  exception when insufficient_privilege or no_data_found then null;
  end;
  begin
    insert into public.email_designs (workspace_id, kind, header_text)
    values ('00000000-0000-4000-8000-000000000001', 'requester', 'Second default');
    raise exception 'one live workspace default per kind';
  exception when unique_violation then null;
  end;
  begin
    insert into public.email_designs (workspace_id, kind, logo_path)
    values ('00000000-0000-4000-8000-000000000001', 'internal', '11111111-1111-4111-8111-111111111111/logo.png');
    raise exception 'a logo from another workspace''s folder should fail';
  exception when check_violation or unique_violation then null;
  end;
end $$;

-- A project Editor can't set an override or the workspace default; the owner (project Admin+) can.
select set_config('request.jwt.claim.sub', 'e2727272-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  begin
    insert into public.email_designs (workspace_id, kind, project_id, header_text)
    values ('00000000-0000-4000-8000-000000000001', 'requester', (select id from ed_ids where name = 'p'), 'Editor try');
    raise exception 'an Editor should not override the project design';
  exception when insufficient_privilege then null;
  end;
  update public.email_designs set header_text = 'Hijack' where project_id is null and kind = 'requester';
  assert (select header_text from public.email_designs where project_id is null and kind = 'requester' and deleted_at is null) = 'Workspace header',
    'a member can''t change the workspace default';
  assert (select count(*) from public.email_designs where project_id is null and deleted_at is null) = 2,
    'everyone allowlisted reads the workspace defaults';
end $$;

select set_config('request.jwt.claim.sub', 'e2727272-0000-4000-8000-000000000001', false) is not null as ok \gset
insert into public.email_designs (workspace_id, kind, project_id, header_text, intro_message)
values ('00000000-0000-4000-8000-000000000001', 'requester', (select id from ed_ids where name = 'p'), 'Project header', 'Hi {requester_name}');
do $$
begin
  insert into public.email_designs (workspace_id, kind, project_id, form_id, button_label, accent_color)
  values ('00000000-0000-4000-8000-000000000001', 'requester', (select id from ed_ids where name = 'p'),
    (select id from ed_ids where name = 'form'), 'Submit another', 'red');
  raise exception 'colors are #rrggbb';
exception when check_violation then null;
end $$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', 'e2727272-0000-4000-8000-000000000001', false) is not null as ok \gset
insert into public.email_designs (workspace_id, kind, project_id, form_id, button_label)
values ('00000000-0000-4000-8000-000000000001', 'requester', (select id from ed_ids where name = 'p'),
  (select id from ed_ids where name = 'form'), 'Submit another');
do $$
begin
  begin
    insert into public.email_designs (workspace_id, kind, project_id, form_id, button_label)
    values ('00000000-0000-4000-8000-000000000001', 'internal', (select id from ed_ids where name = 'p'),
      (select id from ed_ids where name = 'form'), 'Nope');
    raise exception 'internal emails have no form overrides';
  exception when check_violation then null;
  end;
end $$;

-- Resolution: form → project → workspace, setting by setting.
do $$
declare
  d jsonb;
  p uuid := (select id from ed_ids where name = 'p');
  f uuid := (select id from ed_ids where name = 'form');
  f2 uuid := (select id from ed_ids where name = 'form2');
begin
  d := public.resolve_email_design('requester', p, f);
  assert d ->> 'button_label' = 'Submit another', 'the form override wins';
  assert d ->> 'header_text' = 'Project header' and d ->> 'intro_message' = 'Hi {requester_name}', 'the project override next';
  assert d ->> 'accent_color' = '#aa0000' and d ->> 'footer_text' = 'Workspace footer' and d ->> 'button_color' = '#00aa00',
    'the workspace default last (colors stored lowercase)';
  assert d ->> 'logo_path' is null, 'nothing set anywhere = the built-in default';
  d := public.resolve_email_design('requester', p, f2);
  assert d ->> 'button_label' is null and d ->> 'header_text' = 'Project header', 'another form gets only the project override';
  d := public.resolve_email_design('requester', null, null);
  assert d ->> 'header_text' = 'Workspace header', 'no project = the workspace default';
  d := public.resolve_email_design('internal', p, f);
  assert d ->> 'header_text' = 'Internal header' and d ->> 'button_label' is null, 'kinds never mix';
end $$;

-- An explicit empty value overrides; resetting a scope falls back.
update public.email_designs set footer_text = '' where project_id = (select id from ed_ids where name = 'p') and form_id is null;
do $$
begin
  assert public.resolve_email_design('requester', (select id from ed_ids where name = 'p'), null) ->> 'footer_text' = '',
    'an empty value means "none here", not "inherit"';
end $$;
update public.email_designs set deleted_at = now() where project_id = (select id from ed_ids where name = 'p') and form_id is null;
do $$
begin
  assert public.resolve_email_design('requester', (select id from ed_ids where name = 'p'), null) ->> 'header_text' = 'Workspace header',
    'a reset project override falls back to the workspace';
  begin
    update public.email_designs set deleted_at = null where project_id = (select id from ed_ids where name = 'p') and form_id is null and deleted_at is not null;
    raise exception 'a reset design stays reset';
  exception when check_violation then null;
  end;
end $$;
insert into public.email_designs (workspace_id, kind, project_id, header_text, intro_message)
values ('00000000-0000-4000-8000-000000000001', 'requester', (select id from ed_ids where name = 'p'), 'Project header', 'Hi {requester_name}');
reset role;

-- The viewer reads the project's designs; an outsider doesn't.
set role authenticated;
select set_config('request.jwt.claim.sub', 'e2727272-0000-4000-8000-000000000006', false) is not null as ok \gset
do $$
begin
  assert not exists (select 1 from public.email_designs where project_id = (select id from ed_ids where name = 'p')),
    'people outside the project don''t see its designs';
  assert public.resolve_email_design('requester', (select id from ed_ids where name = 'p'), (select id from ed_ids where name = 'form')) ->> 'header_text' = 'Workspace header',
    'and resolve only what they can read';
end $$;
reset role;

-- The drain's context: which design an email uses and the fill-in values.
set role service_role;
do $$
declare
  ctx jsonb;
  confirmation uuid;
begin
  select id into confirmation from public.email_outbox
  where task_id = (select id from ed_ids where name = 'formtask') and template = 'form_confirmation';
  assert confirmation is not null, 'the form confirmation was queued';
  ctx := public.email_design_context(confirmation);
  assert ctx ->> 'kind' = 'requester' and (ctx ->> 'form_id')::uuid = (select id from ed_ids where name = 'form')
    and (ctx ->> 'project_id')::uuid = (select id from ed_ids where name = 'p'), 'a confirmation is a requester email of its form';
  assert ctx -> 'design' ->> 'button_label' = 'Submit another' and ctx -> 'design' ->> 'header_text' = 'Project header',
    'with the resolved design';
  assert ctx -> 'values' ->> 'requester_name' = 'Rhea Rowntree' and ctx -> 'values' ->> 'form_name' = 'Design Request'
    and ctx -> 'values' ->> 'project_name' = 'ED P', 'and the fill-in values';
end $$;
reset role;

-- Responses to the submitter: Editor or above -----------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'e2727272-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
begin
  perform public.send_submitter_response((select id from ed_ids where name = 'formtask'), 'From a commenter');
  raise exception 'a Commenter should not send a response';
exception when insufficient_privilege then null;
end $$;
do $$
declare
  t uuid := (select id from ed_ids where name = 'formtask');
begin
  -- …nor through the transaction-local switch directly.
  perform set_config('alhc.submitter_response', t::text, true);
  insert into public.comments (task_id, body, email_direction) values (t, 'Sneaky commenter', 'sent');
  raise exception 'the comment guard should refuse a Commenter''s emailed comment';
exception when insufficient_privilege then null;
end $$;
-- A Commenter still comments normally.
insert into public.comments (task_id, body) values ((select id from ed_ids where name = 'formtask'), 'Commenter note');

select set_config('request.jwt.claim.sub', 'e2727272-0000-4000-8000-000000000002', false) is not null as ok \gset
insert into ed_ids select 'response', public.send_submitter_response((select id from ed_ids where name = 'formtask'), 'Hi Rhea');
-- From a subtask: the top-level task's submitter and thread.
insert into ed_ids select 'subtask', public.create_subtask((select id from ed_ids where name = 'formtask'), 'ED subtask', null);
insert into ed_ids select 'subresponse', public.send_submitter_response((select id from ed_ids where name = 'subtask'), 'From the subtask');
reset role;

do $$
declare
  c public.comments;
  o public.email_outbox;
begin
  select * into c from public.comments where id = (select id from ed_ids where name = 'subresponse');
  assert c.task_id = (select id from ed_ids where name = 'subtask') and c.email_address = 'rhea.requester@example.org'
    and c.email_subject = 'Re: "Design Request" submission received', 'a subtask response goes to the form''s submitter';
  select * into o from public.email_outbox where payload ->> 'comment_id' = c.id::text;
  assert o.task_id = c.task_id and o.payload ->> 'task_title' = (select title from public.tasks where id = (select id from ed_ids where name = 'formtask')),
    'the email is about the request';
  assert (select count(*) from public.submitter_reply_threads where task_id = (select id from ed_ids where name = 'formtask') and revoked_at is null) = 1
    and not exists (select 1 from public.submitter_reply_threads where task_id = (select id from ed_ids where name = 'subtask')),
    'subtask and task share the top-level task''s thread';
  assert o.payload ->> 'thread_id' = (select payload ->> 'thread_id' from public.email_outbox where payload ->> 'comment_id' = (select id::text from ed_ids where name = 'response')),
    'same thread id';
end $$;

-- Closing a reply thread --------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'e2727272-0000-4000-8000-000000000005', false) is not null as ok \gset
do $$
begin
  assert (public.submitter_thread_status((select id from ed_ids where name = 'formtask')) ->> 'closed')::boolean = false,
    'a Viewer sees the thread is open';
  begin
    perform public.set_submitter_thread_closed((select id from ed_ids where name = 'formtask'), true);
    raise exception 'a Viewer should not close the thread';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', 'e2727272-0000-4000-8000-000000000006', false) is not null as ok \gset
do $$
begin
  assert public.submitter_thread_status((select id from ed_ids where name = 'formtask')) is null, 'outsiders learn nothing';
  begin
    perform public.set_submitter_thread_closed((select id from ed_ids where name = 'formtask'), true);
    raise exception 'an outsider should not close the thread';
  exception when no_data_found then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', 'e2727272-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  s jsonb;
begin
  begin
    perform public.set_submitter_thread_closed((select id from ed_ids where name = 'plain'), true);
    raise exception 'a task with no thread has nothing to close';
  exception when no_data_found then null;
  end;
  -- Closing from the subtask closes the request's thread.
  s := public.set_submitter_thread_closed((select id from ed_ids where name = 'subtask'), true);
  assert (s ->> 'closed')::boolean and s ->> 'closed_by_name' = 'Edmund Eastfield', 'closed, by whom';
end $$;
reset role;

set role service_role;
do $$
declare
  first_email uuid := (select id from public.email_outbox where payload ->> 'comment_id' = (select id::text from ed_ids where name = 'response'));
  tok text;
  result jsonb;
begin
  assert public.submitter_reply_token(first_email) is null, 'no Reply-To while the thread is closed';
  select token into tok from public.submitter_reply_threads where task_id = (select id from ed_ids where name = 'formtask') and revoked_at is null;
  result := public.post_submitter_reply(tok, 'rhea.requester@example.org', 'Thanks!', 'ed-reply-1');
  assert result ->> 'status' = 'rejected' and result ->> 'reason' = 'thread_closed', 'a reply to a closed thread is refused';
  assert exists (select 1 from public.email_replies where provider_id = 'ed-reply-1' and status = 'rejected' and reason = 'thread_closed'),
    'and logged';
  assert not exists (select 1 from public.comments where body = 'Thanks!'), 'and not posted';
  perform set_config('ed.token', tok, false);
end $$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', 'e2727272-0000-4000-8000-000000000002', false) is not null as ok \gset
select public.set_submitter_thread_closed((select id from ed_ids where name = 'formtask'), false) is not null as ok \gset
reset role;

-- Reopened: the reply posts, with its attachments.
set role service_role;
do $$
declare
  result jsonb;
  c uuid;
  a uuid;
  t uuid := (select id from ed_ids where name = 'formtask');
begin
  assert public.submitter_reply_token((select id from public.email_outbox where payload ->> 'comment_id' = (select id::text from ed_ids where name = 'response'))) is not null,
    'Reply-To is back after reopening';
  result := public.post_submitter_reply(current_setting('ed.token'), 'rhea.requester@example.org', 'Thanks again!', 'ed-reply-2');
  assert result ->> 'status' = 'posted', 'a reply to a reopened thread posts';
  c := (result ->> 'comment_id')::uuid;
  insert into ed_ids values ('reply', c);
  a := public.attach_reply_file(c, t::text || '/abc-brief.pdf', 'brief.pdf', 'application/pdf', 1000);
  assert (select comment_id = c and source = 'email' and uploaded_by = (select id from ed_ids where name = 'editor')
          from public.task_attachments where id = a), 'the file is the task''s, linked to the reply, credited to the thread''s starter';
  begin
    perform public.attach_reply_file(c, (select id from ed_ids where name = 'plain')::text || '/x.pdf', 'x.pdf', null, 1);
    raise exception 'a path outside the task''s folder should fail';
  exception when check_violation then null;
  end;
  begin
    perform public.attach_reply_file((select id from ed_ids where name = 'response'), t::text || '/y.pdf', 'y.pdf', null, 1);
    raise exception 'only a received reply takes files';
  exception when no_data_found then null;
  end;
  perform public.note_reply_skipped_files(c, '[{"name":"huge.mov","reason":"too_large"},{"name":"x","reason":"weird"}]');
  assert (select email_skipped_files from public.comments where id = c)
    = '[{"name":"huge.mov","reason":"too_large"},{"name":"x","reason":"failed"}]'::jsonb, 'skipped files are noted on the reply';
end $$;
reset role;

-- Clients can't set the reply link or the skipped list themselves.
set role authenticated;
select set_config('request.jwt.claim.sub', 'e2727272-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from ed_ids where name = 'formtask');
  a uuid;
begin
  insert into public.task_attachments (task_id, storage_path, file_name, size_bytes, comment_id, import_external_id)
  values (t, t::text || '/client.png', 'client.png', 5, (select id from ed_ids where name = 'reply'), 'gid1')
  returning id into a;
  assert (select comment_id is null and import_external_id is null from public.task_attachments where id = a),
    'a client upload is never a reply''s or an import''s file';
  update public.comments set email_skipped_files = '[]' where id = (select id from ed_ids where name = 'reply');
  assert (select email_skipped_files is not null from public.comments where id = (select id from ed_ids where name = 'reply')),
    'nor changes the skipped list';
end $$;
reset role;

-- The Commenter switch ------------------------------------------------------------------------------

update public.workspaces set allow_commenter_role = false;

set role authenticated;
select set_config('request.jwt.claim.sub', 'e2727272-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from ed_ids where name = 'p');
begin
  begin
    perform public.add_project_member(p, 'ed-new@example.com', 'commenter');
    raise exception 'Commenter is off: inviting as Commenter should fail';
  exception when check_violation then null;
  end;
  begin
    perform public.update_project_member_role(p, 'e2727272-0000-4000-8000-000000000005', 'commenter');
    raise exception 'Commenter is off: changing someone to Commenter should fail';
  exception when check_violation then null;
  end;
  begin
    perform public.add_project_member(p, 'ed-pending@example.com', 'commenter');
    raise exception 'pending invites can''t be Commenters either';
  exception when check_violation then null;
  end;
  -- The existing Commenter keeps the role; changing other things about them still works.
  perform public.update_project_member_role(p, 'e2727272-0000-4000-8000-000000000003', 'commenter');
  assert (select role from public.project_members where project_id = p and profile_id = 'e2727272-0000-4000-8000-000000000003' and deleted_at is null) = 'commenter',
    'existing Commenters keep their role';
  perform public.add_project_member(p, 'ed-new@example.com', 'viewer');
  -- Only workspace admins update the switch or list Commenters.
  update public.workspaces set allow_commenter_role = true;
  assert not (select allow_commenter_role from public.workspaces where id = '00000000-0000-4000-8000-000000000001'),
    'a member can''t turn the switch on';
  begin
    perform public.list_commenter_members();
    raise exception 'only workspace admins list Commenters';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.convert_commenter_members('e2727272-0000-4000-8000-000000000003', 'editor');
    raise exception 'only workspace admins convert Commenters';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- The existing Commenter still comments.
set role authenticated;
select set_config('request.jwt.claim.sub', 'e2727272-0000-4000-8000-000000000003', false) is not null as ok \gset
insert into public.comments (task_id, body) values ((select id from ed_ids where name = 'formtask'), 'Still commenting');
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', 'e2727272-0000-4000-8000-000000000004', false) is not null as ok \gset
do $$
declare
  r record;
  n integer;
begin
  select * into r from public.list_commenter_members() where profile_id = 'e2727272-0000-4000-8000-000000000003';
  assert r.project_count >= 1, 'the admin sees the Commenter';
  assert not (r.projects @> jsonb_build_array(jsonb_build_object('name', 'ED P'))),
    'but not the name of a project the admin can''t open';
  begin
    perform public.convert_commenter_members('e2727272-0000-4000-8000-000000000003', 'owner');
    raise exception 'only Viewer or Editor';
  exception when check_violation then null;
  end;
  n := public.convert_commenter_members('e2727272-0000-4000-8000-000000000003', 'viewer');
  assert n = 1, 'one click moves their Commenter memberships';
  update public.workspaces set allow_commenter_role = true where id = '00000000-0000-4000-8000-000000000001';
  assert (select allow_commenter_role from public.workspaces where id = '00000000-0000-4000-8000-000000000001'),
    'a workspace admin turns the switch on';
end $$;
reset role;

do $$
begin
  assert (select role from public.project_members where project_id = (select id from ed_ids where name = 'p')
          and profile_id = 'e2727272-0000-4000-8000-000000000003' and deleted_at is null) = 'viewer', 'now a Viewer';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', 'e2727272-0000-4000-8000-000000000001', false) is not null as ok \gset
select public.update_project_member_role((select id from ed_ids where name = 'p'), 'e2727272-0000-4000-8000-000000000003', 'commenter') is null as ok \gset
reset role;

-- Importer attachment files ------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'e2727272-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid := (select id from ed_ids where name = 'p');
  run uuid;
  task uuid;
  r record;
begin
  run := public.start_import_run(p, 'asana', array['export.json']);
  perform public.import_batch(run, '{"tasks":[{"gid":"9001","title":"Imported with a file"}]}'::jsonb);
  select x.local_id into task from public.import_external_ids x where x.project_id = p and x.kind = 'task' and x.external_id = '9001';
  assert task is not null, 'the task was imported';
  select * into r from public.import_attachment_targets(run, '[{"task":"9001","attachment":"a1"},{"task":"nope","attachment":"a2"}]');
  assert r.task_id = task and r.attachment_gid = 'a1' and not r.present, 'targets map Asana task ids to imported tasks';
  assert (select count(*) from public.import_attachment_targets(run, '[{"task":"nope","attachment":"a2"}]')) = 0,
    'unknown tasks are left out';
  assert public.import_attachment_file(run, task, 'a1', task::text || '/u1-file.pdf', 'file.pdf', 'application/pdf', 10) = 'added', 'added';
  assert public.import_attachment_file(run, task, 'a1', task::text || '/u2-file.pdf', 'file.pdf', 'application/pdf', 10) = 'exists',
    're-running never duplicates';
  assert (select present from public.import_attachment_targets(run, '[{"task":"9001","attachment":"a1"}]')), 'and is reported present';
  assert not exists (select 1 from public.task_stories where task_id = task and kind = 'attachment_added'),
    'quiet like the rest of the import';
  begin
    perform public.import_attachment_file(run, (select id from ed_ids where name = 'plain'), 'a3', (select id from ed_ids where name = 'plain')::text || '/x', 'x', null, 1);
    raise exception 'only tasks the import mapped';
  exception when no_data_found then null;
  end;
  perform public.finish_import_run(run, 'completed', '{}');
  begin
    perform public.import_attachment_file(run, task, 'a4', task::text || '/u4', 'x', null, 1);
    raise exception 'a finished import takes no files';
  exception when check_violation then null;
  end;
  insert into ed_ids values ('run', run);
end $$;
select set_config('request.jwt.claim.sub', 'e2727272-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  perform public.import_attachment_targets((select id from ed_ids where name = 'run'), '[]');
  raise exception 'Editors don''t import';
exception when insufficient_privilege then null;
end $$;
reset role;

-- Storage: project admins may upload a project email logo (manual policy).
do $$
declare
  p uuid := (select id from ed_ids where name = 'p');
begin
  assert public.workspace_asset_email_project('00000000-0000-4000-8000-000000000001/email/' || p::text || '/logo.png') = p,
    'a project email logo path names its project';
  assert public.workspace_asset_email_project('00000000-0000-4000-8000-000000000001/email/' || p::text || '/a/b.png') is null
    and public.workspace_asset_email_project('11111111-1111-4111-8111-111111111111/email/' || p::text || '/logo.png') is null,
    'only <workspace>/email/<project>/<file> of the project''s own workspace';
  assert exists (select 1 from pg_policies where tablename = 'objects' and policyname = 'workspace_assets_objects_insert_project_admin'),
    'the manual Storage policy is in place';
end $$;

do $$ begin raise notice 'email designs smoke: all assertions passed'; end $$;
