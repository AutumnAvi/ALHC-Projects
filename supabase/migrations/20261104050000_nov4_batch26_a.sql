-- Nov 4 notes, batch 26 (medium fix M3): live updates through Realtime Broadcast.
--
-- Realtime Postgres Changes on 16 tables used about half of the database's time: every change to a
-- published table was read back from the WAL and checked against each subscriber's RLS. This migration
-- moves live updates to Broadcast:
--   1. statement-level AFTER INSERT / AFTER UPDATE triggers on the 16 tables (alhc_live_capture, definer)
--      turn the rows a statement changed into a few small messages through realtime.send(), one per
--      private topic: alhc:project:<id> (the project's readers), alhc:task:<id> (the task's readers), and
--      alhc:user:<id> (that person). Each message carries only the columns its topic's readers may already
--      read, and only for rows whose sent columns changed; a trashed task is a tombstone (id and time).
--   2. realtime.messages policies decide who joins a topic: alhc_live_topic_allowed() — Viewer+ of the
--      project (project_ids_with_role, batch 23), has_task_role viewer for a task, the person themself
--      for a user topic. Restrictive policies keep alhc:* topics closed to anyone else whatever other
--      policies the shared project has, and nobody (anon or authenticated) can send into them.
-- Imports and copies send nothing (their pages refresh when they finish). Rows removed outright (only the
-- Trash purge and log retention do that) send nothing either; soft deletes are updates.
--
-- Additive: no table changes; the old publication keeps working for the release still on main until the
-- tail at the end of this file (applied by hand once this release is live) takes these tables out of
-- supabase_realtime.

-- -------------------------------------------------------------------------------------------------
-- Who may join a topic. Called by the realtime.messages policies (as the joining person).

