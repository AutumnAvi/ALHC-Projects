-- Nov 1 notes, batch 8, item 63 (20261101010300_nov1_batch8_review.sql): each file of a review round is
-- approved or has feedback, the answer is derived, and the database holds that.
--   b8r0001…01 b8r-owner@example.com   owner of B8R P

\set ON_ERROR_STOP 1

insert into public.allowed_emails (email, note) values ('b8r-owner@example.com', 'nov 1 batch 8 review');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b8b80001-0000-4000-8000-000000000001', 'b8r-owner@example.com', now(), '{"full_name":"Rhea Owner"}');

create temporary table b8r_ids (name text primary key, id uuid);
grant all on b8r_ids to authenticated, anon;
create temporary table b8r_tokens (name text primary key, token text);
grant all on b8r_tokens to authenticated, anon;

-- ---------------------------------------------------------------------------------------------
-- Grants and signatures (nothing new for clients)
-- ---------------------------------------------------------------------------------------------

do $$
begin
  assert has_function_privilege('anon', 'public.review_check_save(text, jsonb, boolean)', 'execute'), 'save keeps its grant';
  assert has_function_privilege('anon', 'public.review_check_decide(text, text, text, jsonb)', 'execute'), 'decide keeps its grant';
  assert has_function_privilege('anon', 'public.review_check_view(text)', 'execute'), 'view keeps its grant';
  assert (select count(*) from pg_proc where proname = 'review_check_decide' and pronamespace = 'public'::regnamespace) = 1,
    'no second review_check_decide';
  assert (select count(*) from pg_proc where proname = 'review_check_save' and pronamespace = 'public'::regnamespace) = 1,
    'no second review_check_save';
  assert not has_function_privilege('anon', 'public.review_check_file_outcomes(public.review_checks, jsonb)', 'execute'), 'internal';
  assert not has_function_privilege('authenticated', 'public.review_check_file_outcomes(public.review_checks, jsonb)', 'execute'), 'internal';
  assert not (select prosecdef from pg_proc where oid = 'public.review_check_file_outcomes(public.review_checks, jsonb)'::regprocedure),
    'invoker (only called inside review_check_decide)';
  assert has_column_privilege('authenticated', 'public.review_checks', 'file_results', 'SELECT'), 'the team reads the outcome';
  assert not has_column_privilege('authenticated', 'public.review_checks', 'file_results', 'UPDATE'), 'nobody writes it';
  assert not has_column_privilege('anon', 'public.review_checks', 'file_results', 'SELECT'), 'nothing for anon';
end $$;

-- ---------------------------------------------------------------------------------------------
-- A task with three files, a round of all three
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b8b80001-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  p uuid;
  s uuid;
  t uuid;
  t2 uuid;
  result jsonb;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B8R P') returning id into p;
  insert into public.sections (project_id, name, sort_order) values (p, 'Intake', 1024) returning id into s;
  t := public.create_task(p, s, 'Spring flyer');
  t2 := public.create_task(p, s, 'Old-style review');
  insert into b8r_ids values ('p', p), ('t', t), ('t2', t2);
  insert into public.task_attachments (task_id, storage_path, file_name, content_type, size_bytes)
    values (t, t::text || '/one-logo.png', 'logo.png', 'image/png', 10),
           (t, t::text || '/two-flyer.pdf', 'flyer.pdf', 'application/pdf', 10),
           (t, t::text || '/three-poster.png', 'poster.png', 'image/png', 10),
           (t2, t2::text || '/four-banner.png', 'banner.png', 'image/png', 10);
  result := public.create_review_check(
    t,
    array(select id from public.task_attachments where task_id = t order by file_name desc),
    'reviewer@example.org', 'Rae'
  );
  insert into b8r_tokens values ('r1', result ->> 'token');
  insert into b8r_ids values ('r1', (result ->> 'id')::uuid);
  result := public.create_review_check(
    t2, array(select id from public.task_attachments where task_id = t2), 'other@example.org', 'Otto'
  );
  insert into b8r_tokens values ('old', result ->> 'token');
end $$;

reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
declare
  token text := (select token from b8r_tokens where name = 'r1');
  view jsonb := public.review_check_view(token);
  a1 uuid := (select (a ->> 'id')::uuid from jsonb_array_elements(view -> 'assets') a where a ->> 'name' = 'logo.png');
  a2 uuid := (select (a ->> 'id')::uuid from jsonb_array_elements(view -> 'assets') a where a ->> 'name' = 'flyer.pdf');
  a3 uuid := (select (a ->> 'id')::uuid from jsonb_array_elements(view -> 'assets') a where a ->> 'name' = 'poster.png');
  result jsonb;
  saved jsonb;
  pin jsonb;
