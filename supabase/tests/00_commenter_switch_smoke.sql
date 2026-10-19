-- Test harness step (runs before every other suite): the suites written before
-- 20261019010000_email_designs.sql add Commenters freely. That migration added
-- workspaces.allow_commenter_role, off by default, which refuses new Commenters; turn it on here so
-- those suites keep testing what they were written for. zz27_email_designs_smoke.sql turns it off
-- and checks the switch.

\set ON_ERROR_STOP 1

update public.workspaces set allow_commenter_role = true;

do $$
begin
  assert (select bool_and(allow_commenter_role) from public.workspaces), 'Commenter allowed for the older suites';
  raise notice 'commenter switch: on for the older suites';
end $$;