create or replace function public.alhc_live_topic_allowed(topic text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  kind text;
  target uuid;
begin
  if topic is null
     or topic !~ '^alhc:(project|task|user):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  kind := split_part(topic, ':', 2);
  target := split_part(topic, ':', 3)::uuid;
  if kind = 'project' then
    return target = any (coalesce(public.project_ids_with_role('viewer'), array[]::uuid[]));
  elsif kind = 'task' then
    return coalesce(public.has_task_role(target, 'viewer'), false);
  end if;
  return target = (select auth.uid()) and coalesce(public.is_allowlisted(), false);
end;
$$;

comment on function public.alhc_live_topic_allowed(text) is
  'Nov 4 notes, batch 26: whether the caller may receive a live-update topic (alhc:project:<id> = Viewer+ of the project, alhc:task:<id> = can read the task, alhc:user:<id> = themself). Used by the realtime.messages policies.';

revoke all on function public.alhc_live_topic_allowed(text) from public, anon;
grant execute on function public.alhc_live_topic_allowed(text) to authenticated;

-- -------------------------------------------------------------------------------------------------
-- The keys of a row that a topic may see.

create or replace function public.alhc_live_pick(r jsonb, keys text[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(k, r -> k), '{}'::jsonb)
  from unnest(keys) as k
  where r ? k
$$;

-- The keys whose values differ between two picks (null for a new row).
create or replace function public.alhc_live_changed(now_row jsonb, was_row jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when was_row is null then null else coalesce((
    select jsonb_agg(k order by k)
    from jsonb_object_keys(now_row || was_row) as k
    where now_row -> k is distinct from was_row -> k
  ), '[]'::jsonb) end
$$;

revoke all on function public.alhc_live_pick(jsonb, text[]) from public, anon, authenticated;
revoke all on function public.alhc_live_changed(jsonb, jsonb) from public, anon, authenticated;

-- -------------------------------------------------------------------------------------------------
-- Routing: the (topic, row) pairs a statement's rows make. p_new / p_old are the statement's new / old
-- rows as JSON arrays (p_old null for inserts). Returns [{ "t": topic, "r": row }, …], each pair once.
-- Every row object is built from an explicit key list: nothing a topic's readers can't read already
-- (never an email address, a token, an email body, or a field value of a project the topic doesn't
-- cover). Updates carry "_changed": the sent keys that changed.

create or replace function public.alhc_live_route(p_table text, p_new jsonb, p_old jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_old jsonb;
  v_items jsonb;
  task_keys constant text[] := array[
    'id', 'parent_task_id', 'root_task_id', 'title', 'completed_at', 'start_on', 'due_on', 'start_at',
    'due_at', 'time_zone', 'assignee_id', 'kind', 'subtask_order', 'deleted_at'
  ];
  tomb_keys constant text[] := array['id', 'parent_task_id', 'root_task_id', 'deleted_at'];
begin
  -- Old rows by their key.
  v_old := coalesce((
    select jsonb_object_agg(
      case p_table
        when 'task_projects' then (o ->> 'task_id') || ':' || (o ->> 'project_id')
        when 'task_field_values' then (o ->> 'task_id') || ':' || (o ->> 'field_id')
        when 'task_followers' then (o ->> 'task_id') || ':' || (o ->> 'profile_id')
        else o ->> 'id'
      end, o)
    from jsonb_array_elements(coalesce(p_old, '[]'::jsonb)) as e(o)
  ), '{}'::jsonb);

  if p_table = 'tasks' then
    with c as (
      select r, v_old -> (r ->> 'id') as was from jsonb_array_elements(p_new) as e(r)
    ), picked as (
      select
        (r ->> 'id')::uuid as id,
        coalesce(r ->> 'root_task_id', r ->> 'id')::uuid as root,
        (r ->> 'parent_task_id')::uuid as parent,
        (r ->> 'assignee_id')::uuid as assignee,
        (was ->> 'assignee_id')::uuid as was_assignee,
        case when r ->> 'deleted_at' is null then public.alhc_live_pick(r, task_keys)
             else public.alhc_live_pick(r, tomb_keys) end as slim,
        case when r ->> 'deleted_at' is null then public.alhc_live_pick(r, task_keys || array['notes'])
             else public.alhc_live_pick(r, tomb_keys) end as full_row,
        case when was is null then null
             when was ->> 'deleted_at' is null then public.alhc_live_pick(was, task_keys)
             else public.alhc_live_pick(was, tomb_keys) end as was_slim,
        case when was is null then null
             when was ->> 'deleted_at' is null then public.alhc_live_pick(was, task_keys || array['notes'])
             else public.alhc_live_pick(was, tomb_keys) end as was_full
      from c
    ), rows as (
      select p.*,
        p.slim || coalesce(jsonb_build_object('_changed', public.alhc_live_changed(p.slim, p.was_slim)), '{}'::jsonb) as slim_out,
        p.full_row || coalesce(jsonb_build_object('_changed', public.alhc_live_changed(p.full_row, p.was_full)), '{}'::jsonb) as full_out,
        (p.was_slim is null or p.was_slim is distinct from p.slim) as slim_moved,
        (p.was_full is null or p.was_full is distinct from p.full_row) as full_moved
      from picked p
    )
    select jsonb_agg(jsonb_build_object('t', s.t, 'r', s.r)) into v_items
    from (
      select 'alhc:project:' || tp.project_id as t, rows.slim_out as r
      from rows join public.task_projects tp on tp.task_id = rows.root and tp.deleted_at is null
      where rows.slim_moved
      union
      select 'alhc:task:' || rows.id, rows.full_out from rows where rows.full_moved
      union
      select 'alhc:task:' || rows.parent, rows.slim_out from rows where rows.parent is not null and rows.slim_moved
      union
      select 'alhc:user:' || rows.assignee, rows.slim_out from rows where rows.assignee is not null and rows.slim_moved
      union
      -- The person it was taken from learns only that it's no longer theirs.
      select 'alhc:user:' || rows.was_assignee, jsonb_build_object('id', rows.id, 'assignee_id', rows.assignee, '_changed', '["assignee_id"]'::jsonb)
      from rows where rows.was_assignee is not null and rows.was_assignee is distinct from rows.assignee
    ) s;

  elsif p_table = 'task_projects' then
    with rows as (
      select r ->> 'project_id' as project,
        public.alhc_live_pick(r, array['task_id', 'project_id', 'section_id', 'sort_order', 'deleted_at']) as now_row,
        case when v_old ? ((r ->> 'task_id') || ':' || (r ->> 'project_id'))
             then public.alhc_live_pick(v_old -> ((r ->> 'task_id') || ':' || (r ->> 'project_id')),
                    array['task_id', 'project_id', 'section_id', 'sort_order', 'deleted_at']) end as was_row
      from jsonb_array_elements(p_new) as e(r)
    )
    select jsonb_agg(jsonb_build_object('t', 'alhc:project:' || project,
             'r', now_row || coalesce(jsonb_build_object('_changed', public.alhc_live_changed(now_row, was_row)), '{}'::jsonb)))
      into v_items
    from rows where was_row is null or was_row is distinct from now_row;

  elsif p_table = 'comments' then
    with rows as (
      select r ->> 'task_id' as task,
        public.alhc_live_pick(r, array['id', 'task_id', 'author_id', 'rule_id', 'created_at', 'edited_at', 'deleted_at',
          'pinned_at', 'pinned_by', 'review_check_id'])
          || jsonb_build_object(
            'body', case when r ->> 'deleted_at' is null then r -> 'body' else to_jsonb(''::text) end,
            'email', r ->> 'email_direction' is not null,
            'mention_ids', coalesce((
              select jsonb_agg(m.profile_id order by m.profile_id) from public.comment_mentions m
              where m.comment_id = (r ->> 'id')::uuid
            ), '[]'::jsonb)) as now_row,
        v_old -> (r ->> 'id') as was
      from jsonb_array_elements(p_new) as e(r)
    )
    select jsonb_agg(jsonb_build_object('t', 'alhc:task:' || task, 'r', now_row)) into v_items
    from rows
    where was is null
       or was -> 'body' is distinct from now_row -> 'body' and (was ->> 'deleted_at') is null
       or (was -> 'edited_at', was -> 'deleted_at', was -> 'pinned_at')
          is distinct from (now_row -> 'edited_at', now_row -> 'deleted_at', now_row -> 'pinned_at');

  elsif p_table in ('comment_reactions', 'task_stories', 'task_attachments', 'approval_requests', 'review_checks', 'email_outbox') then
    -- Task-scoped rows: the pane patches reactions and removed files, and refetches itself for the rest.
    with keyed as (
      select r, v_old -> (r ->> 'id') as was,
        case p_table
          when 'comment_reactions' then array['id', 'comment_id', 'profile_id', 'emoji', 'deleted_at']
          when 'task_stories' then array['id', 'kind']
          when 'task_attachments' then array['id', 'deleted_at']
          when 'approval_requests' then array['id', 'status', 'round_id', 'deleted_at']
          when 'review_checks' then array['id', 'status', 'decided_at']
          else array['id', 'status', 'delivery_status']
        end as keys
      from jsonb_array_elements(p_new) as e(r)
      where r ->> 'task_id' is not null
    ), rows as (
      select r ->> 'task_id' as task, public.alhc_live_pick(r, keys) as now_row,
        case when was is null then null else public.alhc_live_pick(was, keys) end as was_row
      from keyed
    )
    select jsonb_agg(jsonb_build_object('t', 'alhc:task:' || task, 'r', now_row)) into v_items
    from rows where was_row is null or was_row is distinct from now_row;

  elsif p_table = 'task_followers' then
    with rows as (
      select r ->> 'task_id' as task, public.alhc_live_pick(r, array['task_id', 'profile_id', 'deleted_at']) as now_row,
        v_old -> ((r ->> 'task_id') || ':' || (r ->> 'profile_id')) as was
      from jsonb_array_elements(p_new) as e(r)
    )
    select jsonb_agg(jsonb_build_object('t', 'alhc:task:' || task, 'r', now_row)) into v_items
    from rows where was is null or was -> 'deleted_at' is distinct from now_row -> 'deleted_at';

  elsif p_table = 'task_tags' then
    with rows as (
      select (r ->> 'task_id')::uuid as task, public.alhc_live_pick(r, array['id', 'task_id', 'tag_id', 'deleted_at']) as now_row,
        v_old -> (r ->> 'id') as was
      from jsonb_array_elements(p_new) as e(r)
    ), moved as (
      select rows.*, coalesce(t.root_task_id, t.id) as root
      from rows join public.tasks t on t.id = rows.task
      where rows.was is null or rows.was -> 'deleted_at' is distinct from rows.now_row -> 'deleted_at'
    )
    select jsonb_agg(jsonb_build_object('t', s.t, 'r', s.r)) into v_items
    from (
      select 'alhc:task:' || moved.task as t, moved.now_row as r from moved
      union
      select 'alhc:project:' || tp.project_id, moved.now_row
      from moved join public.task_projects tp on tp.task_id = moved.root and tp.deleted_at is null
    ) s;

  elsif p_table = 'task_field_values' then
    -- The value goes only to the field's own project (its readers read it there); the task's topic hears
    -- that a value changed, not what it is (the task's readers may not read that project).
    with rows as (
      select (r ->> 'task_id')::uuid as task, (r ->> 'field_id')::uuid as field, r -> 'value' as value,
        v_old -> ((r ->> 'task_id') || ':' || (r ->> 'field_id')) as was
      from jsonb_array_elements(p_new) as e(r)
    ), moved as (
      select rows.*, cf.project_id
      from rows join public.custom_fields cf on cf.id = rows.field
      where rows.was is null or rows.was -> 'value' is distinct from rows.value
    )
    select jsonb_agg(jsonb_build_object('t', s.t, 'r', s.r)) into v_items
    from (
      select 'alhc:project:' || moved.project_id as t,
        jsonb_build_object('task_id', moved.task, 'field_id', moved.field, 'value', moved.value) as r
      from moved
      union
      select 'alhc:task:' || moved.task, jsonb_build_object('task_id', moved.task, 'field_id', moved.field) from moved
    ) s;

  elsif p_table = 'rule_runs' then
    with rows as (
      select r, v_old -> (r ->> 'id') as was from jsonb_array_elements(p_new) as e(r)
    ), moved as (
      select r from rows
      where was is null or (was -> 'status', was -> 'deleted_at') is distinct from (r -> 'status', r -> 'deleted_at')
    )
    select jsonb_agg(jsonb_build_object('t', s.t, 'r', s.r)) into v_items
    from (
      select 'alhc:task:' || (r ->> 'task_id') as t, public.alhc_live_pick(r, array['id', 'status']) as r
      from moved where r ->> 'task_id' is not null
      union
      select 'alhc:user:' || (r ->> 'actor_id'), public.alhc_live_pick(r, array['id', 'task_id', 'rule_id', 'status', 'created_at'])
      from moved where r ->> 'actor_id' is not null
    ) s;

  elsif p_table = 'inbox_items' then
    with rows as (
      select r ->> 'recipient_id' as person,
        public.alhc_live_pick(r, array['id', 'kind', 'task_id', 'read_at', 'archived_at', 'bookmarked_at', 'created_at']) as now_row,
        v_old -> (r ->> 'id') as was
      from jsonb_array_elements(p_new) as e(r)
    )
    select jsonb_agg(jsonb_build_object('t', 'alhc:user:' || person, 'r', now_row)) into v_items
    from rows
    where was is null
       or (was -> 'read_at', was -> 'archived_at', was -> 'bookmarked_at')
          is distinct from (now_row -> 'read_at', now_row -> 'archived_at', now_row -> 'bookmarked_at');

  elsif p_table in ('project_messages', 'project_message_reactions') then
    with rows as (
      select r, v_old -> (r ->> 'id') as was from jsonb_array_elements(p_new) as e(r)
    )
    select jsonb_agg(jsonb_build_object('t', 'alhc:project:' || (r ->> 'project_id'),
             'r', public.alhc_live_pick(r, array['id', 'thread_id', 'message_id', 'deleted_at']))) into v_items
    from rows
    where r ->> 'project_id' is not null
      and (was is null
        or (was -> 'title', was -> 'body', was -> 'deleted_at', was -> 'last_activity_at')
           is distinct from (r -> 'title', r -> 'body', r -> 'deleted_at', r -> 'last_activity_at'));
  end if;

  return coalesce(v_items, '[]'::jsonb);
end;
$$;

revoke all on function public.alhc_live_route(text, jsonb, jsonb) from public, anon, authenticated;

-- -------------------------------------------------------------------------------------------------
-- Sending: one realtime.send() per topic and up to 50 rows. realtime.send() never raises (it turns a
-- failure into a warning), so a write never fails because a live update couldn't go out.

create or replace function public.alhc_live_send(p_table text, p_op text, p_items jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  r record;
  sent_at text := to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    return;
  end if;
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return;
  end if;
  for r in
    select s.topic, jsonb_agg(s.row order by s.ord) as rows
    from (
      select e ->> 't' as topic, e -> 'r' as row, x.ord,
        (row_number() over (partition by e ->> 't' order by x.ord) - 1) / 50 as chunk
      from jsonb_array_elements(p_items) with ordinality as x(e, ord)
    ) s
    group by s.topic, s.chunk
    order by s.topic, s.chunk
  loop
    perform realtime.send(
      jsonb_build_object('v', 1, 'table', p_table, 'op', p_op, 'at', sent_at, 'rows', r.rows),
      p_table, r.topic, true
    );
  end loop;
end;
$$;

revoke all on function public.alhc_live_send(text, text, jsonb) from public, anon, authenticated;

-- -------------------------------------------------------------------------------------------------
-- The trigger function: one per statement (AFTER INSERT / AFTER UPDATE … FOR EACH STATEMENT with
-- transition tables), so a statement that changes 200 rows sends a few messages, not 200.

create or replace function public.alhc_live_capture()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new jsonb;
  v_old jsonb;
begin
  if public.import_context_id() is not null or public.copy_context_id() is not null then
    return null;
  end if;
  if tg_op = 'INSERT' then
    select jsonb_agg(to_jsonb(n)) into v_new from new_rows n;
  else
    select jsonb_agg(to_jsonb(n)) into v_new from new_rows n;
    select jsonb_agg(to_jsonb(o)) into v_old from old_rows o;
  end if;
  if v_new is null then
    return null;
  end if;
  perform public.alhc_live_send(tg_table_name, tg_op, public.alhc_live_route(tg_table_name, v_new, v_old));
  return null;
end;
$$;

comment on function public.alhc_live_capture() is
  'Nov 4 notes, batch 26: statement-level trigger that sends live updates (Realtime Broadcast) for the rows a statement inserted or updated: alhc_live_route picks the topics and columns, alhc_live_send sends them.';

revoke all on function public.alhc_live_capture() from public, anon, authenticated;

do $$
declare
  name text;
begin
  foreach name in array array[
    'tasks', 'task_projects', 'comments', 'comment_reactions', 'task_stories', 'rule_runs', 'inbox_items',
    'email_outbox', 'approval_requests', 'review_checks', 'project_messages', 'project_message_reactions',
    'task_field_values', 'task_attachments', 'task_followers', 'task_tags'
  ] loop
    execute format(
      'create or replace trigger %I after insert on public.%I referencing new table as new_rows '
      'for each statement execute function public.alhc_live_capture()',
      name || '_zz_live_insert', name);
    execute format(
      'create or replace trigger %I after update on public.%I referencing old table as old_rows new table as new_rows '
      'for each statement execute function public.alhc_live_capture()',
      name || '_zz_live_update', name);
  end loop;
end $$;

-- -------------------------------------------------------------------------------------------------
-- Who joins a topic (realtime.messages is shared with the other app on this project: these policies
-- only ever speak about alhc:* topics). Realtime checks a private channel's join by reading
-- realtime.messages as the joining person with realtime.topic set to the topic.

do $$
begin
  if to_regclass('realtime.messages') is null then
    return;
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'alhc_live_receive'
  ) then
    execute $p$
      create policy alhc_live_receive on realtime.messages
      for select to authenticated
      using (
        realtime.messages.extension = 'broadcast'
        and public.alhc_live_topic_allowed(current_setting('realtime.topic', true))
      )
    $p$;
  end if;
  -- Whatever other policies allow, an alhc:* topic is only for the people above …
  if not exists (
    select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'alhc_live_guard_read'
  ) then
    execute $p$
      create policy alhc_live_guard_read on realtime.messages
      as restrictive for select to authenticated
      using (
        left(coalesce(current_setting('realtime.topic', true), ''), 5) <> 'alhc:'
        or public.alhc_live_topic_allowed(current_setting('realtime.topic', true))
      )
    $p$;
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'alhc_live_guard_read_anon'
  ) then
    execute $p$
      create policy alhc_live_guard_read_anon on realtime.messages
      as restrictive for select to anon
      using (left(coalesce(current_setting('realtime.topic', true), ''), 5) <> 'alhc:')
    $p$;
  end if;
  -- … and only the database sends into one (clients never broadcast on them).
  if not exists (
    select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'alhc_live_guard_send'
  ) then
    execute $p$
      create policy alhc_live_guard_send on realtime.messages
      as restrictive for insert to anon, authenticated
      with check (
        left(coalesce(current_setting('realtime.topic', true), ''), 5) <> 'alhc:'
        and left(coalesce(realtime.messages.topic, ''), 5) <> 'alhc:'
      )
    $p$;
  end if;
end $$;

-- TAIL — applied by hand once this release is live (the release still on main subscribes to Postgres
-- Changes on these tables until then). Takes ALHC's tables out of the supabase_realtime publication, so
-- Realtime stops reading their changes from the WAL. The other app's tables are left as they are.
do $$
declare
  name text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach name in array array[
      'tasks', 'task_projects', 'comments', 'comment_reactions', 'comment_pin_events', 'task_stories',
      'task_likes', 'rule_runs', 'inbox_items', 'email_outbox', 'approval_requests', 'project_messages',
      'project_message_reactions', 'team_messages', 'team_message_reactions', 'team_message_followers'
    ] loop
      if exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = name
      ) then
        execute format('alter publication supabase_realtime drop table public.%I', name);
      end if;
    end loop;
  end if;
end $$;
