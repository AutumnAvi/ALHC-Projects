-- Behavioural checks for Phase: Daily essentials: private My Tasks tasks (only the creator and the
-- assignee read, find, or hear about one — workspace admins included; subtasks through their root;
-- joining a project makes it an ordinary task), Duplicate task (respects roles, lands only where the
-- caller edits, options), archived projects (Admin+ by the member's own role; read-only for everyone,
-- hidden from non-members, rules and forms off; unarchive), task likes (Viewer reads, Commenter likes
-- own rows), the multi-task auto-shift with "pull earlier", and anon getting nothing.
-- Fresh people for this suite (no memberships from earlier suites):
--   f4f4…01 de-owner@example.com      owner of DE P, DE Q, DE R
--   f4f4…02 de-editor@example.com     Editor of P, Viewer of Q, Admin of R
--   f4f4…03 de-viewer@example.com     Viewer of P, Editor of R
--   f4f4…04 de-commenter@example.com  Commenter of P
--   f4f4…05 de-other@example.com      no memberships
--   f4f4…06 de-outsider@example.com   no memberships

\set ON_ERROR_STOP 1

create temporary table de_ids (name text primary key, id uuid) on commit preserve rows;
grant all on de_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('de-owner@example.com', 'daily essentials suite'),
  ('de-editor@example.com', 'daily essentials suite'),
  ('de-viewer@example.com', 'daily essentials suite'),
  ('de-commenter@example.com', 'daily essentials suite'),
  ('de-other@example.com', 'daily essentials suite'),
  ('de-outsider@example.com', 'daily essentials suite');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('f4f4f4f4-0000-4000-8000-000000000001', 'de-owner@example.com', now(), '{"full_name":"Olive Owner"}'),
  ('f4f4f4f4-0000-4000-8000-000000000002', 'de-editor@example.com', now(), '{"full_name":"Edna Editor"}'),
  ('f4f4f4f4-0000-4000-8000-000000000003', 'de-viewer@example.com', now(), '{"full_name":"Vic Viewer"}'),
  ('f4f4f4f4-0000-4000-8000-000000000004', 'de-commenter@example.com', now(), '{"full_name":"Cora Commenter"}'),
  ('f4f4f4f4-0000-4000-8000-000000000005', 'de-other@example.com', now(), '{"full_name":"Pat Other"}'),
  ('f4f4f4f4-0000-4000-8000-000000000006', 'de-outsider@example.com', now(), '{"full_name":"Oz Outsider"}');

insert into de_ids values
  ('owner', 'f4f4f4f4-0000-4000-8000-000000000001'),
  ('editor', 'f4f4f4f4-0000-4000-8000-000000000002'),
  ('viewer', 'f4f4f4f4-0000-4000-8000-000000000003'),
  ('commenter', 'f4f4f4f4-0000-4000-8000-000000000004'),
  ('other', 'f4f4f4f4-0000-4000-8000-000000000005'),
  ('outsider', 'f4f4f4f4-0000-4000-8000-000000000006'),
  ('admin', (select profile_id from public.workspace_admins where deleted_at is null order by created_at limit 1));

do $$
begin
  assert (select id from de_ids where name = 'admin') is not null, 'an earlier suite left a workspace admin';
end $$;

-- Owner: projects, members, tasks ------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'f4f4f4f4-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid;
  q uuid;
  r uuid;
  doing uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'DE P') returning id into p;
  insert into public.projects (workspace_id, name) values (ws, 'DE Q') returning id into q;
  insert into public.projects (workspace_id, name) values (ws, 'DE R') returning id into r;
  insert into public.sections (project_id, name, sort_order) values (p, 'Doing', 1024) returning id into doing;
  perform public.add_project_member(p, 'de-editor@example.com', 'editor');
  perform public.add_project_member(p, 'de-viewer@example.com', 'viewer');
  perform public.add_project_member(p, 'de-commenter@example.com', 'commenter');
  perform public.add_project_member(q, 'de-editor@example.com', 'viewer');
  perform public.add_project_member(r, 'de-editor@example.com', 'admin');
  perform public.add_project_member(r, 'de-viewer@example.com', 'editor');
  insert into de_ids values ('p', p), ('q', q), ('r', r), ('doing', doing);
