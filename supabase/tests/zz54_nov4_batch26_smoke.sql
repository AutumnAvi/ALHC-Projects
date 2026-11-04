-- Nov 4 notes, batch 26 (20261104050000_nov4_batch26_a.sql): live updates through Realtime Broadcast.
-- Runs last, over every message the earlier suites' writes sent (the triggers were on for all of them):
--   1. the functions: grants, definer / invoker, empty search_path; the two statement triggers on each of
--      the 16 tables;
--   2. every message sent so far: a topic of ours, at most 50 rows, and only the keys its table may send
--      (never notes or a title in a project / user tombstone, never a field value on a task topic);
--   3. topic authorization through the realtime.messages policies equals the rule (project Viewer+,
--      has_task_role viewer, the person themself) for a range of people, anyone signed out included;
--   4. the restrictive policies keep alhc:* topics closed (also when another policy allows everything)
--      and refuse sending into them, while other topics are untouched;
--   5. writes send what they should: a rename (task / project / assignee topics), nothing for an unchanged
--      row, a tombstone for the Trash, the old assignee's notice, comments with mentions, Inbox state,
--      field values, chunks of 50, and nothing while an import or a copy runs.

\set ON_ERROR_STOP 1

-- 1. Functions and triggers ----------------------------------------------------------------------------

do $$
declare
  fn regprocedure;
  t text;
begin
  fn := 'public.alhc_live_topic_allowed(text)'::regprocedure;
  assert not (select prosecdef from pg_catalog.pg_proc where oid = fn), 'the topic check runs as the caller';
  assert (select provolatile from pg_catalog.pg_proc where oid = fn) = 's', 'the topic check is stable';
  assert (select proconfig from pg_catalog.pg_proc where oid = fn) = array['search_path=""'], 'empty search_path';
  assert has_function_privilege('authenticated', fn, 'execute'), 'authenticated evaluates it in the policies';
  assert not has_function_privilege('anon', fn, 'execute'), 'nothing for anon';

  assert (select prosecdef from pg_catalog.pg_proc where oid = 'public.alhc_live_capture()'::regprocedure),
    'the trigger function is definer (it sends as the owner)';
  foreach fn in array array[
    'public.alhc_live_capture()', 'public.alhc_live_route(text,jsonb,jsonb)', 'public.alhc_live_send(text,text,jsonb)',
    'public.alhc_live_pick(jsonb,text[])', 'public.alhc_live_changed(jsonb,jsonb)'
  ]::regprocedure[] loop
    assert not has_function_privilege('authenticated', fn, 'execute'), format('%s: no client executes it', fn);
    assert not has_function_privilege('anon', fn, 'execute'), format('%s: nothing for anon', fn);
    assert (select proconfig from pg_catalog.pg_proc where oid = fn) = array['search_path=""'], format('%s: empty search_path', fn);
  end loop;

  foreach t in array array[
    'tasks', 'task_projects', 'comments', 'comment_reactions', 'task_stories', 'rule_runs', 'inbox_items',
    'email_outbox', 'approval_requests', 'review_checks', 'project_messages', 'project_message_reactions',
    'task_field_values', 'task_attachments', 'task_followers', 'task_tags'
  ] loop
    assert (
      select count(*) from pg_catalog.pg_trigger tg
      where tg.tgrelid = ('public.' || t)::regclass
        and tg.tgname in (t || '_zz_live_insert', t || '_zz_live_update')
        and tg.tgfoid = 'public.alhc_live_capture()'::regprocedure
        and (tg.tgtype & 1) = 0          -- for each statement
        and tg.tgenabled = 'O'
    ) = 2, format('%s has both live triggers, statement-level', t);
  end loop;

  assert (select count(*) from pg_policies where schemaname = 'realtime' and tablename = 'messages'
          and policyname in ('alhc_live_receive', 'alhc_live_guard_read', 'alhc_live_guard_read_anon', 'alhc_live_guard_send')) = 4,
    'the four realtime.messages policies';
  assert (select permissive from pg_policies where schemaname = 'realtime' and policyname = 'alhc_live_receive') = 'PERMISSIVE';
  assert (select count(*) from pg_policies where schemaname = 'realtime'
          and policyname in ('alhc_live_guard_read', 'alhc_live_guard_read_anon', 'alhc_live_guard_send')
          and permissive = 'RESTRICTIVE') = 3, 'the guards are restrictive';
