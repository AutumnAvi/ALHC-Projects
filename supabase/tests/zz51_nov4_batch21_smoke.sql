-- Nov 4 notes, batch 21 (20261104020000_nov4_batch21_a.sql): every foreign key of an ALHC table has a
-- covering index by the Supabase advisor's rule (lint 0001 unindexed_foreign_keys: a valid index whose
-- leading columns are exactly the key's columns, in order). A new table or foreign key without one fails
-- here, so the advisor stays quiet about ALHC.
do $$
declare
  missing text;
begin
  select string_agg(format('%s.%s', cl.relname, ct.conname), ', ' order by cl.relname, ct.conname)
    into missing
    from pg_catalog.pg_constraint ct
    join pg_catalog.pg_class cl on cl.oid = ct.conrelid
    where ct.contype = 'f'
      and cl.relnamespace = 'public'::regnamespace
      and not exists (
        select 1
        from pg_catalog.pg_index pi
        where pi.indrelid = ct.conrelid
          and pi.indisvalid
          and (string_to_array(pi.indkey::text, ' ')::smallint[])[1:array_length(ct.conkey, 1)] = ct.conkey
      );
  if missing is not null then
    raise exception 'foreign keys without a covering index: %', missing;
  end if;
end
$$;

-- The migration's block adds nothing on a database that is already covered, and running it again is safe.
do $$
begin
  if exists (select 1 from pg_catalog.pg_class where relname like 'alhc_fk\_%' and relkind = 'i') then
    raise exception 'nov4_batch21_a added an index locally, so a migration in this repository left a foreign key uncovered';
  end if;
end
$$;

select 'zz51_nov4_batch21_smoke: ok';
