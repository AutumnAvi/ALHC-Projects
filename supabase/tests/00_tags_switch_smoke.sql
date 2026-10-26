-- Test harness step (runs before every other suite): the suites written before
-- 20261026010000_oct26_batch3_a.sql use tags freely (search by tag name among them). That migration added
-- workspaces.tags_enabled, off by default, which stops search matching tag names; turn it on here so
-- those suites keep testing what they were written for. zz32_oct26_batch3_smoke.sql turns it off and
-- checks the switch.

\set ON_ERROR_STOP 1

update public.workspaces set tags_enabled = true;

do $$
begin
  assert (select bool_and(tags_enabled) from public.workspaces), 'tags on for the older suites';
  raise notice 'tags switch: on for the older suites';
end $$;
