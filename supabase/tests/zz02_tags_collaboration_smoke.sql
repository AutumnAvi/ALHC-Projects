-- Behavioural checks for Phase: Tags and collaboration extras: the one-time copy of imported Asana
-- "Tags" fields into native tags (only the marked field, once), tag metadata rights (creator or
-- workspace admin), task_tags following the task (Viewers read, Editors write, subtasks via the root),
-- non-members and workspace admins seeing no links or messages, the views / search / report / bulk
-- additions, tags carried by templates, Duplicate, and recurrence, the importer's native tags, project
-- Messages (Viewers read, Commenters+ post, mentions only reach project readers, inbox items about
-- messages), and anon getting nothing.
-- Fresh people for this suite (no memberships from earlier suites):
--   d2d2…01 tags-owner@example.com      owner of Tag Alpha and Tag Import
--   d2d2…02 tags-viewer@example.com     Viewer of Tag Alpha
--   d2d2…03 tags-commenter@example.com  Commenter of Tag Alpha
--   d2d2…04 tags-out@example.com        allowlisted, in no project

\set ON_ERROR_STOP 1

create temporary table tg_ids (name text primary key, id uuid) on commit preserve rows;
grant all on tg_ids to authenticated, anon, service_role;

-- The data migration: only the marked field, once ---------------------------------------------------

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  print_tag uuid;
  web_tag uuid;
  links_before integer;
begin
  select id into print_tag from public.tags where workspace_id = ws and name = 'Legacy Print' and deleted_at is null;
  select id into web_tag from public.tags where workspace_id = ws and name = 'Legacy Web' and deleted_at is null;
  assert print_tag is not null and web_tag is not null, 'option names of the imported Tags field became tags';
  assert (select color from public.tags where id = print_tag) = 'blue', 'the option colour is kept';
  assert (select created_by from public.tags where id = print_tag) = 'f1f1f1f1-0000-4000-8000-000000000001',
    'migrated tags are attributed to the importer';
  assert not exists (select 1 from public.tags where name in ('Legacy Unused', 'Legacy Handmade')),
    'unused options and fields without the marker are not migrated';
  assert (select count(*) from public.task_tags where task_id = 'f1f1f1f1-0000-4000-8000-0000000000b1' and deleted_at is null) = 2,
    'a task with two values gets two tags';
  assert exists (select 1 from public.task_tags where task_id = 'f1f1f1f1-0000-4000-8000-0000000000b2' and tag_id = print_tag),
    'each value becomes a link';
  assert not exists (select 1 from public.task_tags where task_id = 'f1f1f1f1-0000-4000-8000-0000000000b3'),
    'trashed tasks are skipped';
  assert exists (select 1 from public.tag_field_migrations where field_id = 'f1f1f1f1-0000-4000-8000-0000000000c1'),
    'the marked field is recorded as migrated';
  assert not exists (select 1 from public.tag_field_migrations where field_id = 'f1f1f1f1-0000-4000-8000-0000000000c2'),
    'the unmarked field is not';
  assert exists (select 1 from public.custom_fields where id = 'f1f1f1f1-0000-4000-8000-0000000000c1' and deleted_at is null)
    and (select count(*) from public.task_field_values where field_id = 'f1f1f1f1-0000-4000-8000-0000000000c1') = 3,
    'the field and its values are kept';

  -- Earlier suites may have imported Tags fields since the migration ran; one call takes those, then
  -- nothing is left to do.
  perform public.migrate_imported_tag_fields();
  select count(*) into links_before from public.task_tags;
  assert public.migrate_imported_tag_fields() = 0, 'running the migration again adds nothing';
  assert (select count(*) from public.task_tags) = links_before, 'no duplicate links';

  -- Once means once: a tag removed after the migration is not re-added.
  update public.task_tags set deleted_at = now()
  where task_id = 'f1f1f1f1-0000-4000-8000-0000000000b2' and tag_id = print_tag and deleted_at is null;
  perform public.migrate_imported_tag_fields();
  assert not exists (
    select 1 from public.task_tags
    where task_id = 'f1f1f1f1-0000-4000-8000-0000000000b2' and tag_id = print_tag and deleted_at is null
  ), 'a removed tag stays removed';
  assert (select count(*) from public.tags where workspace_id = ws and lower(name) = 'legacy print') = 1,
    'no duplicate tags';
