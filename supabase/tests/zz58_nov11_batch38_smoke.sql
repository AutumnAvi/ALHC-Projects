-- Nov 11 batch 38 (20261111010000_nov11_batch38_a.sql): comment text edits only for 15 minutes after
-- posting (note 189), and new forms start with verified-domain submitters only (note 192).
--   a3100380…01 b38-owner@example.com   Bo Owner    (owns P)
--   a3100380…02 b38-editor@example.com  Ed Editor   (Editor of P, writes the comments)

\set ON_ERROR_STOP 1

create temporary table b38_ids (name text primary key, id uuid) on commit preserve rows;
grant all on b38_ids to authenticated, anon, service_role;

insert into public.allowed_emails (email, note) values
  ('b38-owner@example.com', 'batch 38'), ('b38-editor@example.com', 'batch 38');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a3100380-0000-4000-8000-000000000001', 'b38-owner@example.com', now(), '{"full_name":"Bo Owner"}'),
  ('a3100380-0000-4000-8000-000000000002', 'b38-editor@example.com', now(), '{"full_name":"Ed Editor"}');

-- 0. The migration's column default (00_verified_forms_default_smoke.sql set it back to off for the older
--    suites and kept it), and the guard is still the caller's (invoker) and not anon's.
do $$
begin
  assert (select value from harness.settings where name = 'forms.verified_domains_only.default') = 'true',
    'the migration makes new forms verified-domain only';
end $$;
alter table public.forms alter column verified_domains_only set default true;
do $$
begin
  assert (select column_default from information_schema.columns
          where table_schema = 'public' and table_name = 'forms' and column_name = 'verified_domains_only') = 'true',
    'new forms default to verified-domain submitters only';
  assert not (select prosecdef from pg_proc where oid = 'public.guard_comment_update()'::regprocedure), 'invoker';
  assert not has_function_privilege('anon', 'public.guard_comment_update()', 'execute'), 'anon doesn''t';
  assert pg_get_functiondef('public.guard_comment_update()'::regprocedure) like '%interval ''15 minutes''%',
    'the window is in the guard';
end $$;

-- A project with a task; Ed posts two comments.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100380-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid;
  s uuid;
  t uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B38 Requests') returning id into p;
  insert into public.sections (project_id, name) values (p, 'Doing') returning id into s;
  perform public.add_project_member(p, 'b38-editor@example.com', 'editor');
  t := public.create_task(p, s, 'B38 task');
  insert into b38_ids values ('p', p), ('s', s), ('t', t);
end $$;