end $$;

-- Private tasks: created by the owner ---------------------------------------------------------------

do $$
declare
  me uuid := (select id from de_ids where name = 'owner');
  t uuid;
  s uuid;
  spoof uuid;
  maker uuid;
begin
  t := public.create_private_task('  Buy the printer paper  ');
  assert (select home_project_id is null and parent_task_id is null and assignee_id = me and created_by = me
            and title = 'Buy the printer paper' and workspace_id = '00000000-0000-4000-8000-000000000001'
          from public.tasks where id = t), 'a private task: no project, assigned to and created by the caller';
  assert not exists (select 1 from public.task_projects where task_id = t), 'a private task has no memberships';
  assert public.task_role(t) = 'editor', 'the creator edits it';
  assert exists (select 1 from public.task_stories where task_id = t and kind = 'created'), 'normal creation story';

  -- Nobody creates a private task for someone else.
  insert into public.tasks (title, created_by) values ('Spoofed', (select id from de_ids where name = 'other'))
  returning id, created_by into spoof, maker;
  assert maker = me, 'the creator of a private task is always the caller';

  s := public.create_subtask(t, 'Compare prices', null);
  assert (select home_project_id is null and root_task_id = t from public.tasks where id = s), 'subtasks stay private';

  -- @mentions only reach people who can read it: nobody else here.
  insert into public.comments (task_id, body) values (t, 'ask @Edna Editor and @Pat Other');
  assert not exists (select 1 from public.comment_mentions cm join public.comments c on c.id = cm.comment_id where c.task_id = t),
    'mentions on a private task match nobody who can''t read it';

  -- Followers must be able to read it.
  begin
    insert into public.task_followers (task_id, profile_id) values (t, (select id from de_ids where name = 'editor'));
    raise exception 'a non-reader can''t follow a private task';
  exception when insufficient_privilege then null;
  end;

  -- The subtask goes to someone who can't read the root: they still can't read it or hear about it.
  update public.tasks set assignee_id = (select id from de_ids where name = 'editor') where id = s;

  insert into de_ids values ('private', t), ('private_sub', s), ('spoof', spoof);
end $$;

-- Everyone else: nothing (workspace admin included) ------------------------------------------------

do $$
declare
  t uuid := (select id from de_ids where name = 'private');
  s uuid := (select id from de_ids where name = 'private_sub');
  who text;
begin
  foreach who in array array['editor', 'viewer', 'other', 'admin'] loop
    perform set_config('request.jwt.claim.sub', (select id::text from de_ids where name = who), true);
    assert not exists (select 1 from public.tasks where id in (t, s)), format('%s can''t read the private task', who);
    assert not exists (select 1 from public.search_tasks('printer paper')), format('%s can''t find it', who);
    assert not exists (select 1 from public.search_tasks('Compare prices')), format('%s can''t find its subtask', who);
    assert not exists (select 1 from public.inbox_items where task_id in (t, s)), format('%s heard nothing', who);
    assert not exists (select 1 from public.task_stories where task_id in (t, s)), format('%s reads no stories', who);
    assert not exists (select 1 from public.comments where task_id = t), format('%s reads no comments', who);
    assert public.task_role(t) is null and not public.has_task_role(s, 'viewer'), format('%s has no role', who);
    assert not public.is_workspace_admin() or who = 'admin', 'only the admin is a workspace admin here';
  end loop;
  -- Writes as a non-reader change nothing.
  perform set_config('request.jwt.claim.sub', (select id::text from de_ids where name = 'admin'), true);
  update public.tasks set title = 'Hijacked' where id = t;
  begin
    perform public.duplicate_task(t, '{}');
    raise exception 'a non-reader can''t duplicate a private task';
  exception when no_data_found then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'f4f4f4f4-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  t uuid := (select id from de_ids where name = 'private');
  ptask uuid;
  other_private uuid;
  mine_a uuid;
  mine_b uuid;