end $$;

-- People ---------------------------------------------------------------------------------------------

insert into public.allowed_emails (email, note) values
  ('tags-owner@example.com', 'tags suite'),
  ('tags-viewer@example.com', 'tags suite'),
  ('tags-commenter@example.com', 'tags suite'),
  ('tags-out@example.com', 'tags suite');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('d2d2d2d2-0000-4000-8000-000000000001', 'tags-owner@example.com', now(), '{"full_name":"Tess Owner"}'),
  ('d2d2d2d2-0000-4000-8000-000000000002', 'tags-viewer@example.com', now(), '{"full_name":"Vee Viewer"}'),
  ('d2d2d2d2-0000-4000-8000-000000000003', 'tags-commenter@example.com', now(), '{"full_name":"Cory Commenter"}'),
  ('d2d2d2d2-0000-4000-8000-000000000004', 'tags-out@example.com', now(), '{"full_name":"Oscar Out"}');

insert into tg_ids values
  ('owner', 'd2d2d2d2-0000-4000-8000-000000000001'),
  ('viewer', 'd2d2d2d2-0000-4000-8000-000000000002'),
  ('commenter', 'd2d2d2d2-0000-4000-8000-000000000003'),
  ('out', 'd2d2d2d2-0000-4000-8000-000000000004'),
  ('admin', (select profile_id from public.workspace_admins where deleted_at is null order by created_at limit 1));

do $$
begin
  assert (select id from tg_ids where name = 'admin') is not null, 'an earlier suite left a workspace admin';
end $$;

-- Owner: project, tags, links -------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'd2d2d2d2-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  alpha uuid;
  doing uuid;
  t1 uuid;
  t2 uuid;
  s1 uuid;
  urgent uuid;
  print uuid;
  old_tag uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Tag Alpha') returning id into alpha;
  insert into public.sections (project_id, name, sort_order) values (alpha, 'Doing', 1024) returning id into doing;
  perform public.add_project_member(alpha, 'tags-viewer@example.com', 'viewer');
  perform public.add_project_member(alpha, 'tags-commenter@example.com', 'commenter');

  t1 := public.create_task(alpha, doing, 'Tagged brochure');
  t2 := public.create_task(alpha, doing, 'Plain banner');
  s1 := public.create_subtask(t1, 'Tagged proof');

  insert into public.tags (name, color) values ('Zz Urgent', 'red') returning id into urgent;
  insert into public.tags (name, color) values ('  Zz Print  ', 'blue') returning id into print;
  insert into public.tags (name) values ('Zz Old') returning id into old_tag;
  assert (select name from public.tags where id = print) = 'Zz Print', 'tag names are trimmed';
  assert (select created_by from public.tags where id = urgent) = auth.uid(), 'the creator is the caller';
  assert (select workspace_id from public.tags where id = urgent) = ws, 'tags land in the workspace';

  begin
    insert into public.tags (name) values ('zz urgent');
    raise exception 'tag names are unique per workspace (case-insensitive)';
  exception when unique_violation then null;
  end;
  begin
    insert into public.tags (name, color) values ('Zz Neon', 'neon');
    raise exception 'unknown colours are rejected';
  exception when check_violation then null;
  end;
  begin
    insert into public.tags (name, created_by) values ('Zz Forged', 'd2d2d2d2-0000-4000-8000-000000000002');
    assert (select created_by from public.tags where name = 'Zz Forged') = auth.uid(), 'the creator can''t be forged';
  end;

  insert into public.task_tags (task_id, tag_id) values (t1, urgent), (s1, urgent), (t2, print);
  begin
    insert into public.task_tags (task_id, tag_id) values (t1, urgent);
    raise exception 'one active link per task and tag';
  exception when unique_violation then null;
  end;

  update public.tags set archived_at = now() where id = old_tag;
  begin
    insert into public.task_tags (task_id, tag_id) values (t1, old_tag);
    raise exception 'archived tags can''t be added';
  exception when check_violation then null;
  end;
  begin
    update public.task_tags set tag_id = print where task_id = t1 and tag_id = urgent;
    raise exception 'links can''t move to another tag';
  exception when insufficient_privilege then null;
  end;

  insert into tg_ids values ('alpha', alpha), ('doing', doing), ('t1', t1), ('t2', t2), ('s1', s1),
    ('urgent', urgent), ('print', print), ('old_tag', old_tag);
