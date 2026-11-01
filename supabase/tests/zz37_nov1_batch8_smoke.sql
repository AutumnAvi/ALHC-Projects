-- Nov 1 notes, batch 8 (20261101010000_nov1_batch8_a.sql). One section per part, each with its own people
-- and temporary ids; every section starts as the database owner with no signed-in person.

\set ON_ERROR_STOP 1


-- =================================================================================================
-- Batch 7 leftovers: 47 (select options on insert) and 55 (library copies linked again)
-- =================================================================================================

reset role;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset

insert into public.allowed_emails (email, note) values ('b8-owner@example.com', 'nov 1 batch 8');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('b8b80101-0000-4000-8000-000000000001', 'b8-owner@example.com', now(), '{"full_name":"Bea Owner"}');

create temporary table b8l_ids (name text primary key, id uuid);
grant all on b8l_ids to authenticated, anon;

set role authenticated;
select set_config('request.jwt.claim.sub', 'b8b80101-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  a uuid;
  p uuid;
  f uuid;
  opts jsonb := '[{"id": "o1", "name": "High", "color": "red"}]';
begin
  insert into public.projects (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B8 Fields') returning id into a;
  insert into public.portfolios (workspace_id, name) values ('00000000-0000-4000-8000-000000000001', 'B8 Portfolio') returning id into p;
  insert into b8l_ids values ('a', a), ('p', p);

  -- 47. A person can no longer create a single- or multi-select without options.
  begin
    insert into public.custom_fields (project_id, name, field_type) values (a, 'Pick', 'single_select');
    raise exception 'an option-less single-select insert must be refused';
  exception when check_violation then
    assert sqlerrm like 'Add at least one option to the “Pick” field%', 'says what to do: ' || sqlerrm;
  end;
  begin
    insert into public.custom_fields (project_id, name, field_type, options) values (a, 'Channels', 'multi_select', '[]');
    raise exception 'an option-less multi-select insert must be refused';
  exception when check_violation then null;
  end;
  begin
    insert into public.portfolio_fields (portfolio_id, name, field_type) values (p, 'Phase', 'single_select');
    raise exception 'an option-less portfolio single-select insert must be refused';
  exception when check_violation then
    assert sqlerrm like 'Add at least one option to the “Phase” field%', 'says what to do: ' || sqlerrm;
  end;

  -- With an option it's fine; other types need none.
  insert into public.custom_fields (project_id, name, field_type, options) values (a, 'Priority', 'single_select', opts)
  returning id into f;
  insert into public.custom_fields (project_id, name, field_type) values (a, 'Notes', 'text');
  insert into public.portfolio_fields (portfolio_id, name, field_type, options) values (p, 'Stage', 'single_select', opts);
  insert into public.portfolio_fields (portfolio_id, name, field_type) values (p, 'Spend', 'number');
  insert into b8l_ids values ('f', f);
end $$;

-- System paths (the database owner here, like import_batch and the copy engine) still insert one.
reset role;
do $$
declare
  a uuid := (select id from b8l_ids where name = 'a');
  p uuid := (select id from b8l_ids where name = 'p');
begin
  insert into public.custom_fields (project_id, name, field_type) values (a, 'System pick', 'single_select');
  insert into public.portfolio_fields (portfolio_id, name, field_type) values (p, 'System phase', 'single_select');
end $$;

-- Duplicate project still copies the seeded template's option-less selects (definer copy engine).
set role authenticated;
select set_config('request.jwt.claim.sub', 'b8b80101-0000-4000-8000-000000000001', false) is not null as ok \gset
do $$
declare
  result jsonb;
  created uuid;
begin
  result := public.create_project_from_template('00000000-0000-4000-8000-0000000000c1', 'B8 From template', current_date);
  created := (result ->> 'project_id')::uuid;
  assert (select count(*) from public.custom_fields
          where project_id = created and field_type = 'single_select' and options = '[]'::jsonb) >= 2,
    'the template''s option-less select fields are copied';
end $$;

-- 55. The migration ran link_library_field_copies() once more and left its counts in the comment.
reset role;
do $$
declare
  note text := obj_description('public.link_library_field_copies()'::regprocedure, 'pg_proc');
begin
  assert note like '%Nov 1 batch 8 migration%', 'the counts are recorded: ' || coalesce(note, '(none)');
  assert note like '%"linked"%' and note like '%"ambiguous"%', 'with every count: ' || note;
  -- Running it again changes nothing (idempotent).
  assert (public.link_library_field_copies() ->> 'linked')::int = 0, 'a second run links nothing new';
end $$;

select 'zz37 batch 7 leftovers ok' as result;