begin
  assert jsonb_array_length(view -> 'assets') = 3, 'three files';
  assert view -> 'file_results' = 'null'::jsonb, 'nothing answered yet';

  -- The draft keeps each file's state (once per file, only this round's files, only real states).
  saved := public.review_check_save(token, jsonb_build_object(
    'pins', '[]'::jsonb, 'note', '', 'decision', null, 'active_asset', a1, 'per_file', true,
    'files', jsonb_build_array(
      jsonb_build_object('asset_id', a1, 'approved', false, 'note', ''),
      jsonb_build_object('asset_id', a1, 'approved', true, 'note', ''),
      jsonb_build_object('asset_id', a2, 'approved', false, 'note', 'Too dark'),
      jsonb_build_object('asset_id', a3, 'approved', false, 'note', ''),
      jsonb_build_object('asset_id', gen_random_uuid(), 'approved', true),
      jsonb_build_object('asset_id', a3, 'approved', 'yes')
    )
  ));
  assert saved ->> 'status' = 'ok', format('saved %s', saved);
  view := public.review_check_view(token);
  assert (view -> 'draft' ->> 'per_file')::boolean, 'per file';
  assert jsonb_array_length(view -> 'draft' -> 'files') = 2, format('a1 approved, a2 noted, nothing else: %s', view -> 'draft' -> 'files');
  assert exists (select 1 from jsonb_array_elements(view -> 'draft' -> 'files') f
                 where f ->> 'asset_id' = a1::text and (f ->> 'approved')::boolean), 'the last state of a file wins';
  assert exists (select 1 from jsonb_array_elements(view -> 'draft' -> 'files') f
                 where f ->> 'asset_id' = a2::text and f ->> 'note' = 'Too dark' and not (f ->> 'approved')::boolean), 'a file''s note';
  assert public.review_check_save(token, jsonb_build_object('per_file', true, 'files', '"x"'::jsonb)) ->> 'status' = 'invalid',
    'files is a list';

  -- Not every file reviewed (a3): refused, whatever the answer.
  pin := jsonb_build_object('asset_id', a2, 'x', 0.5, 'y', 0.5, 'body', 'Lighter, please');
  assert public.review_check_decide(token, 'changes_requested', null, jsonb_build_array(pin)) ->> 'status' = 'unreviewed',
    'a file with neither';
  assert public.review_check_decide(token, 'approved', null, '[]'::jsonb) ->> 'status' = 'unreviewed', 'approving too';

  -- Every file reviewed, but the answer isn't the derived one.
  saved := public.review_check_save(token, jsonb_build_object(
    'pins', jsonb_build_array(pin), 'note', '', 'active_asset', a3, 'per_file', true,
    'files', jsonb_build_array(
      jsonb_build_object('asset_id', a1, 'approved', true, 'note', ''),
      jsonb_build_object('asset_id', a2, 'approved', false, 'note', 'Too dark'),
      jsonb_build_object('asset_id', a3, 'approved', true, 'note', '')
    )
  ));
  assert saved ->> 'status' = 'ok', 'saved again';
  assert public.review_check_decide(token, 'approved', null, jsonb_build_array(pin)) ->> 'status' = 'mismatch',
    'feedback on a file asks for changes';
  -- A pin alone is feedback (its file needs no note), and a file's note alone is feedback too.
  saved := public.review_check_decide(token, 'changes_requested', 'Close!', jsonb_build_array(pin, pin));
  assert saved ->> 'status' = 'ok', format('decided %s', saved);

  view := public.review_check_view(token);
  assert view -> 'draft' = 'null'::jsonb, 'the draft is cleared';
  assert jsonb_array_length(view -> 'file_results') = 3, format('each file''s outcome: %s', view -> 'file_results');
  assert view -> 'file_results' -> 0 ->> 'name' = 'poster.png', 'in the round''s order';
  select r into result from jsonb_array_elements(view -> 'file_results') r where r ->> 'asset_id' = a1::text;
  assert (result ->> 'approved')::boolean and (result ->> 'pins')::int = 0 and result -> 'note' = 'null'::jsonb, format('logo %s', result);
  select r into result from jsonb_array_elements(view -> 'file_results') r where r ->> 'asset_id' = a2::text;
  assert result ->> 'note' = 'Too dark' and (result ->> 'pins')::int = 2, format('flyer: note + 2 pins %s', result);
  select r into result from jsonb_array_elements(view -> 'file_results') r where r ->> 'asset_id' = a3::text;
  assert (result ->> 'approved')::boolean, 'poster approved';
