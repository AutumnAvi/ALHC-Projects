-- Behavioural checks for the collaboration migration. Runs after 10_core_smoke.sql and reuses its users:
--   1111… member@example.com  "Member One"   (allowlisted)
--   4444… later@example.com   "Later Person" (allowlisted)
--   2222… outsider@example.com               (not allowlisted)

\set ON_ERROR_STOP 1

do $$
begin
  assert public.regex_escape('a.b (c)') = 'a\.b \(c\)', 'regex_escape escapes metacharacters';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

create temporary table ids (name text primary key, id uuid) on commit preserve rows;
grant all on ids to authenticated;

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid;
  other_p uuid;
  s1 uuid;
  s2 uuid;
  t uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Collab') returning id into p;
  insert into public.projects (workspace_id, name) values (ws, 'Elsewhere') returning id into other_p;
  -- Since Teams & permissions, other people need a membership to read or be notified about a project.
  perform public.add_project_member(p, 'later@example.com', 'editor');
  insert into public.sections (project_id, name, sort_order) values (p, 'Backlog', 1) returning id into s1;
  insert into public.sections (project_id, name, sort_order) values (p, 'Doing', 2) returning id into s2;

  t := public.create_task(p, s1, 'Plan the launch');
  insert into ids values ('task', t), ('project', p), ('other_project', other_p), ('s1', s1), ('s2', s2);

  assert (select section_id from public.task_projects where task_id = t and project_id = p) = s1,
    'create_task places the task in the requested section';
  assert (select array_agg(kind order by created_at) from public.task_stories where task_id = t) = array['created'],
    'a new task has exactly one "created" story (no membership noise)';
  assert exists (select 1 from public.task_followers where task_id = t and profile_id = auth.uid()),
    'creator auto-follows';
end $$;

-- Later changes happen in their own transactions, as they would from the app.
do $$
declare
  later uuid := '44444444-4444-4444-8444-444444444444';
  t uuid := (select id from ids where name = 'task');
  p uuid := (select id from ids where name = 'project');
  other_p uuid := (select id from ids where name = 'other_project');
  s2 uuid := (select id from ids where name = 's2');
  f_select uuid;
  f_number uuid;
  f_text uuid;
  f_status uuid;
  f_other uuid;
begin

  update public.tasks set assignee_id = later where id = t;
  assert exists (select 1 from public.task_stories where task_id = t and kind = 'assigned'), 'assignment story';
  assert exists (select 1 from public.task_followers where task_id = t and profile_id = later),
    'assignee auto-follows';

  update public.task_projects set section_id = s2 where task_id = t and project_id = p;
  assert (select data ->> 'to' from public.task_stories where task_id = t and kind = 'section_changed') = 'Doing',
    'section move story records the new section name';

  insert into public.comments (task_id, body) values (t, 'Hey @Later Person, take a look. cc @member');
  insert into public.comments (task_id, body) values (t, 'Following up without a mention');
  assert (select count(*) from public.comment_mentions) = 1,
    'only the other person is recorded as mentioned (self-mention ignored)';

  begin
    insert into public.comments (task_id, author_id, body) values (t, later, 'Spoofed');
    raise exception 'spoofed comment author should fail';
  exception when insufficient_privilege then
    null;
  end;

  begin
    insert into public.inbox_items (recipient_id, task_id, kind) values (later, t, 'assigned');
    raise exception 'clients must not write inbox items';
  exception when insufficient_privilege then
    null;
  end;

  begin
    insert into public.task_stories (task_id, kind) values (t, 'created');
    raise exception 'clients must not write stories';
  exception when insufficient_privilege then
    null;
  end;

  assert (select count(*) from public.inbox_items) = 0, 'members only see their own inbox';

  -- Custom fields ------------------------------------------------------------------------------
  insert into public.custom_fields (project_id, name, field_type, options)
  values (p, 'Priority', 'single_select', '[{"id":"hi","name":"High"},{"id":"lo","name":"Low"}]')
  returning id into f_select;
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Budget', 'number')
  returning id into f_number;
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Channel', 'text')
  returning id into f_text;
  insert into public.custom_fields (project_id, name, field_type, bound_to_sections)
  values (p, 'Status', 'single_select', true) returning id into f_status;
  insert into public.custom_fields (project_id, name, field_type) values (other_p, 'Other', 'text')
  returning id into f_other;

  insert into public.task_field_values (task_id, field_id, value) values (t, f_select, '"hi"');
  insert into public.task_field_values (task_id, field_id, value) values (t, f_number, '1200.5');
  insert into public.task_field_values (task_id, field_id, value) values (t, f_text, '"Email"');
  update public.task_field_values set value = 'null' where task_id = t and field_id = f_text;
  assert (select value from public.task_field_values where task_id = t and field_id = f_text) is null,
    'JSON null clears a value';
  assert (select count(*) from public.task_stories where task_id = t and kind = 'field_changed') = 4,
    'field changes are recorded as stories';

  begin
    update public.task_field_values set value = '"nope"' where task_id = t and field_id = f_select;
    raise exception 'unknown option should fail';
  exception when check_violation then null;
  end;
  begin
    update public.task_field_values set value = '"abc"' where task_id = t and field_id = f_number;
    raise exception 'string in number field should fail';
  exception when check_violation then null;
  end;
  begin
    insert into public.task_field_values (task_id, field_id, value) values (t, f_status, '"x"');
    raise exception 'section-bound field values should fail';
  exception when check_violation then null;
  end;
  begin
    insert into public.task_field_values (task_id, field_id, value) values (t, f_other, '"x"');
    raise exception 'field from a project the task is not in should fail';
  exception when check_violation then null;
  end;
  begin
    insert into public.custom_fields (project_id, name, field_type, bound_to_sections)
    values (p, 'Status 2', 'single_select', true);
    raise exception 'second section-bound field should fail';
  exception when unique_violation then null;
  end;

  -- Attachments --------------------------------------------------------------------------------
  begin
    insert into public.task_attachments (task_id, storage_path, file_name, size_bytes)
    values (t, 'elsewhere/file.pdf', 'file.pdf', 10);
    raise exception 'attachment path outside the task folder should fail';
  exception when check_violation then null;
  end;
  insert into public.task_attachments (task_id, storage_path, file_name, content_type, size_bytes)
  values (t, t::text || '/abc-brief.pdf', 'brief.pdf', 'application/pdf', 2048);
  assert exists (select 1 from public.task_stories where task_id = t and kind = 'attachment_added'),
    'attachment story';
  insert into storage.objects (bucket_id, name) values ('task-attachments', t::text || '/abc-brief.pdf');
  begin
    insert into storage.objects (bucket_id, name) values ('some-other-bucket', 'x');
    raise exception 'other buckets should be rejected';
  exception when insufficient_privilege then null;
  end;

  -- Completion + search -------------------------------------------------------------------------
  update public.tasks set completed_at = now() where id = t;
  assert (select count(*) from public.search_tasks('plan the')) = 1, 'search finds by title';
  assert (select count(*) from public.search_tasks('%')) = 0, 'LIKE wildcards in queries are literal';
  assert (select count(*) from public.search_tasks('   ')) = 0, 'blank query returns nothing';
