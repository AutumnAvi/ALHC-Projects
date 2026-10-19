-- Extra rows on top of scripts/perf/seed.sql (run it after seed.sql) so the pane's subtask path can be timed:
-- 3 subtasks under each of tasks 2..21, a Priority field with values on tasks 1..200.
\set ON_ERROR_STOP 1
set role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', false);
do $$
declare
  i int;
  j int;
  parent uuid;
begin
  for i in 2..21 loop
    parent := ('c1000000-0000-4000-8000-' || lpad(to_hex(i), 12, '0'))::uuid;
    for j in 1..3 loop
      perform public.create_subtask(parent, 'Task ' || i || ' step ' || j, null);
    end loop;
  end loop;
end $$;
reset role;
insert into public.custom_fields (id, project_id, name, field_type, options, show_in_views)
values ('f1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'Priority', 'single_select',
  '[{"id":"hi","name":"High","color":"red"},{"id":"lo","name":"Low","color":"blue"}]', true);
alter table public.task_field_values disable trigger user;
insert into public.task_field_values (task_id, field_id, value)
select ('c1000000-0000-4000-8000-' || lpad(to_hex(i), 12, '0'))::uuid, 'f1000000-0000-4000-8000-000000000001',
  case when i % 2 = 0 then '"hi"'::jsonb else '"lo"'::jsonb end
from generate_series(1, 200) as i;
alter table public.task_field_values enable trigger user;
analyze public.tasks;