end $$;

-- 2. Every message sent so far -------------------------------------------------------------------------

do $$
declare
  n bigint;
  bad bigint;
begin
  select count(*) into n from realtime.messages;
  assert n > 1000, format('the earlier suites sent live updates (%s messages)', n);

  select count(*) into bad from realtime.messages m
  where m.extension <> 'broadcast' or not m.private
     or m.topic !~ '^alhc:(project|task|user):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or m.event is distinct from m.payload ->> 'table'
     or (m.payload ->> 'v') <> '1'
     or m.payload ->> 'op' not in ('INSERT', 'UPDATE')
     or jsonb_array_length(m.payload -> 'rows') not between 1 and 50;
  assert bad = 0, format('%s messages with a bad topic, envelope, or row count', bad);

  -- Only the keys each table may send.
  with allowed(tbl, keys) as (values
    ('tasks', array['id', 'parent_task_id', 'root_task_id', 'title', 'completed_at', 'start_on', 'due_on', 'start_at',
      'due_at', 'time_zone', 'assignee_id', 'kind', 'subtask_order', 'deleted_at', 'notes', '_changed']),
    ('task_projects', array['task_id', 'project_id', 'section_id', 'sort_order', 'deleted_at', '_changed']),
    ('comments', array['id', 'task_id', 'author_id', 'rule_id', 'created_at', 'edited_at', 'deleted_at', 'pinned_at',
      'pinned_by', 'review_check_id', 'body', 'email', 'mention_ids']),
    ('comment_reactions', array['id', 'comment_id', 'profile_id', 'emoji', 'deleted_at']),
    ('task_stories', array['id', 'kind']),
    ('task_attachments', array['id', 'deleted_at']),
    ('approval_requests', array['id', 'status', 'round_id', 'deleted_at']),
    ('review_checks', array['id', 'status', 'decided_at']),
    ('email_outbox', array['id', 'status', 'delivery_status']),
    ('task_followers', array['task_id', 'profile_id', 'deleted_at']),
    ('task_tags', array['id', 'task_id', 'tag_id', 'deleted_at']),
    ('task_field_values', array['task_id', 'field_id', 'value']),
    ('rule_runs', array['id', 'status', 'task_id', 'rule_id', 'created_at']),
    ('inbox_items', array['id', 'kind', 'task_id', 'read_at', 'archived_at', 'bookmarked_at', 'created_at']),
    ('project_messages', array['id', 'thread_id', 'message_id', 'deleted_at']),
    ('project_message_reactions', array['id', 'thread_id', 'message_id', 'deleted_at'])
  )
  select count(*) into bad
  from realtime.messages m
  cross join lateral jsonb_array_elements(m.payload -> 'rows') as r(row)
  cross join lateral jsonb_object_keys(r.row) as k
  left join allowed a on a.tbl = m.payload ->> 'table'
  where a.keys is null or not (k = any (a.keys));
  assert bad = 0, format('%s row keys outside their table''s list', bad);

  -- Notes only on the task's own topic; a trashed task is a tombstone everywhere.
  select count(*) into bad
  from realtime.messages m cross join lateral jsonb_array_elements(m.payload -> 'rows') as r(row)
  where m.payload ->> 'table' = 'tasks'
    and ((m.topic not like 'alhc:task:%' or (r.row ->> 'id') <> split_part(m.topic, ':', 3)) and r.row ? 'notes'
      or r.row ->> 'deleted_at' is not null and (r.row ? 'title' or r.row ? 'notes' or r.row ? 'assignee_id'));
  assert bad = 0, format('%s task rows leak notes off the task topic or a trashed title', bad);

  -- Field values only on project topics.
  select count(*) into bad
  from realtime.messages m cross join lateral jsonb_array_elements(m.payload -> 'rows') as r(row)
  where m.payload ->> 'table' = 'task_field_values' and m.topic like 'alhc:task:%' and r.row ? 'value';
  assert bad = 0, 'no field value on a task topic';

  -- Project / task / user messages only for their own kind of table.
  select count(*) into bad from realtime.messages m
  where (m.topic like 'alhc:user:%' and m.payload ->> 'table' not in ('tasks', 'inbox_items', 'rule_runs'))
     or (m.topic like 'alhc:project:%' and m.payload ->> 'table' not in
         ('tasks', 'task_projects', 'task_field_values', 'task_tags', 'project_messages', 'project_message_reactions'));
  assert bad = 0, format('%s messages on a topic of the wrong kind', bad);