end $$;

-- Views, search, reports, bulk -----------------------------------------------------------------------

do $$
declare
  alpha uuid := (select id from tg_ids where name = 'alpha');
  t1 uuid := (select id from tg_ids where name = 't1');
  t2 uuid := (select id from tg_ids where name = 't2');
  s1 uuid := (select id from tg_ids where name = 's1');
  urgent uuid := (select id from tg_ids where name = 'urgent');
  print uuid := (select id from tg_ids where name = 'print');
  result jsonb;
begin
  assert (select array_agg(task_id) from public.filter_project_tasks(alpha, jsonb_build_object('tags', jsonb_build_array(urgent)), 'UTC'))
    = array[t1], 'the tag filter keeps tasks with the tag (subtasks are not view rows)';
  assert (select count(*) from public.filter_project_tasks(alpha, jsonb_build_object('tags', jsonb_build_array(urgent, print)), 'UTC')) = 2,
    'tag filters are any-of';
  insert into public.task_tags (task_id, tag_id) values (t2, urgent);
  update public.task_tags set deleted_at = now() where task_id = t2 and deleted_at is null;
  assert (select array_agg(task_id) from public.filter_project_tasks(alpha, '{"tags": [null]}', 'UTC')) = array[t2],
    'null = tasks with no tags';
  insert into public.task_tags (task_id, tag_id) values (t2, print);

  insert into public.project_views (project_id, name, layout, config)
  values (alpha, 'By tag', 'list', jsonb_build_object('group_by', 'tag', 'filters', jsonb_build_object('tags', jsonb_build_array(urgent, null))));
  begin
    insert into public.project_views (project_id, name, layout, config)
    values (alpha, 'Bad tag', 'list', '{"filters": {"tags": ["00000000-0000-4000-8000-00000000dead"]}}');
    raise exception 'unknown tags are rejected in view filters';
  exception when check_violation then null;
  end;

  assert (select count(*) from public.search_tasks('zz urg', 50) s where s.id in (t1, s1)) = 2,
    'search matches tasks and subtasks by tag name';
  assert not exists (select 1 from public.search_tasks('zz urg', 50) s where s.id = t2), 'only tagged tasks';

  assert (select array_agg(task_id) from public.report_task_rows(jsonb_build_object('tags', jsonb_build_array(urgent)), 'UTC'))
    = array[t1], 'the report tag filter';
  assert (select count(*) from public.report_task_rows(jsonb_build_object('tags', jsonb_build_array(urgent), 'include_subtasks', true), 'UTC')) = 2,
    'subtask rows use their own tags';
  begin
    perform public.validate_report_filters('{"tags": ["nope"]}');
    raise exception 'report tag filters list ids';
  exception when check_violation then null;
  end;

  result := public.bulk_update_tasks(array[t1, t2], jsonb_build_object('action', 'add_tag', 'tag_id', print));
  assert result -> 'updated' = jsonb_build_array(t1) and result -> 'unchanged' = jsonb_build_array(t2), 'bulk add_tag';
  result := public.bulk_update_tasks(array[t1], jsonb_build_object('action', 'remove_tag', 'tag_id', print));
  assert result -> 'updated' = jsonb_build_array(t1), 'bulk remove_tag';
  begin
    perform public.bulk_update_tasks(array[t1], jsonb_build_object('action', 'add_tag',
      'tag_id', (select id from tg_ids where name = 'old_tag')));
    raise exception 'bulk can''t add an archived tag';
  exception when invalid_parameter_value then null;
  end;
end $$;

-- Templates, Duplicate, and recurrence carry tags ----------------------------------------------------

do $$
declare
  alpha uuid := (select id from tg_ids where name = 'alpha');
  doing uuid := (select id from tg_ids where name = 'doing');
  t1 uuid := (select id from tg_ids where name = 't1');
  urgent uuid := (select id from tg_ids where name = 'urgent');
  tpl uuid;
  from_tpl uuid;
  copy jsonb;
  copied_task uuid;
  rec uuid;
  next_id uuid;