end $$;

reset role;
do $$
declare
  c record;
begin
  select body, email_subject into c from public.comments where review_check_id = (select id from b8r_ids where name = 'r1');
  assert c.email_subject = 'Review round 1: Changes requested', format('subject %s', c.email_subject);
  assert c.body like 'Requested changes (round 1)' || E'\n\n' || 'Close!' || E'\n\n' || 'Files:%', format('body %s', c.body);
  assert position(E'- poster.png — Approved\n' in c.body) > 0, format('poster line in %s', c.body);
  assert position(E'- logo.png — Approved\n' in c.body) > 0, 'logo line';
  assert position('- flyer.pdf — Changes requested: 2 comments. Note: Too dark' in c.body) > 0, format('flyer line in %s', c.body);
  assert position(E'Feedback:\n1. flyer.pdf: Lighter, please' in c.body) > 0, 'the pins are listed as before';
  assert (select file_results is not null from public.review_checks where id = (select id from b8r_ids where name = 'r1')), 'kept';
end $$;

-- An all-approved round approves; asking for changes then is a mismatch.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b8b80001-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  t uuid := (select id from b8r_ids where name = 't');
  result jsonb;
begin
  result := public.create_review_check(t, array(select id from public.task_attachments where task_id = t and file_name <> 'flyer.pdf'),
    'reviewer@example.org', 'Rae');
  insert into b8r_tokens values ('r2', result ->> 'token');
  insert into b8r_ids values ('r2', (result ->> 'id')::uuid);
end $$;
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
declare
  token text := (select token from b8r_tokens where name = 'r2');
  view jsonb := public.review_check_view(token);
  files jsonb;
  saved jsonb;
begin
  assert jsonb_array_length(view -> 'previous' -> 'file_results') = 3, format('the previous round''s outcomes: %s', view -> 'previous');
  select jsonb_agg(jsonb_build_object('asset_id', a ->> 'id', 'approved', true, 'note', '')) into files
  from jsonb_array_elements(view -> 'assets') a;
  assert public.review_check_save(token, jsonb_build_object('per_file', true, 'files', files)) ->> 'status' = 'ok', 'all approved';
  assert public.review_check_decide(token, 'changes_requested', 'hmm', '[]'::jsonb) ->> 'status' = 'mismatch',
    'nothing to change means approve';
  saved := public.review_check_decide(token, 'approved', 'Lovely', '[]'::jsonb);
  assert saved ->> 'status' = 'ok', format('approved %s', saved);
  assert public.review_check_view(token) ->> 'status' = 'ok', 'still opens';
end $$;
reset role;
do $$
declare
  body text := (select c.body from public.comments c where c.review_check_id = (select id from b8r_ids where name = 'r2'));
begin
  assert body like 'Approved (round 2)' || E'\n\nLovely\n\nFiles:\n- %', format('approved body %s', body);
  assert position('Changes requested' in body) = 0, 'every file approved';
end $$;

-- A round answered the old way (the release on main: no per_file in the draft) works as before.
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset
do $$
declare
  token text := (select token from b8r_tokens where name = 'old');
  asset uuid := (public.review_check_view(token) -> 'assets' -> 0 ->> 'id')::uuid;
begin
  assert public.review_check_save(token, jsonb_build_object('note', 'x', 'decision', 'approved', 'active_asset', asset)) ->> 'status' = 'ok',
    'an old-style save';
  assert not (public.review_check_view(token) -> 'draft' ? 'per_file'), 'no per-file state';
  assert public.review_check_decide(token, 'changes_requested', null, '[]'::jsonb) ->> 'status' = 'empty', 'the old rule';
  assert public.review_check_decide(token, 'approved', null, '[]'::jsonb) ->> 'status' = 'ok', 'approves without per-file states';
  assert public.review_check_view(token) -> 'file_results' = 'null'::jsonb, 'no outcomes kept';
end $$;
reset role;
do $$
begin
  assert (select c.body from public.comments c join public.review_checks r on r.id = c.review_check_id
          where r.recipient_email = 'other@example.org') = 'Approved (round 1)', 'the comment is unchanged';
end $$;

do $$ begin raise notice 'nov 1 batch 8 review smoke: all assertions passed'; end $$;