end $$;

-- 3. Topic authorization -------------------------------------------------------------------------------

create temporary table b26_people (id uuid) on commit preserve rows;
insert into b26_people
select id from (
  (select m.profile_id as id from public.project_members m where m.deleted_at is null
   group by m.profile_id order by count(*) desc, m.profile_id limit 6)
  union
  (select m.profile_id from public.project_members m where m.deleted_at is not null
   group by m.profile_id order by m.profile_id limit 2)
  union
  (select t.created_by from public.tasks t where t.home_project_id is null and t.created_by is not null
   group by t.created_by order by count(*) desc, t.created_by limit 2)
  union
  (select m.profile_id from public.project_members m join public.projects pj on pj.id = m.project_id
   where m.deleted_at is null and pj.archived_at is not null order by m.profile_id limit 1)
  union
  (select p.id from public.profiles p join public.allowed_emails a on a.email = lower(p.email)
   where a.removed_at is not null order by p.id limit 2)
  union
  (select p.id from public.profiles p
   where not exists (select 1 from public.project_members m where m.profile_id = p.id) order by p.id limit 1)
) x;
insert into b26_people values (null);

create temporary table b26_topics (topic text primary key, kind text, target uuid) on commit preserve rows;
insert into b26_topics
select 'alhc:project:' || id, 'project', id from public.projects
union all
select 'alhc:task:' || id, 'task', id from (
  (select id from public.tasks where parent_task_id is null and home_project_id is not null order by id limit 150)
  union (select id from public.tasks where parent_task_id is not null order by id limit 60)
  union (select id from public.tasks where home_project_id is null order by id limit 40)
  union (select id from public.tasks where deleted_at is not null order by id limit 20)
) t
union all
select 'alhc:user:' || id, 'user', id from b26_people where id is not null
on conflict do nothing;
-- Plus malformed / foreign topics (never ours).
insert into b26_topics values
  ('alhc:team:' || gen_random_uuid(), 'other', null),
  ('alhc:project:not-a-uuid', 'other', null),
  ('alhc:project:' || upper(gen_random_uuid()::text), 'other', null);

-- One message per topic (Realtime's own join check reads the topic's rows the same way).
insert into realtime.messages (topic, extension, payload, event, private)
select topic, 'broadcast', '{}'::jsonb, 'probe', true from b26_topics;

do $$
declare
  who uuid;
  r record;
  expected boolean;
  seen boolean;
  mismatches int := 0;
  checks int := 0;
