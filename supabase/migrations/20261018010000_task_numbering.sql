-- ALHC Projects — Task numbering (request numbers).
--
-- The simple switch turns numbering on for a project. New top-level tasks take the next number
-- from a per-project counter (row lock). Existing tasks can be numbered in creation order in one
-- statement. Turning numbering off stops new numbers and hides labels; the stored numbers stay.
--
-- Advanced rules live on request_sequences: a format template, a start number, reuse of numbers
-- freed after reuse was turned on (or every gap, when fill-all-gaps is chosen), a yearly or
-- monthly reset, one single-select field with its own counter per option, subtask indexes
-- (484.1, 484.2.1), and a scope (every task, forms, sections, or task types). Moving a task
-- keeps the number from the project that issued it unless that project opts in to renumbering.
--
-- Labels are rendered. add_to_title still prefixes the stored title when it is on, so the
-- release already on main and the older smoke tests keep today's titles. Sequences that already
-- exist when this migration runs stop prefixing the title; the label is rendered instead.
-- New sequences still default add_to_title on until the new settings screen turns it off.
--
-- format_request_label and task_request_label become SECURITY INVOKER. A non-member reads
-- nothing (RLS on request_sequences and tasks). Calls from definer functions still see the rows
-- the owner sees, so form confirmations and rule emails keep their labels.
--
-- apply_task_numbering (Editor+; Renumber is project admin or workspace admin) is the one new
-- client SECURITY DEFINER function. It checks has_project_role / is_workspace_admin.
-- The tail retires the old unique index that also covered trashed tasks, so a freed number can
-- be stored again. Nothing above depends on that.

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
-- Settings and stored numbers
-- ---------------------------------------------------------------------------

alter table public.request_sequences
  add column template text not null default 'Req #{n}'
    constraint request_sequences_template_check check (char_length(template) between 1 and 200),
  add column wrap_brackets boolean not null default true,
  add column number_subtasks boolean not null default true,
  add column subtask_separator text not null default '.'
    constraint request_sequences_separator_check check (subtask_separator in ('.', '-', '/')),
  add column number_scope text not null default 'inherit'
    constraint request_sequences_scope_check
      check (number_scope in ('inherit', 'all_tasks', 'form_submissions', 'sections', 'kinds')),
  add column section_ids uuid[] not null default '{}',
  add column task_kinds text[] not null default '{}',
  add column reuse_deleted boolean not null default false,
  add column reuse_since timestamptz,
  add column fill_gaps boolean not null default false,
  add column reset_period text not null default 'never'
    constraint request_sequences_reset_check check (reset_period in ('never', 'yearly', 'monthly')),
  add column counter_field_id uuid,
  add column project_code text
    constraint request_sequences_project_code_check
      check (project_code is null or project_code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,11}$'),
  add column renumber_on_move boolean not null default false,
  add column time_zone text not null default 'UTC',
  add column start_number bigint not null default 1
    constraint request_sequences_start_number_check check (start_number >= 1);

alter table public.request_sequences
  add constraint request_sequences_counter_field_fkey
  foreign key (counter_field_id) references public.custom_fields (id);

create index request_sequences_counter_field_idx
  on public.request_sequences (counter_field_id);

-- Keep a custom prefix / pad working: Req # + 3 digits becomes Req #{n:3}.
update public.request_sequences
set template = prefix || case when pad_width > 0 then '{n:' || pad_width::text || '}' else '{n}' end
where template = 'Req #{n}'
  and (prefix is distinct from 'Req #' or pad_width is distinct from 0);

alter table public.tasks
  add column req_subindex integer
    constraint tasks_req_subindex_check check (req_subindex is null or req_subindex > 0),
  add column req_path text,
  add column req_label text,
  add column req_period text not null default '',
  add column req_counter_key text not null default '';

create index tasks_req_path_idx on public.tasks (req_path) where req_path is not null;

create unique index tasks_req_subindex_idx
  on public.tasks (parent_task_id, req_subindex)
  where req_subindex is not null and deleted_at is null;

-- Active top-level numbers, including the reset period and the per-option counter.
-- The older index (project, number), which also covers trashed rows, stays until the tail.
create unique index tasks_req_number_scope_idx
  on public.tasks (req_project_id, req_period, req_counter_key, req_number)
  where req_number is not null and deleted_at is null;

-- Numbers freed for reuse. A consumed row stays (consumed_at); nothing is removed.
do $do$
begin
  execute $sql$
    create table public.request_number_gaps (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references public.projects (id),
      period_key text not null default '',
      counter_key text not null default '',
      number bigint not null constraint request_number_gaps_number_check check (number > 0),
      freed_at timestamptz not null default now(),
      consumed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz
    )
  $sql$;
  execute 'alter table public.request_number_gaps enable row level security';
  execute 'revoke all on public.request_number_gaps from anon, authenticated';
end;
$do$;

create unique index request_number_gaps_open_idx
  on public.request_number_gaps (project_id, period_key, counter_key, number)
  where consumed_at is null and deleted_at is null;

create index request_number_gaps_project_idx on public.request_number_gaps (project_id);

create policy request_number_gaps_select_viewer on public.request_number_gaps
  for select to authenticated
  using ((select public.has_project_role(project_id, 'viewer')));

grant select on public.request_number_gaps to authenticated;

comment on table public.request_number_gaps is
  'Task numbering: numbers freed after reuse was turned on (or by fill-all-gaps). '
  'The next new task takes the lowest open number. consumed_at means a task took it.';

-- One counter per period and per field option. The plain counter (period '', key '')
-- stays on request_sequences.last_number so existing sequences are unchanged.
do $do$
begin
  execute $sql$
    create table public.request_counters (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references public.projects (id),
      period_key text not null default '',
      counter_key text not null default '',
      last_number bigint not null default 0
        constraint request_counters_last_number_check check (last_number >= 0),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz,
      constraint request_counters_key unique (project_id, period_key, counter_key)
    )
  $sql$;
  execute 'alter table public.request_counters enable row level security';
  execute 'revoke all on public.request_counters from anon, authenticated';
