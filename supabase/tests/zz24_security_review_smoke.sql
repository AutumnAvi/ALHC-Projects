-- Security review (docs/SECURITY-REVIEW.md). Pass 1 recorded the gaps; pass 2 fixed them in
-- 20261018020000_security_review_fixes.sql (and task numbering, for the request labels). Every
-- FIXED block below asserts the fix; CONTROL blocks are boundaries that already held.
--
-- People:
--   a11c2411-…01 sec24-owner@example.com     allowlisted project owner, workspace admin
--   a11c2411-…02 sec24-stranger@example.com  allowlisted, not a member until added as Viewer
--   a11c2411-…03 sec24-unlisted@example.com  confirmed account, not on the allowlist

\set ON_ERROR_STOP 1

create temporary table sec_ids (name text primary key, id uuid) on commit preserve rows;
grant all on sec_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('sec24-owner@example.com', 'security review'),
  ('sec24-stranger@example.com', 'security review');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a11c2411-0000-4000-8000-000000000001', 'sec24-owner@example.com', now(), '{"full_name":"Sec Owner"}'),
  ('a11c2411-0000-4000-8000-000000000002', 'sec24-stranger@example.com', now(), '{"full_name":"Sec Stranger"}'),
  ('a11c2411-0000-4000-8000-000000000003', 'sec24-unlisted@example.com', now(), '{"full_name":"Sec Unlisted"}');
insert into public.workspace_admins (workspace_id, profile_id)
values ('00000000-0000-4000-8000-000000000001', 'a11c2411-0000-4000-8000-000000000001')
on conflict do nothing;

