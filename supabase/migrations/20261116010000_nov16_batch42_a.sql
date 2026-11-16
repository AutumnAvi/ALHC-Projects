-- ALHC Projects — Nov 16 batch 42 (follow-ups from the Nov 16 status audit, section 2).
--
-- Additive, no tail: one new function, one new internal helper, and one asserted text patch. No table,
-- policy, or data change; nothing for anon. The release still on main never calls the new function, and
-- the patched function keeps its signature, result type, and grants.
--
-- 1. Audit C97 — the Inbox's "Showing the latest 100 notifications" note. inbox_page(tab) returns the
--    newest 100 items, so the app couldn't tell "exactly 100" from "more than 100". inbox_page_window(tab,
--    max_items) is the same function with the page size as an argument (1–200): the app asks for 101 and
--    shows the note only when the 101st exists. Generated from inbox_page's live definition (every
--    `limit 100` becomes the argument; each edit asserted), so it can never drift from what the Inbox
--    reads today. SECURITY DEFINER like inbox_page (it reads only the caller's own items, by the same
--    rules), authenticated only; pinned in suite 60.
--
-- 2. Audit C71 — dates in automation text. {{task.due_date}}, {{task.start_date}}, and {{today}} were
--    already "Oct 24, 2026" (rule_placeholder_value, to_char 'Mon FMDD, YYYY'), but a date custom field
--    ({{field.Launch}}, Send email's field line, and the "changed Launch on" Inbox / email notification)
--    still read 2026-11-14: task_field_text() printed the stored value as is. It now writes a date field's
--    value the same way. alhc_plain_date() never raises (a value that isn't a real date comes back as it
--    was), so no write or notification can fail on it.

-- Kept on the hosted project (see AGENTS.md, Conventions).
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

-- 1. inbox_page_window(inbox_tab, max_items): inbox_page with the page size as an argument.
do $do$
declare
  body text := pg_get_functiondef('public.inbox_page(text)'::regprocedure);
  header text := 'CREATE OR REPLACE FUNCTION public.inbox_page(inbox_tab text)';
  limits integer;
begin
  if strpos(body, header) <> 1 then
    raise exception 'inbox_page_window: inbox_page''s header changed';
  end if;
  body := 'CREATE OR REPLACE FUNCTION public.inbox_page_window(inbox_tab text, max_items integer)'
    || substr(body, length(header) + 1);
  -- One page size, read once (1–200; null = 100).
  if (length(body) - length(replace(body, E'declare\n', ''))) / length(E'declare\n') <> 1 then
    raise exception 'inbox_page_window: expected one declare block';
  end if;
  body := replace(body, E'declare\n',
    E'declare\n  page_limit integer := least(greatest(coalesce(max_items, 100), 1), 200);\n');
  limits := (length(body) - length(replace(body, 'limit 100', ''))) / length('limit 100');
  -- Task, project message, team message, status update, and project items, and the merged page.
  if limits <> 6 then
    raise exception 'inbox_page_window: expected 6 page limits in inbox_page, found %', limits;
  end if;
  body := replace(body, 'limit 100', 'limit page_limit');
  execute body;
end;
$do$;

revoke all on function public.inbox_page_window(text, integer) from public, anon;
grant execute on function public.inbox_page_window(text, integer) to authenticated;
comment on function public.inbox_page_window(text, integer) is
  'Nov 16 batch 42 (audit C97): inbox_page(tab) with the page size as an argument (1–200), generated from inbox_page''s definition. The Inbox asks for 101 so it knows whether there are more than 100.';

-- 2. Dates in automation text.
create or replace function public.alhc_plain_date(value text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if value is null or value !~ '^\d{4}-\d{2}-\d{2}$' then
    return value;
  end if;
  return to_char(value::date, 'Mon FMDD, YYYY');
exception when others then
  return value;
end;
$$;
revoke all on function public.alhc_plain_date(text) from public, anon, authenticated;
comment on function public.alhc_plain_date(text) is
  'Nov 16 batch 42 (audit C71): a stored YYYY-MM-DD as people read it ("Nov 14, 2026", like dayLabel and {{task.due_date}}); anything else comes back unchanged. Never raises.';

select public.alhc_patch_function(
  'public.task_field_text(uuid, uuid)'::regprocedure,
  $old$    else v.value #>> '{}'$old$,
  $new$    when 'date' then public.alhc_plain_date(v.value #>> '{}')
    else v.value #>> '{}'$new$
);
