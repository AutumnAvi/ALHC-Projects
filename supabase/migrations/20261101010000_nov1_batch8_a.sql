-- Nov 1 notes, batch 8 (items 56, 58–63, Forgot password for 57, and two Oct 29 batch 7 leftovers).
-- Additive, no tail: no row or object removal anywhere in this file. Ordered for a chunked apply: new
-- columns first, every function before its callers, guards after the paths they rely on, and the
-- one-time linking of library copies last.
--
-- What the database gains (the app does the rest):
--   * 47 (batch 7 leftover): select fields need at least one option on insert too (BEFORE INSERT
--     triggers on custom_fields and portfolio_fields, same function and same rules as the update
--     check: people's writes only; imports, the copy engine, and library code are unchanged).
--   * 63: the review page reviews each file on its own (review_check_save / _decide / _view patched,
--     review_checks.file_results; signatures and grants unchanged).
--   * 61: every form has a required "Your name" question (forms_04_requester_name), the answer is kept in
--     form_submissions.submitter_name, and {requester_name} uses it.
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
-- 63. The review page reviews each file on its own.
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
-- =================================================================================================

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

-- =================================================================================================
-- 61. Forms require the requester's name.
--
-- Every form has one required "Your name" question: a short-text question carrying "role": "name"
-- (id requester_name for the ones this release adds). A plain short-text question on purpose: the
-- release still on main renders it as an ordinary required text box, so published forms keep taking
-- responses between this migration and the merge, and submit_form's existing required check enforces it
-- server-side without a change to its body or signature.
--
--   * forms_04_requester_name (invoker, BEFORE INSERT / UPDATE, every writer): makes sure a form has
--     exactly one name question and that it stays a required, always-shown, unmapped short-text question
--     (a writer that drops the role key, like main's form editor, gets it back on the requester_name
--     question; a form with none gets one added first). It never refuses a save.
--   * Existing forms get the question by touching each one (the trigger adds it); a form an earlier
--     validation would now refuse (e.g. a question mapped to a removed field) is left as it is and
--     counted in a NOTICE — its next successful save adds the question.
--   * form_submissions.submitter_name (≤ 200): the name answer, filled by form_submissions_04_name
--     (definer trigger; submit_form is the only writer). Existing submissions keep null.
--   * submission_requester_name() (asserted patch): the typed name comes first, so {requester_name} in
--     requester emails and the review dialog use it.
-- =================================================================================================

alter table public.form_submissions add column if not exists submitter_name text;
alter table public.form_submissions
  add constraint form_submissions_submitter_name_length
  check (submitter_name is null or char_length(submitter_name) between 1 and 200) not valid;

create or replace function public.ensure_form_requester_name()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  qs jsonb := case when jsonb_typeof(new.questions) = 'array' then new.questions else '[]'::jsonb end;
  idx integer;
  q jsonb;
  out jsonb := '[]'::jsonb;
  has_name boolean := false;
  pos integer;
begin
  -- The name question: the first one with "role": "name", else the one with id requester_name.
  select e.n - 1 into idx
  from jsonb_array_elements(qs) with ordinality e(x, n)
  where e.x ->> 'role' = 'name'
  order by e.n limit 1;
  if idx is null then
    select e.n - 1 into idx
    from jsonb_array_elements(qs) with ordinality e(x, n)
    where e.x ->> 'id' = 'requester_name'
    order by e.n limit 1;
  end if;

  for q, pos in select e.x, e.n - 1 from jsonb_array_elements(qs) with ordinality e(x, n) loop
    if idx is not null and pos = idx then
      has_name := true;
      out := out || jsonb_build_array(
        (q - 'role' - 'maps_to' - 'show_if' - 'options')
        || jsonb_build_object(
          'type', 'short_text',
          'role', 'name',
          'required', true,
          'label', coalesce(nullif(btrim(q ->> 'label'), ''), 'Your name')
        )
      );
    elsif q ->> 'role' is not null then
      -- Only one name question: any other keeps its text but loses the role.
      out := out || jsonb_build_array(q - 'role');
    else
      out := out || jsonb_build_array(q);
    end if;
  end loop;

  if not has_name then
    out := jsonb_build_array(jsonb_build_object(
      'id', 'requester_name',
      'type', 'short_text',
      'role', 'name',
      'label', 'Your name',
      'required', true
    )) || out;
  end if;

  -- Branching on the name question isn't allowed (it's a text question, so nothing could depend on it).
  new.questions := out;
  return new;
end;
$$;

select public.alhc_revoke_anon_execute(array['ensure_form_requester_name()']);

create trigger forms_04_requester_name
  before insert or update of questions on public.forms
  for each row execute function public.ensure_form_requester_name();

create or replace function public.fill_submission_requester_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  qid text;
begin
  if new.submitter_name is null then
    select q ->> 'id' into qid
    from public.forms f, jsonb_array_elements(coalesce(f.questions, '[]'::jsonb)) q
    where f.id = new.form_id and q ->> 'role' = 'name'
    limit 1;
    if qid is not null and jsonb_typeof(new.answers -> qid) = 'string' then
      new.submitter_name := left(nullif(btrim(new.answers ->> qid), ''), 200);
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.fill_submission_requester_name() from public, anon, authenticated;

create trigger form_submissions_04_name
  before insert on public.form_submissions
  for each row execute function public.fill_submission_requester_name();

select public.alhc_patch_function(
  'public.submission_requester_name(uuid)'::regprocedure,
  E'select coalesce(\n    (select nullif(btrim(p.full_name), \'\')',
  E'select coalesce(\n    nullif(btrim(fs.submitter_name), \'\'),\n    (select nullif(btrim(p.full_name), \'\')'
);

-- Existing forms: touch each live one so the trigger adds the name question (first, required).
do $do$
declare
  f record;
  added integer := 0;
  skipped integer := 0;
begin
  for f in
    select id from public.forms
    where deleted_at is null
      and not exists (select 1 from jsonb_array_elements(questions) q where q ->> 'role' = 'name')
  loop
    begin
      update public.forms set questions = questions where id = f.id;
      added := added + 1;
    exception when others then
      skipped := skipped + 1;
    end;
  end loop;
  raise notice 'Forms (batch 8): added the required name question to % forms, left % that no longer pass validation', added, skipped;
end;
$do$;

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
