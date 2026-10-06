-- Behavioural checks for Phase: Asana importer: Admin+ only RPCs and Storage uploads, the batch
-- mapping (sections, fields + options, tasks, assignees matched by member email, unmatched notes,
-- dates, completion, subtasks, comments, attachment links, followers, dependencies, multi-homing),
-- imported rules landing disabled, no rule runs / inbox items / extra stories during an import,
-- idempotent re-import by external id, finish summary, and RLS on the new tables. People from
-- earlier suites:
--   1111… member@example.com    "Member One"     (owner of everything below)
--   5555… viewer@example.com    "Vera Viewer"
--   7777… editor@example.com    "Eddie Editor"
--   8888… admin@example.com     "Ada Admin"      (runs the imports)
--   9999… nonmember@example.com "Nora Nonmember" (has an account, never joins the target project)

\set ON_ERROR_STOP 1

create temporary table ai_ids (name text primary key, id uuid) on commit preserve rows;
grant all on ai_ids to authenticated, anon, service_role;

-- Fixtures ----------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid;
  sib uuid;
  s_doing uuid;
  s_inbox uuid;
  live_rule uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Import target') returning id into p;
  insert into public.projects (workspace_id, name) values (ws, 'Sibling') returning id into sib;
  insert into public.sections (project_id, name, sort_order) values (p, 'Doing', 1024) returning id into s_doing;
  insert into public.sections (project_id, name, sort_order) values (sib, 'Inbox', 1024) returning id into s_inbox;
  perform public.add_project_member(p, 'admin@example.com', 'admin');
  perform public.add_project_member(p, 'editor@example.com', 'editor');
  perform public.add_project_member(p, 'viewer@example.com', 'viewer');
  perform public.add_project_member(sib, 'admin@example.com', 'admin');
  -- An enabled rule that must not fire for imported tasks (but still fires for normal ones).
  insert into public.rules (project_id, name, enabled, trigger_type, actions)
  values (p, 'Comment on new tasks', true, 'task_created', '[{"type": "add_comment", "body": "Welcome"}]')
  returning id into live_rule;
  insert into ai_ids values ('p', p), ('sib', sib), ('s_doing', s_doing), ('s_inbox', s_inbox), ('live_rule', live_rule);
end $$;

-- Only Admins can start an import or upload export files --------------------------------------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from ai_ids where name = 'p');
begin
  begin
    perform public.start_import_run(p, 'asana', array['export.json']);
    raise exception 'editors should not start imports';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into storage.objects (bucket_id, name)
    values ('imports', p::text || '/77777777-7777-4777-8777-777777777777/x-export.json');
    raise exception 'editors should not upload export files';
  exception when insufficient_privilege then null;
  end;
  assert not exists (select 1 from public.import_runs), 'editors see no import runs';
end $$;

select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999999', false) is not null as ok \gset

do $$
begin
  perform public.start_import_run((select id from ai_ids where name = 'p'), 'asana', '{}');
  raise exception 'non-members should not start imports';
exception when no_data_found then null;
end $$;

select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from ai_ids where name = 'p');
begin
  begin
    perform public.start_import_run(p, 'trello', '{}');
    raise exception 'unknown sources should fail';
  exception when check_violation then null;
  end;
  insert into storage.objects (bucket_id, name)
  values ('imports', p::text || '/88888888-8888-4888-8888-888888888888/a1-export.json');
  assert (select count(*) from storage.objects where bucket_id = 'imports') = 1, 'the uploader reads their own file';
  begin
    insert into storage.objects (bucket_id, name)
    values ('imports', p::text || '/77777777-7777-4777-8777-777777777777/spoofed.json');
    raise exception 'uploads must sit under the uploader''s own folder';
  exception when insufficient_privilege then null;
  end;
end $$;

-- The sibling project is imported first, so tasks of the main export can be multi-homed into it.
do $$
declare
  sib uuid := (select id from ai_ids where name = 'sib');
  run uuid;
begin
  run := public.start_import_run(sib, 'asana', array['sibling.json']);
  perform public.import_batch(run, '{"project": {"gid": "asana-proj-B", "name": "Sibling"}}'::jsonb);
  perform public.finish_import_run(run, 'completed', '{}'::jsonb);
end $$;

-- First import ------------------------------------------------------------------------------------

do $$
declare
  p uuid := (select id from ai_ids where name = 'p');
  run uuid;
  result jsonb;