end;
$do$;

create index request_counters_project_idx on public.request_counters (project_id);

create policy request_counters_select_viewer on public.request_counters
  for select to authenticated
  using ((select public.has_project_role(project_id, 'viewer')));

grant select on public.request_counters to authenticated;

comment on table public.request_counters is
  'Task numbering: last number issued for one reset period and one field option. '
  'The default counter (no period, no option) remains request_sequences.last_number.';

select public.alhc_revoke_anon_grants(array['request_number_gaps', 'request_counters']);

-- ---------------------------------------------------------------------------
-- Rendering
-- ---------------------------------------------------------------------------

-- Pulls 484, #484, Req 484, Req #484, [Req #484], or 484.2.1 out of a search box.
create or replace function public.request_number_query(raw text)
returns text
language sql
immutable
set search_path = ''
as $$
  select (regexp_match(
    btrim(raw),
    '^\[?(?:req[[:space:]]*)?#?[[:space:]]*([0-9]+(?:\.[0-9]+)*)\]?$',
    'i'
  ))[1];
$$;

revoke all on function public.request_number_query(text) from public, anon;
grant execute on function public.request_number_query(text) to authenticated;

create or replace function public.request_number_period(
  created_at timestamptz,
  reset_period text,
  zone text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case reset_period
    when 'yearly' then to_char(created_at at time zone public.safe_timezone(zone), 'YYYY')
    when 'monthly' then to_char(created_at at time zone public.safe_timezone(zone), 'YYYY-MM')
    else ''
  end;
$$;

revoke all on function public.request_number_period(timestamptz, text, text) from public, anon, authenticated;

-- template tokens: {n} {n:4} {yyyy} {yy} {mm} {project} {parent}. {field:Name} is replaced by the caller.
create or replace function public.render_request_template(
  template text,
  number_text text,
  created_at timestamptz,
  zone text,
  project_code text,
  field_text text,
  parent_label text
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  result text := coalesce(template, '');
  pad text;
  stamp timestamptz := coalesce(created_at, now());
  z text := public.safe_timezone(zone);
begin
  result := replace(result, '{field}', coalesce(field_text, ''));
  while result ~ '\{n:[0-9]+\}' loop
    pad := substring(result from '\{n:([0-9]+)\}');
    result := regexp_replace(
      result,
      '\{n:[0-9]+\}',
      lpad(coalesce(number_text, ''), least(greatest(pad::int, 0), 12), '0')
    );
  end loop;
  result := replace(result, '{n}', coalesce(number_text, ''));
  result := replace(result, '{yyyy}', to_char(stamp at time zone z, 'YYYY'));
  result := replace(result, '{yy}', to_char(stamp at time zone z, 'YY'));
  result := replace(result, '{mm}', to_char(stamp at time zone z, 'MM'));
  result := replace(result, '{project}', coalesce(project_code, ''));
  result := replace(result, '{parent}', coalesce(parent_label, ''));
  return result;
end;
$$;

revoke all on function public.render_request_template(text, text, timestamptz, text, text, text, text) from public, anon;
grant execute on function public.render_request_template(text, text, timestamptz, text, text, text, text) to authenticated;

-- The label for a task the caller can read. Null when the task has no number.
-- Does not look at enabled: callers that hide a paused sequence check that themselves.
create or replace function public.compose_request_label(target_task uuid)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  t public.tasks;
  s public.request_sequences;
  tpl text;
  fname text;
  val text;
  field_type text;
  options jsonb;
  raw jsonb;
  parent_label text;
begin
  select * into t from public.tasks where id = target_task;
  if not found or (t.req_number is null and t.req_path is null and t.req_subindex is null) then
    return null;
  end if;
  select * into s from public.request_sequences
  where project_id = coalesce(t.req_project_id, t.home_project_id) and deleted_at is null;
  if not found then
    return null;
  end if;
  tpl := s.template;
  while tpl ~ '\{field:[^}]+\}' loop
    fname := btrim(substring(tpl from '\{field:([^}]+)\}'));
    val := '';
    select cf.field_type, cf.options, v.value
      into field_type, options, raw
    from public.custom_fields cf
    left join public.task_field_values v on v.field_id = cf.id and v.task_id = t.id
    where cf.deleted_at is null
      and lower(btrim(cf.name)) = lower(fname)
      and cf.project_id in (
        select tp.project_id from public.task_projects tp
        where tp.task_id = coalesce(t.root_task_id, t.id) and tp.deleted_at is null
      )
    limit 1;
    if field_type = 'single_select' then
      select o ->> 'name' into val
      from jsonb_array_elements(coalesce(options, '[]'::jsonb)) o
      where o ->> 'id' = raw #>> '{}'
      limit 1;
    elsif field_type = 'multi_select' then
      select o ->> 'name' into val
      from jsonb_array_elements(coalesce(options, '[]'::jsonb)) o
      where raw @> jsonb_build_array(o ->> 'id')
      limit 1;
    else
      val := raw #>> '{}';
    end if;
    tpl := regexp_replace(tpl, '\{field:[^}]+\}', coalesce(val, ''), '');
  end loop;
  parent_label := (
    select p.req_label from public.tasks p where p.id = t.parent_task_id
  );
  return public.render_request_template(
    tpl,
    coalesce(t.req_path, t.req_number::text),
    t.created_at,
    s.time_zone,
    s.project_code,
    null,
    parent_label
  );
end;
$$;

revoke all on function public.compose_request_label(uuid) from public, anon;
grant execute on function public.compose_request_label(uuid) to authenticated;

create or replace function public.format_request_label(target_project uuid, number bigint)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select public.render_request_template(
    s.template, number::text, now(), s.time_zone, s.project_code, null, null
  )
  from public.request_sequences s
  where s.project_id = target_project and s.deleted_at is null and number is not null;
$$;

revoke all on function public.format_request_label(uuid, bigint) from public, anon;
grant execute on function public.format_request_label(uuid, bigint) to authenticated;

create or replace function public.task_request_label(target_task uuid)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select case when s.enabled then public.compose_request_label(t.id) else null end
  from public.tasks t
  join public.request_sequences s
    on s.project_id = coalesce(t.req_project_id, t.home_project_id)
   and s.deleted_at is null
  where t.id = target_task
    and (t.req_number is not null or t.req_path is not null or t.req_subindex is not null);
$$;

revoke all on function public.task_request_label(uuid) from public, anon;
grant execute on function public.task_request_label(uuid) to authenticated;

-- Existing numbered tasks: path + label, then stop baking the prefix into the title.
update public.tasks
set req_path = req_number::text
where req_number is not null and req_path is null;

update public.tasks t
set req_label = public.compose_request_label(t.id)
where t.req_number is not null and t.req_label is null;

update public.tasks t
set title = substr(t.title, char_length('[' || t.req_label || '] ') + 1)
where t.req_label is not null
  and char_length(t.title) > char_length('[' || t.req_label || '] ')
  and left(t.title, char_length('[' || t.req_label || '] ')) = '[' || t.req_label || '] ';

update public.request_sequences
set add_to_title = false
where deleted_at is null and add_to_title;

-- ---------------------------------------------------------------------------
-- Counter, scope, assign
-- ---------------------------------------------------------------------------

create or replace function public.guard_request_sequence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.last_number < old.last_number
     and coalesce(current_setting('alhc.renumber', true), '') <> '1' then
    raise exception 'Request numbers can only move forward (last issued: %)', old.last_number
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Validates a settings change and keeps the template in step with an older prefix / pad edit.
-- A counter bump (last_number only) does not re-check the template.
create or replace function public.guard_request_sequence_settings()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  scope text;
  sec uuid;
  kind text;
  field public.custom_fields;
begin
  if tg_op = 'UPDATE'
     and new.template is not distinct from old.template
     and new.prefix is not distinct from old.prefix
     and new.pad_width is not distinct from old.pad_width
     and new.number_scope is not distinct from old.number_scope
     and new.section_ids is not distinct from old.section_ids
     and new.task_kinds is not distinct from old.task_kinds
     and new.reset_period is not distinct from old.reset_period
     and new.counter_field_id is not distinct from old.counter_field_id
     and new.project_code is not distinct from old.project_code
     and new.subtask_separator is not distinct from old.subtask_separator
     and new.time_zone is not distinct from old.time_zone
     and new.start_number is not distinct from old.start_number
     and new.enabled is not distinct from old.enabled
     and new.reuse_deleted is not distinct from old.reuse_deleted then
    return new;
  end if;

  new.time_zone := public.safe_timezone(new.time_zone);
  new.template := btrim(new.template);
  if new.template !~ '\{n(:[0-9]+)?\}' then
    raise exception 'The format needs the {n} counter' using errcode = 'check_violation';
  end if;
  if new.reset_period <> 'never' and new.template !~ '\{yyyy\}|\{yy\}|\{mm\}' then
    raise exception 'A yearly or monthly reset needs {yyyy}, {yy}, or {mm} in the format so labels stay unique'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'INSERT' and new.template = 'Req #{n}'
     and (new.prefix is distinct from 'Req #' or new.pad_width is distinct from 0) then
    new.template := new.prefix || case when new.pad_width > 0 then '{n:' || new.pad_width::text || '}' else '{n}' end;
  elsif tg_op = 'UPDATE'
        and new.template is not distinct from old.template
        and (new.prefix is distinct from old.prefix or new.pad_width is distinct from old.pad_width) then
    new.template := new.prefix || case when new.pad_width > 0 then '{n:' || new.pad_width::text || '}' else '{n}' end;
  end if;

  if new.reuse_deleted and (tg_op = 'INSERT' or not old.reuse_deleted) then
    new.reuse_since := coalesce(new.reuse_since, now());
  end if;

  scope := case when new.number_scope = 'inherit' then new.assign_to else new.number_scope end;
  if scope = 'sections' then
    if coalesce(cardinality(new.section_ids), 0) = 0 then
      raise exception 'Choose at least one section to number' using errcode = 'check_violation';
    end if;
    foreach sec in array new.section_ids loop
      if not exists (
        select 1 from public.sections s
        where s.id = sec and s.project_id = new.project_id and s.deleted_at is null
      ) then
        raise exception 'That section is not in this project' using errcode = 'check_violation';
      end if;
    end loop;
  end if;
  if scope = 'kinds' then
    if coalesce(cardinality(new.task_kinds), 0) = 0 then
      raise exception 'Choose at least one task type to number' using errcode = 'check_violation';
    end if;
    foreach kind in array new.task_kinds loop
      if kind not in ('task', 'milestone', 'approval') then
        raise exception 'Unknown task type' using errcode = 'check_violation';
      end if;
    end loop;
  end if;
  if new.counter_field_id is not null then
    select * into field from public.custom_fields
    where id = new.counter_field_id and deleted_at is null;
    if not found or field.project_id <> new.project_id or field.field_type <> 'single_select'
       or field.bound_to_sections then
      raise exception 'The counter field must be a single-select field in this project'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_request_sequence_settings() from public, anon, authenticated;

create trigger request_sequences_06_settings
  before insert or update on public.request_sequences
  for each row execute function public.guard_request_sequence_settings();

-- Next number. Locks the sequence row. Takes the lowest freed number first when reuse is on.
create or replace function public.allocate_request_number(
  target_project uuid,
  period_key text,
  counter_key text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  seq public.request_sequences;
  n bigint;
  period text := coalesce(period_key, '');
  ckey text := coalesce(counter_key, '');
begin
  select * into seq from public.request_sequences
  where project_id = target_project and deleted_at is null
  for update;
  if not found or not seq.enabled then
    return null;
  end if;

  if seq.reuse_deleted then
    update public.request_number_gaps g
    set consumed_at = now()
    where g.id = (
      select id from public.request_number_gaps
      where project_id = target_project
        and period_key = period
        and counter_key = ckey
        and consumed_at is null
        and deleted_at is null
      order by number
      limit 1
      for update
    )
    returning g.number into n;
    if n is not null then
      return n;
    end if;
  end if;

  if period = '' and ckey = '' then
    update public.request_sequences
    set last_number = last_number + 1
    where project_id = target_project
    returning last_number into n;
    return n;
  end if;

  insert into public.request_counters (project_id, period_key, counter_key, last_number)
  values (target_project, period, ckey, greatest(seq.start_number - 1, 0))
  on conflict (project_id, period_key, counter_key) do nothing;

  update public.request_counters
  set last_number = last_number + 1
  where project_id = target_project and period_key = period and counter_key = ckey and deleted_at is null
  returning last_number into n;
  return n;
end;
$$;

revoke all on function public.allocate_request_number(uuid, text, text) from public, anon, authenticated;

create or replace function public.next_request_number(target_project uuid)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select public.allocate_request_number(target_project, '', '');
$$;

revoke all on function public.next_request_number(uuid) from public, anon, authenticated;

create or replace function public.request_number_in_scope(
  target_task uuid,
  seq public.request_sequences
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t public.tasks;
  scope text;
  sec uuid;
begin
  select * into t from public.tasks where id = target_task;
  if not found then
    return false;
  end if;
  scope := case when seq.number_scope = 'inherit' then seq.assign_to else seq.number_scope end;
  if scope = 'form_submissions' and t.source is distinct from 'form' then
    return false;
  end if;
  if scope = 'kinds' and not (t.kind = any (seq.task_kinds)) then
    return false;
  end if;
  if scope = 'sections' then
    select tp.section_id into sec
    from public.task_projects tp
    where tp.task_id = t.id and tp.project_id = t.home_project_id and tp.deleted_at is null
    limit 1;
    if sec is null or not (sec = any (seq.section_ids)) then
      return false;
    end if;
  end if;
  if seq.counter_field_id is not null and not exists (
    select 1 from public.task_field_values v
    where v.task_id = t.id and v.field_id = seq.counter_field_id and v.value is not null
      and v.value <> 'null'::jsonb
  ) then
    return false;
  end if;
  return scope in ('all_tasks', 'form_submissions', 'sections', 'kinds');
end;
$$;

revoke all on function public.request_number_in_scope(uuid, public.request_sequences) from public, anon, authenticated;

-- Numbers one existing top-level task. force skips the scope (the on-demand button).
create or replace function public.ensure_request_number(target_task uuid, force boolean default false)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tasks;
  seq public.request_sequences;
  period text;
  ckey text;
  number bigint;
  label text;
  prefix text;
begin
  select * into t from public.tasks where id = target_task and deleted_at is null for update;
  if not found or t.parent_task_id is not null or t.req_number is not null or t.home_project_id is null then
    return null;
  end if;
  select * into seq from public.request_sequences
  where project_id = t.home_project_id and enabled and deleted_at is null
  for update;
  if not found then
    return null;
  end if;
  if not force and not public.request_number_in_scope(t.id, seq) then
    return null;
  end if;
  period := public.request_number_period(t.created_at, seq.reset_period, seq.time_zone);
  ckey := '';
  if seq.counter_field_id is not null then
    select coalesce(v.value #>> '{}', '') into ckey
    from public.task_field_values v
    where v.task_id = t.id and v.field_id = seq.counter_field_id;
    if ckey is null then
      ckey := '';
    end if;
  end if;
  number := public.allocate_request_number(t.home_project_id, period, ckey);
  if number is null then
    return null;
  end if;
  update public.tasks
  set req_project_id = t.home_project_id,
      req_number = number,
      req_period = period,
      req_counter_key = ckey,
      req_path = number::text
  where id = t.id;
  label := public.compose_request_label(t.id);
  prefix := case when seq.wrap_brackets then '[' || label || '] ' else label || ' ' end;
  update public.tasks
  set req_label = label,
      title = case
        when seq.add_to_title and left(title, char_length(prefix)) is distinct from prefix then prefix || title
        else title
      end
  where id = t.id;
  return label;
end;
$$;

revoke all on function public.ensure_request_number(uuid, boolean) from public, anon, authenticated;

create or replace function public.guard_task_system_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.is_client_role() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.source <> 'manual' or new.req_number is not null or new.req_project_id is not null
       or new.req_subindex is not null or new.req_path is not null or new.req_label is not null
       or new.req_period is distinct from '' or new.req_counter_key is distinct from '' then
      raise exception 'Task source and request numbers are managed by the system'
        using errcode = 'insufficient_privilege';
    end if;
  elsif new.source is distinct from old.source
     or new.req_number is distinct from old.req_number
     or new.req_project_id is distinct from old.req_project_id
     or new.req_subindex is distinct from old.req_subindex
     or new.req_path is distinct from old.req_path
     or new.req_label is distinct from old.req_label
     or new.req_period is distinct from old.req_period
     or new.req_counter_key is distinct from old.req_counter_key then
    raise exception 'Task source and request numbers are managed by the system'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create or replace function public.assign_request_number_on_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  seq public.request_sequences;
  parent public.tasks;
  scope text;
  number bigint;
  label text;
  period text;
  idx integer;
  prefix text;
begin
  if new.parent_task_id is not null then
    if new.req_subindex is not null or new.home_project_id is null then
      return new;
    end if;
    select * into seq from public.request_sequences
    where project_id = new.home_project_id and enabled and deleted_at is null;
    if not found or not seq.number_subtasks then
      return new;
    end if;
    perform 1 from public.tasks where id = new.parent_task_id for update;
    select * into parent from public.tasks where id = new.parent_task_id;
    if parent.req_path is null then
      return new;
    end if;
    if seq.reuse_deleted then
      update public.request_number_gaps g
      set consumed_at = now()
      where g.id = (
        select id from public.request_number_gaps
        where project_id = seq.project_id
          and counter_key = 'sub:' || new.parent_task_id::text
          and consumed_at is null and deleted_at is null
        order by number
        limit 1
        for update
      )
      returning g.number into idx;
    end if;
    if idx is null then
      select coalesce(max(c.req_subindex), 0) + 1 into idx
      from public.tasks c
      where c.parent_task_id = new.parent_task_id and c.deleted_at is null;
    end if;
    new.req_subindex := idx;
    new.req_path := parent.req_path || seq.subtask_separator || idx::text;
    new.req_label := public.render_request_template(
      seq.template,
      new.req_path,
      coalesce(new.created_at, now()),
      seq.time_zone,
      seq.project_code,
      null,
      parent.req_label
    );
    return new;
  end if;

  if new.req_number is not null or new.home_project_id is null then
    return new;
  end if;
  select * into seq from public.request_sequences
  where project_id = new.home_project_id and enabled and deleted_at is null;
  if not found then
    return new;
  end if;
  scope := case when seq.number_scope = 'inherit' then seq.assign_to else seq.number_scope end;
  if scope = 'form_submissions' and new.source is distinct from 'form' then
    return new;
  end if;
  if scope = 'kinds' and not (new.kind = any (seq.task_kinds)) then
    return new;
  end if;
  -- The section and the counter field are written after the task row.
  if scope = 'sections' or seq.counter_field_id is not null then
    return new;
  end if;
  if scope not in ('all_tasks', 'form_submissions', 'kinds') then
    return new;
  end if;

  period := public.request_number_period(coalesce(new.created_at, now()), seq.reset_period, seq.time_zone);
  number := public.allocate_request_number(new.home_project_id, period, '');
  if number is null then
    return new;
  end if;
  new.req_project_id := new.home_project_id;
  new.req_number := number;
  new.req_period := period;
  new.req_counter_key := '';
  new.req_path := number::text;
  label := public.render_request_template(
    seq.template, number::text, coalesce(new.created_at, now()), seq.time_zone, seq.project_code, null, null
  );
  new.req_label := label;
  if seq.add_to_title then
    prefix := case when seq.wrap_brackets then '[' || label || '] ' else label || ' ' end;
    new.title := prefix || new.title;
  end if;
  return new;
end;
$$;

revoke all on function public.assign_request_number_on_insert() from public, anon, authenticated;

create or replace function public.assign_request_number(target_task uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tasks;
  label text;
begin
  if not public.has_task_role(target_task, 'editor') then
    raise exception 'You need Editor access to number this task' using errcode = 'insufficient_privilege';
  end if;
  select * into t from public.tasks where id = target_task and deleted_at is null for update;
  if not found then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if t.parent_task_id is not null then
    raise exception 'Subtasks don’t get request numbers' using errcode = 'check_violation';
  end if;
  if t.req_number is not null then
    return public.format_request_label(t.req_project_id, t.req_number);
  end if;
  label := public.ensure_request_number(target_task, true);
  if label is null then
    raise exception 'Request numbers are not enabled for this task''s home project'
      using errcode = 'check_violation';
  end if;
  return label;
end;
$$;

revoke all on function public.assign_request_number(uuid) from public, anon;
grant execute on function public.assign_request_number(uuid) to authenticated;

-- Later, once a section or a counter field exists.
create or replace function public.assign_request_number_when_ready()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  task uuid;
begin
  if tg_table_name = 'task_field_values' then
    task := new.task_id;
  elsif tg_table_name = 'task_projects' then
    task := new.task_id;
  else
    task := new.id;
  end if;
  if exists (
    select 1 from public.tasks t
    where t.id = task and t.parent_task_id is null and t.req_number is null and t.deleted_at is null
  ) then
    perform public.ensure_request_number(task, false);
  end if;
  return new;
end;
$$;

revoke all on function public.assign_request_number_when_ready() from public, anon, authenticated;

create trigger task_projects_15_number
  after insert or update of section_id on public.task_projects
  for each row execute function public.assign_request_number_when_ready();

create trigger task_field_values_15_number
  after insert or update of value on public.task_field_values
  for each row execute function public.assign_request_number_when_ready();

create trigger tasks_24_number_kind
  after update of kind on public.tasks
  for each row execute function public.assign_request_number_when_ready();

create or replace function public.story_request_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.import_context_id() is not null or public.copy_context_id() is not null then
    return new;
  end if;
  if new.req_label is not null and (tg_op = 'INSERT' or new.req_label is distinct from old.req_label) then
    perform public.add_story(new.id, 'request_number_assigned', jsonb_build_object(
      'label', new.req_label,
      'number', new.req_number,
      'path', new.req_path
    ));
  end if;
  return new;
end;
$$;

revoke all on function public.story_request_number() from public, anon, authenticated;

create trigger tasks_21_request_number_story
  after insert or update of req_label on public.tasks
  for each row execute function public.story_request_number();

-- A trashed task frees its number only after reuse is on, and only for numbers
-- freed from then on (deleted_at >= reuse_since), unless fill-all-gaps already ran.
create or replace function public.free_request_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  seq public.request_sequences;
  home uuid;
begin
  if new.deleted_at is null or old.deleted_at is not null then
    return new;
  end if;
  home := coalesce(new.req_project_id, new.home_project_id);
  select * into seq from public.request_sequences where project_id = home and deleted_at is null;
  if not found or not seq.reuse_deleted then
    return new;
  end if;
  if not seq.fill_gaps and new.deleted_at < coalesce(seq.reuse_since, new.deleted_at) then
    return new;
  end if;
  if new.parent_task_id is null and new.req_number is not null then
    insert into public.request_number_gaps (project_id, period_key, counter_key, number)
    select new.req_project_id, new.req_period, new.req_counter_key, new.req_number
    where not exists (
      select 1 from public.request_number_gaps g
      where g.project_id = new.req_project_id
        and g.period_key = new.req_period
        and g.counter_key = new.req_counter_key
        and g.number = new.req_number
        and g.consumed_at is null and g.deleted_at is null
    );
  elsif new.req_subindex is not null then
    insert into public.request_number_gaps (project_id, period_key, counter_key, number)
    select seq.project_id, '', 'sub:' || new.parent_task_id::text, new.req_subindex
    where not exists (
      select 1 from public.request_number_gaps g
      where g.project_id = seq.project_id
        and g.counter_key = 'sub:' || new.parent_task_id::text
        and g.number = new.req_subindex
        and g.consumed_at is null and g.deleted_at is null
    );
  end if;
  return new;
end;
$$;

revoke all on function public.free_request_number() from public, anon, authenticated;

create trigger tasks_22_free_request_number
  after update of deleted_at on public.tasks
  for each row execute function public.free_request_number();

create or replace function public.maybe_renumber_on_move()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  seq public.request_sequences;
begin
  if new.parent_task_id is not null
     or new.home_project_id is not distinct from old.home_project_id
     or new.home_project_id is null then
    return new;
  end if;
  select * into seq from public.request_sequences
  where project_id = new.home_project_id and enabled and deleted_at is null;
  if not found or not seq.renumber_on_move then
    return new;
  end if;
  if old.req_project_id is not distinct from new.home_project_id then
    return new;
  end if;
  update public.tasks
  set req_number = null, req_project_id = null, req_path = null, req_label = null,
      req_period = '', req_counter_key = ''
  where id = new.id;
  perform public.ensure_request_number(new.id, true);
  return new;
end;
$$;

revoke all on function public.maybe_renumber_on_move() from public, anon, authenticated;

create trigger tasks_23_renumber_on_move
  after update of home_project_id on public.tasks
  for each row execute function public.maybe_renumber_on_move();

-- Numbers every matching top-level task in one statement, then subtask indexes.
create or replace function public.number_project_tasks(target_project uuid, renumber boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  seq public.request_sequences;
  numbered integer := 0;
  touched integer := 0;
  round integer;
begin
  select * into seq from public.request_sequences
  where project_id = target_project and deleted_at is null
  for update;
  if not found or not seq.enabled then
    return 0;
  end if;

  if renumber then
    perform set_config('alhc.renumber', '1', true);
    update public.tasks t
    set req_number = null, req_project_id = null, req_path = null, req_label = null,
        req_subindex = null, req_period = '', req_counter_key = ''
    where t.deleted_at is null
      and (t.home_project_id = target_project or t.req_project_id = target_project);
    update public.request_sequences
    set last_number = greatest(start_number - 1, 0)
    where project_id = target_project;
    update public.request_counters
    set last_number = greatest(seq.start_number - 1, 0)
    where project_id = target_project;
    update public.request_number_gaps
    set consumed_at = now()
    where project_id = target_project and consumed_at is null;
  end if;

  with cand as (
    select t.id,
           t.created_at,
           public.request_number_period(t.created_at, seq.reset_period, seq.time_zone) as period_key,
           case
             when seq.counter_field_id is null then ''
             else coalesce(fv.value #>> '{}', '')
           end as counter_key
    from public.tasks t
    left join public.task_field_values fv
      on fv.task_id = t.id and fv.field_id = seq.counter_field_id
    where t.home_project_id = target_project
      and t.parent_task_id is null
      and t.deleted_at is null
      and (renumber or t.req_number is null)
      and public.request_number_in_scope(t.id, seq)
      and (seq.counter_field_id is null or fv.value is not null)
  ),
  ranked as (
    select id, period_key, counter_key,
           row_number() over (partition by period_key, counter_key order by created_at, id) as rn
    from cand
  ),
  bases as (
    select r.period_key, r.counter_key,
           case
             when renumber then greatest(seq.start_number - 1, 0)
             when r.period_key = '' and r.counter_key = '' then seq.last_number
             else coalesce(
               (select c.last_number from public.request_counters c
                where c.project_id = target_project and c.period_key = r.period_key
                  and c.counter_key = r.counter_key and c.deleted_at is null),
               greatest(seq.start_number - 1, 0)
             )
           end as base
    from ranked r
    group by r.period_key, r.counter_key
  ),
  assigned as (
    update public.tasks t
    set req_project_id = target_project,
        req_number = b.base + r.rn,
        req_period = r.period_key,
        req_counter_key = r.counter_key,
        req_path = (b.base + r.rn)::text
    from ranked r
    join bases b on b.period_key = r.period_key and b.counter_key = r.counter_key
    where t.id = r.id
    returning t.req_period, t.req_counter_key, t.req_number
  )
  select count(*)::int into numbered from assigned;

  update public.request_sequences s
  set last_number = greatest(s.last_number, coalesce((
    select max(t.req_number) from public.tasks t
    where t.req_project_id = target_project and t.req_period = '' and t.req_counter_key = ''
      and t.deleted_at is null
  ), s.last_number))
  where s.project_id = target_project;

  insert into public.request_counters (project_id, period_key, counter_key, last_number)
  select target_project, t.req_period, t.req_counter_key, max(t.req_number)
  from public.tasks t
  where t.req_project_id = target_project and t.deleted_at is null
    and not (t.req_period = '' and t.req_counter_key = '')
  group by t.req_period, t.req_counter_key
  on conflict (project_id, period_key, counter_key)
  do update set last_number = greatest(public.request_counters.last_number, excluded.last_number);

  if seq.number_subtasks then
    if renumber then
      update public.tasks c
      set req_subindex = null, req_path = null, req_label = null
      where c.deleted_at is null and c.parent_task_id is not null and c.home_project_id = target_project;
    end if;
    for round in 1..4 loop
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
      get diagnostics touched = row_count;
      numbered := numbered + touched;
      update public.tasks c
      set req_path = p.req_path || seq.subtask_separator || c.req_subindex::text
      from public.tasks p
      where c.parent_task_id = p.id
        and c.req_subindex is not null
        and c.deleted_at is null
        and p.req_path is not null
        and c.home_project_id = target_project;
    end loop;
  else
    for round in 1..4 loop
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
    and t.home_project_id = target_project
    and t.parent_task_id is null
    and t.req_number is not null;

  for round in 1..4 loop
    update public.tasks c
    set req_label = public.compose_request_label(c.id)
    where c.deleted_at is null
      and c.req_subindex is not null
      and c.home_project_id = target_project
      and exists (
        select 1 from public.tasks p
        where p.id = c.parent_task_id and p.req_label is not null
      );
  end loop;

  return numbered;
end;
$$;

revoke all on function public.number_project_tasks(uuid, boolean) from public, anon, authenticated;

create or replace function public.fill_request_number_gaps(target_project uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  seq public.request_sequences;
begin
  select * into seq from public.request_sequences
  where project_id = target_project and deleted_at is null;
  if not found or seq.last_number < 1 then
    return;
  end if;
  insert into public.request_number_gaps (project_id, period_key, counter_key, number)
  select target_project, '', '', g.n
  from generate_series(1, seq.last_number) as g(n)
  where not exists (
    select 1 from public.tasks t
    where t.req_project_id = target_project and t.req_number = g.n and t.deleted_at is null
      and t.req_period = '' and t.req_counter_key = ''
  )
  and not exists (
    select 1 from public.request_number_gaps gap
    where gap.project_id = target_project and gap.period_key = '' and gap.counter_key = ''
      and gap.number = g.n and gap.consumed_at is null and gap.deleted_at is null
  );
end;
$$;

revoke all on function public.fill_request_number_gaps(uuid) from public, anon, authenticated;

-- Editor+ saves settings and can number tasks that do not have one yet.
-- mode renumber is project admin or workspace admin and needs confirmation RENUMBER.
create or replace function public.apply_task_numbering(
  target_project uuid,
  settings jsonb,
  mode text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  proj public.projects;
  seq public.request_sequences;
  numbered integer := 0;
  editor_ok boolean;
  admin_ok boolean;
begin
  if mode not in ('save', 'number_missing', 'renumber') then
    raise exception 'Unknown numbering action' using errcode = 'check_violation';
  end if;
  select * into proj from public.projects where id = target_project and deleted_at is null;
  if not found then
    raise exception 'Project not found' using errcode = 'no_data_found';
  end if;
  editor_ok := public.has_project_role(target_project, 'editor');
  admin_ok := public.has_project_role(target_project, 'admin')
    or public.is_workspace_admin(proj.workspace_id);
  if mode = 'renumber' then
    if not admin_ok then
      raise exception 'Only a project admin can renumber every task' using errcode = 'insufficient_privilege';
    end if;
    if coalesce(settings ->> 'confirmation', '') <> 'RENUMBER' then
      raise exception 'Type RENUMBER to renumber every task' using errcode = 'check_violation';
    end if;
  elsif not editor_ok then
    raise exception 'You need Editor access to change task numbering' using errcode = 'insufficient_privilege';
  end if;

  insert into public.request_sequences (project_id, enabled)
  values (target_project, false)
  on conflict (project_id) do nothing;

  if settings is not null and jsonb_typeof(settings) = 'object' then
    update public.request_sequences s
    set enabled = case when settings ? 'enabled' then (settings ->> 'enabled')::boolean else s.enabled end,
        template = case when settings ? 'template' then settings ->> 'template' else s.template end,
        wrap_brackets = case when settings ? 'wrap_brackets' then (settings ->> 'wrap_brackets')::boolean else s.wrap_brackets end,
        add_to_title = case when settings ? 'add_to_title' then (settings ->> 'add_to_title')::boolean else s.add_to_title end,
        number_subtasks = case when settings ? 'number_subtasks' then (settings ->> 'number_subtasks')::boolean else s.number_subtasks end,
        subtask_separator = case when settings ? 'subtask_separator' then settings ->> 'subtask_separator' else s.subtask_separator end,
        number_scope = case when settings ? 'number_scope' then settings ->> 'number_scope' else s.number_scope end,
        assign_to = case
          when settings ->> 'number_scope' in ('all_tasks', 'form_submissions') then settings ->> 'number_scope'
          when settings ? 'assign_to' then settings ->> 'assign_to'
          else s.assign_to
        end,
        section_ids = case
          when settings ? 'section_ids' then coalesce(
            (select array_agg(x::uuid) from jsonb_array_elements_text(settings -> 'section_ids') x),
            '{}'::uuid[]
          )
          else s.section_ids
        end,
        task_kinds = case
          when settings ? 'task_kinds' then coalesce(
            (select array_agg(x) from jsonb_array_elements_text(settings -> 'task_kinds') x),
            '{}'::text[]
          )
          else s.task_kinds
        end,
        reuse_deleted = case when settings ? 'reuse_deleted' then (settings ->> 'reuse_deleted')::boolean else s.reuse_deleted end,
        fill_gaps = case when settings ? 'fill_gaps' then (settings ->> 'fill_gaps')::boolean else s.fill_gaps end,
        reset_period = case when settings ? 'reset_period' then settings ->> 'reset_period' else s.reset_period end,
        counter_field_id = case
          when settings ? 'counter_field_id' then nullif(settings ->> 'counter_field_id', '')::uuid
          else s.counter_field_id
        end,
        project_code = case
          when settings ? 'project_code' then nullif(btrim(settings ->> 'project_code'), '')
          else s.project_code
        end,
        renumber_on_move = case when settings ? 'renumber_on_move' then (settings ->> 'renumber_on_move')::boolean else s.renumber_on_move end,
        time_zone = case when settings ? 'time_zone' then settings ->> 'time_zone' else s.time_zone end,
        start_number = case
          when settings ? 'start_number' then (settings ->> 'start_number')::bigint
          else s.start_number
        end,
        prefix = case when settings ? 'prefix' then settings ->> 'prefix' else s.prefix end,
        pad_width = case when settings ? 'pad_width' then (settings ->> 'pad_width')::smallint else s.pad_width end
    where s.project_id = target_project;

    if settings ? 'start_number' and mode <> 'renumber' then
      update public.request_sequences
      set last_number = greatest(last_number, start_number - 1)
      where project_id = target_project;
    end if;
  end if;

  select * into seq from public.request_sequences where project_id = target_project;
  if seq.fill_gaps and seq.reuse_deleted then
    perform public.fill_request_number_gaps(target_project);
  end if;

  if mode = 'number_missing' then
    numbered := public.number_project_tasks(target_project, false);
  elsif mode = 'renumber' then
    numbered := public.number_project_tasks(target_project, true);
  else
    -- A save refreshes rendered labels and subtask paths. It does not hand out new numbers.
    for numbered in 1..4 loop
      update public.tasks c
      set req_path = p.req_path || seq.subtask_separator || c.req_subindex::text
      from public.tasks p
      where c.parent_task_id = p.id
        and c.req_subindex is not null
        and c.deleted_at is null
        and p.req_path is not null
        and c.home_project_id = target_project;
    end loop;
    update public.tasks t
    set req_label = public.compose_request_label(t.id)
    where t.deleted_at is null and t.home_project_id = target_project
      and (t.req_number is not null or t.req_subindex is not null);
    numbered := 0;
  end if;

  select * into seq from public.request_sequences where project_id = target_project;
  return jsonb_build_object(
    'numbered', numbered,
    'next_number', seq.last_number + 1,
    'enabled', seq.enabled
  );
end;
$$;

revoke all on function public.apply_task_numbering(uuid, jsonb, text) from public, anon;
grant execute on function public.apply_task_numbering(uuid, jsonb, text) to authenticated;

-- Search: 484, #484, Req 484, the dotted subtask path, and the rendered label.
select public.alhc_patch_function('public.search_tasks(text, integer)'::regprocedure,
$p$        where tt.task_id = t.id and tt.deleted_at is null and g.name ilike pattern.value
      )
    )
  order by t.completed_at is not null, t.title ilike pattern.value desc,$p$,
$p$        where tt.task_id = t.id and tt.deleted_at is null and g.name ilike pattern.value
      )
      or coalesce(t.req_label, '') ilike pattern.value
      or (
        public.request_number_query(trim(query)) is not null
        and (
          t.req_path = public.request_number_query(trim(query))
          or t.req_path like public.request_number_query(trim(query)) || '.%'
          or t.req_number::text = ltrim(public.request_number_query(trim(query)), '0')
        )
      )
    )
  order by t.completed_at is not null, t.title ilike pattern.value desc,$p$);

select public.alhc_patch_function('public.filter_project_tasks(uuid, jsonb, text)'::regprocedure,
$p$    and (p.needle is null or t.title ilike pattern.value or coalesce(t.notes, '') ilike pattern.value)$p$,
$p$    and (
      p.needle is null
      or t.title ilike pattern.value
      or coalesce(t.notes, '') ilike pattern.value
      or coalesce(t.req_label, '') ilike pattern.value
      or (
        public.request_number_query(p.needle) is not null
        and (
          t.req_path = public.request_number_query(p.needle)
          or t.req_path like public.request_number_query(p.needle) || '.%'
          or t.req_number::text = ltrim(public.request_number_query(p.needle), '0')
        )
      )
    )$p$);

select public.alhc_revoke_anon_execute(array[
  'request_number_query(text)',
  'request_number_period(timestamptz, text, text)',
  'render_request_template(text, text, timestamptz, text, text, text, text)',
  'compose_request_label(uuid)',
  'format_request_label(uuid, bigint)',
  'task_request_label(uuid)',
  'allocate_request_number(uuid, text, text)',
  'next_request_number(uuid)',
  'request_number_in_scope(uuid, public.request_sequences)',
  'ensure_request_number(uuid, boolean)',
  'guard_request_sequence_settings()',
  'assign_request_number_on_insert()',
  'assign_request_number(uuid)',
  'assign_request_number_when_ready()',
  'story_request_number()',
  'free_request_number()',
  'maybe_renumber_on_move()',
  'number_project_tasks(uuid, boolean)',
  'fill_request_number_gaps(uuid)',
  'apply_task_numbering(uuid, jsonb, text)'
]);

-- TAIL
-- The original unique index also covers trashed tasks, so a reused number cannot be stored
-- until it is gone. tasks_req_number_scope_idx already keeps active numbers unique per
-- project, period, and counter.
drop index if exists public.tasks_req_number_idx;