begin
  assert (select title from public.tasks where id = t) = 'Buy the printer paper', 'the non-reader''s update affected nothing';
  assert exists (select 1 from public.search_tasks('printer paper') x where x.id = t and x.home_project_id is null and x.home_project_name is null),
    'the creator finds it, without a project';
  -- Share it by assigning it.
  update public.tasks set assignee_id = (select id from de_ids where name = 'other') where id = t;

  -- A link between two private tasks with different readers: neither story names the other task.
  other_private := public.create_private_task('Outsider errand');
  update public.tasks set assignee_id = (select id from de_ids where name = 'outsider') where id = other_private;
  perform public.set_task_dependency(t, other_private, 'finish_to_start', 0);
  assert not exists (select 1 from public.task_stories where task_id in (t, other_private)
                     and kind = 'dependency_added' and data ? 'task_title'),
    'stories never carry the title of a private task some reader can''t open';
  -- Same readers (both only the owner's): the title is kept.
  mine_a := public.create_private_task('Mine A');
  mine_b := public.create_private_task('Mine B');
  perform public.set_task_dependency(mine_a, mine_b, 'finish_to_start', 0);
  assert (select data ->> 'task_title' from public.task_stories where task_id = mine_b and kind = 'dependency_added') = 'Mine A',
    'titles stay when every reader can open the other task';

  -- A project task never becomes private.
  ptask := public.create_task((select id from de_ids where name = 'p'), null, 'Project work');
  begin
    update public.tasks set home_project_id = null where id = ptask;
    raise exception 'a project task can''t be made private';
  exception when check_violation then null;
  end;
  insert into de_ids values ('ptask', ptask);
end $$;

-- The assignee reads it, hears about it, and can find it.
select set_config('request.jwt.claim.sub', 'f4f4f4f4-0000-4000-8000-000000000005', false) is not null as ok \gset

do $$
declare
  t uuid := (select id from de_ids where name = 'private');
  s uuid := (select id from de_ids where name = 'private_sub');
begin
  assert (select count(*) from public.tasks where id in (t, s)) = 2, 'the assignee reads the task and its subtasks';
  assert exists (select 1 from public.inbox_items where task_id = t and kind = 'assigned'), 'the assignee is notified';
  assert exists (select 1 from public.search_tasks('printer paper') x where x.id = t), 'the assignee finds it';
  assert public.task_role(t) = 'editor', 'the assignee edits it';
  begin
    update public.tasks set created_by = auth.uid() where id = t;
    raise exception 'the creator of a private task is fixed';
  exception when insufficient_privilege then null;
  end;
end $$;

-- The editor: their own private task, then into projects.
select set_config('request.jwt.claim.sub', 'f4f4f4f4-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  t uuid := public.create_private_task('Plan the launch');
begin
  assert not exists (select 1 from public.inbox_items where task_id = (select id from de_ids where name = 'private_sub')),
    'assigning a private subtask to someone who can''t read it notifies nobody';
  insert into de_ids values ('adopted', t), ('adopted_sub', public.create_subtask(t, 'Draft the plan', null));
end $$;

do $$
declare
  t uuid := (select id from de_ids where name = 'adopted');
  s uuid := (select id from de_ids where name = 'adopted_sub');
begin
  begin
    insert into public.task_projects (task_id, project_id) values (t, (select id from de_ids where name = 'q'));
    raise exception 'a Viewer of Q can''t move a task into Q';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.tasks set home_project_id = (select id from de_ids where name = 'q') where id = t;
    raise exception 'nor by setting the home project';
  exception when insufficient_privilege then null;
  end;
  insert into public.task_projects (task_id, project_id, section_id)
  values (t, (select id from de_ids where name = 'p'), (select id from de_ids where name = 'doing'));
  assert (select home_project_id from public.tasks where id = t) = (select id from de_ids where name = 'p'),
    'joining a project makes it that project''s task';
  assert (select home_project_id from public.tasks where id = s) = (select id from de_ids where name = 'p'),
    'its subtasks follow';
  assert exists (select 1 from public.task_stories where task_id = t and kind = 'project_added'), 'logged';
end $$;

select set_config('request.jwt.claim.sub', 'f4f4f4f4-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
begin
  assert (select count(*) from public.tasks where id in (
    (select id from de_ids where name = 'adopted'), (select id from de_ids where name = 'adopted_sub'))) = 2,
    'the project''s members read it now';
end $$;

-- Duplicate task -------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'f4f4f4f4-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from de_ids where name = 'p');
  q uuid := (select id from de_ids where name = 'q');
  doing uuid := (select id from de_ids where name = 'doing');
  d uuid;
  after_d uuid;
  pred uuid;
  sub uuid;
  tag uuid;
  budget uuid;
begin
  pred := public.create_task(p, doing, 'Get quotes');
  d := public.create_task(p, doing, 'Print flyers');
  after_d := public.create_task(p, doing, 'Hang flyers');
  insert into public.task_projects (task_id, project_id) values (d, q);
  update public.tasks set notes = 'A5, two-sided', start_on = date '2026-11-02', due_on = date '2026-11-04',
    assignee_id = (select id from de_ids where name = 'editor')
  where id = d;
  sub := public.create_subtask(d, 'Proof', null);
  perform public.create_subtask(sub, 'Proof again', null);
  insert into public.tags (name) values ('DE Print') returning id into tag;
  insert into public.task_tags (task_id, tag_id) values (d, tag);
  insert into public.custom_fields (project_id, name, field_type) values (p, 'DE Budget', 'number') returning id into budget;
  insert into public.task_field_values (task_id, field_id, value) values (d, budget, '120');
  insert into public.task_followers (task_id, profile_id) values (d, (select id from de_ids where name = 'viewer'));
  insert into public.task_attachments (task_id, storage_path, file_name, content_type, size_bytes)
  values (d, d::text || '/abc-proof.pdf', 'proof.pdf', 'application/pdf', 1000);
  perform public.set_task_dependency(pred, d, 'finish_to_start', 1);
  insert into de_ids values ('d', d), ('after_d', after_d), ('pred', pred), ('d_sub', sub), ('tag', tag), ('budget', budget);
end $$;

-- Below Editor: refused. Not a reader: not found.
do $$
declare
  d uuid := (select id from de_ids where name = 'd');
  who text;
begin
  foreach who in array array['viewer', 'commenter'] loop
    perform set_config('request.jwt.claim.sub', (select id::text from de_ids where name = who), true);
    begin
      perform public.duplicate_task(d, '{}');
      raise exception '% must not duplicate', who;
    exception when insufficient_privilege then null;
    end;
  end loop;
  foreach who in array array['outsider', 'admin'] loop
    perform set_config('request.jwt.claim.sub', (select id::text from de_ids where name = who), true);
    begin
      perform public.duplicate_task(d, '{}');
      raise exception '% can''t see the task', who;
    exception when no_data_found then null;
    end;
  end loop;
end $$;

-- The editor (Editor of P, Viewer of Q): the copy lands in P only.
select set_config('request.jwt.claim.sub', 'f4f4f4f4-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from de_ids where name = 'p');
  q uuid := (select id from de_ids where name = 'q');
  d uuid := (select id from de_ids where name = 'd');
  result jsonb;
  c uuid;
  csub uuid;
  plain jsonb;
begin
  begin
    perform public.duplicate_task(d, '{"bogus": true}');
    raise exception 'unknown options are rejected';
  exception when check_violation then null;
  end;

  result := public.duplicate_task(d, '{}');
  c := (result ->> 'task_id')::uuid;
  assert (result ->> 'subtasks')::integer = 2, 'the whole subtask tree is copied';
  assert (select title = 'Copy of Print flyers' and notes = 'A5, two-sided' and completed_at is null
            and start_on = date '2026-11-02' and due_on = date '2026-11-04' and home_project_id = p
            and created_by = auth.uid() and assignee_id = (select id from de_ids where name = 'editor')
          from public.tasks where id = c), 'title, notes, dates, assignee; open; created by the caller';
  assert (select array_agg(project_id) from public.task_projects where task_id = c and deleted_at is null) = array[p],
    'only in the projects the caller edits';
  assert (select section_id = (select id from de_ids where name = 'doing') from public.task_projects where task_id = c and project_id = p),
    'same section';
  assert (select tp.sort_order from public.task_projects tp where tp.task_id = c and tp.project_id = p)
           > (select tp.sort_order from public.task_projects tp where tp.task_id = d and tp.project_id = p)
     and (select tp.sort_order from public.task_projects tp where tp.task_id = c and tp.project_id = p)
           < (select tp.sort_order from public.task_projects tp where tp.task_id = (select id from de_ids where name = 'after_d') and tp.project_id = p),
    'right after the original';
  assert exists (select 1 from public.task_tags where task_id = c and tag_id = (select id from de_ids where name = 'tag') and deleted_at is null), 'tags';
  assert (select value from public.task_field_values where task_id = c and field_id = (select id from de_ids where name = 'budget')) = '120'::jsonb, 'fields';
  assert exists (select 1 from public.task_followers where task_id = c and profile_id = (select id from de_ids where name = 'viewer') and deleted_at is null), 'followers';
  assert exists (select 1 from public.task_attachment_links l join public.task_attachments a on a.id = l.attachment_id
                 where l.task_id = c and l.source = 'duplicate' and a.task_id = d and l.name = 'proof.pdf'), 'attachments as links';
  assert exists (select 1 from public.task_dependencies where predecessor_id = (select id from de_ids where name = 'pred')
                 and successor_id = c and lag_days = 1 and deleted_at is null), 'dependencies';
  select id into csub from public.tasks where parent_task_id = c;
  assert (select title from public.tasks where id = csub) = 'Proof', 'subtasks keep their titles';
  assert exists (select 1 from public.tasks where parent_task_id = csub and title = 'Proof again'), 'nested';

  plain := public.duplicate_task(d, '{"subtasks": false, "dates": false, "assignee": false, "tags": false, "title": "Fresh flyers"}');
  c := (plain ->> 'task_id')::uuid;
  assert (select title = 'Fresh flyers' and due_on is null and start_on is null and assignee_id is null from public.tasks where id = c),
    'options are honoured';
  assert not exists (select 1 from public.tasks where parent_task_id = c), 'no subtasks';
  assert not exists (select 1 from public.task_tags where task_id = c), 'no tags';

  -- A subtask's copy is a sibling, right after it.
  result := public.duplicate_task((select id from de_ids where name = 'd_sub'), '{"subtasks": false}');
  c := (result ->> 'task_id')::uuid;
  assert (select parent_task_id = d and title = 'Copy of Proof' from public.tasks where id = c), 'sibling copy';
  insert into de_ids values ('d_copy', (result ->> 'task_id')::uuid);
end $$;

-- A private task's copy is the caller's private task.
select set_config('request.jwt.claim.sub', 'f4f4f4f4-0000-4000-8000-000000000005', false) is not null as ok \gset

do $$
declare
  result jsonb := public.duplicate_task((select id from de_ids where name = 'private'), '{}');
  c uuid := (result ->> 'task_id')::uuid;
begin
  assert (select home_project_id is null and created_by = auth.uid() from public.tasks where id = c), 'private copy, created by the caller';
  assert (result ->> 'subtasks')::integer = 1, 'with its subtask';
  insert into de_ids values ('private_copy', c);
end $$;

select set_config('request.jwt.claim.sub', 'f4f4f4f4-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
begin
  assert not exists (select 1 from public.tasks where id = (select id from de_ids where name = 'private_copy')),
    'other people still can''t read the private copy';
end $$;

-- Archive projects ------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'f4f4f4f4-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  r uuid := (select id from de_ids where name = 'r');
  q uuid := (select id from de_ids where name = 'q');
  rt uuid;
  rule uuid;
  form uuid;
begin
  rt := public.create_task(r, null, 'Archive me');
  insert into public.task_projects (task_id, project_id) values (rt, q);
  insert into public.rules (project_id, name, trigger_type, actions)
  values (r, 'Say hi', 'assignee_changed', '[{"type": "add_comment", "body": "rule says hi"}]') returning id into rule;
  update public.rules set enabled = true where id = rule;
  insert into public.forms (project_id, title, questions, accepting_responses) values (r, 'DE intake', '[]', true) returning id into form;
  update public.tasks set assignee_id = auth.uid() where id = rt;
  assert (select count(*) from public.comments where task_id = rt and rule_id = rule) = 1, 'the rule fires while active';
  insert into de_ids values ('rt', rt), ('rule', rule), ('form', form);
end $$;

-- An Editor can't archive; nobody writes the columns directly.
select set_config('request.jwt.claim.sub', 'f4f4f4f4-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
begin
  begin
    perform public.set_project_archived((select id from de_ids where name = 'r'), true);
    raise exception 'editors can''t archive';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'f4f4f4f4-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  r uuid := (select id from de_ids where name = 'r');
  stamp timestamptz;
begin
  begin
    update public.projects set archived_at = now() where id = r;
    raise exception 'the archive columns are RPC-only';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.set_project_archived((select id from de_ids where name = 'p'), true);
    raise exception 'an Editor of P can''t archive P';
  exception when insufficient_privilege then null;
  end;
  stamp := public.set_project_archived(r, true);
  assert stamp is not null, 'an Admin archives';
  assert (select archived_by from public.projects where id = r) = auth.uid(), 'who archived it';
  assert exists (select 1 from public.project_stories where project_id = r and kind = 'archived'), 'logged';
  assert public.project_role(r) = 'viewer', 'an archived project is read-only, whatever the role';
  assert public.set_project_archived(r, true) = stamp, 'archiving again is a no-op';
  update public.projects set name = 'Renamed' where id = r;
  assert (select name from public.projects where id = r) = 'DE R', 'even admins can''t rename it';
end $$;

-- Read-only for its Editor; still readable.
select set_config('request.jwt.claim.sub', 'f4f4f4f4-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
declare
  r uuid := (select id from de_ids where name = 'r');
  rt uuid := (select id from de_ids where name = 'rt');
begin
  assert exists (select 1 from public.projects where id = r) and exists (select 1 from public.tasks where id = rt),
    'members still read an archived project';
  begin
    perform public.create_task(r, null, 'New work');
    raise exception 'no new tasks in an archived project';
  exception when insufficient_privilege then null;
  end;
  update public.tasks set title = 'Edited' where id = rt;
  assert (select title from public.tasks where id = rt) = 'Archive me', 'tasks only in archived projects can''t be edited';
  begin
    insert into public.sections (project_id, name) values (r, 'Nope');
    raise exception 'no new sections';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.comments (task_id, body) values (rt, 'hello');
    raise exception 'no comments';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.set_project_archived(r, false);
    raise exception 'editors can''t unarchive';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Non-members (workspace admin included) don't see it.
do $$
declare
  who text;
begin
  foreach who in array array['outsider', 'admin', 'commenter'] loop
    perform set_config('request.jwt.claim.sub', (select id::text from de_ids where name = who), true);
    assert not exists (select 1 from public.projects where id = (select id from de_ids where name = 'r')),
      format('%s can''t see the archived project', who);
    begin
      perform public.set_project_archived((select id from de_ids where name = 'r'), false);
      raise exception '% can''t unarchive', who;
    exception when no_data_found then null;
    end;
  end loop;
end $$;

-- Through an active project the multi-homed task stays editable, but the archived project's rules
-- don't fire and its form takes no responses.
select set_config('request.jwt.claim.sub', 'f4f4f4f4-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  rt uuid := (select id from de_ids where name = 'rt');
  rule uuid := (select id from de_ids where name = 'rule');
  form uuid := (select id from de_ids where name = 'form');
begin
  update public.tasks set assignee_id = (select id from de_ids where name = 'editor') where id = rt;
  assert (select assignee_id from public.tasks where id = rt) = (select id from de_ids where name = 'editor'),
    'editable through its active project';
  assert (select count(*) from public.comments where task_id = rt and rule_id = rule) = 1, 'archived rules don''t fire';
  assert not (public.get_public_form(form) ->> 'accepting_responses')::boolean, 'the form shows as closed';
  begin
    perform public.submit_form(form, 'someone@example.org', '{}');
    raise exception 'archived forms take no responses';
  exception when check_violation then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'f4f4f4f4-0000-4000-8000-000000000002', false) is not null as ok \gset

do $$
declare
  r uuid := (select id from de_ids where name = 'r');
begin
  assert public.set_project_archived(r, false) is null, 'an Admin unarchives';
  assert public.project_role(r) = 'admin', 'roles are back';
  assert exists (select 1 from public.project_stories where project_id = r and kind = 'unarchived'), 'logged';
end $$;

select set_config('request.jwt.claim.sub', 'f4f4f4f4-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
begin
  perform public.create_task((select id from de_ids where name = 'r'), null, 'Back to work');
end $$;

-- Likes -----------------------------------------------------------------------------------------------

do $$
declare
  d uuid := (select id from de_ids where name = 'd');
begin
  -- The viewer of P (still this session's person) reads likes but can't like.
  perform set_config('request.jwt.claim.sub', (select id::text from de_ids where name = 'viewer'), true);
  begin
    insert into public.task_likes (task_id) values (d);
    raise exception 'viewers can''t like';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'f4f4f4f4-0000-4000-8000-000000000004', false) is not null as ok \gset

do $$
declare
  d uuid := (select id from de_ids where name = 'd');
  l uuid;
begin
  insert into public.task_likes (task_id) values (d) returning id into l;
  assert (select profile_id from public.task_likes where id = l) = auth.uid(), 'a like is the caller''s own';
  begin
    insert into public.task_likes (task_id) values (d);
    raise exception 'one active like per person';
  exception when unique_violation then null;
  end;
  begin
    insert into public.task_likes (task_id, profile_id) values (d, (select id from de_ids where name = 'viewer'));
    raise exception 'nobody likes on someone else''s behalf';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.task_likes set task_id = (select id from de_ids where name = 'pred') where id = l;
    raise exception 'likes don''t move';
  exception when insufficient_privilege then null;
  end;
  update public.task_likes set deleted_at = now() where id = l;
  begin
    update public.task_likes set deleted_at = null where id = l;
    raise exception 'an unlike is final for that row';
  exception when check_violation then null;
  end;
  insert into public.task_likes (task_id) values (d);
  insert into de_ids values ('like', l);
end $$;

do $$
declare
  d uuid := (select id from de_ids where name = 'd');
  who text;
begin
  perform set_config('request.jwt.claim.sub', (select id::text from de_ids where name = 'viewer'), true);
  assert (select count(*) from public.task_likes where task_id = d and deleted_at is null) = 1, 'viewers read likes';
  update public.task_likes set deleted_at = now() where task_id = d;
  perform set_config('request.jwt.claim.sub', (select id::text from de_ids where name = 'commenter'), true);
  assert (select count(*) from public.task_likes where task_id = d and deleted_at is null) = 1, 'nobody unlikes for others';
  foreach who in array array['outsider', 'admin'] loop
    perform set_config('request.jwt.claim.sub', (select id::text from de_ids where name = who), true);
    assert not exists (select 1 from public.task_likes where task_id = d), format('%s reads no likes', who);
  end loop;
end $$;

-- Auto-shift: several tasks at once, and pull earlier --------------------------------------------------

select set_config('request.jwt.claim.sub', 'f4f4f4f4-0000-4000-8000-000000000001', false) is not null as ok \gset

do $$
declare
  p uuid := (select id from de_ids where name = 'p');
  x1 uuid := public.create_task(p, null, 'Shift X1');
  x2 uuid := public.create_task(p, null, 'Shift X2');
  y uuid := public.create_task(p, null, 'Shift Y');
  z uuid := public.create_task(p, null, 'Shift Z');
  w uuid := public.create_task(p, null, 'Shift W');
  result jsonb;
  undone jsonb;
begin
  update public.tasks set due_on = date '2026-12-01' where id = x1;
  update public.tasks set due_on = date '2026-12-03' where id = x2;
  update public.tasks set start_on = date '2026-12-05', due_on = date '2026-12-06' where id = y;
  update public.tasks set start_on = date '2026-12-05', due_on = date '2026-12-05' where id = z;
  update public.tasks set due_on = date '2026-11-28' where id = w;
  perform public.set_task_dependency(x1, y, 'finish_to_start', 0);
  perform public.set_task_dependency(w, y, 'finish_to_start', 0);
  perform public.set_task_dependency(x2, z, 'finish_to_start', 1);

  -- Two tasks later at once (a bulk due date): both dependents are pushed.
  assert (select count(*) from public.preview_dependency_shifts(jsonb_build_array(
            jsonb_build_object('task_id', x1, 'due_on', '2026-12-08'),
            jsonb_build_object('task_id', x2, 'due_on', '2026-12-09'))) s
          where (s.task_id = y and s.shift_days = 3) or (s.task_id = z and s.shift_days = 5)) = 2,
    'every moved task pushes its dependents';

  -- Earlier: nothing moves unless pulling is asked for; then by the move, bounded by other links.
  assert not exists (select 1 from public.preview_dependency_shifts(jsonb_build_array(
    jsonb_build_object('task_id', x1, 'due_on', '2026-11-26')))), 'moving earlier never pulls by default';
  assert (select shift_days from public.preview_dependency_shifts(jsonb_build_array(
            jsonb_build_object('task_id', x2, 'due_on', '2026-11-30')), true) where task_id = z) = -3,
    'pull earlier keeps the gap';
  assert (select shift_days from public.preview_dependency_shifts(jsonb_build_array(
            jsonb_build_object('task_id', x1, 'due_on', '2026-11-26')), true) where task_id = y) = -5,
    'pull earlier by the move (Y to Nov 30; W, due Nov 28, allows it)';

  result := public.apply_dependency_shifts(jsonb_build_array(
    jsonb_build_object('task_id', x2, 'due_on', '2026-11-30')), array[z], true);
  assert jsonb_array_length(result -> 'changes') = 2, 'the task and its confirmed dependent';
  assert (select start_on = date '2026-12-02' and due_on = date '2026-12-02' from public.tasks where id = z), 'pulled';
  undone := public.undo_dependency_shift(result -> 'changes');
  assert jsonb_array_length(undone -> 'restored') = 2, 'Undo restores both';
  assert (select due_on from public.tasks where id = x2) = date '2026-12-03', 'back';

  insert into de_ids values ('x1', x1), ('y', y), ('w', w);
end $$;

-- The bound from an unmoved predecessor (pin it precisely).
do $$
declare
  x1 uuid := (select id from de_ids where name = 'x1');
  y uuid := (select id from de_ids where name = 'y');
  w uuid := (select id from de_ids where name = 'w');
begin
  update public.tasks set due_on = date '2026-12-03' where id = w;
  assert (select shift_days from public.preview_dependency_shifts(jsonb_build_array(
            jsonb_build_object('task_id', x1, 'due_on', '2026-11-26')), true) where task_id = y) = -2,
    'W (due Dec 3) keeps Y from starting before Dec 3';
end $$;

-- Someone who can't edit a task in the moves gets it skipped, with nothing moved for it.
select set_config('request.jwt.claim.sub', 'f4f4f4f4-0000-4000-8000-000000000003', false) is not null as ok \gset

do $$
declare
  result jsonb := public.apply_dependency_shifts(jsonb_build_array(
    jsonb_build_object('task_id', (select id from de_ids where name = 'x1'), 'due_on', '2026-12-20')), '{}', false);
begin
  assert jsonb_array_length(result -> 'changes') = 0, 'nothing changed';
  assert result -> 'skipped' -> 0 ->> 'reason' = 'You can’t edit this task', 'and why';
end $$;

-- Anon gets nothing -----------------------------------------------------------------------------------

reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.create_private_task(text)', 'public.duplicate_task(uuid, jsonb)', 'public.duplicate_subtask_tree(uuid, uuid, jsonb)',
    'public.duplicate_option(jsonb, text)', 'public.set_project_archived(uuid, boolean)',
    'public.preview_dependency_shifts(jsonb, boolean)', 'public.apply_dependency_shifts(jsonb, uuid[], boolean)',
    'public.guard_private_task()', 'public.adopt_private_task()', 'public.guard_project_archive()', 'public.guard_task_like()'
  ] loop
    assert not has_function_privilege('anon', fn, 'execute'), format('anon can''t execute %s', fn);
  end loop;
  assert not has_table_privilege('anon', 'public.task_likes', 'select')
     and not has_table_privilege('anon', 'public.task_likes', 'insert'), 'anon has no task_likes grants';
end $$;

reset role;

select 'daily essentials smoke: all assertions passed' as result;
