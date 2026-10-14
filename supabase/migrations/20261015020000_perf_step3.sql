-- Performance, stage 3: page the project list.
--
-- project_task_cards still builds one jsonb value for every task. List and Board paint about
-- 80 rows per group. This function returns that page (plus each group's total and the id of
-- the next task, so a drag after the last painted row lands before the rest) and builds cards
-- only for the rows on the page, by calling project_task_cards with those ids.
--
-- Access is the same rule: one has_project_role(viewer) check, then the view filter. A
-- non-member, including a workspace admin who is not a member, gets {"groups":[]}.
-- Calendar and Timeline keep calling project_task_cards for the whole project.
--
-- No object is removed. The tail is empty.

-- Title order matches the list's localeCompare(..., { numeric: true }) closely enough that
-- "Task 2" stays before "Task 10". Internal. Not a client RPC.
create or replace function public.alhc_natural_sort_key(value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce((
    select string_agg(
      case
        when m[1] is not null then lpad(m[1], 12, '0')
        else lower(m[2])
      end,
      '' order by ordinality
    )
    from regexp_matches(coalesce(value, ''), '([0-9]+)|([^0-9]+)', 'g') with ordinality as u(m, ordinality)
  ), '');
$$;

revoke all on function public.alhc_natural_sort_key(text) from public, anon, authenticated;

-- One sort slot: a number, or a text key, never both. Null means "sorts last".
-- Internal. Not a client RPC.
create or replace function public.alhc_card_sort_parts(
  sort_key text,
  task_title text,
  task_due date,
  task_start date,
  task_created timestamp with time zone,
  task_sort double precision,
  assignee_name text,
  field_type text,
  field_options jsonb,
  field_value jsonb
)
returns table (num numeric, txt text)
language sql
stable
set search_path = ''
as $$
  select
    case
      when sort_key = 'manual' then task_sort::numeric
      when sort_key = 'due' then (task_due - date '1970-01-01')::numeric
      when sort_key = 'start' then (task_start - date '1970-01-01')::numeric
      when sort_key = 'created' then extract(epoch from task_created)
      when sort_key like 'field:%' and field_type = 'number' and jsonb_typeof(field_value) = 'number'
        then (field_value #>> '{}')::numeric
      when sort_key like 'field:%' and field_type = 'single_select' then (
        select (opt.ord - 1)::numeric
        from jsonb_array_elements(coalesce(field_options, '[]'::jsonb)) with ordinality as opt(value, ord)
        where opt.value ->> 'id' = field_value #>> '{}'
        limit 1
      )
      when sort_key like 'field:%' and field_type = 'boolean' and field_value = 'true'::jsonb then 0
      else null
    end,
    case
      when sort_key = 'title' then public.alhc_natural_sort_key(task_title)
      when sort_key = 'assignee' then nullif(lower(btrim(assignee_name)), '')
      when sort_key like 'field:%' and field_type in ('text', 'date')
        and jsonb_typeof(field_value) = 'string'
        then public.alhc_natural_sort_key(field_value #>> '{}')
      when sort_key like 'field:%' and field_type in ('multi_select', 'people')
        and jsonb_typeof(field_value) = 'array' and jsonb_array_length(field_value) > 0
        then public.alhc_natural_sort_key(field_value ->> 0)
      else null
    end;
$$;

revoke all on function public.alhc_card_sort_parts(text, text, date, date, timestamp with time zone, double precision, text, text, jsonb, jsonb) from public, anon, authenticated;

-- One page of cards per group. group_by is section | assignee | tag | none | field:<uuid>.
-- sorts is the view's sort list ({key, dir}). limits maps a group key to how many cards
-- that group should return; every other group uses page_size (80). Keys match the list:
-- section-<uuid>, section-none, assignee-<uuid>, assignee-none, tag-<uuid>, tag-none,
-- option-<uuid>, option-none, all.
create or replace function public.project_task_card_page(
  target_project uuid,
  filters jsonb default '{}'::jsonb,
  tz text default 'UTC',
  group_by text default 'section',
  sorts jsonb default null,
  page_size integer default 80,
  limits jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_mode text := 'section';
  v_field uuid := null;
  v_sorts jsonb := '[{"key":"manual","dir":"asc"}]'::jsonb;
  v_page integer := 80;
  v_item jsonb;
  v_key text;
  v_dir text;
  v_groups jsonb;
begin
  if target_project is null or not public.has_project_role(target_project, 'viewer') then
    return '{"groups":[]}'::jsonb;
  end if;

  if coalesce(group_by, 'section') = 'none' then
    v_mode := 'none';
  elsif group_by = 'assignee' then
    v_mode := 'assignee';
  elsif group_by = 'tag' then
    v_mode := 'tag';
  elsif group_by ~ '^field:[0-9a-fA-F-]{36}$' then
    select cf.id into v_field
    from public.custom_fields cf
    where cf.id = substring(group_by from 7)::uuid
      and cf.project_id = target_project
      and cf.deleted_at is null
      and cf.field_type = 'single_select'
      and not cf.bound_to_sections;
    if v_field is not null then
      v_mode := 'field';
    end if;
  end if;

  if jsonb_typeof(sorts) = 'array' then
    v_sorts := '[]'::jsonb;
    for v_item in select value from jsonb_array_elements(sorts) loop
      exit when jsonb_array_length(v_sorts) >= 3;
      v_key := v_item ->> 'key';
      v_dir := case when v_item ->> 'dir' = 'desc' then 'desc' else 'asc' end;
      if v_key in ('manual', 'due', 'start', 'title', 'created', 'assignee')
        or (
          v_key ~ '^field:[0-9a-fA-F-]{36}$'
          and exists (
            select 1 from public.custom_fields cf
            where cf.id = substring(v_key from 7)::uuid
              and cf.project_id = target_project
              and cf.deleted_at is null
              and not cf.bound_to_sections
          )
        )
      then
        v_sorts := v_sorts || jsonb_build_array(jsonb_build_object('key', v_key, 'dir', v_dir));
      end if;
    end loop;
    if jsonb_array_length(v_sorts) = 0 then
      v_sorts := '[{"key":"manual","dir":"asc"}]'::jsonb;
    end if;
  end if;

  v_page := greatest(1, least(coalesce(page_size, 80), 500));
  if jsonb_typeof(limits) is distinct from 'object' then
    limits := '{}'::jsonb;
  end if;

  -- The everyday list: incomplete tasks, grouped by section, manual order. A direct
  -- scan plus cards for the page, without the general filter and sort machinery.
  if v_mode = 'section'
     and v_sorts = '[{"key":"manual","dir":"asc"}]'::jsonb
     and (
       filters is null
       or filters = '{}'::jsonb
       or (
         jsonb_typeof(filters) = 'object'
         and (select count(*) from jsonb_object_keys(filters)) = 1
         and filters ->> 'completion' = 'incomplete'
       )
     )
  then
    with base as (
      select tp.task_id,
             'section-' || coalesce(tp.section_id::text, 'none') as group_key,
             tp.sort_order
      from public.task_projects tp
      join public.tasks t on t.id = tp.task_id
      where tp.project_id = target_project
        and tp.deleted_at is null
        and t.deleted_at is null
        and t.completed_at is null
    ),
    ranked as (
      select b.task_id, b.group_key, b.sort_order,
             row_number() over (partition by b.group_key order by b.sort_order, b.task_id) as rn,
             count(*) over (partition by b.group_key) as total
      from base b
    ),
    bounded as (
      select r.*,
             least(20000, greatest(1, coalesce(
               case when (limits ->> r.group_key) ~ '^[0-9]+$' then (limits ->> r.group_key)::integer end,
               v_page
             ))) as lim
      from ranked r
    ),
    page as (
      select * from bounded where rn <= lim
    ),
    nxt as (
      select distinct on (group_key) group_key, task_id, sort_order
      from bounded
      where rn = lim + 1
      order by group_key, rn
    ),
    totals as (
      select distinct group_key, total from bounded
    ),
    ids as (
      select coalesce(array_agg(distinct task_id), '{}'::uuid[]) as ids from page
    ),
    card_map as (
      select coalesce(jsonb_object_agg(c ->> 'id', c), '{}'::jsonb) as cards
      from jsonb_array_elements(
        public.project_task_cards(target_project, (select ids from ids))
      ) c
    )
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'key', t.group_key,
        'total', t.total,
        'next_id', n.task_id,
        'next_sort_order', n.sort_order,
        'cards', coalesce((
          select jsonb_agg(cm.cards -> p.task_id::text order by p.rn)
          from page p
          where p.group_key = t.group_key
            and cm.cards ? p.task_id::text
        ), '[]'::jsonb)
      )
      order by t.group_key
    ), '[]'::jsonb)
    into v_groups
    from totals t
    left join nxt n on n.group_key = t.group_key
    cross join card_map cm;

    return jsonb_build_object('groups', coalesce(v_groups, '[]'::jsonb));
  end if;

  with matched as (
    select f.task_id, f.section_id, f.assignee_id
    from public.filter_project_tasks(target_project, filters, tz) f
  ),
  base as (
    select m.task_id, m.section_id, m.assignee_id,
           t.title, t.due_on, t.start_on, t.created_at, tp.sort_order,
           coalesce(nullif(btrim(pr.full_name), ''), pr.email) as assignee_name
    from matched m
    join public.tasks t on t.id = m.task_id
    join public.task_projects tp
      on tp.task_id = m.task_id
     and tp.project_id = target_project
     and tp.deleted_at is null
    left join public.profiles pr on pr.id = m.assignee_id
  ),
  keyed as (
    select b.*, 'section-' || coalesce(b.section_id::text, 'none') as group_key
    from base b
    where v_mode = 'section'
    union all
    select b.*, 'assignee-' || coalesce(b.assignee_id::text, 'none')
    from base b
    where v_mode = 'assignee'
    union all
    select b.*, 'all'
    from base b
    where v_mode = 'none'
    union all
    select b.*, 'tag-' || g.id::text
    from base b
    join public.task_tags tt on tt.task_id = b.task_id and tt.deleted_at is null
    join public.tags g on g.id = tt.tag_id and g.deleted_at is null
    where v_mode = 'tag'
    union all
    select b.*, 'tag-none'
    from base b
    where v_mode = 'tag'
      and not exists (
        select 1
        from public.task_tags tt
        join public.tags g on g.id = tt.tag_id and g.deleted_at is null
        where tt.task_id = b.task_id and tt.deleted_at is null
      )
    union all
    select b.*, coalesce('option-' || opt.id, 'option-none')
    from base b
    left join public.task_field_values fv
      on fv.task_id = b.task_id and fv.field_id = v_field
    left join lateral (
      select o ->> 'id' as id
      from public.custom_fields cf
      cross join lateral jsonb_array_elements(cf.options) o
      where cf.id = v_field
        and o ->> 'id' = fv.value #>> '{}'
      limit 1
    ) opt on true
    where v_mode = 'field'
  ),
  slotted as (
    -- Column sorts stay inline. The field helper runs only when that slot is a field,
    -- and the natural title key only when that slot sorts by title.
    select k.*,
           case (v_sorts -> 0 ->> 'key')
             when 'manual' then k.sort_order::numeric
             when 'due' then (k.due_on - date '1970-01-01')::numeric
             when 'start' then (k.start_on - date '1970-01-01')::numeric
             when 'created' then extract(epoch from k.created_at)
             else case when (v_sorts -> 0 ->> 'key') like 'field:%' then (
               select p.num
               from public.custom_fields cf
               left join public.task_field_values fv
                 on fv.field_id = cf.id and fv.task_id = k.task_id
               cross join lateral public.alhc_card_sort_parts(
                 v_sorts -> 0 ->> 'key', k.title, k.due_on, k.start_on, k.created_at, k.sort_order,
                 k.assignee_name, cf.field_type, cf.options, fv.value
               ) p
               where cf.id = substring(v_sorts -> 0 ->> 'key' from 7)::uuid
                 and cf.deleted_at is null
             ) end
           end as n1,
           case
             when (v_sorts -> 0 ->> 'key') = 'title' then public.alhc_natural_sort_key(k.title)
             when (v_sorts -> 0 ->> 'key') = 'assignee' then nullif(lower(btrim(k.assignee_name)), '')
             when (v_sorts -> 0 ->> 'key') like 'field:%' then (
               select p.txt
               from public.custom_fields cf
               left join public.task_field_values fv
                 on fv.field_id = cf.id and fv.task_id = k.task_id
               cross join lateral public.alhc_card_sort_parts(
                 v_sorts -> 0 ->> 'key', k.title, k.due_on, k.start_on, k.created_at, k.sort_order,
                 k.assignee_name, cf.field_type, cf.options, fv.value
               ) p
               where cf.id = substring(v_sorts -> 0 ->> 'key' from 7)::uuid
                 and cf.deleted_at is null
             )
             else null
           end as t1,
           case (v_sorts -> 1 ->> 'key')
             when 'manual' then k.sort_order::numeric
             when 'due' then (k.due_on - date '1970-01-01')::numeric
             when 'start' then (k.start_on - date '1970-01-01')::numeric
             when 'created' then extract(epoch from k.created_at)
             else null
           end as n2,
           case
             when (v_sorts -> 1 ->> 'key') = 'title' then public.alhc_natural_sort_key(k.title)
             when (v_sorts -> 1 ->> 'key') = 'assignee' then nullif(lower(btrim(k.assignee_name)), '')
             else null
           end as t2,
           case (v_sorts -> 2 ->> 'key')
             when 'manual' then k.sort_order::numeric
             when 'due' then (k.due_on - date '1970-01-01')::numeric
             when 'start' then (k.start_on - date '1970-01-01')::numeric
             when 'created' then extract(epoch from k.created_at)
             else null
           end as n3,
           case
             when (v_sorts -> 2 ->> 'key') = 'title' then public.alhc_natural_sort_key(k.title)
             when (v_sorts -> 2 ->> 'key') = 'assignee' then nullif(lower(btrim(k.assignee_name)), '')
             else null
           end as t3
    from keyed k
  ),
  ranked as (
    select s.*,
           row_number() over (
             partition by s.group_key
             order by
               case when (v_sorts -> 0 ->> 'key') is null then 0
                    when s.n1 is null and s.t1 is null then 1 else 0 end,
               case when coalesce(v_sorts -> 0 ->> 'dir', 'asc') = 'desc' then s.n1 end desc nulls last,
               case when coalesce(v_sorts -> 0 ->> 'dir', 'asc') <> 'desc' then s.n1 end asc nulls last,
               case when coalesce(v_sorts -> 0 ->> 'dir', 'asc') = 'desc' then s.t1 end desc nulls last,
               case when coalesce(v_sorts -> 0 ->> 'dir', 'asc') <> 'desc' then s.t1 end asc nulls last,
               case when (v_sorts -> 1 ->> 'key') is null then 0
                    when s.n2 is null and s.t2 is null then 1 else 0 end,
               case when coalesce(v_sorts -> 1 ->> 'dir', 'asc') = 'desc' then s.n2 end desc nulls last,
               case when coalesce(v_sorts -> 1 ->> 'dir', 'asc') <> 'desc' then s.n2 end asc nulls last,
               case when coalesce(v_sorts -> 1 ->> 'dir', 'asc') = 'desc' then s.t2 end desc nulls last,
               case when coalesce(v_sorts -> 1 ->> 'dir', 'asc') <> 'desc' then s.t2 end asc nulls last,
               case when (v_sorts -> 2 ->> 'key') is null then 0
                    when s.n3 is null and s.t3 is null then 1 else 0 end,
               case when coalesce(v_sorts -> 2 ->> 'dir', 'asc') = 'desc' then s.n3 end desc nulls last,
               case when coalesce(v_sorts -> 2 ->> 'dir', 'asc') <> 'desc' then s.n3 end asc nulls last,
               case when coalesce(v_sorts -> 2 ->> 'dir', 'asc') = 'desc' then s.t3 end desc nulls last,
               case when coalesce(v_sorts -> 2 ->> 'dir', 'asc') <> 'desc' then s.t3 end asc nulls last,
               s.sort_order asc,
               s.task_id asc
           ) as rn,
           count(*) over (partition by s.group_key) as total
    from slotted s
  ),
  bounded as (
    select r.*,
           least(
             20000,
             greatest(
               1,
               coalesce(
                 case
                   when (limits ->> r.group_key) ~ '^[0-9]+$' then (limits ->> r.group_key)::integer
                 end,
                 v_page
               )
             )
           ) as lim
    from ranked r
  ),
  page as (
    select * from bounded where rn <= lim
  ),
  nxt as (
    select distinct on (group_key) group_key, task_id, sort_order
    from bounded
    where rn = lim + 1
    order by group_key, rn
  ),
  totals as (
    select distinct group_key, total from bounded
  ),
  ids as (
    select coalesce(array_agg(distinct task_id), '{}'::uuid[]) as ids from page
  ),
  card_map as (
    select coalesce(jsonb_object_agg(c ->> 'id', c), '{}'::jsonb) as cards
    from jsonb_array_elements(
      public.project_task_cards(target_project, (select ids from ids))
    ) c
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'key', t.group_key,
      'total', t.total,
      'next_id', n.task_id,
      'next_sort_order', n.sort_order,
      'cards', coalesce((
        select jsonb_agg(cm.cards -> p.task_id::text order by p.rn)
        from page p
        where p.group_key = t.group_key
          and cm.cards ? p.task_id::text
      ), '[]'::jsonb)
    )
    order by t.group_key
  ), '[]'::jsonb)
  into v_groups
  from totals t
  left join nxt n on n.group_key = t.group_key
  cross join card_map cm;

  return jsonb_build_object('groups', coalesce(v_groups, '[]'::jsonb));
end;
$$;

revoke all on function public.project_task_card_page(uuid, jsonb, text, text, jsonb, integer, jsonb) from public, anon;
grant execute on function public.project_task_card_page(uuid, jsonb, text, text, jsonb, integer, jsonb) to authenticated;

select public.alhc_revoke_anon_execute(array[
  'alhc_natural_sort_key(text)',
  'alhc_card_sort_parts(text,text,date,date,timestamp with time zone,double precision,text,text,jsonb,jsonb)',
  'project_task_card_page(uuid,jsonb,text,text,jsonb,integer,jsonb)'
]);

-- TAIL
-- Nothing in this phase removes an object.
