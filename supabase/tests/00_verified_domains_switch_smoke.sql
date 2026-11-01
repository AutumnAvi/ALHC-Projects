-- Test harness step (runs before every other suite): the suites written before
-- 20261101020000_nov1_batch9a_a.sql send responses to form submitters at example.org / example.net
-- addresses. That migration added workspaces.verified_domain_conversations, on by default, which keeps
-- the reply-by-email conversation to submitters on a verified domain (autumnhc.net,
-- autumnlakemarketing.com); turn it off here so those suites keep testing what they were written for.
-- zz38_nov1_batch9a_smoke.sql turns it back on and checks the switch.

\set ON_ERROR_STOP 1

update public.workspaces set verified_domain_conversations = false;

do $$
begin
  assert not (select bool_or(verified_domain_conversations) from public.workspaces),
    'verified-domain conversations off for the older suites';
  raise notice 'verified domains switch: off for the older suites';
end $$;