begin
  tpl := public.save_task_as_template(t1, alpha, 'Tagged template');
  assert (select tags from public.task_templates where id = tpl) = jsonb_build_array(urgent), 'task templates keep tag ids';
  from_tpl := public.create_task_from_template(tpl, doing, 'From template');
  assert exists (select 1 from public.task_tags where task_id = from_tpl and tag_id = urgent and deleted_at is null),
    'tasks from a task template get its tags';

  copy := public.duplicate_project(alpha, 'Tag Alpha copy', '{}'::jsonb);
  select t.id into copied_task from public.tasks t
  where t.home_project_id = (copy ->> 'project_id')::uuid and t.title = 'Tagged brochure' and t.parent_task_id is null;
  assert exists (select 1 from public.task_tags where task_id = copied_task and tag_id = urgent and deleted_at is null),
    'Duplicate project keeps tags';
  assert exists (
    select 1 from public.tasks s join public.task_tags tt on tt.task_id = s.id and tt.tag_id = urgent and tt.deleted_at is null
    where s.parent_task_id = copied_task
  ), 'and subtask tags';

  rec := public.create_task(alpha, doing, 'Weekly tagged report');
  insert into public.task_tags (task_id, tag_id) values (rec, urgent);
  update public.tasks set recurrence = '{"freq": "daily"}', due_on = current_date where id = rec;
  update public.tasks set completed_at = now() where id = rec;
  select recurrence_next_id into next_id from public.tasks where id = rec;
  assert next_id is not null, 'the next occurrence was spawned';
  assert exists (select 1 from public.task_tags where task_id = next_id and tag_id = urgent and deleted_at is null),
    'the next occurrence keeps the tags';
end $$;

-- The importer: Asana tags become native tags ---------------------------------------------------------

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  imp uuid;
  run uuid;
  result jsonb;
  t uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Tag Import') returning id into imp;
  run := public.start_import_run(imp, 'asana', array['tags.json']);
  result := public.import_batch(run, $json$
    {"tasks": [{"gid": "tg-1", "title": "Imported tagged", "tags": ["zz urgent", "Zz Imported", "Zz Imported", " "]}]}
  $json$::jsonb);
  perform public.finish_import_run(run, 'completed', '{}'::jsonb);
  assert (result ->> 'tags')::integer = 2, format('two links (an existing tag by name, one new): %s', result);
  select local_id into t from public.import_external_ids where project_id = imp and kind = 'task' and external_id = 'tg-1';
  assert exists (select 1 from public.task_tags where task_id = t and tag_id = (select id from tg_ids where name = 'urgent')),
    'an existing tag is matched by name, case-insensitively';
  assert (select count(*) from public.tags where lower(name) = 'zz imported' and deleted_at is null) = 1,
    'a missing tag is created once';
  assert not exists (select 1 from public.custom_fields where project_id = imp and name = 'Tags'), 'no Tags field';
  assert not exists (select 1 from public.inbox_items where task_id = t), 'imports stay silent';
end $$;

-- Viewer: reads, can't tag or post ----------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'd2d2d2d2-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  t1 uuid := (select id from tg_ids where name = 't1');
  s1 uuid := (select id from tg_ids where name = 's1');
  urgent uuid := (select id from tg_ids where name = 'urgent');
  print uuid := (select id from tg_ids where name = 'print');
  n integer;
  result jsonb;
begin
  assert (select count(*) from public.task_tags where task_id in (t1, s1) and deleted_at is null) = 2,
    'viewers read tags of tasks and subtasks';
  begin
    insert into public.task_tags (task_id, tag_id) values (t1, print);
    raise exception 'viewers can''t tag';
  exception when insufficient_privilege then null;
  end;
  update public.task_tags set deleted_at = now() where task_id = t1;
  get diagnostics n = row_count;
  assert n = 0, 'viewers can''t remove tags';
  result := public.bulk_update_tasks(array[t1], jsonb_build_object('action', 'add_tag', 'tag_id', print));
  assert jsonb_array_length(result -> 'skipped') = 1, 'bulk tagging skips a viewer';

  update public.tags set name = 'Hijacked' where id = urgent;
  get diagnostics n = row_count;
  assert n = 0, 'only the creator or a workspace admin renames a tag';
  assert not public.can_manage_tag(urgent), 'can_manage_tag agrees';
  insert into public.tags (name) values ('Zz Viewer tag');
  assert public.can_manage_tag((select id from public.tags where name = 'Zz Viewer tag')), 'anyone allowlisted creates tags';
