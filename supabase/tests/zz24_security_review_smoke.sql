-- Security review pass 1 evidence (read-only audit). These checks record what the local
-- database does today. Sections marked FINDING are gaps; sections marked CONTROL are boundaries
-- that hold. Nothing here is a fix.
--
-- People:
--   a11c2411-…01 sec24-owner@example.com     allowlisted project owner
--   a11c2411-…02 sec24-stranger@example.com  allowlisted, not a member until added as Viewer
--   a11c2411-…03 sec24-unlisted@example.com  confirmed account, not on the allowlist

\set ON_ERROR_STOP 1

create temporary table sec_ids (name text primary key, id uuid) on commit preserve rows;
grant all on sec_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('sec24-owner@example.com', 'security review pass 1'),
  ('sec24-stranger@example.com', 'security review pass 1');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a11c2411-0000-4000-8000-000000000001', 'sec24-owner@example.com', now(), '{"full_name":"Sec Owner"}'),
  ('a11c2411-0000-4000-8000-000000000002', 'sec24-stranger@example.com', now(), '{"full_name":"Sec Stranger"}'),
  ('a11c2411-0000-4000-8000-000000000003', 'sec24-unlisted@example.com', now(), '{"full_name":"Sec Unlisted"}');

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
  update public.comments set deleted_at = now() where id = c;
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Budget', 'text') returning id into f;
  insert into public.rules (project_id, name, trigger_type, actions)
  values (p, 'Quiet', 'task_created', '[{"type": "add_comment", "body": "should never run"}]')
  returning id into r;
  insert into sec_ids values ('p', p), ('task', t), ('comment', c), ('field', f), ('rule', r);
end $$;
reset role;

-- Clients cannot write request numbers. Stamp one as the migration owner so the label helpers
-- have something to leak.
update public.request_sequences
set enabled = true, prefix = 'SECRET-', pad_width = 4, last_number = greatest(last_number, 41)
where project_id = (select id from sec_ids where name = 'p');
insert into public.request_sequences (project_id, enabled, prefix, pad_width, last_number)
select id, true, 'SECRET-', 4, 41 from sec_ids where name = 'p'
on conflict (project_id) do nothing;
update public.tasks
set req_project_id = (select id from sec_ids where name = 'p'), req_number = 41
where id = (select id from sec_ids where name = 'task');

-- The comment guard refuses email columns from a client. Replica mode skips it so the page
-- function can be shown returning them after a soft delete.
set session_replication_role = replica;
update public.comments
set email_direction = 'sent', email_address = 'submitter@secret.example', email_subject = 'Re: secret'
where id = (select id from sec_ids where name = 'comment');
set session_replication_role = default;

-- FINDING: request label and id helpers ignore membership and the allowlist.
set role authenticated;
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
  assert (select count(*) from public.custom_fields where id = field) = 0, 'RLS hides the field';
  assert (select count(*) from public.rules where id = rule) = 0, 'RLS hides the rule';
  assert (select count(*) from public.request_sequences where project_id = project) = 0,
    'RLS hides the request sequence';
  assert public.task_request_label(task) = 'SECRET-0041',
    'FINDING: task_request_label returns the label with no access check';
  assert public.format_request_label(project, 99) = 'SECRET-0099',
    'FINDING: format_request_label reads another project''s prefix';
  assert public.custom_field_project(field) = project,
    'FINDING: custom_field_project maps a field id to its project';
  assert public.rule_project(rule) = project,
    'FINDING: rule_project maps a rule id to its project';
end $$;

-- FINDING: a task viewer still receives a soft-deleted comment body from the table.
-- The page function blanks the body and still returns the submitter address and subject.
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
  assert (select body from public.comments where task_id = task) = 'please delete this secret body',
    'FINDING: comments select returns a soft-deleted body to a task viewer';
  page := public.task_comment_page(task);
  assert page -> 'comments' -> 0 ->> 'body' = '',
    'task_comment_page blanks a deleted body';
  assert page -> 'comments' -> 0 ->> 'email_address' = 'submitter@secret.example',
    'FINDING: task_comment_page still returns the deleted comment''s email address';
  assert page -> 'comments' -> 0 ->> 'email_subject' = 'Re: secret',
    'FINDING: task_comment_page still returns the deleted comment''s subject';
end $$;

-- CONTROL: perf readers and the story log do not open the project to a non-member.
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

-- FINDING: webhook URL check blocks IP literals, not names that resolve to them.
do $$
begin
  assert not public.integration_url_ok('https://169.254.169.254/latest/meta-data/'), 'link-local literal blocked';
  assert not public.integration_url_ok('https://127.0.0.1/'), 'loopback literal blocked';
  assert not public.integration_url_ok('https://10.1.2.3/'), 'rfc1918 literal blocked';
  assert not public.integration_url_ok('http://example.com/hook'), 'plain http blocked';
  assert not public.integration_url_ok('https://metadata.google.internal/'), '.internal host blocked';
  assert not public.integration_url_ok('https://169.254.169.254.nip.io/'), 'IP-prefixed nip.io host blocked';
  assert public.integration_url_ok('https://a.169.254.169.254.nip.io/latest'),
    'FINDING: a label in front of a link-local nip.io name is accepted';
  assert public.integration_url_ok('https://customer.localtest.me/hook'),
    'FINDING: localtest.me (loopback DNS) is accepted';
  assert public.integration_url_ok('https://100.64.0.1/'),
    'FINDING: CGNAT 100.64.0.0/10 literal is accepted';
end $$;

-- FINDING: TRUNCATE is granted and is not covered by RLS. Roll back so the suite stays put.
do $$
begin
  assert has_table_privilege('authenticated', 'public.task_stories', 'TRUNCATE'),
    'FINDING: authenticated can TRUNCATE task_stories';
  assert has_table_privilege('authenticated', 'public.comments', 'TRUNCATE'),
    'FINDING: authenticated can TRUNCATE comments';
  assert has_table_privilege('authenticated', 'public.allowed_emails', 'INSERT'),
    'FINDING: authenticated still holds INSERT on allowed_emails (RLS blocks the statement)';
  assert has_table_privilege('anon', 'storage.objects', 'TRUNCATE'),
    'FINDING: anon can TRUNCATE storage.objects';
  assert (select public from storage.buckets where id = 'workspace-assets'),
    'FINDING: workspace-assets bucket is public';
end $$;

begin;
set role authenticated;
truncate public.rule_presets;
rollback;

-- CONTROL: anon's definer surface, search_path, and RLS.
reset role;
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