set role authenticated;
select set_config('request.jwt.claim.sub', 'a11c2411-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid;
  s uuid;
  t uuid;
  c uuid;
  f uuid;
  r uuid;
begin
  insert into public.projects (workspace_id, name)
  values ('00000000-0000-4000-8000-000000000001', 'SEC review')
  returning id into p;
  insert into public.sections (project_id, name, sort_order) values (p, 'In', 1024) returning id into s;
  t := public.create_task(p, s, 'Secret task');
  insert into public.comments (task_id, body) values (t, 'please delete this secret body') returning id into c;
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Budget', 'text') returning id into f;
  insert into public.task_field_values (task_id, field_id, value) values (t, f, '"42"');
  insert into public.rules (project_id, name, trigger_type, actions)
  values (p, 'Quiet', 'task_created', '[{"type": "add_comment", "body": "should never run"}]')
  returning id into r;
  insert into sec_ids values ('p', p), ('task', t), ('comment', c), ('field', f), ('rule', r);
end $$;
reset role;

-- Clients cannot write request numbers. Stamp one as the migration owner.
insert into public.request_sequences (project_id, enabled, prefix, pad_width, last_number)
select id, true, 'SECRET-', 4, 41 from sec_ids where name = 'p'
on conflict (project_id) do update set enabled = true, prefix = 'SECRET-', pad_width = 4;
update public.tasks
set req_project_id = (select id from sec_ids where name = 'p'), req_number = 41
where id = (select id from sec_ids where name = 'task');

-- The comment guard refuses email columns from a client; replica mode skips it. Two emailed
-- copies of the comment's text sit in the outbox, as the comment email and submitter response do.
set session_replication_role = replica;
update public.comments
set email_direction = 'sent', email_address = 'submitter@secret.example', email_subject = 'Re: secret'
where id = (select id from sec_ids where name = 'comment');
set session_replication_role = default;
insert into public.email_outbox (task_id, comment_id, to_email, template, payload)
select (select id from sec_ids where name = 'task'), id, 'follower@example.com', 'custom',
       jsonb_build_object('kind', 'comment', 'comment_body', 'please delete this secret body')
from sec_ids where name = 'comment';
insert into public.email_outbox (task_id, to_email, template, payload)
select (select id from sec_ids where name = 'task'), 'submitter@secret.example', 'custom',
       jsonb_build_object('kind', 'submitter_response', 'comment_id', id, 'message', 'please delete this secret body')
from sec_ids where name = 'comment';

-- The owner removes the comment.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a11c2411-0000-4000-8000-000000000001', false) is not null as ok \gset
update public.comments set deleted_at = now() where id = (select id from sec_ids where name = 'comment');

-- FIXED (finding 2): request label and id helpers no longer answer without access.
select set_config('request.jwt.claim.sub', 'a11c2411-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  task uuid := (select id from sec_ids where name = 'task');
  field uuid := (select id from sec_ids where name = 'field');
  rule uuid := (select id from sec_ids where name = 'rule');
  project uuid := (select id from sec_ids where name = 'p');
begin
  assert not public.is_allowlisted(), 'this caller is not on the allowlist';
  assert (select count(*) from public.tasks where id = task) = 0, 'RLS hides the task';
  assert public.task_request_label(task) is null, 'task_request_label says nothing without access';
  assert public.format_request_label(project, 99) is null, 'format_request_label says nothing without access';
  assert not public.custom_field_has_role(field, 'viewer'), 'no role in the field''s project';
  assert not public.rule_has_role(rule, 'viewer'), 'no role in the rule''s project';
  begin
    perform public.custom_field_project(field);
    raise exception 'custom_field_project should not be callable';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.rule_project(rule);
    raise exception 'rule_project should not be callable';
  exception when insufficient_privilege then
    null;
  end;
  assert (select count(*) from public.task_field_values where field_id = field) = 0, 'field values stay hidden';
end $$;
reset role;
do $$
begin
  assert not has_function_privilege('authenticated', 'public.custom_field_project(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.rule_project(uuid)', 'execute'),
    'the id-mapping helpers are not granted to clients';
  assert not has_function_privilege('anon', 'public.custom_field_has_role(uuid,text)', 'execute')
    and not has_function_privilege('anon', 'public.rule_has_role(uuid,text)', 'execute'),
    'the role booleans are not anon';
end $$;

-- CONTROL: members keep their labels, field values, and the policies that use the new helpers.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a11c2411-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  task uuid := (select id from sec_ids where name = 'task');
  field uuid := (select id from sec_ids where name = 'field');
  rule uuid := (select id from sec_ids where name = 'rule');
  project uuid := (select id from sec_ids where name = 'p');
begin
  assert public.task_request_label(task) is not null, 'the owner still sees the label';
  assert public.format_request_label(project, 99) is not null, 'the owner still formats labels';
  assert public.custom_field_has_role(field, 'editor') and public.rule_has_role(rule, 'admin'), 'owner roles';
  assert (select value #>> '{}' from public.task_field_values where task_id = task and field_id = field) = '42',
    'the owner reads the field value';
  update public.task_field_values set value = '"43"' where task_id = task and field_id = field;
  assert (select value #>> '{}' from public.task_field_values where task_id = task and field_id = field) = '43',
    'the owner updates the field value';
end $$;

-- FIXED (finding 3): a removed comment's text is gone from every client-readable place, and the
-- page function no longer returns its submitter address or subject. The row stays for the placeholder.
select set_config('request.jwt.claim.sub', 'a11c2411-0000-4000-8000-000000000001', false) is not null as ok \gset
select public.add_project_member(
  (select id from sec_ids where name = 'p'), 'sec24-stranger@example.com', 'viewer'
);
select set_config('request.jwt.claim.sub', 'a11c2411-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  task uuid := (select id from sec_ids where name = 'task');
  page jsonb;
begin
  assert (select count(*) from public.comments where task_id = task) = 1, 'the removed comment row is still listed';
  assert (select body from public.comments where task_id = task) = '[deleted]', 'the table holds no removed text';
  assert not exists (
    select 1 from public.email_outbox o where o.task_id = task and o.payload::text like '%secret body%'
  ), 'the emailed copies are blanked';
  page := public.task_comment_page(task);
  assert page -> 'comments' -> 0 ->> 'body' = '', 'task_comment_page blanks a removed body';
  assert page -> 'comments' -> 0 ->> 'email_address' is null, 'no address for a removed comment';
  assert page -> 'comments' -> 0 ->> 'email_subject' is null, 'no subject for a removed comment';
  assert page -> 'comments' -> 0 ->> 'deleted_at' is not null, 'the placeholder still renders';
  begin
    perform 1 from public.comment_removed_bodies;
    raise exception 'comment_removed_bodies should not be readable';
  exception when insufficient_privilege then
    null;
  end;
end $$;
reset role;
do $$
declare
  hit text;
  col record;
  found_it boolean;
begin
  assert (select body from public.comment_removed_bodies
          where comment_id = (select id from sec_ids where name = 'comment')) = 'please delete this secret body',
    'the original text is kept out of client reach';
  -- Every other table and column in public: the removed text appears nowhere.
  for col in
    select c.table_name, c.column_name
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
      and c.table_name <> 'comment_removed_bodies'
      and c.data_type in ('text', 'jsonb', 'json', 'character varying')
  loop
    execute format('select exists (select 1 from public.%I where %I::text like %L)',
      col.table_name, col.column_name, '%please delete this secret body%') into found_it;
    if found_it then
      hit := concat_ws(', ', hit, col.table_name || '.' || col.column_name);
    end if;
  end loop;
  assert hit is null, format('removed text still in %s', hit);
end $$;

-- CONTROL: perf readers and the story log do not open the project to a non-member.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a11c2411-0000-4000-8000-000000000003', false) is not null as ok \gset
do $$
declare
  project uuid := (select id from sec_ids where name = 'p');
  task uuid := (select id from sec_ids where name = 'task');
begin
  assert public.project_task_cards(project, null) = '[]'::jsonb, 'non-member cards are empty';
  assert public.project_section_task_counts(project) = '{}'::jsonb, 'non-member section counts are empty';
  assert public.project_task_card_page(project) = '{"groups":[]}'::jsonb, 'non-member card page is empty';
  assert public.project_schedule_cards(project) = '[]'::jsonb, 'non-member schedule cards are empty';
  assert public.task_comment_page(task) ->> 'total' = '0', 'non-member comment page is empty';
  assert public.my_task_cards() = '{"open":[],"completed":[]}'::jsonb, 'unlisted caller has no My Tasks';
  assert public.inbox_page('activity') = '[]'::jsonb, 'unlisted caller has no inbox page';
  assert public.inbox_unread_count() = 0, 'unlisted caller has no unread count';
  begin
    insert into public.task_stories (task_id, kind) values (task, 'created');
    raise exception 'story insert should have been refused';
  exception when insufficient_privilege then
    null;
  end;
  begin
    insert into public.allowed_emails (email) values ('smuggled@example.com');
    raise exception 'allowlist insert should have been refused';
  exception when insufficient_privilege then
    null;
  end;
end $$;
reset role;

-- FIXED (finding 1, database half): shared and reserved literals are refused when a URL is saved.
-- Host names that resolve to private addresses are refused by the app at send time
-- (src/lib/safe-fetch.ts, tests/unit/safe-fetch.test.ts); SQL can't resolve DNS.
do $$
begin
  assert not public.integration_url_ok('https://169.254.169.254/latest/meta-data/'), 'link-local literal blocked';
  assert not public.integration_url_ok('https://127.0.0.1/'), 'loopback literal blocked';
  assert not public.integration_url_ok('https://10.1.2.3/'), 'rfc1918 literal blocked';
  assert not public.integration_url_ok('http://example.com/hook'), 'plain http blocked';
  assert not public.integration_url_ok('https://metadata.google.internal/'), '.internal host blocked';
  assert not public.integration_url_ok('https://100.64.0.1/'), 'CGNAT literal blocked';
  assert not public.integration_url_ok('https://100.127.255.254/'), 'CGNAT upper end blocked';
  assert not public.integration_url_ok('https://198.18.0.1/'), 'benchmarking range blocked';
  assert not public.integration_url_ok('https://224.0.0.1/'), 'multicast blocked';
  assert not public.integration_url_ok('https://240.0.0.1/'), 'reserved blocked';
  assert public.integration_url_ok('https://100.63.0.1/'), 'just below CGNAT is public';
  assert public.integration_url_ok('https://hooks.slack.com/services/T/B/x'), 'Slack still allowed';
end $$;

-- FIXED (finding 5): no TRUNCATE (or REFERENCES / TRIGGER) for clients on ALHC tables or Storage.
do $$
declare
  bad text;
begin
  select string_agg(format('%s:%s', r.rolname, c.relname), ', ' order by c.relname) into bad
  from pg_class c
  cross join (values ('anon'), ('authenticated')) r (rolname)
  where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
    and (has_table_privilege(r.rolname, c.oid, 'TRUNCATE')
      or has_table_privilege(r.rolname, c.oid, 'REFERENCES')
      or has_table_privilege(r.rolname, c.oid, 'TRIGGER'));
  assert bad is null, format('clients still hold TRUNCATE / REFERENCES / TRIGGER on %s (call alhc_revoke_client_truncate)', bad);
  assert not has_table_privilege('anon', 'storage.objects', 'TRUNCATE')
    and not has_table_privilege('authenticated', 'storage.objects', 'TRUNCATE'),
    'no TRUNCATE on storage.objects';
  assert has_table_privilege('anon', 'storage.objects', 'INSERT'), 'anon still uploads form files';
  assert not has_function_privilege('authenticated', 'public.alhc_revoke_client_truncate(text[])', 'execute'),
    'the revoke helper is not for clients';
end $$;

set role authenticated;
do $$
begin
  truncate public.rule_presets;
  raise exception 'truncate should have been refused';
exception when insufficient_privilege then
  null;
end $$;
reset role;

-- FIXED (finding 6): logos stay public files; only workspace admins list or remove them.
do $$
begin
  assert (select public from storage.buckets where id = 'workspace-assets'), 'logo URLs keep working';
  assert not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'workspace_assets_objects_select_allowlisted'
  ), 'no allowlist-wide listing';
  assert exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'workspace_assets_objects_select_admin'
      and qual like '%is_workspace_admin%'
  ), 'admins list the bucket';
  assert exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'workspace_assets_objects_delete_admin'
      and cmd = 'DELETE' and qual like '%is_workspace_admin%'
  ), 'admins remove old logos';
end $$;

insert into storage.objects (bucket_id, name)
values ('workspace-assets', '00000000-0000-4000-8000-000000000001/logo-old.png');
set role authenticated;
select set_config('request.jwt.claim.sub', 'a11c2411-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
begin
  assert (select count(*) from storage.objects where bucket_id = 'workspace-assets') = 0,
    'a member can''t list logos';
  delete from storage.objects where bucket_id = 'workspace-assets';
end $$;
select set_config('request.jwt.claim.sub', 'a11c2411-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
begin
  assert (select count(*) from storage.objects where bucket_id = 'workspace-assets') = 1,
    'the admin lists the logo, and the member removed nothing';
  delete from storage.objects where bucket_id = 'workspace-assets';
  assert (select count(*) from storage.objects where bucket_id = 'workspace-assets') = 0, 'the admin removes it';
end $$;
reset role;

-- CONTROL: anon's definer surface, search_path, and RLS.
do $$
declare
  anon_defs text;
begin
  select string_agg(p.proname, ',' order by p.proname) into anon_defs
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
    and has_function_privilege('anon', p.oid, 'execute');
  assert anon_defs = 'calendar_feed,email_unsubscribe,get_public_form,receive_inbound_webhook,submit_form',
    'anon executes only the five intended definer functions';
  assert not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and not exists (
        select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg
        where cfg like 'search_path=%'
      )
  ), 'every public security definer function sets search_path';
  assert not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
  ), 'every public table has RLS enabled';
  assert not has_function_privilege('authenticated', 'public.post_submitter_reply(text,text,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.post_submitter_reply(text,text,text,text)', 'execute')
    and has_function_privilege('service_role', 'public.post_submitter_reply(text,text,text,text)', 'execute'),
    'only service_role posts a submitter reply';
  assert not has_function_privilege('anon', 'public.project_task_cards(uuid,uuid[])', 'execute')
    and not has_function_privilege('anon', 'public.my_task_cards()', 'execute')
    and not has_function_privilege('anon', 'public.inbox_page(text)', 'execute'),
    'perf readers are not anon';
end $$;