select set_config('request.jwt.claim.sub', 'a3100380-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  fresh uuid;
  old uuid;
begin
  insert into public.comments (task_id, body) values ((select id from b38_ids where name = 't'), 'Fresh comment')
  returning id into fresh;
  insert into public.comments (task_id, body) values ((select id from b38_ids where name = 't'), 'Old comment')
  returning id into old;
  insert into b38_ids values ('fresh', fresh), ('old', old);
end $$;

-- 1. Inside the window the author edits the text (edited_at stamped).
do $$
begin
  update public.comments set body = 'Fresh comment, edited' where id = (select id from b38_ids where name = 'fresh');
  assert (select body from public.comments where id = (select id from b38_ids where name = 'fresh')) = 'Fresh comment, edited',
    'an edit inside 15 minutes works';
  assert (select edited_at is not null from public.comments where id = (select id from b38_ids where name = 'fresh')),
    'edited_at is stamped';
end $$;

-- 2. The other comment was posted 16 minutes ago (set by the owner role, which the guard doesn't check).
reset role;
update public.comments set created_at = now() - interval '16 minutes' where id = (select id from b38_ids where name = 'old');
-- Exactly 14 minutes ago still edits.
update public.comments set created_at = now() - interval '14 minutes' where id = (select id from b38_ids where name = 'fresh');
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100380-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  refused boolean := false;
  message text;
begin
  update public.comments set body = 'Still in time' where id = (select id from b38_ids where name = 'fresh');
  assert (select body from public.comments where id = (select id from b38_ids where name = 'fresh')) = 'Still in time',
    '14 minutes after posting still edits';
  begin
    update public.comments set body = 'Too late' where id = (select id from b38_ids where name = 'old');
  exception when check_violation then
    refused := true;
    get stacked diagnostics message = message_text;
  end;
  assert refused, 'an edit after 15 minutes is refused';
  assert message = 'Comments can only be edited for 15 minutes', 'with a plain message: ' || coalesce(message, '');
  assert (select body from public.comments where id = (select id from b38_ids where name = 'old')) = 'Old comment',
    'the text is unchanged';
end $$;

-- 3. Removing an old comment still works (no time limit), and the text is scrubbed as before.
do $$
begin
  update public.comments set deleted_at = now() where id = (select id from b38_ids where name = 'old');
  assert (select deleted_at is not null from public.comments where id = (select id from b38_ids where name = 'old')),
    'an old comment can still be removed';
end $$;

-- 4. System code (no client role) still changes old comments' text, e.g. the scrub or a rule.
reset role;
do $$
begin
  update public.comments set created_at = now() - interval '1 day' where id = (select id from b38_ids where name = 'fresh');
  update public.comments set body = 'System rewrite' where id = (select id from b38_ids where name = 'fresh');
  assert (select body from public.comments where id = (select id from b38_ids where name = 'fresh')) = 'System rewrite',
    'definer / owner code is not limited';
end $$;

-- 5. Forms: a form made without naming the flag starts on; one that names off keeps it; the editor can
--    turn it off.
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100380-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  f_on uuid;
  f_off uuid;
begin
  insert into public.forms (project_id, title, questions)
  values ((select id from b38_ids where name = 'p'), 'B38 default', '[]'::jsonb) returning id into f_on;
  insert into public.forms (project_id, title, questions, verified_domains_only)
  values ((select id from b38_ids where name = 'p'), 'B38 open', '[]'::jsonb, false) returning id into f_off;
  insert into b38_ids values ('f_on', f_on), ('f_off', f_off);
  assert (select verified_domains_only from public.forms where id = f_on), 'a new form is verified-domains only';
  assert not (select verified_domains_only from public.forms where id = f_off), 'an explicit off stays off';
end $$;

-- 6. Duplicate project carries each form's flag.
select set_config('request.jwt.claim.sub', 'a3100380-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  result jsonb;
  copy uuid;
begin
  result := public.duplicate_project((select id from b38_ids where name = 'p'), 'B38 copy', '{"forms": true}'::jsonb);
  copy := (result ->> 'project_id')::uuid;
  assert (select verified_domains_only from public.forms where project_id = copy and title = 'B38 default'),
    'an on form stays on in the copy';
  assert not (select verified_domains_only from public.forms where project_id = copy and title = 'B38 open'),
    'an off form stays off in the copy';
end $$;

-- 7. A template saved before this release (its snapshot has no flag) makes forms that start on.
do $$
declare
  tmpl uuid;
  made jsonb;
  copy uuid;
begin
  tmpl := public.save_project_as_template((select id from b38_ids where name = 'p'), 'B38 template', null, null, null);
  insert into b38_ids values ('tmpl', tmpl);
end $$;
reset role;
update public.project_templates
set content = jsonb_set(content, '{forms}', (
  select coalesce(jsonb_agg(f - 'verified_domains_only'), '[]'::jsonb) from jsonb_array_elements(content -> 'forms') f
))
where id = (select id from b38_ids where name = 'tmpl');
set role authenticated;
select set_config('request.jwt.claim.sub', 'a3100380-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  made jsonb;
  copy uuid;
begin
  made := public.create_project_from_template((select id from b38_ids where name = 'tmpl'), 'B38 from template', current_date);
  copy := (made ->> 'project_id')::uuid;
  assert (select count(*) from public.forms where project_id = copy) = 2, 'both forms are copied';
  assert (select bool_and(verified_domains_only) from public.forms where project_id = copy),
    'forms from an old snapshot start on';
end $$;

reset role;
select 'zz58_nov11_batch38_smoke passed' as result;