end $$;

-- Commenter: can't tag; posts a thread with mentions ----------------------------------------------------

select set_config('request.jwt.claim.sub', 'd2d2d2d2-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
declare
  alpha uuid := (select id from tg_ids where name = 'alpha');
  t1 uuid := (select id from tg_ids where name = 't1');
  thread uuid;
begin
  begin
    insert into public.task_tags (task_id, tag_id) values (t1, (select id from tg_ids where name = 'print'));
    raise exception 'commenters can''t tag';
  exception when insufficient_privilege then null;
  end;

  insert into public.project_messages (project_id, title, body, author_id)
  values (alpha, '  Launch plan  ', 'Kickoff Monday. @Vee Viewer please read; @Oscar Out too.', 'd2d2d2d2-0000-4000-8000-000000000001')
  returning id into thread;
  assert (select author_id from public.project_messages where id = thread) = auth.uid(), 'the author is the caller';
  assert (select title from public.project_messages where id = thread) = 'Launch plan', 'titles are trimmed';
  assert (select array_agg(profile_id) from public.project_message_mentions where message_id = thread)
    = array['d2d2d2d2-0000-4000-8000-000000000002'::uuid], 'mentions only reach people who can read the project';

  insert into public.project_message_reactions (message_id, emoji) values (thread, 'tada');
  begin
    insert into public.project_messages (project_id, title, body) values (alpha, null, 'No title');
    raise exception 'threads need a title';
  exception when check_violation then null;
  end;
  begin
    update public.project_messages set author_id = 'd2d2d2d2-0000-4000-8000-000000000001' where id = thread;
    raise exception 'authors can only change the text';
  exception when insufficient_privilege then null;
  end;
  insert into tg_ids values ('thread', thread);
end $$;

-- Viewer: reads messages and the mention, can't post or react ------------------------------------------

select set_config('request.jwt.claim.sub', 'd2d2d2d2-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  alpha uuid := (select id from tg_ids where name = 'alpha');
  thread uuid := (select id from tg_ids where name = 'thread');
begin
  assert (select count(*) from public.project_messages where project_id = alpha) = 1, 'viewers read messages';
  assert (select count(*) from public.project_message_reactions where message_id = thread) = 1, 'and reactions';
  assert exists (
    select 1 from public.inbox_items
    where message_id = thread and kind = 'mention' and task_id is null
  ), 'the mentioned viewer gets an inbox item about the message';
  begin
    insert into public.project_messages (project_id, title, body) values (alpha, 'Viewer thread', 'Hi');
    raise exception 'viewers can''t post';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.project_messages (project_id, thread_id, body) values (alpha, thread, 'Viewer reply');
    raise exception 'viewers can''t reply';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.project_message_reactions (message_id, emoji) values (thread, 'heart');
    raise exception 'viewers can''t react';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Owner: replies; participants are told, edits notify only new mentions ---------------------------------

select set_config('request.jwt.claim.sub', 'd2d2d2d2-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  alpha uuid := (select id from tg_ids where name = 'alpha');
  thread uuid := (select id from tg_ids where name = 'thread');
  reply uuid;
  n integer;
begin
  insert into public.project_messages (project_id, thread_id, body) values (alpha, thread, 'Sounds good')
  returning id into reply;
  assert (select thread_id from public.project_messages where id = reply) = thread, 'replies join the thread';
  begin
    insert into public.project_messages (project_id, thread_id, body) values (alpha, reply, 'Nested');
    raise exception 'replies are one level deep';
  exception when check_violation then null;
  end;
  update public.project_messages set body = 'Sounds good, @Vee Viewer' where id = reply;
  update public.project_messages set body = 'Sounds good, @Vee Viewer!' where id = reply;
  assert (select edited_at from public.project_messages where id = reply) is not null, 'edits are marked';
  update public.project_messages set body = 'Hijacked' where id = thread;
  get diagnostics n = row_count;
  assert n = 0, 'only the author edits a message';
  insert into tg_ids values ('reply', reply);
end $$;

reset role;

do $$
declare
  thread uuid := (select id from tg_ids where name = 'thread');
  reply uuid := (select id from tg_ids where name = 'reply');
begin
  assert (select count(*) from public.inbox_items where message_id = reply and kind = 'message'
          and recipient_id = 'd2d2d2d2-0000-4000-8000-000000000003') = 1, 'the thread''s author hears about the reply';
  assert (select count(*) from public.inbox_items where message_id = reply and kind = 'mention'
          and recipient_id = 'd2d2d2d2-0000-4000-8000-000000000002') = 1, 'an edit notifies a newly mentioned person once';
  assert not exists (select 1 from public.inbox_items where recipient_id = 'd2d2d2d2-0000-4000-8000-000000000004'),
    'the non-member is never notified';
  assert not exists (select 1 from public.inbox_items where message_id = reply
                     and recipient_id = 'd2d2d2d2-0000-4000-8000-000000000001'), 'the actor is never notified';
  assert (select last_activity_at from public.project_messages where id = thread)
    >= (select created_at from public.project_messages where id = reply), 'a reply bumps the thread';
end $$;

-- Non-member and workspace admin: no links, no messages ----------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'd2d2d2d2-0000-4000-8000-000000000004', false) is not null as ok \gset

do $$
declare
  alpha uuid := (select id from tg_ids where name = 'alpha');
  t1 uuid := (select id from tg_ids where name = 't1');
  s1 uuid := (select id from tg_ids where name = 's1');
begin
  assert exists (select 1 from public.tags where id = (select id from tg_ids where name = 'urgent')),
    'tag names are readable by everyone allowlisted';
  assert not exists (select 1 from public.task_tags where task_id in (t1, s1)), 'non-members read no links';
  assert not exists (select 1 from public.project_messages where project_id = alpha), 'or messages';
  assert not exists (select 1 from public.project_message_reactions where project_id = alpha), 'or reactions';
  assert not exists (select 1 from public.project_message_mentions), 'or mentions';
  assert (select count(*) from public.search_tasks('zz urg', 50)) = 0, 'tag search finds nothing unreadable';
  assert (select count(*) from public.report_task_rows(jsonb_build_object('tags', jsonb_build_array((select id from tg_ids where name = 'urgent'))), 'UTC')) = 0,
    'reports count nothing unreadable';
  begin
    insert into public.project_messages (project_id, title, body) values (alpha, 'Sneaky', 'Hi');
    raise exception 'non-members can''t post';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.task_tags (task_id, tag_id) values (t1, (select id from tg_ids where name = 'urgent'));
    raise exception 'non-members can''t tag';
  exception when no_data_found or insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', (select id::text from tg_ids where name = 'admin'), false) is not null as ok \gset

do $$
declare
  alpha uuid := (select id from tg_ids where name = 'alpha');
  t1 uuid := (select id from tg_ids where name = 't1');
  urgent uuid := (select id from tg_ids where name = 'urgent');
  n integer;
begin
  assert public.is_workspace_admin(), 'the earlier suite''s admin';
  assert not exists (select 1 from public.task_tags where task_id = t1), 'a workspace admin reads no links of private projects';
  assert not exists (select 1 from public.project_messages where project_id = alpha), 'or their messages';
  assert not exists (select 1 from public.inbox_items where message_id is not null), 'or inbox items about them';
  begin
    insert into public.task_tags (task_id, tag_id) values (t1, urgent);
    raise exception 'a workspace admin can''t tag a private task';
  exception when no_data_found or insufficient_privilege then null;
  end;
  begin
    insert into public.project_messages (project_id, title, body) values (alpha, 'Admin', 'Hi');
    raise exception 'a workspace admin can''t post in a private project';
  exception when insufficient_privilege then null;
  end;
  -- Tag metadata only:
  update public.tags set color = 'violet' where id = urgent;
  get diagnostics n = row_count;
  assert n = 1 and public.can_manage_tag(urgent), 'a workspace admin manages any tag''s metadata';
end $$;

-- Losing the project hides message inbox items; deleting a thread reads them ------------------------

select set_config('request.jwt.claim.sub', 'd2d2d2d2-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
declare
  thread uuid := (select id from tg_ids where name = 'thread');
begin
  assert exists (select 1 from public.inbox_items where kind = 'message' and read_at is null), 'an unread reply item';
  update public.project_messages set deleted_at = now() where id = thread;
  assert not exists (select 1 from public.inbox_items where message_id is not null and read_at is null),
    'deleting a thread reads its inbox items';
  begin
    update public.project_messages set deleted_at = null where id = thread;
    raise exception 'deleted messages stay deleted';
  exception when check_violation then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'd2d2d2d2-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  perform public.remove_project_member((select id from tg_ids where name = 'alpha'), 'd2d2d2d2-0000-4000-8000-000000000002');
end $$;
select set_config('request.jwt.claim.sub', 'd2d2d2d2-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
begin
  assert not exists (select 1 from public.inbox_items where message_id is not null),
    'a removed member no longer sees inbox items about the project''s messages';
  assert not exists (select 1 from public.task_tags where task_id = (select id from tg_ids where name = 't1')),
    'or its task tags';
end $$;

-- anon gets nothing ----------------------------------------------------------------------------------

set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset

do $$
begin
  begin
    perform 1 from public.tags;
    raise exception 'anon reads no tags';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.task_tags;
    raise exception 'anon reads no task tags';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.project_messages;
    raise exception 'anon reads no messages';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.can_manage_tag('00000000-0000-4000-8000-000000000001');
    raise exception 'anon executes nothing new';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- EXECUTE surface: no new client-callable SECURITY DEFINER function; nothing for anon -----------------

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.notify_message(uuid, uuid, text, jsonb)', 'public.message_mention_ids(uuid, uuid, text)',
    'public.on_project_message_insert()', 'public.on_project_message_update()'
  ] loop
    assert (select prosecdef from pg_proc where oid = fn::regprocedure), format('%s is definer', fn);
    assert not has_function_privilege('authenticated', fn, 'execute') and not has_function_privilege('anon', fn, 'execute'),
      format('%s is revoked from clients', fn);
  end loop;
  foreach fn in array array[
    'public.task_tag_ids(uuid)', 'public.apply_task_tags(uuid, jsonb)', 'public.copy_task_tags(uuid, uuid)',
    'public.ensure_tag(uuid, text, text, uuid)', 'public.import_task_tags(uuid, uuid, jsonb, uuid)',
    'public.migrate_imported_tag_fields()'
  ] loop
    assert not (select prosecdef from pg_proc where oid = fn::regprocedure), format('%s is invoker', fn);
    assert not has_function_privilege('authenticated', fn, 'execute') and not has_function_privilege('anon', fn, 'execute'),
      format('%s is internal', fn);
  end loop;
  assert not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.proname in ('guard_tag', 'can_manage_tag', 'guard_task_tag', 'guard_project_message',
        'guard_project_message_reaction')
  ), 'guards and can_manage_tag run as the caller';
  assert not has_function_privilege('anon', 'public.can_manage_tag(uuid)', 'execute'), 'anon gets no tag helper';
  assert not has_table_privilege('anon', 'public.tags', 'select')
    and not has_table_privilege('anon', 'public.task_tags', 'select')
    and not has_table_privilege('anon', 'public.project_messages', 'select')
    and not has_table_privilege('anon', 'public.project_message_reactions', 'select')
    and not has_table_privilege('anon', 'public.project_message_mentions', 'select')
    and not has_table_privilege('anon', 'public.tag_field_migrations', 'select'), 'no anon table grants';
  assert not has_table_privilege('authenticated', 'public.tag_field_migrations', 'select'), 'the migration log is internal';
  assert not has_table_privilege('authenticated', 'public.task_tags', 'delete')
    and not has_table_privilege('authenticated', 'public.tags', 'delete')
    and not has_table_privilege('authenticated', 'public.project_messages', 'delete'), 'no hard deletes';
  assert not has_table_privilege('authenticated', 'public.project_message_mentions', 'insert'), 'mentions are trigger-written';
end $$;

select 'tags and collaboration smoke: all assertions passed' as result;
