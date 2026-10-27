-- ALHC Projects — Oct 27 notes, batch 6.
--
-- @@HEADER@@
--
-- No row-removal or object-removal keywords anywhere in this file (the hosted connector refuses them).
-- Additive: no tail.

create or replace function public.alhc_patch_function(target regprocedure, variadic edits text[])
returns void
language plpgsql
set search_path = ''
as $$
declare
  def text := pg_get_functiondef(target);
  hits integer;
begin
  if coalesce(array_length(edits, 1), 0) = 0 or array_length(edits, 1) % 2 <> 0 then
    raise exception 'alhc_patch_function(%): pass (old, new) text pairs', target;
  end if;
  for i in 1 .. array_length(edits, 1) / 2 loop
    if coalesce(edits[2 * i - 1], '') = '' then
      raise exception 'alhc_patch_function(%): edit % has no text to replace', target, i;
    end if;
    hits := (length(def) - length(replace(def, edits[2 * i - 1], ''))) / length(edits[2 * i - 1]);
    if hits <> 1 then
      raise exception 'alhc_patch_function(%): edit % matched % times (expected exactly once)', target, i, hits;
    end if;
    def := replace(def, edits[2 * i - 1], edits[2 * i]);
  end loop;
  execute def;
end;
$$;

revoke all on function public.alhc_patch_function(regprocedure, text[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 40. Adding a subtask failed with 'column reference "number" is ambiguous' in projects that reuse
--     freed numbers: the subtask branch of assign_request_number_on_insert() orders the open gaps by
--     `number`, which is both request_number_gaps.number and the function's own `number` variable.
--     Qualify the column (the top-level branch already goes through allocate_request_number, which does).
-- ---------------------------------------------------------------------------------------------------

select public.alhc_patch_function(
  'public.assign_request_number_on_insert()'::regprocedure,
  $old$        select id from public.request_number_gaps
        where project_id = seq.project_id
          and counter_key = 'sub:' || new.parent_task_id::text
          and consumed_at is null and deleted_at is null
        order by number
        limit 1$old$,
  $new$        select open_gap.id from public.request_number_gaps open_gap
        where open_gap.project_id = seq.project_id
          and open_gap.counter_key = 'sub:' || new.parent_task_id::text
          and open_gap.consumed_at is null and open_gap.deleted_at is null
        order by open_gap.number
        limit 1$new$
);
