-- ALHC Projects — Oct 19 test notes (fix batch).
--
-- 1. Task numbering settings take effect everywhere. "Wrap the label in brackets" was saved but no
--    screen read it (every label was drawn as "[label]"). Labels stay bare in tasks.req_label; the
--    display rule lives in request_display_label(label, wrap) (mirrored by formatRequestLabel() in
--    src/lib/request-numbers.ts), and task_request_labels(task ids) hands the app each visible task's
--    { label, wrap } in one call (invoker: RLS decides, a POST body so max_rows can't cut it).
--    task_request_display_label(task) is the same rule for one task. Same class of bug, also fixed:
--    allocate_request_number's ON CONFLICT was ambiguous with its own parameter names, so a yearly /
--    monthly reset made every new task fail and a per-field counter made field writes fail;
--    "Number subtasks" off now hides subtask labels (like "enabled" hides all of them) and turning it
--    back on with Save numbers the subtasks made meanwhile; a {parent} template is current after one
--    save (top-level labels first, then each subtask depth); a sequence apply_task_numbering creates
--    never bakes labels into titles; Duplicate project and project templates keep every numbering
--    setting; email_design_context tells the drain the issuing project's bracket setting.
--    Tokens and payloads stay bare on purpose: the webhook "req", Slack {req}, the email fill-in
--    {request_number}, submit_form's request_label, and the inbound response.
-- 2. Email control. Designs gain a subject template and a heading (fill-in fields plus the email's own
--    {email_subject} / {email_heading}), editable small print, and a show / hide switch per block
--    (logo, header label, heading, intro, message, details, button, small print, sign-off), resolved
--    form → project → workspace like the rest. A response to a form's submitter gets its subject from
--    the database (submitter_response_subject: the conversation's subject, else the design's template
--    filled in by email_subject_fill_in, else Asana's), and the comment, its thread, and its email all
--    carry it. Every other email's subject and heading are designed at send time by the drain.
--
-- No new SECURITY DEFINER function for clients (suite 60 unchanged); the new functions are invoker or
-- immutable helpers, revoked from anon. fire_rules, notify_with, notify_message, and add_story are
-- untouched. Additive: the release on main never calls the new functions, and every patched function
-- keeps its signature and grants.

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

-- =============================================================================================
-- 1. Task numbering labels and settings
-- =============================================================================================

-- The counter row's conflict target named columns that are also this function's parameters
-- (period_key, counter_key): "column reference is ambiguous" on every task created under a reset
-- period or a per-field counter. Name the constraint instead.
select public.alhc_patch_function(
  'public.allocate_request_number(uuid, text, text)'::regprocedure,
  $p$  on conflict (project_id, period_key, counter_key) do nothing;$p$,
  $p$  on conflict on constraint request_counters_key do nothing;$p$
);

-- How a label is shown in front of a task name: "[Task #3]" or "Task #3".
create or replace function public.request_display_label(label text, wrap boolean)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when label is null or btrim(label) = '' then null
    when coalesce(wrap, true) then '[' || label || ']'
    else label
  end;
$$;

revoke all on function public.request_display_label(text, boolean) from public, anon;
grant execute on function public.request_display_label(text, boolean) to authenticated, service_role;

-- "Number subtasks" off hides the subtask labels already stored, the way "enabled" hides every label.
select public.alhc_patch_function(
  'public.task_request_label(uuid)'::regprocedure,
  $p$select case when s.enabled then public.compose_request_label(t.id) else null end$p$,
  $p$select case when s.enabled and (t.parent_task_id is null or s.number_subtasks) then public.compose_request_label(t.id) else null end$p$
);

create or replace function public.task_request_display_label(target_task uuid)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select public.request_display_label(public.task_request_label(t.id), s.wrap_brackets)
  from public.tasks t
  join public.request_sequences s
    on s.project_id = coalesce(t.req_project_id, t.home_project_id)
   and s.deleted_at is null
  where t.id = target_task;
$$;

revoke all on function public.task_request_display_label(uuid) from public, anon;
grant execute on function public.task_request_display_label(uuid) to authenticated, service_role;

-- Every app surface reads labels here: { "<task id>": { "label": "Task #3", "wrap": false } } for
-- the tasks the caller can read whose numbering is on (subtasks only while "Number subtasks" is on).
-- Invoker, so RLS on tasks and request_sequences decides exactly as before. At most 5,000 ids a call.
create or replace function public.task_request_labels(task_ids uuid[])
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    jsonb_object_agg(t.id, jsonb_build_object('label', t.req_label, 'wrap', s.wrap_brackets)),
    '{}'::jsonb
  )
  from public.tasks t
  join public.request_sequences s
    on s.project_id = coalesce(t.req_project_id, t.home_project_id)
   and s.deleted_at is null
   and s.enabled
  where t.id = any (task_ids[1:5000])
    and t.req_label is not null
    and (t.parent_task_id is null or s.number_subtasks);
$$;

revoke all on function public.task_request_labels(uuid[]) from public, anon;
grant execute on function public.task_request_labels(uuid[]) to authenticated;

-- apply_task_numbering: a sequence it creates never bakes labels into titles (the column default is
-- the old behavior, kept for the older paths); a save relabels top-level tasks first, then each
-- subtask depth, so {parent} is current after one save; and with "Number subtasks" on, a save gives
-- indexes to subtasks made while it was off (it still never hands out new top-level numbers).
select public.alhc_patch_function(
  'public.apply_task_numbering(uuid, jsonb, text)'::regprocedure,
  $p$  insert into public.request_sequences (project_id, enabled)
  values (target_project, false)$p$,
  $p$  insert into public.request_sequences (project_id, enabled, add_to_title)
  values (target_project, false, false)$p$,
  $p$    update public.tasks t
    set req_label = public.compose_request_label(t.id)
    where t.deleted_at is null and t.home_project_id = target_project
      and (t.req_number is not null or t.req_subindex is not null);
    numbered := 0;$p$,
  $p$    if seq.enabled and seq.number_subtasks then
      for numbered in 1..4 loop
        with kids as (
          select c.id,
                 coalesce((
                   select max(s.req_subindex) from public.tasks s
                   where s.parent_task_id = c.parent_task_id and s.deleted_at is null and s.req_subindex is not null
                 ), 0) + row_number() over (
                   partition by c.parent_task_id
                   order by c.subtask_order, c.created_at, c.id
                 ) as idx
          from public.tasks c
          join public.tasks p on p.id = c.parent_task_id
          where c.deleted_at is null
            and c.home_project_id = target_project
            and c.req_subindex is null
            and p.req_path is not null
            and p.deleted_at is null
        )
        update public.tasks t
        set req_subindex = k.idx
        from kids k
        where t.id = k.id;
        update public.tasks c
        set req_path = p.req_path || seq.subtask_separator || c.req_subindex::text
        from public.tasks p
        where c.parent_task_id = p.id
          and c.req_subindex is not null
          and c.deleted_at is null
          and p.req_path is not null
          and c.home_project_id = target_project;
      end loop;
    end if;
    update public.tasks t
    set req_label = public.compose_request_label(t.id)
    where t.deleted_at is null
      and t.parent_task_id is null
      and t.req_number is not null
      and (t.home_project_id = target_project or t.req_project_id = target_project);
    for numbered in 1..4 loop
      update public.tasks c
      set req_label = public.compose_request_label(c.id)
      where c.deleted_at is null
        and c.req_subindex is not null
        and c.home_project_id = target_project
        and char_length(c.req_path) - char_length(replace(c.req_path, seq.subtask_separator, '')) = numbered;
    end loop;
    numbered := 0;$p$
);

-- Duplicate project and project templates keep every numbering setting (they kept only the legacy
-- prefix / padding / scope before). Section and field references are remapped once those exist.
select public.alhc_patch_function(
  'public.project_snapshot(uuid, jsonb)'::regprocedure,
  $p$      select jsonb_build_object('enabled', rs.enabled, 'prefix', rs.prefix, 'pad_width', rs.pad_width,
        'add_to_title', rs.add_to_title, 'assign_to', rs.assign_to)$p$,
  $p$      select jsonb_build_object('enabled', rs.enabled, 'prefix', rs.prefix, 'pad_width', rs.pad_width,
        'add_to_title', rs.add_to_title, 'assign_to', rs.assign_to,
        'template', rs.template, 'wrap_brackets', rs.wrap_brackets, 'number_subtasks', rs.number_subtasks,
        'subtask_separator', rs.subtask_separator, 'number_scope', rs.number_scope,
        'section_ids', to_jsonb(rs.section_ids), 'task_kinds', to_jsonb(rs.task_kinds),
        'reset_period', rs.reset_period, 'counter_field_id', rs.counter_field_id,
        'project_code', rs.project_code, 'renumber_on_move', rs.renumber_on_move,
        'time_zone', rs.time_zone, 'reuse_deleted', rs.reuse_deleted, 'fill_gaps', rs.fill_gaps,
        'start_number', rs.start_number)$p$
);

select public.alhc_patch_function(
  (select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'instantiate_project_snapshot'),
  $p$  if jsonb_typeof(snapshot -> 'request_sequence') = 'object' then
    insert into public.request_sequences (project_id, enabled, prefix, pad_width, add_to_title, assign_to)
    values (
      new_project,
      coalesce((snapshot #>> '{request_sequence,enabled}')::boolean, true),
      left(coalesce(snapshot #>> '{request_sequence,prefix}', 'Req #'), 20),
      least(greatest(coalesce((snapshot #>> '{request_sequence,pad_width}')::smallint, 0), 0), 8),
      coalesce((snapshot #>> '{request_sequence,add_to_title}')::boolean, true),
      case when snapshot #>> '{request_sequence,assign_to}' = 'all_tasks' then 'all_tasks' else 'form_submissions' end
    );
  end if;$p$,
  $p$  if jsonb_typeof(snapshot -> 'request_sequence') = 'object' then
    insert into public.request_sequences (
      project_id, enabled, prefix, pad_width, add_to_title, assign_to,
      template, wrap_brackets, number_subtasks, subtask_separator, number_scope, task_kinds,
      reset_period, project_code, renumber_on_move, time_zone, reuse_deleted, fill_gaps, start_number
    )
    values (
      new_project,
      coalesce((snapshot #>> '{request_sequence,enabled}')::boolean, true),
      left(coalesce(snapshot #>> '{request_sequence,prefix}', 'Req #'), 20),
      least(greatest(coalesce((snapshot #>> '{request_sequence,pad_width}')::smallint, 0), 0), 8),
      coalesce((snapshot #>> '{request_sequence,add_to_title}')::boolean, true),
      case when snapshot #>> '{request_sequence,assign_to}' = 'all_tasks' then 'all_tasks' else 'form_submissions' end,
      coalesce(nullif(snapshot #>> '{request_sequence,template}', ''), 'Req #{n}'),
      coalesce((snapshot #>> '{request_sequence,wrap_brackets}')::boolean, true),
      coalesce((snapshot #>> '{request_sequence,number_subtasks}')::boolean, true),
      case when snapshot #>> '{request_sequence,subtask_separator}' in ('.', '-', '/')
        then snapshot #>> '{request_sequence,subtask_separator}' else '.' end,
      -- Sections are remapped below, once they exist.
      case when snapshot #>> '{request_sequence,number_scope}' in ('inherit', 'all_tasks', 'form_submissions', 'kinds')
        then snapshot #>> '{request_sequence,number_scope}' else 'inherit' end,
      coalesce(
        (select array_agg(x) from jsonb_array_elements_text(
          case when jsonb_typeof(snapshot #> '{request_sequence,task_kinds}') = 'array'
            then snapshot #> '{request_sequence,task_kinds}' else '[]'::jsonb end) x
         where x in ('task', 'milestone', 'approval')),
        array['task', 'milestone', 'approval']
      ),
      case when snapshot #>> '{request_sequence,reset_period}' in ('never', 'yearly', 'monthly')
        then snapshot #>> '{request_sequence,reset_period}' else 'never' end,
      nullif(snapshot #>> '{request_sequence,project_code}', ''),
      coalesce((snapshot #>> '{request_sequence,renumber_on_move}')::boolean, false),
      coalesce(nullif(snapshot #>> '{request_sequence,time_zone}', ''), 'UTC'),
      coalesce((snapshot #>> '{request_sequence,reuse_deleted}')::boolean, false),
      coalesce((snapshot #>> '{request_sequence,fill_gaps}')::boolean, false),
      greatest(coalesce((snapshot #>> '{request_sequence,start_number}')::bigint, 1), 1)
    );
  end if;$p$,
  $p$  -- Forms (closed until someone opens them; ones that no longer validate are skipped) --------------$p$,
  $p$  -- Numbering scope by section and per-field counters point at this copy's sections and fields. A
  -- reference that doesn't map (or no longer validates) leaves that setting at its default.
  if jsonb_typeof(snapshot -> 'request_sequence') = 'object' then
    begin
      update public.request_sequences rs
      set number_scope = 'sections',
          section_ids = (
            select array_agg((id_map ->> x)::uuid)
            from jsonb_array_elements_text(snapshot #> '{request_sequence,section_ids}') x
            where id_map ? x
          )
      where rs.project_id = new_project
        and snapshot #>> '{request_sequence,number_scope}' = 'sections'
        and jsonb_typeof(snapshot #> '{request_sequence,section_ids}') = 'array'
        and exists (
          select 1 from jsonb_array_elements_text(snapshot #> '{request_sequence,section_ids}') x
          where id_map ? x
        );
    exception when others then
      null;
    end;
    begin
      update public.request_sequences rs
      set counter_field_id = (id_map ->> (snapshot #>> '{request_sequence,counter_field_id}'))::uuid
      where rs.project_id = new_project
        and id_map ? coalesce(snapshot #>> '{request_sequence,counter_field_id}', '');
    exception when others then
      null;
    end;
  end if;

  -- Forms (closed until someone opens them; ones that no longer validate are skipped) --------------$p$
);

-- The drain reads each email's design context at send time: add the issuing project's bracket
-- setting, so the emailed "Task" / "Request" rows follow it like every screen does.
select public.alhc_patch_function(
  'public.email_design_context(uuid)'::regprocedure,
  $p$      'request_number', case when r.id is not null then public.task_request_label(r.id) end,$p$,
  $p$      'request_number', case when r.id is not null then public.task_request_label(r.id) end,
      'request_wrap', coalesce((
        select s.wrap_brackets from public.request_sequences s
        where s.project_id = coalesce(t.req_project_id, t.home_project_id) and s.deleted_at is null
      ), true),$p$
);

-- =============================================================================================
-- 2. Email control: subject and heading templates, small print, and show / hide per block
-- =============================================================================================

-- New settings on every design scope (null = inherit, like the others). '' in subject_template,
-- heading_text, and notice_text = "this email's own".
alter table public.email_designs
  add column subject_template text constraint email_designs_subject_template_check check (
    subject_template is null or (char_length(subject_template) <= 300 and subject_template !~ '[\r\n]')
  ),
  add column heading_text text constraint email_designs_heading_text_check check (
    heading_text is null or char_length(heading_text) <= 300
  ),
  add column notice_text text constraint email_designs_notice_text_check check (
    notice_text is null or char_length(notice_text) <= 500
  ),
  add column show_logo boolean,
  add column show_header boolean,
  add column show_heading boolean,
  add column show_intro boolean,
  add column show_body boolean,
  add column show_details boolean,
  add column show_button boolean,
  add column show_notice boolean,
  add column show_footer boolean;

comment on column public.email_designs.subject_template is
  'The subject, with fill-in fields and {email_subject} (the email''s own). '''' = the email''s own. '
  'A response to a form''s submitter keeps the subject of its conversation''s first response.';
comment on column public.email_designs.heading_text is
  'The heading, with fill-in fields, {email_heading}, and {email_subject}. '''' = the email''s own.';
comment on column public.email_designs.notice_text is
  'The small print under the card (how to reply, why they got it). '''' = the email''s own. '
  'The reply marker and the digest / report "Turn off" links always stay.';
comment on column public.email_designs.show_body is
  'Show the message (comment, confirmation message, rule text). A response to a submitter always shows it.';

grant insert (subject_template, heading_text, notice_text, show_logo, show_header, show_heading, show_intro,
  show_body, show_details, show_button, show_notice, show_footer)
  on public.email_designs to authenticated;
grant update (subject_template, heading_text, notice_text, show_logo, show_header, show_heading, show_intro,
  show_body, show_details, show_button, show_notice, show_footer)
  on public.email_designs to authenticated;

-- The guard trims the new texts and puts a pasted subject on one line (before the CHECK sees it).
select public.alhc_patch_function(
  'public.guard_email_design()'::regprocedure,
  $p$  new.header_text := case when new.header_text is null then null else btrim(new.header_text) end;$p$,
  $p$  new.header_text := case when new.header_text is null then null else btrim(new.header_text) end;
  new.heading_text := case when new.heading_text is null then null else btrim(new.heading_text) end;
  new.notice_text := case when new.notice_text is null then null else btrim(new.notice_text) end;
  new.subject_template := case when new.subject_template is null then null
    else btrim(regexp_replace(new.subject_template, '[ \t\r\n\f\v]+', ' ', 'g')) end;$p$
);

-- resolve_email_design returns the new settings too, each from the nearest scope that sets it.
select public.alhc_patch_function(
  'public.resolve_email_design(text, uuid, uuid)'::regprocedure,
  $p$    'button_color', (select s.button_color from scopes s where s.button_color is not null order by s.rank limit 1)$p$,
  $p$    'button_color', (select s.button_color from scopes s where s.button_color is not null order by s.rank limit 1),
    'subject_template', (select s.subject_template from scopes s where s.subject_template is not null order by s.rank limit 1),
    'heading_text', (select s.heading_text from scopes s where s.heading_text is not null order by s.rank limit 1),
    'notice_text', (select s.notice_text from scopes s where s.notice_text is not null order by s.rank limit 1),
    'show_logo', (select s.show_logo from scopes s where s.show_logo is not null order by s.rank limit 1),
    'show_header', (select s.show_header from scopes s where s.show_header is not null order by s.rank limit 1),
    'show_heading', (select s.show_heading from scopes s where s.show_heading is not null order by s.rank limit 1),
    'show_intro', (select s.show_intro from scopes s where s.show_intro is not null order by s.rank limit 1),
    'show_body', (select s.show_body from scopes s where s.show_body is not null order by s.rank limit 1),
    'show_details', (select s.show_details from scopes s where s.show_details is not null order by s.rank limit 1),
    'show_button', (select s.show_button from scopes s where s.show_button is not null order by s.rank limit 1),
    'show_notice', (select s.show_notice from scopes s where s.show_notice is not null order by s.rank limit 1),
    'show_footer', (select s.show_footer from scopes s where s.show_footer is not null order by s.rank limit 1)$p$
);

-- A subject template filled in, on one line, at most 300 characters. Mirrors renderSubjectTemplate()
-- in src/lib/email-design.ts: the same {field} tokens (case-insensitive, spaces allowed inside the
-- braces), one pass (a value that looks like {field} is never filled in again), unknown fields and
-- fields the kind doesn't offer blank ({task_link} only for internal emails), values trimmed, every run
-- of whitespace one space. Whitespace is an explicit class so the browser and the database agree.
create or replace function public.email_subject_fill_in(template text, vals jsonb, design_kind text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  token constant text := '\{[ \t\r\n\f\v]*([A-Za-z_]+)[ \t\r\n\f\v]*\}';
  allowed text[] := array['requester_name', 'request_number', 'task_name', 'project_name', 'form_name',
    'commenter_name', 'due_date', 'email_subject'];
  pieces text[];
  keys text[];
  result text;
  val text;
begin
  if template is null then
    return '';
  end if;
  if design_kind = 'internal' then
    allowed := allowed || 'task_link'::text;
  end if;
  pieces := regexp_split_to_array(template, token);
  select coalesce(array_agg(lower(m.match[1]) order by m.n), '{}') into keys
  from regexp_matches(template, token, 'g') with ordinality as m(match, n);
  result := coalesce(pieces[1], '');
  for i in 1 .. coalesce(array_length(keys, 1), 0) loop
    val := case when keys[i] = any(allowed) then vals ->> keys[i] end;
    val := regexp_replace(coalesce(val, ''), '^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$', '', 'g');
    result := result || val || coalesce(pieces[i + 1], '');
  end loop;
  result := regexp_replace(result, '[ \t\r\n\f\v]+', ' ', 'g');
  result := regexp_replace(result, '^ | $', '', 'g');
  return left(result, 300);
end;
$$;

revoke all on function public.email_subject_fill_in(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.email_subject_fill_in(text, jsonb, text) to service_role;

-- The subject of a response to a form's submitter. A conversation keeps one subject (the submitter's
-- mailbox groups by it, and their replies come back with it): an open thread's subject wins. A new
-- conversation gets the requester design's subject template (form → project → workspace) filled in
-- with the same values email_design_context gives the drain, else Asana's Re: "<form>" submission
-- received. Invoker, revoked from clients: only fill_comment_email (a definer trigger) calls it.
create or replace function public.submitter_response_subject(target_task uuid, author uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  s record;
  t public.tasks;
  r public.tasks;
  existing text;
  tmpl text;
  rendered text;
begin
  select * into s from public.task_submitter(target_task);
  if s.submitter_email is null then
    return null;
  end if;
  select * into t from public.tasks where id = target_task;
  select * into r from public.tasks where id = coalesce(t.root_task_id, t.id);
  select k.subject into existing from public.submitter_reply_threads k
  where k.task_id = r.id and k.submitter_email = s.submitter_email and k.revoked_at is null
  order by k.created_at desc
  limit 1;
  if existing is not null then
    return existing;
  end if;
  tmpl := public.resolve_email_design('requester', r.home_project_id, s.form_id) ->> 'subject_template';
  if coalesce(public.email_subject_fill_in(tmpl, '{}'::jsonb, 'requester'), '') = '' then
    return s.subject;
  end if;
  rendered := public.email_subject_fill_in(tmpl, jsonb_build_object(
    'requester_name', public.submission_requester_name(s.submission_id),
    'request_number', public.task_request_label(r.id),
    'task_name', r.title,
    'project_name', (select p.name from public.projects p where p.id = r.home_project_id),
    'form_name', (select f.title from public.forms f where f.id = s.form_id),
    'commenter_name', coalesce(
      (select coalesce(nullif(btrim(p.full_name), ''), p.email) from public.profiles p where p.id = author),
      'The team'
    ),
    'due_date', to_char(coalesce(t.due_on, r.due_on), 'Mon FMDD, YYYY'),
    'email_subject', s.subject
  ), 'requester');
  return coalesce(nullif(rendered, ''), s.subject);
end;
$$;

revoke all on function public.submitter_response_subject(uuid, uuid) from public, anon, authenticated;

-- A response comment, its thread, and its outbox email all carry that one subject.
select public.alhc_patch_function(
  'public.fill_comment_email()'::regprocedure,
  $p$  new.email_subject := s.subject;$p$,
  $p$  new.email_subject := coalesce(public.submitter_response_subject(new.task_id, new.author_id), s.subject);$p$
);

select public.alhc_patch_function(
  'public.on_comment_submitter_response()'::regprocedure,
  $p$  values (root.id, s.submission_id, s.submitter_email, s.subject, left(public.inbound_random_hex(), 40), new.author_id)$p$,
  $p$  values (root.id, s.submission_id, s.submitter_email, new.email_subject, left(public.inbound_random_hex(), 40), new.author_id)$p$
);

-- The pane's optimistic response card uses the conversation's subject (task Viewers already see it on
-- the sent and received cards).
select public.alhc_patch_function(
  'public.submitter_thread_status(uuid)'::regprocedure,
  $p$      'submitter_email', k.submitter_email,$p$,
  $p$      'submitter_email', k.submitter_email,
      'subject', k.subject,$p$
);

-- =============================================================================================
-- Statements that must run last (applied by hand) go after the marker below. None this time.
-- =============================================================================================
-- TAIL
