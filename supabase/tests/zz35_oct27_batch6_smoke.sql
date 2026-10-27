-- Oct 27 notes, batch 6 (20261027020000_oct27_batch6_a.sql).
--   b6b60027…01 b6-owner@example.com    owner of B6 A and B6 B
--   b6b60027…02 b6-editor@example.com   Editor of B6 A and B6 B
--   b6b60027…03 b6-viewer@example.com   Viewer of B6 A
--   b6b60027…04 b6-approver@example.com Commenter of B6 A (approver)
--   b6b60027…05 b6-second@example.com   Editor of B6 A (second approver)

\set ON_ERROR_STOP 1

insert into public.allowed_emails (email, note) values
  ('b6-owner@example.com', 'oct 27 batch 6'),
  ('b6-editor@example.com', 'oct 27 batch 6'),
  ('b6-viewer@example.com', 'oct 27 batch 6'),
  ('b6-approver@example.com', 'oct 27 batch 6'),
  ('b6-second@example.com', 'oct 27 batch 6');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b6b60027-0000-4000-8000-000000000001', 'b6-owner@example.com', now(), '{"full_name":"Olive Owner"}'),
  ('b6b60027-0000-4000-8000-000000000002', 'b6-editor@example.com', now(), '{"full_name":"Edna Editor"}'),
  ('b6b60027-0000-4000-8000-000000000003', 'b6-viewer@example.com', now(), '{"full_name":"Vic Viewer"}'),
  ('b6b60027-0000-4000-8000-000000000004', 'b6-approver@example.com', now(), '{"full_name":"Abe Approver"}'),
  ('b6b60027-0000-4000-8000-000000000005', 'b6-second@example.com', now(), '{"full_name":"Sam Second"}');

-- The local harness turns the Commenter role on for older suites; keep it on here too.
update public.workspaces set allow_commenter_role = true where id = '00000000-0000-4000-8000-000000000001';

create temporary table b6_ids (name text primary key, id uuid);
grant all on b6_ids to authenticated, anon;

-- ---------------------------------------------------------------------------------------------
-- Setup: B6 A (numbered "A-{n}", reuses freed numbers) and B6 B (numbered "B-{n}")
-- ---------------------------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claim.sub', 'b6b60027-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  a uuid;
  b uuid;
  sa uuid;
  sa2 uuid;
  sb uuid;
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B6 A') returning id into a;
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B6 B') returning id into b;
  insert into public.sections (project_id, name, sort_order) values (a, 'Intake', 1024) returning id into sa;
  insert into public.sections (project_id, name, sort_order) values (a, 'Done', 2048) returning id into sa2;
  insert into public.sections (project_id, name, sort_order) values (b, 'Inbox', 1024) returning id into sb;
  insert into b6_ids values ('a', a), ('b', b), ('sa', sa), ('sa2', sa2), ('sb', sb);
  perform public.add_project_member(a, 'b6-editor@example.com', 'editor');
  perform public.add_project_member(b, 'b6-editor@example.com', 'editor');
  perform public.add_project_member(a, 'b6-viewer@example.com', 'viewer');
  perform public.add_project_member(a, 'b6-approver@example.com', 'commenter');
  perform public.add_project_member(a, 'b6-second@example.com', 'editor');
  perform public.apply_task_numbering(a,
    '{"enabled": true, "number_scope": "all_tasks", "template": "A-{n}", "reuse_deleted": true}'::jsonb, 'save');
  perform public.apply_task_numbering(b,
    '{"enabled": true, "number_scope": "all_tasks", "template": "B-{n}"}'::jsonb, 'save');
end $$;

-- ---------------------------------------------------------------------------------------------
-- 40. Adding a subtask in a project that reuses freed numbers (it used to fail with
--     'column reference "number" is ambiguous'), and the freed subtask index is reused.
-- ---------------------------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b6b60027-0000-4000-8000-000000000002', false) is not null as ok \gset
do $$
declare
  a uuid := (select id from b6_ids where name = 'a');
  t uuid;
  c1 uuid;
  c2 uuid;
  c3 uuid;
begin
  assert (select reuse_deleted from public.request_sequences where project_id = a), 'reuse is on';
  t := public.create_task(a, (select id from b6_ids where name = 'sa'), 'Parent 40');
  insert into b6_ids values ('t40', t);
  assert (select req_label from public.tasks where id = t) = 'A-1', 'parent numbered';
  c1 := public.create_subtask(t, 'First child', null);
  c2 := public.create_subtask(t, 'Second child', null);
  assert (select req_label from public.tasks where id = c1) = 'A-1.1', 'first child numbered';
  assert (select req_label from public.tasks where id = c2) = 'A-1.2', 'second child numbered';
  -- Trash the first; its index is freed and the next subtask takes it.
  update public.tasks set deleted_at = now() where id = c1;
  c3 := public.create_subtask(t, 'Third child', null);
  assert (select req_subindex from public.tasks where id = c3) = 1, 'the freed index is reused';
  assert (select req_label from public.tasks where id = c3) = 'A-1.1', 'labelled with it';
  -- A sub-subtask too.
  c1 := public.create_subtask(c3, 'Grandchild', null);
  assert (select req_label from public.tasks where id = c1) = 'A-1.1.1', 'nested subtasks number as well';
end $$;
reset role;
