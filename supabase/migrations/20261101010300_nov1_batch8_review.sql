-- Nov 1 notes (batch 8), item 63: the review page reviews each file on its own.
--
-- The reviewer marks every file (asset) of a round either Approved or with feedback (a pin, or a note on
-- that file), and the round's answer is derived: every file approved → Approve; any feedback → Request
-- changes. Additive, no tail. Nothing new for anon or authenticated: the three functions keep their
-- signatures and grants, changed with asserted text patches.
--
--   * review_check_save (asserted patch) also keeps, in the draft, each file's state
--     (files: [{ asset_id, approved, note }]) and per_file: true when the page sent it. The release still
--     on main never sends per_file, so its drafts (and its answers) work exactly as before.
--   * review_check_file_outcomes(round, pins) (internal, revoked): each live file of the round with its
--     saved approval and note and how many of the answer's pins are on it; null unless the saved draft is
--     per-file.
--   * review_check_decide (asserted patch): for a per-file draft it refuses an answer while some file has
--     neither an approval nor feedback ('unreviewed'), or whose answer isn't the derived one ('mismatch');
--     the per-file "empty" rule replaces the old one (a file's note is feedback too); the comment on the
--     task lists each file's outcome ("Logo.png — Approved", "Flyer.pdf — Changes requested: 2 comments");
--     and the outcome is kept in review_checks.file_results.
--   * review_check_view / review_check_previous_json (asserted patches) return file_results for answered
--     rounds (the confirmation page, the previous round).
-- The check lives in the database (not only the page's Server Action) so it holds however the answer is
-- sent; it reads what the page saved, so review_check_decide's signature (and the release on main) stay
-- as they are.

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

-- ---------------------------------------------------------------------------
-- 1. Where an answered round keeps each file's outcome
-- ---------------------------------------------------------------------------

alter table public.review_checks add column if not exists file_results jsonb;

comment on column public.review_checks.file_results is
  'Nov 1 notes, item 63: each file''s outcome when the round was answered file by file '
  '([{ asset_id, name, approved, note, pins }], in the round''s order); null for rounds answered as a whole.';

-- The team reads it with the round (the Reviews tab), like the decision note.
grant select (file_results) on public.review_checks to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Each file's outcome, from the saved draft and the answer's pins (invoker: only ever called inside
--    review_check_decide)
-- ---------------------------------------------------------------------------

create or replace function public.review_check_file_outcomes(r public.review_checks, pins jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case when coalesce(r.draft ->> 'per_file', '') = 'true' then coalesce((
    select jsonb_agg(jsonb_build_object(
      'asset_id', a.id,
      'name', ta.file_name,
      'approved', coalesce((
        select (f ->> 'approved') = 'true'
        from jsonb_array_elements(case when jsonb_typeof(r.draft -> 'files') = 'array' then r.draft -> 'files' else '[]'::jsonb end) f
        where f ->> 'asset_id' = a.id::text
        limit 1
      ), false),
      'note', (
        select nullif(btrim(coalesce(f ->> 'note', '')), '')
        from jsonb_array_elements(case when jsonb_typeof(r.draft -> 'files') = 'array' then r.draft -> 'files' else '[]'::jsonb end) f
        where f ->> 'asset_id' = a.id::text
        limit 1
      ),
      'pins', (
        select count(*)::integer
        from jsonb_array_elements(case when jsonb_typeof(pins) = 'array' then pins else '[]'::jsonb end) p
        where p ->> 'asset_id' = a.id::text
      )
    ) order by a.sort_order, a.created_at)
    from public.review_check_assets a
    join public.task_attachments ta on ta.id = a.attachment_id and ta.deleted_at is null
    where a.review_id = r.id
  ), '[]'::jsonb) end;
$$;

revoke all on function public.review_check_file_outcomes(public.review_checks, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The draft keeps each file's state
-- ---------------------------------------------------------------------------

select public.alhc_patch_function('public.review_check_save(text, jsonb, boolean)'::regprocedure,
$p$  decision text;
  active text;
begin$p$,
$p$  decision text;
  active text;
  clean_files jsonb;
begin$p$,
$p$     or (progress ? 'note' and jsonb_typeof(progress -> 'note') not in ('string', 'null')) then$p$,
$p$     or (progress ? 'note' and jsonb_typeof(progress -> 'note') not in ('string', 'null'))
     or (progress ? 'files' and jsonb_typeof(progress -> 'files') <> 'array')
     or jsonb_array_length(coalesce(progress -> 'files', '[]'::jsonb)) > 200 then$p$,
$p$  update public.review_checks x
  set draft = jsonb_build_object(
        'pins', clean_pins,
        'note', left(coalesce(progress ->> 'note', ''), 5000),
        'decision', decision,
        'active_asset', active
      ),$p$,
$p$  -- Nov 1 notes (batch 8): each file's state (approved, a note on it), once per file of this round; files
  -- with neither are left out.
  select coalesce(jsonb_agg(jsonb_build_object('asset_id', s.asset_id, 'approved', s.approved, 'note', s.note) order by s.ord), '[]'::jsonb)
  into clean_files
  from (
    select distinct on (e.f ->> 'asset_id')
      e.f ->> 'asset_id' as asset_id,
      e.ord,
      jsonb_typeof(e.f -> 'approved') = 'boolean' and (e.f ->> 'approved')::boolean as approved,
      left(case when jsonb_typeof(e.f -> 'note') = 'string' then e.f ->> 'note' else '' end, 2000) as note
    from jsonb_array_elements(coalesce(progress -> 'files', '[]'::jsonb)) with ordinality e(f, ord)
    where jsonb_typeof(e.f) = 'object'
      and coalesce(e.f ->> 'asset_id', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and exists (
        select 1 from public.review_check_assets a where a.review_id = r.id and a.id = (e.f ->> 'asset_id')::uuid
      )
    order by e.f ->> 'asset_id', e.ord desc
  ) s
  where s.approved or s.note <> '';

  update public.review_checks x
  set draft = jsonb_build_object(
        'pins', clean_pins,
        'note', left(coalesce(progress ->> 'note', ''), 5000),
        'decision', decision,
        'active_asset', active
      ) || case when jsonb_typeof(progress -> 'per_file') = 'boolean' and (progress ->> 'per_file')::boolean
               then jsonb_build_object('per_file', true, 'files', clean_files)
               else '{}'::jsonb end,$p$
);

-- ---------------------------------------------------------------------------
-- 4. The answer: every file reviewed, the derived decision, each file's outcome on the task
-- ---------------------------------------------------------------------------

select public.alhc_patch_function('public.review_check_decide(text, text, text, jsonb)'::regprocedure,
$p$  previous_sub text;
  assignee uuid;
begin$p$,
$p$  previous_sub text;
  assignee uuid;
  outcomes jsonb;
  outcome jsonb;
  outcome_lines text[] := '{}';
  outcome_text text;
  derived text;
begin$p$,
$p$  if decision = 'changes_requested' and clean_note is null and jsonb_array_length(coalesce(pins, '[]'::jsonb)) = 0 then
    return jsonb_build_object('status', 'empty');
  end if;$p$,
$p$  -- Nov 1 notes (batch 8): a round reviewed file by file (the page saved per_file) has its own rules
  -- below; the old one (feedback needs a note or a pin) is for the rest.
  outcomes := public.review_check_file_outcomes(r, pins);
  -- A round whose files are all gone (removed from the task) is answered as a whole.
  if jsonb_array_length(outcomes) = 0 then
    outcomes := null;
  end if;
  if outcomes is null and decision = 'changes_requested' and clean_note is null and jsonb_array_length(coalesce(pins, '[]'::jsonb)) = 0 then
    return jsonb_build_object('status', 'empty');
  end if;
  if outcomes is not null then
    -- Every file approved or with feedback (a pin in this answer, or its saved note).
    if exists (
      select 1 from jsonb_array_elements(outcomes) o
      where not (o ->> 'approved')::boolean and (o ->> 'pins')::integer = 0 and o ->> 'note' is null
    ) then
      return jsonb_build_object('status', 'unreviewed');
    end if;
    -- The answer is the derived one: any feedback asks for changes; all approved approves.
    derived := 'approved';
    if exists (
      select 1 from jsonb_array_elements(outcomes) o where (o ->> 'pins')::integer > 0 or o ->> 'note' is not null
    ) then
      derived := 'changes_requested';
    end if;
    if decision <> derived then
      return jsonb_build_object('status', 'mismatch');
    end if;
  end if;$p$,
$p$  set status = decision, decided_at = now(), decision_note = clean_note, updated_at = now(), draft = null$p$,
$p$  set status = decision, decided_at = now(), decision_note = clean_note, updated_at = now(), draft = null,
      file_results = outcomes$p$,
$p$    || coalesce(E'\n\n' || clean_note, '')$p$,
$p$    || coalesce(E'\n\n' || clean_note, '')
    || coalesce(E'\n\n' || outcome_text, '')$p$,
$p$  select string_agg(f.file_name, ', ' order by f.created_at) into files_text$p$,
$p$  -- Each file's outcome, in the round's order ("Logo.png — Approved", "Flyer.pdf — Changes requested:
  -- 2 comments. Note: …"). A file with feedback counts as changes, even if it was ticked approved too.
  if outcomes is not null then
    for outcome in select value from jsonb_array_elements(outcomes)
    loop
      outcome_lines := outcome_lines || (
        '- ' || (outcome ->> 'name') || ' — '
        || case
             when (outcome ->> 'pins')::integer = 0 and outcome ->> 'note' is null then 'Approved'
             else 'Changes requested'
               || case when (outcome ->> 'pins')::integer > 0
                       then ': ' || (outcome ->> 'pins') || case when (outcome ->> 'pins')::integer = 1 then ' comment' else ' comments' end
                       else '' end
               || coalesce('. Note: ' || (outcome ->> 'note'), '')
           end
      );
    end loop;
    outcome_text := E'Files:\n' || array_to_string(outcome_lines, E'\n');
  end if;

  select string_agg(f.file_name, ', ' order by f.created_at) into files_text$p$
);

-- ---------------------------------------------------------------------------
-- 5. The page reads each file's outcome back (answered rounds, and the previous round)
-- ---------------------------------------------------------------------------

select public.alhc_patch_function('public.review_check_view(text)'::regprocedure,
$p$    'draft', case when r.status = 'pending' then r.draft end,$p$,
$p$    'draft', case when r.status = 'pending' then r.draft end,
    -- Nov 1 notes (batch 8): each file's outcome once the round is answered file by file.
    'file_results', case when r.status in ('approved', 'changes_requested') then r.file_results end,$p$
);

select public.alhc_patch_function('public.review_check_previous_json(public.review_checks)'::regprocedure,
$p$    'decision_note', prev.decision_note,$p$,
$p$    'decision_note', prev.decision_note,
    'file_results', prev.file_results,$p$
);