begin
  run := public.start_import_run(p, 'asana', array['project.json', 'project.csv']);
  insert into ai_ids values ('run', run);

  result := public.import_batch(run, $json$
  {
    "project": {"gid": "asana-proj-A", "name": "Marketing"},
    "sections": [
      {"key": "s-todo", "name": "To do"},
      {"key": "name:doing", "name": "doing"}
    ],
    "fields": [
      {"key": "f-priority", "name": "Priority", "type": "single_select", "options": ["High", "Low"]},
      {"key": "f-budget", "name": "Budget", "type": "number"},
      {"key": "f-brief", "name": "Brief", "type": "text"},
      {"key": "f-launch", "name": "Launch", "type": "date"},
      {"key": "f-owners", "name": "Owners", "type": "people"},
      {"key": "asana:tags", "name": "Tags", "type": "multi_select", "options": ["Print", "Web"]}
    ],
    "rules": [
      {"key": "r-ok", "name": "Ping on create", "trigger_type": "task_created",
       "actions": [{"type": "add_comment", "body": "hi"}]},
      {"key": "r-bad", "name": "Broken", "trigger_type": "task_created", "actions": [{"type": "explode"}]}
    ],
    "tasks": [
      {"gid": "1001", "title": "Spring flyer", "notes": "Two sizes", "due_on": "2026-11-02", "start_on": "2026-10-20",
       "assignee_email": "Editor@Example.com", "assignee_name": "Eddie Editor", "section_key": "s-todo",
       "fields": [
         {"key": "f-priority", "value": "high"},
         {"key": "f-budget", "value": 1200},
         {"key": "f-brief", "value": "Bold"},
         {"key": "f-launch", "value": "2026-11-15"},
         {"key": "f-owners", "value": ["viewer@example.com", "stranger@elsewhere.com"]},
         {"key": "asana:tags", "value": ["Print", "Web"]},
         {"key": "f-priority-missing", "value": "x"}
       ],
       "followers": ["viewer@example.com"],
       "subtasks": [
         {"gid": "2001", "title": "Draft copy"},
         {"gid": "2002", "title": "Pick photo", "completed_at": "2026-10-01T10:00:00Z"}
       ],
       "comments": [
         {"gid": "3001", "body": "Looks good", "author_email": "editor@example.com", "created_at": "2026-09-30T09:00:00Z"},
         {"gid": "3002", "body": "Need logo", "author_name": "Olga Outside", "author_email": "olga@elsewhere.com"}
       ],
       "attachments": [
         {"gid": "4001", "name": "brief.pdf", "url": "https://app.asana.com/app/asana/-/get_asset?asset_id=4001"},
         {"gid": "4002", "name": "evil.txt", "url": "javascript:alert(1)"}
       ]},
      {"gid": "1002", "title": "Print order", "due_on": "2026-10-10", "start_on": "2026-10-12",
       "completed_at": "2026-10-03T12:00:00Z",
       "assignee_email": "nonmember@example.com", "assignee_name": "Nora Nonmember", "section_key": "name:doing"},
      {"gid": "1003", "title": "Web banner", "section_key": "name:doing",
       "projects": [{"gid": "asana-proj-B", "section_name": "inbox"}, {"gid": "asana-proj-unknown", "section_name": "x"}]}
    ],
    "dependencies": [
      {"predecessor": "1001", "successor": "1002"},
      {"predecessor": "1002", "successor": "1001"},
      {"predecessor": "1001", "successor": "9999"}
    ]
  }
  $json$::jsonb);

  assert (result ->> 'tasks')::int = 3, format('three tasks created, got %s', result);
  assert (result ->> 'sections')::int = 1, 'one new section; "doing" matched the existing "Doing"';
  assert (result ->> 'fields')::int = 6, 'six fields created';
  assert (result ->> 'rules')::int = 1 and (result ->> 'rules_skipped')::int = 1, 'valid rule added, invalid one skipped';
  assert (result ->> 'subtasks')::int = 2, 'two subtasks';
  assert (result ->> 'comments')::int = 2, 'two comments';
  assert (result ->> 'attachments')::int = 2, 'two attachment links';
  assert (result ->> 'dependencies')::int = 1, 'one dependency';
  assert (result ->> 'dependencies_skipped')::int = 2, 'cycle and missing task skipped';
  assert (result ->> 'memberships')::int = 1, 'one task multi-homed into the imported sibling project';
  assert (result ->> 'unassigned')::int = 1, 'the non-member assignee is reported';
  assert (result ->> 'dates_dropped')::int = 1, 'a start date after the due date is dropped';
end $$;

reset role;