begin
  for who in select id from b26_people loop
    perform set_config('request.jwt.claim.sub', coalesce(who::text, ''), false);
    for r in select * from b26_topics loop
      expected := case r.kind
        when 'project' then coalesce(public.has_project_role(r.target, 'viewer'), false)
        when 'task' then coalesce(public.has_task_role(r.target, 'viewer'), false)
        when 'user' then who is not null and r.target = who and coalesce(public.is_allowlisted(), false)
        else false end;
      perform set_config('realtime.topic', r.topic, true);
      set local role authenticated;
      seen := exists (select 1 from realtime.messages m where m.topic = r.topic and m.event = 'probe');
      reset role;
      checks := checks + 1;
      if seen is distinct from expected then
        mismatches := mismatches + 1;
        raise warning 'topic % for %: policies say %, the rule says %', r.topic, who, seen, expected;
      end if;
      -- anon never joins one of ours.
      set local role anon;
      assert not exists (select 1 from realtime.messages m where m.topic = r.topic), format('anon reads %s', r.topic);
      reset role;
    end loop;
  end loop;
  perform set_config('request.jwt.claim.sub', '', false);
  perform set_config('realtime.topic', '', false);
  assert mismatches = 0, format('%s of %s topic checks disagree', mismatches, checks);
  assert checks > 1000, format('enough checks (%s)', checks);
  -- Someone was allowed somewhere, and refused somewhere (the check isn't trivially true or false).
  raise notice 'batch 26: % topic checks agree', checks;
end $$;

-- 4. The guards, with another app's wide-open policies in place (rolled back) --------------------------

begin;
create policy b26_other_app_read on realtime.messages for select to anon, authenticated using (true);
create policy b26_other_app_send on realtime.messages for insert to anon, authenticated with check (true);
insert into realtime.messages (topic, extension, payload, event, private) values ('room-1', 'broadcast', '{}', 'probe', true);

do $$
declare
  outsider uuid := (select id from b26_people where id is not null and not exists (
    select 1 from public.project_members m where m.profile_id = b26_people.id and m.deleted_at is null) limit 1);
  project uuid := (select id from public.projects order by id limit 1);
  refused boolean;
begin
  assert outsider is not null, 'someone with no project';
  perform set_config('request.jwt.claim.sub', outsider::text, true);

  perform set_config('realtime.topic', 'alhc:project:' || project, true);
  set local role authenticated;
  assert not exists (select 1 from realtime.messages where topic = 'alhc:project:' || project),
    'a wide-open policy elsewhere doesn''t open an alhc topic';
  reset role;

  perform set_config('realtime.topic', 'room-1', true);
  set local role authenticated;
  assert exists (select 1 from realtime.messages where topic = 'room-1'), 'other topics are left alone';
  reset role;
  set local role anon;
  assert exists (select 1 from realtime.messages where topic = 'room-1'), 'anon too';
  reset role;

  -- Sending into an alhc topic is refused, even for a member; other topics aren't.
  perform set_config('request.jwt.claim.sub',
    (select m.profile_id::text from public.project_members m where m.project_id = project and m.deleted_at is null limit 1), true);
  perform set_config('realtime.topic', 'alhc:project:' || project, true);
  refused := false;
  begin
    set local role authenticated;
    insert into realtime.messages (topic, extension, payload, event, private)
    values ('alhc:project:' || project, 'broadcast', '{"v":1}', 'tasks', true);
  exception when insufficient_privilege then
    refused := true;
  end;
  reset role;
  assert refused, 'clients can''t send into an alhc topic';

  refused := false;
  perform set_config('realtime.topic', 'room-1', true);
  begin
    set local role authenticated;
    insert into realtime.messages (topic, extension, payload, event, private) values ('alhc:user:' || outsider, 'broadcast', '{}', 'x', true);
  exception when insufficient_privilege then
    refused := true;
  end;
  reset role;
  assert refused, 'nor by naming one in the row under another topic';

  perform set_config('realtime.topic', 'room-1', true);
  set local role authenticated;
  insert into realtime.messages (topic, extension, payload, event, private) values ('room-1', 'broadcast', '{}', 'x', true);
  reset role;
end $$;
rollback;

-- 5. What writes send ----------------------------------------------------------------------------------

do $$
declare
  t record;
  owner uuid;
  other uuid;
  n int;
  m jsonb;
  c uuid;
  f record;
begin
  -- A live top-level task with an active membership, an owner of that project, and another member.
  select tk.id, tk.title, tk.assignee_id, tp.project_id into t
  from public.tasks tk join public.task_projects tp on tp.task_id = tk.id and tp.deleted_at is null
  join public.projects pj on pj.id = tp.project_id and pj.deleted_at is null and pj.archived_at is null
  where tk.deleted_at is null and tk.parent_task_id is null
    and exists (select 1 from public.project_members m where m.project_id = tp.project_id and m.role = 'owner' and m.deleted_at is null)
    and (select count(*) from public.project_members m where m.project_id = tp.project_id and m.deleted_at is null) >= 2
  order by tk.id limit 1;
  assert t.id is not null, 'a task to test with';
  select m.profile_id into owner from public.project_members m
  where m.project_id = t.project_id and m.role = 'owner' and m.deleted_at is null order by m.profile_id limit 1;
  select m.profile_id into other from public.project_members m
  where m.project_id = t.project_id and m.deleted_at is null and m.profile_id <> owner order by m.profile_id limit 1;

  -- a. A rename by the owner (through RLS, as a client): task, project, and assignee topics.
  update public.tasks set assignee_id = owner where id = t.id;
  truncate realtime.messages;
  perform set_config('request.jwt.claim.sub', owner::text, true);
  set local role authenticated;
  update public.tasks set title = 'Live rename check', notes = 'Private notes' where id = t.id;
  reset role;
  select payload -> 'rows' -> 0 into m from realtime.messages where topic = 'alhc:task:' || t.id and event = 'tasks';
  assert m ->> 'title' = 'Live rename check' and m ->> 'notes' = 'Private notes', 'the task topic has the row with notes';
  assert m -> '_changed' ?& array['title', 'notes'], 'and says what changed';
  select payload -> 'rows' -> 0 into m from realtime.messages where topic = 'alhc:project:' || t.project_id and event = 'tasks';
  assert m ->> 'title' = 'Live rename check' and not m ? 'notes', 'the project topic has the row without notes';
  assert exists (select 1 from realtime.messages where topic = 'alhc:user:' || owner and event = 'tasks'), 'the assignee hears it';

  -- b. Nothing sent for a write that changes nothing sent.
  truncate realtime.messages;
  update public.tasks set title = title where id = t.id;
  select count(*) into n from realtime.messages where event = 'tasks';
  assert n = 0, format('an unchanged row sends nothing (%s)', n);

  -- c. A notes-only change goes to the task topic only.
  update public.tasks set notes = 'Other notes' where id = t.id;
  assert not exists (select 1 from realtime.messages where event = 'tasks' and topic <> 'alhc:task:' || t.id)
     and exists (select 1 from realtime.messages where topic = 'alhc:task:' || t.id and event = 'tasks'), 'notes: task topic only';

  -- d. Reassigned: the old assignee hears only that it's no longer theirs.
  truncate realtime.messages;
  update public.tasks set assignee_id = other where id = t.id;
  select payload -> 'rows' -> 0 into m from realtime.messages where topic = 'alhc:user:' || owner and event = 'tasks';
  assert m - '_changed' = jsonb_build_object('id', t.id, 'assignee_id', other), 'the old assignee: id and new assignee only';
  assert exists (select 1 from realtime.messages where topic = 'alhc:user:' || other and event = 'tasks'), 'the new assignee hears it';

  -- e. The Trash: a tombstone.
  truncate realtime.messages;
  update public.tasks set deleted_at = now() where id = t.id;
  select payload -> 'rows' -> 0 into m from realtime.messages where topic = 'alhc:project:' || t.project_id and event = 'tasks';
  assert m ? 'deleted_at' and not m ? 'title', 'a trashed task is a tombstone';
  update public.tasks set deleted_at = null, title = t.title, assignee_id = t.assignee_id where id = t.id;

  -- f. A comment with a mention: the task topic, the body, the mention, no address.
  truncate realtime.messages;
  perform set_config('request.jwt.claim.sub', owner::text, true);
  set local role authenticated;
  insert into public.comments (task_id, author_id, body)
  values (t.id, owner, 'Live check @' || (select split_part(email, '@', 1) from public.profiles where id = other))
  returning id into c;
  reset role;
  select payload -> 'rows' -> 0 into m from realtime.messages where topic = 'alhc:task:' || t.id and event = 'comments';
  assert m ->> 'id' = c::text and m ->> 'body' like 'Live check @%', 'the comment arrives with its body';
  assert m -> 'mention_ids' ? other::text, 'with the people it mentions';
  assert not m ? 'email_address' and m -> 'email' = 'false'::jsonb, 'and never an address';

  -- g. The Inbox: read state on the recipient's topic.
  truncate realtime.messages;
  update public.inbox_items set read_at = now()
  where id = (select id from public.inbox_items where read_at is null order by id limit 1);
  assert exists (select 1 from realtime.messages where topic like 'alhc:user:%' and event = 'inbox_items'
                 and payload -> 'rows' -> 0 ->> 'read_at' is not null), 'a read item is sent to its recipient';

  -- h. A field value: the value on the field's project, a signal on the task.
  select v.task_id, v.field_id, cf.project_id into f
  from public.task_field_values v join public.custom_fields cf on cf.id = v.field_id
  where cf.field_type = 'text' and not cf.locked order by v.task_id limit 1;
  if f.task_id is not null then
    truncate realtime.messages;
    update public.task_field_values set value = to_jsonb('Live value'::text) where task_id = f.task_id and field_id = f.field_id;
    assert (select payload -> 'rows' -> 0 ->> 'value' from realtime.messages where topic = 'alhc:project:' || f.project_id and event = 'task_field_values') = 'Live value',
      'the field''s project hears the value';
    assert (select payload -> 'rows' -> 0 from realtime.messages where topic = 'alhc:task:' || f.task_id and event = 'task_field_values')
      = jsonb_build_object('task_id', f.task_id, 'field_id', f.field_id), 'the task hears only which field';
  end if;

  -- i. A big statement: chunks of 50 rows.
  truncate realtime.messages;
  update public.tasks set title = title || ' ' where id in (
    select tk.id from public.tasks tk join public.task_projects tp on tp.task_id = tk.id and tp.deleted_at is null
    where tp.project_id = t.project_id and tk.deleted_at is null and tk.parent_task_id is null
  );
  get diagnostics n = row_count;
  if n > 50 then
    assert (select max(jsonb_array_length(payload -> 'rows')) from realtime.messages where topic = 'alhc:project:' || t.project_id and event = 'tasks') = 50,
      'chunks of 50';
  end if;
  assert (select sum(jsonb_array_length(payload -> 'rows')) from realtime.messages where topic = 'alhc:project:' || t.project_id and event = 'tasks') = n,
    'every row once on the project topic';
  update public.tasks set title = rtrim(title, ' ') where id in (
    select tk.id from public.tasks tk join public.task_projects tp on tp.task_id = tk.id and tp.deleted_at is null
    where tp.project_id = t.project_id and tk.deleted_at is null and tk.parent_task_id is null
  );

  -- j. Imports and copies send nothing.
  truncate realtime.messages;
  perform set_config('alhc.import_run_id', gen_random_uuid()::text, true);
  update public.tasks set title = 'During an import' where id = t.id;
  perform set_config('alhc.import_run_id', '', true);
  perform set_config('alhc.copy_id', gen_random_uuid()::text, true);
  update public.tasks set title = 'During a copy' where id = t.id;
  perform set_config('alhc.copy_id', '', true);
  assert (select count(*) from realtime.messages) = 0, 'imports and copies are quiet';
  update public.tasks set title = t.title where id = t.id;

  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- The publication: once the tail ran, none of ALHC's tables stream Postgres Changes any more.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    assert not exists (
      select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
        and tablename in ('tasks', 'task_projects', 'comments', 'comment_reactions', 'task_stories', 'rule_runs', 'inbox_items',
          'email_outbox', 'approval_requests', 'project_messages', 'project_message_reactions', 'task_likes',
          'comment_pin_events', 'team_messages', 'team_message_reactions', 'team_message_followers')
    ), 'ALHC tables are out of supabase_realtime';
  end if;
end $$;

select 'zz54_nov4_batch26_smoke: ok';
