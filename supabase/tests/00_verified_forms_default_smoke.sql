-- Test harness step (runs before every other suite): the suites written before
-- 20261111010000_nov11_batch38_a.sql make forms without naming verified_domains_only and submit them
-- from example.org / example.net addresses. That migration made new forms verified-domain only by
-- default (note 192); put the old default back here so those suites keep testing what they were written
-- for. The migration's default is kept in harness.settings, and zz58_nov11_batch38_smoke.sql checks it
-- and restores it.

\set ON_ERROR_STOP 1

create schema if not exists harness;
create table if not exists harness.settings (name text primary key, value text);
insert into harness.settings (name, value)
select 'forms.verified_domains_only.default', column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'forms' and column_name = 'verified_domains_only'
on conflict (name) do nothing;

alter table public.forms alter column verified_domains_only set default false;

do $$
begin
  raise notice 'new forms default: verified_domains_only off for the older suites (migration default %)',
    (select value from harness.settings where name = 'forms.verified_domains_only.default');
end $$;