end $$;

-- Recipient view -------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false) is not null as ok \gset

do $$
declare
  t uuid := (select id from ids where name = 'task');
  affected int;
begin
  assert (select array_agg(kind order by kind) from public.inbox_items)
    = array['assigned', 'comment', 'completed', 'mention'],
    'recipient gets assigned, mention (not a duplicate comment), follower comment, completed';
  assert (select count(*) from public.inbox_items where actor_id = '11111111-1111-4111-8111-111111111111') = 4,
    'inbox items record the actor';

  update public.inbox_items set read_at = now();
  assert (select count(*) from public.inbox_items where read_at is null) = 0, 'recipient can mark read';

  begin
    update public.inbox_items set kind = 'mention';
    raise exception 'recipient must not rewrite inbox items';
  exception when insufficient_privilege then null;
  end;

  update public.comments set deleted_at = now() where task_id = t;
  get diagnostics affected = row_count;
  assert affected = 0, 'only the author can soft-delete a comment';
end $$;

-- Retracting a comment clears the recipient's unread item for it.

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

do $$
declare
  t uuid := (select id from ids where name = 'task');
  c uuid;
begin
  insert into public.comments (task_id, body) values (t, 'Retracted note') returning id into c;
  update public.comments set deleted_at = now() where id = c;
  insert into ids values ('retracted', c);
end $$;

select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false) is not null as ok \gset

do $$
begin
  assert exists (
    select 1 from public.inbox_items where comment_id = (select id from ids where name = 'retracted')
  ), 'the follower was notified of the comment';
  assert (select count(*) from public.inbox_items where read_at is null) = 0,
    'a soft-deleted comment leaves no unread inbox item';
end $$;

-- Outsider + anon ------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false) is not null as ok \gset

do $$
begin
  assert (select count(*) from public.comments) = 0, 'outsider cannot read comments';
  assert (select count(*) from public.custom_fields) = 0, 'outsider cannot read fields';
  assert (select count(*) from public.search_tasks('plan')) = 0, 'outsider search returns nothing';
  begin
    insert into storage.objects (bucket_id, name) values ('task-attachments', 'x/y');
    raise exception 'outsider upload should fail';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
set role anon;

do $$
begin
  begin
    perform public.search_tasks('plan');
    raise exception 'anon should not be able to search';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
select 'collaboration smoke: all assertions passed' as result;
