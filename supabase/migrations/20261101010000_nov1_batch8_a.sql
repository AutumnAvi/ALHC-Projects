-- Nov 1 notes, batch 8 (items 56, 58–63, Forgot password for 57, and two Oct 29 batch 7 leftovers).
-- Additive, no tail: no row or object removal anywhere in this file. Ordered for a chunked apply: new
-- columns first, every function before its callers, guards after the paths they rely on, and the
-- one-time linking of library copies last.
--
-- What the database gains (the app does the rest):
--   * 47 (batch 7 leftover): select fields need at least one option on insert too (BEFORE INSERT
--     triggers on custom_fields and portfolio_fields, same function and same rules as the update
--     check: people's writes only; imports, the copy engine, and library code are unchanged).
--   * 55 (batch 7 leftover): link_library_field_copies() runs once more at the very end (it skips fields
--     already linked, so it only picks up clear copies made since batch 7) and records its counts in the
--     function's comment, so they can be read back after the apply.

-- =================================================================================================
-- 47. Select fields need at least one option: inserts too.
--
-- Batch 7 added guard_select_field_options() as BEFORE UPDATE triggers only, because the release then on
-- main created portfolio single-selects with no options and added them afterwards. Every release since
-- batch 7 creates a select with its options in the same insert (createField / createPortfolioField
-- refuse an option-less select), so the insert check can go on now. The function already refuses an
-- option-less insert for a client role (tg_op = 'INSERT' never matches its update exemption); definer
-- code (import_batch, the copy engine incl. the seeded Creative Requests template, library placements)
-- runs as its owner, not a client role, and is never refused.
-- =================================================================================================

create trigger custom_fields_07_select_options_insert
  before insert on public.custom_fields
  for each row execute function public.guard_select_field_options();

create trigger portfolio_fields_07_select_options_insert
  before insert on public.portfolio_fields
  for each row execute function public.guard_select_field_options();

-- =================================================================================================
-- 55 (batch 7 leftover). Link the existing library copies once more: the very last statement. The
-- function is idempotent (a field already linked, or in the library, is never a candidate), so this only
-- links clear copies made since batch 7's run. Its counts go to a NOTICE and into the function's comment
-- (obj_description('public.link_library_field_copies()'::regprocedure)) so they can be read back.
-- =================================================================================================
do $do$
declare
  result jsonb := public.link_library_field_copies();
begin
  raise notice 'Field library (batch 8): linked % existing copies, filled % values, recorded % conflicts (library_field_link_conflicts), left % ambiguous fields alone',
    result ->> 'linked', result ->> 'filled', result ->> 'conflicts', result ->> 'ambiguous';
  execute format(
    'comment on function public.link_library_field_copies() is %L',
    'Links existing copies of library fields (Oct 29 notes, batch 7). Last run by the Nov 1 batch 8 migration at '
      || to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI') || ' UTC: ' || result::text
  );
end;
$do$;