do $$
declare
  p uuid := (select id from ai_ids where name = 'p');
  sib uuid := (select id from ai_ids where name = 'sib');
  run uuid := (select id from ai_ids where name = 'run');
  t1 uuid := (select local_id from public.import_external_ids where project_id = p and kind = 'task' and external_id = '1001');
  t2 uuid := (select local_id from public.import_external_ids where project_id = p and kind = 'task' and external_id = '1002');
  t3 uuid := (select local_id from public.import_external_ids where project_id = p and kind = 'task' and external_id = '1003');
  s_todo uuid := (select id from public.sections where project_id = p and name = 'To do' and deleted_at is null);
  priority public.custom_fields;
  tags public.custom_fields;
begin
  insert into ai_ids values ('t1', t1), ('t2', t2), ('t3', t3);
  assert t1 is not null and t2 is not null and t3 is not null, 'gids map to tasks';

  -- Tasks
  assert (select source from public.tasks where id = t1) = 'import', 'imported tasks have source import';
  assert (select assignee_id from public.tasks where id = t1) = '77777777-7777-4777-8777-777777777777',
    'assignee matched by member email (case-insensitive)';
  assert (select due_on from public.tasks where id = t1) = '2026-11-02'
    and (select start_on from public.tasks where id = t1) = '2026-10-20', 'dates kept';
  assert (select section_id from public.task_projects where task_id = t1 and project_id = p) = s_todo, 'new section used';
  assert (select section_id from public.task_projects where task_id = t2 and project_id = p)
    = (select id from ai_ids where name = 's_doing'), 'existing section matched by name';
  assert (select assignee_id from public.tasks where id = t2) is null, 'a non-member stays unassigned';
  assert (select notes from public.tasks where id = t2) like '%Assignee in Asana: Nora Nonmember <nonmember@example.com>%',
    'the unmatched assignee is noted on the task';
  assert (select start_on from public.tasks where id = t2) is null
    and (select notes from public.tasks where id = t2) like '%Start date in Asana: 2026-10-12%', 'dropped start date noted';
  assert (select completed_at from public.tasks where id = t2) = '2026-10-03T12:00:00Z', 'completion kept';
  assert (select completed_at from public.tasks where id = t1) is null, 'open tasks stay open';
  assert exists (select 1 from public.task_projects where task_id = t3 and project_id = sib and deleted_at is null
    and section_id = (select id from ai_ids where name = 's_inbox')), 'multi-homed into the mapped project + section';

  -- Fields
  select * into priority from public.custom_fields where project_id = p and name = 'Priority';
  select * into tags from public.custom_fields where project_id = p and name = 'Tags';
  assert priority.field_type = 'single_select' and jsonb_array_length(priority.options) = 2, 'select options created';
  assert (select value from public.task_field_values where task_id = t1 and field_id = priority.id)
    = (select o -> 'id' from jsonb_array_elements(priority.options) o where o ->> 'name' = 'High'),
    'select values are stored as option ids, matched by name';
  assert jsonb_array_length((select value from public.task_field_values where task_id = t1 and field_id = tags.id)) = 2,
    'tags become a multi-select value';
  assert (select value from public.task_field_values tv join public.custom_fields f on f.id = tv.field_id
          where tv.task_id = t1 and f.name = 'Budget') = '1200'::jsonb, 'number value';
  assert (select value from public.task_field_values tv join public.custom_fields f on f.id = tv.field_id
          where tv.task_id = t1 and f.name = 'Launch') = '"2026-11-15"'::jsonb, 'date value';
  assert (select value from public.task_field_values tv join public.custom_fields f on f.id = tv.field_id
          where tv.task_id = t1 and f.name = 'Owners') = '["55555555-5555-4555-8555-555555555555"]'::jsonb,
    'people values keep matched members only';

  -- Rules
  assert (select enabled from public.rules where project_id = p and name = 'Ping on create') = false,
    'imported rules land disabled';
  assert not exists (select 1 from public.rules where project_id = p and name = 'Broken'), 'invalid rule skipped';

  -- Subtasks, comments, attachments, followers, dependencies
  assert (select count(*) from public.tasks where parent_task_id = t1 and deleted_at is null) = 2, 'subtasks';
  assert (select completed_at from public.tasks where parent_task_id = t1 and title = 'Pick photo') is not null, 'subtask completion';
  assert (select author_id from public.comments where task_id = t1 and body = 'Looks good')
    = '77777777-7777-4777-8777-777777777777', 'comment by a matched member keeps its author';
  assert (select created_at from public.comments where task_id = t1 and body = 'Looks good') = '2026-09-30T09:00:00Z',
    'comment keeps its original time';
  assert exists (select 1 from public.comments where task_id = t1
    and author_id = '88888888-8888-4888-8888-888888888888' and body = E'Olga Outside wrote in Asana:\nNeed logo'),
    'an unmatched author''s comment is posted by the importer with their name';
  assert (select url from public.task_attachment_links where task_id = t1 and name = 'brief.pdf') like 'https://app.asana.com/%',
    'attachment link kept';
  assert (select url from public.task_attachment_links where task_id = t1 and name = 'evil.txt') is null,
    'non-https links are dropped, the name is kept';
  assert exists (select 1 from public.task_followers where task_id = t1 and profile_id = '55555555-5555-4555-8555-555555555555'
    and deleted_at is null), 'matched followers follow';
  assert not exists (select 1 from public.task_followers where task_id = t2 and profile_id = '88888888-8888-4888-8888-888888888888'
    and deleted_at is null), 'the importer does not stay subscribed to every imported task';
  assert exists (select 1 from public.task_dependencies where predecessor_id = t1 and successor_id = t2 and deleted_at is null),
    'dependency created';

  -- No side effects
  assert not exists (select 1 from public.rule_runs where task_id in (t1, t2, t3)), 'no rule ran for imported tasks';
  assert not exists (select 1 from public.comments where task_id in (t1, t2, t3) and body = 'Welcome'), 'enabled rule did not fire';
  assert not exists (select 1 from public.inbox_items where task_id in (t1, t2, t3)), 'an import notifies nobody';
  assert (select count(*) from public.task_stories where task_id in (t1, t2, t3)) = 3
    and (select count(*) from public.task_stories where task_id in (t1, t2, t3) and kind = 'created'
         and data #>> '{import,source}' = 'asana' and data #>> '{import,run_id}' = run::text) = 3,
    'exactly one created story per imported task, tagged with the import';
  assert current_setting('alhc.import_run_id', true) is null or current_setting('alhc.import_run_id', true) = '',
    'the import context does not outlive its transaction';
end $$;

-- Re-import is idempotent (and adds only what is new) ------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', false) is not null as ok \gset

do $$
declare
  run uuid := (select id from ai_ids where name = 'run');
  before_counts bigint[];
  result jsonb;
begin
  select array[
    (select count(*) from public.tasks where home_project_id = (select id from ai_ids where name = 'p')),
    (select count(*) from public.sections where project_id = (select id from ai_ids where name = 'p')),
    (select count(*) from public.custom_fields where project_id = (select id from ai_ids where name = 'p')),
    (select count(*) from public.tasks where parent_task_id = (select id from ai_ids where name = 't1')),
    (select count(*) from public.task_dependencies where project_id = (select id from ai_ids where name = 'p'))
  ] into before_counts;

  result := public.import_batch(run, $json$
  {
    "sections": [{"key": "s-todo", "name": "To do"}, {"key": "name:doing", "name": "Doing"}],
    "fields": [{"key": "f-priority", "name": "Priority", "type": "single_select", "options": ["High", "Low", "Urgent"]}],
    "rules": [{"key": "r-ok", "name": "Ping on create", "trigger_type": "task_created",
               "actions": [{"type": "add_comment", "body": "hi"}]}],
    "tasks": [
      {"gid": "1001", "title": "Spring flyer (renamed in Asana)", "section_key": "s-todo",
       "subtasks": [{"gid": "2001", "title": "Draft copy"}],
       "comments": [{"gid": "3001", "body": "Looks good", "author_email": "editor@example.com"},
                    {"gid": "3003", "body": "Approved", "author_email": "editor@example.com"}]},
      {"gid": "1002", "title": "Print order"},
      {"gid": "1003", "title": "Web banner"}
    ],
    "dependencies": [{"predecessor": "1001", "successor": "1002"}]
  }
  $json$::jsonb);

  assert (result ->> 'tasks')::int = 0 and (result ->> 'tasks_skipped')::int = 3, format('no duplicate tasks, got %s', result);
  assert (result ->> 'sections')::int = 0 and (result ->> 'fields')::int = 0 and (result ->> 'rules')::int = 0,
    'no duplicate sections, fields, or rules';
  assert (result ->> 'subtasks')::int = 0 and (result ->> 'dependencies')::int = 0, 'no duplicate subtasks or dependencies';
  assert (result ->> 'comments')::int = 1, 'only the new comment is added';
  assert before_counts = array[
    (select count(*) from public.tasks where home_project_id = (select id from ai_ids where name = 'p')),
    (select count(*) from public.sections where project_id = (select id from ai_ids where name = 'p')),
    (select count(*) from public.custom_fields where project_id = (select id from ai_ids where name = 'p')),
    (select count(*) from public.tasks where parent_task_id = (select id from ai_ids where name = 't1')),
    (select count(*) from public.task_dependencies where project_id = (select id from ai_ids where name = 'p'))
  ], 'row counts unchanged';
  assert (select title from public.tasks where id = (select id from ai_ids where name = 't1')) = 'Spring flyer',
    'existing tasks are never overwritten';
  assert (select jsonb_array_length(options) from public.custom_fields where id =
    (select local_id from public.import_external_ids where kind = 'field' and external_id = 'f-priority')) = 3,
    'a new select option is appended to the existing field';

  -- Dry-run lookup sees what was imported, for Admins of the project.
  assert (select count(*) from public.import_lookup('asana', array['1001', '1002', '1003', 'nope'])
          where kind = 'task') = 3, 'lookup finds imported tasks';
  assert exists (select 1 from public.import_lookup('asana', array['asana-proj-A']) where kind = 'project'),
    'lookup finds the imported project';

  perform public.finish_import_run(run, 'completed', '{"files": 2}'::jsonb);
  assert (select status from public.import_runs where id = run) = 'completed', 'run completed';
  assert (select summary #>> '{created,task}' from public.import_runs where id = run) = '3', 'summary counts what landed';
  assert (select summary #>> '{created,section}' from public.import_runs where id = run) = '2'
    and (select summary #>> '{created,field}' from public.import_runs where id = run) = '6',
    're-sending known sections and fields does not count them again';
  assert (select summary ->> 'files' from public.import_runs where id = run) = '2', 'app summary kept';
  begin
    perform public.import_batch(run, '{"tasks": []}'::jsonb);
    raise exception 'a finished run takes no more batches';
  exception when check_violation then null;
  end;
end $$;

-- The import context is per transaction: a normal task still fires the enabled rule ----------------

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', false) is not null as ok \gset

do $$
declare
  t uuid;
begin
  t := public.create_task((select id from ai_ids where name = 'p'), null, 'Made by hand');
  insert into ai_ids values ('manual', t);
end $$;

do $$
begin
  assert exists (select 1 from public.comments where task_id = (select id from ai_ids where name = 'manual') and body = 'Welcome'),
    'rules still fire outside an import';
  assert (select source from public.tasks where id = (select id from ai_ids where name = 'manual')) = 'manual', 'normal source';

  -- RLS: editors see no import bookkeeping and can't write it; viewers+ see attachment links.
  assert not exists (select 1 from public.import_runs), 'editors cannot read import runs';
  assert not exists (select 1 from public.import_external_ids), 'editors cannot read the id map';
  assert not exists (select 1 from public.import_lookup('asana', array['1001'])), 'editors get nothing from lookup';
  assert exists (select 1 from public.task_attachment_links where task_id = (select id from ai_ids where name = 't1')),
    'members read attachment links';
  begin
    insert into public.import_external_ids (project_id, source, kind, external_id, local_id)
    values ((select id from ai_ids where name = 'p'), 'asana', 'task', 'forged', gen_random_uuid());
    raise exception 'clients cannot write the id map';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.task_attachment_links (task_id, source, name)
    values ((select id from ai_ids where name = 't1'), 'asana', 'forged');
    raise exception 'clients cannot write attachment links';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999999', false) is not null as ok \gset

do $$
begin
  assert not exists (select 1 from public.task_attachment_links), 'non-members read no attachment links';
end $$;

select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false) is not null as ok \gset

do $$
begin
  assert not exists (select 1 from storage.objects where bucket_id = 'imports'), 'other people never read uploaded exports';
  begin
    perform public.import_batch((select id from ai_ids where name = 'run'), '{}'::jsonb);
    raise exception 'viewers cannot send batches';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

do $$
begin
  assert not has_function_privilege('anon', 'public.import_batch(uuid, jsonb)', 'execute'), 'anon cannot import';
  assert not has_function_privilege('anon', 'public.start_import_run(uuid, text, text[])', 'execute'), 'anon cannot start';
  assert not has_function_privilege('authenticated', 'public.import_remember(uuid, text, text, text, uuid, uuid)', 'execute'),
    'internal helpers are revoked';
  assert not has_function_privilege('authenticated', 'public.import_member(uuid, text)', 'execute'), 'member lookup is internal';
  assert not has_table_privilege('anon', 'public.import_runs', 'select'), 'anon has no table access';
end $$;

select 'asana import smoke: all assertions passed' as result;
