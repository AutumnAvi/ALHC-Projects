-- Behavioural checks for the workflows migration: Req #, forms (branching, public submit), approvals,
-- rules (presets, delays, due dates, loop guard with section-bound Status), and the email outbox.
-- Reuses the users from 10_core_smoke.sql:
--   1111… member@example.com  "Member One"   (allowlisted)
--   4444… later@example.com   "Later Person" (allowlisted)
--   2222… outsider@example.com               (not allowlisted)

\set ON_ERROR_STOP 1

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

create temporary table ids (name text primary key, id uuid) on commit preserve rows;
grant all on ids to authenticated, anon, service_role;

-- Fixtures ---------------------------------------------------------------------------------------

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid;
  other_p uuid;
  section_name text;
  s uuid;
  f_type uuid;
  f_tracking uuid;
  f_email uuid;
begin
  insert into public.projects (workspace_id, name) values (ws, 'Requests') returning id into p;
  insert into public.projects (workspace_id, name) values (ws, 'Other') returning id into other_p;
  insert into ids values ('p', p), ('other_p', other_p);
  -- Since Teams & permissions, other people need a membership to read or be notified about a project.
  perform public.add_project_member(p, 'later@example.com', 'editor');
  foreach section_name in array array['Intake', 'Review', 'Doing', 'Approved', 'Changes', 'Shipped', 'Loop A', 'Loop B'] loop
    insert into public.sections (project_id, name, sort_order) values (p, section_name, 1) returning id into s;
    insert into ids values ('s_' || lower(replace(section_name, ' ', '_')), s);
  end loop;
  insert into public.sections (project_id, name) values (other_p, 'Elsewhere') returning id into s;
  insert into ids values ('s_elsewhere', s);

  insert into public.custom_fields (project_id, name, field_type, options)
  values (p, 'Request type', 'single_select',
    '[{"id": "opt-print", "name": "Print", "color": "blue"}, {"id": "opt-digital", "name": "Digital", "color": "green"}]')
  returning id into f_type;
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Tracking', 'text') returning id into f_tracking;
  insert into public.custom_fields (project_id, name, field_type) values (p, 'Requester email', 'text') returning id into f_email;
  insert into ids values ('f_type', f_type), ('f_tracking', f_tracking), ('f_email', f_email);
end $$;

-- Req # ------------------------------------------------------------------------------------------

do $$
declare
  p uuid := (select id from ids where name = 'p');
  t1 uuid;
  t2 uuid;
begin
  -- Continue an existing numbering at 41, pad to 3 digits, number every task.
  insert into public.request_sequences (project_id, prefix, pad_width, assign_to, last_number)
  values (p, 'Req #', 3, 'all_tasks', 41);

  t1 := public.create_task(p, null, 'Poster');
  t2 := public.create_task(p, null, 'Banner');
  insert into ids values ('req_t1', t1);
  assert (select req_number from public.tasks where id = t1) = 42, 'first number continues the sequence';
  assert (select title from public.tasks where id = t1) = '[Req #042] Poster', 'title gets the padded prefix';
  assert (select req_number from public.tasks where id = t2) = 43, 'numbers are sequential';
  assert public.task_request_label(t2) = 'Req #043', 'label formatting';

  begin
    update public.tasks set req_number = 7 where id = t1;
    raise exception 'clients must not edit Req #';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.tasks set source = 'form' where id = t1;
    raise exception 'clients must not edit source';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.request_sequences set last_number = 10 where project_id = p;
    raise exception 'sequence must not move backwards';
  exception when check_violation then null;
  end;

  -- From here on, only form submissions are numbered automatically.
  update public.request_sequences set assign_to = 'form_submissions' where project_id = p;
  t2 := public.create_task(p, null, 'Unnumbered');
  assert (select req_number from public.tasks where id = t2) is null, 'manual tasks skip numbering in form_submissions mode';
  assert public.assign_request_number(t2) = 'Req #044', 'existing tasks can be numbered on demand';
  assert exists (select 1 from public.task_stories where task_id = t2 and kind = 'request_number_assigned'),
    'manual numbering leaves a story';
end $$;

-- Forms ------------------------------------------------------------------------------------------

do $$
declare
  p uuid := (select id from ids where name = 'p');
  form_id uuid;
begin
  begin
    insert into public.forms (project_id, title, questions) values (p, 'Bad', '[
      {"id": "a", "type": "short_text", "label": "A", "show_if": {"question_id": "b", "option_ids": ["x"]}},
      {"id": "b", "type": "single_select", "label": "B", "options": [{"id": "x", "label": "X"}]}
    ]');
    raise exception 'show_if must reference an earlier question';
  exception when check_violation then null;
  end;
  begin
    insert into public.forms (project_id, title, questions) values (p, 'Bad', jsonb_build_array(jsonb_build_object(
      'id', 'a', 'type', 'short_text', 'label', 'A',
      'maps_to', jsonb_build_object('target', 'field', 'field_id', (select id from ids where name = 'f_tracking')::text)
    )));
    -- Same project: allowed. A field from another project is not.
    insert into public.forms (project_id, title, questions) values ((select id from ids where name = 'other_p'), 'Bad', jsonb_build_array(jsonb_build_object(
      'id', 'a', 'type', 'short_text', 'label', 'A',
      'maps_to', jsonb_build_object('target', 'field', 'field_id', (select id from ids where name = 'f_tracking')::text)
    )));
    raise exception 'mapping to another project''s field must fail';
  exception when check_violation then null;
  end;

  insert into public.forms (project_id, title, accepting_responses, destination_section_id, confirmation_message, questions)
  values (p, 'Design request', true, (select id from ids where name = 's_intake'), 'Thanks! We will be in touch.', jsonb_build_array(
    jsonb_build_object('id', 'title', 'type', 'short_text', 'label', 'What do you need?', 'required', true,
      'maps_to', jsonb_build_object('target', 'title')),
    jsonb_build_object('id', 'kind', 'type', 'single_select', 'label', 'Request type', 'required', true,
      'options', jsonb_build_array(jsonb_build_object('id', 'print', 'label', 'Print'), jsonb_build_object('id', 'digital', 'label', 'Digital')),
      'maps_to', jsonb_build_object('target', 'field', 'field_id', (select id from ids where name = 'f_type')::text)),
    jsonb_build_object('id', 'size', 'type', 'short_text', 'label', 'Print size', 'required', true,
      'show_if', jsonb_build_object('question_id', 'kind', 'option_ids', jsonb_build_array('print'))),
    jsonb_build_object('id', 'rush', 'type', 'checkbox', 'label', 'Rush job?'),
    jsonb_build_object('id', 'rush_reason', 'type', 'long_text', 'label', 'Why the rush?',
      'show_if', jsonb_build_object('question_id', 'rush', 'option_ids', jsonb_build_array('true'))),
    jsonb_build_object('id', 'due', 'type', 'date', 'label', 'Needed by', 'maps_to', jsonb_build_object('target', 'due_on')),
    jsonb_build_object('id', 'details', 'type', 'long_text', 'label', 'Details', 'maps_to', jsonb_build_object('target', 'notes'))
  ))
  returning id into form_id;
  insert into ids values ('form', form_id);

  insert into public.forms (project_id, title, questions) values (p, 'Closed form', '[]') returning id into form_id;
  insert into ids values ('closed_form', form_id);
end $$;

-- Anonymous visitors use the public RPCs only.
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false) is not null as ok \gset

do $$
declare
  form_id uuid := (select id from ids where name = 'form');
  result jsonb;
  public_form jsonb := public.get_public_form((select id from ids where name = 'form'));
begin
  assert public_form ->> 'title' = 'Design request', 'anon can load an open form';
  assert not exists (select 1 from jsonb_array_elements(public_form -> 'questions') q where q ? 'maps_to'),
    'public form hides field mappings';
  assert jsonb_array_length(public.get_public_form((select id from ids where name = 'closed_form')) -> 'questions') = 0,
    'closed forms expose no questions to anon';

  begin
    perform public.submit_form(form_id, 'requester@example.org', '{"title": "Flyer", "kind": "print"}');
    raise exception 'missing visible required answer must fail';
  exception when check_violation then null;
  end;
  begin
    perform public.submit_form(form_id, 'not-an-email', '{"title": "Flyer", "kind": "digital"}');
    raise exception 'invalid email must fail';
  exception when check_violation then null;
  end;
  begin
    perform public.submit_form(form_id, 'requester@example.org', '{"title": "Flyer", "kind": "video"}');
    raise exception 'unknown option must fail';
  exception when check_violation then null;
  end;
  begin
    perform public.submit_form((select id from ids where name = 'closed_form'), 'requester@example.org', '{}');
    raise exception 'closed form must reject submissions';
  exception when check_violation then null;
  end;

  -- Digital: the print-only "size" answer is hidden and discarded even though it was sent.
  result := public.submit_form(form_id, ' Requester@Example.org ', jsonb_build_object(
    'title', 'Spring social posts', 'kind', 'digital', 'size', '24x36', 'rush', true, 'rush_reason', 'Launch moved up',
    'due', (current_date + 10)::text, 'details', 'Three posts for the spring launch.'
  ));
  insert into ids values ('form_task', (result ->> 'task_id')::uuid);
  assert result ->> 'request_label' = 'Req #045', 'form submission gets the next Req #';

  result := public.submit_form(form_id, 'printer@example.org', '{"title": "Poster run", "kind": "print", "size": "A2"}');
  insert into ids values ('print_task', (result ->> 'task_id')::uuid);

  begin
    insert into public.form_submissions (form_id, task_id, submitter_email) values (form_id, (result ->> 'task_id')::uuid, 'x@example.org');
    raise exception 'anon must not insert submissions directly';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.request_approval((result ->> 'task_id')::uuid, '11111111-1111-4111-8111-111111111111');
    raise exception 'anon must not request approvals';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

do $$
declare
  t uuid := (select id from ids where name = 'form_task');
  print_t uuid := (select id from ids where name = 'print_task');
  sub public.form_submissions;
begin
  assert (select source from public.tasks where id = t) = 'form', 'form tasks have source=form';
  assert (select title from public.tasks where id = t) = '[Req #045] Spring social posts', 'title maps from the answer';
  assert (select due_on from public.tasks where id = t) = current_date + 10, 'due date maps';
  assert (select notes from public.tasks where id = t) like 'Three posts for the spring launch.%', 'notes map first';
  assert (select notes from public.tasks where id = t) like '%Rush job?: Yes%', 'notes include the answer summary';
  assert (select section_id from public.task_projects where task_id = t) = (select id from ids where name = 's_intake'),
    'lands in the destination section';
  assert (select value from public.task_field_values where task_id = t and field_id = (select id from ids where name = 'f_type'))
    = '"opt-digital"'::jsonb, 'select answer maps to the field option by name';
  select * into sub from public.form_submissions where task_id = t;
  assert sub.submitter_email = 'requester@example.org', 'submitter email is normalised';
  assert not sub.answers ? 'size', 'hidden answers are discarded';
  assert sub.answers ->> 'rush_reason' = 'Launch moved up', 'branch shown by a checkbox keeps its answer';
  assert (select answers ->> 'size' from public.form_submissions where task_id = print_t) = 'A2', 'visible branch kept';
  assert (select array_agg(kind order by kind) from public.task_stories where task_id = t)
    = array['created', 'email_queued', 'field_changed', 'form_submitted'],
    'form task history: created, field set, submitted, confirmation queued (no membership noise)';
  assert exists (
    select 1 from public.email_outbox
    where task_id = t and template = 'form_confirmation' and to_email = 'requester@example.org' and status = 'pending'
      and payload ->> 'request_label' = 'Req #045'
  ), 'confirmation email is queued with the Req #';

  begin
    insert into public.email_outbox (to_email, template) values ('x@example.org', 'custom');
    raise exception 'members must not write to the outbox';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Approvals --------------------------------------------------------------------------------------

do $$
declare
  ws uuid := '00000000-0000-4000-8000-000000000001';
  p uuid;
  t uuid;
  a uuid;
begin
  insert into public.projects (workspace_id, name, approval_completes_task) values (ws, 'Approvals', true) returning id into p;
  perform public.add_project_member(p, 'later@example.com', 'commenter');
  t := public.create_task(p, null, 'Brochure');
  insert into ids values ('approval_task', t);
end $$;

do $$
declare
  t uuid := (select id from ids where name = 'approval_task');
  a uuid;
  sub uuid;
  affected integer;
begin
  a := public.request_approval(t, '44444444-4444-4444-8444-444444444444', 'Please check the copy', true, 'Approve brochure');
  insert into ids values ('approval', a);
  select subtask_id into sub from public.approval_requests where id = a;
  assert (select title from public.tasks where id = sub and parent_task_id = t) = 'Approve brochure', 'approval creates a linked subtask';
  assert (select status from public.approval_requests where id = a) = 'pending', 'starts pending';
  assert exists (select 1 from public.task_stories where task_id = t and kind = 'approval_requested'), 'request story';
  assert exists (select 1 from public.task_followers where task_id = t and profile_id = '44444444-4444-4444-8444-444444444444'),
    'approver follows the task';

  begin
    perform public.decide_approval(a, 'approved');
    raise exception 'only the approver can decide';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.tasks set completed_at = now() where id = sub;
    raise exception 'approval subtasks complete by deciding';
  exception when check_violation then null;
  end;
  update public.approval_requests set status = 'approved' where id = a;
  get diagnostics affected = row_count;
  assert affected = 0, 'status changes only go through the RPCs (no update policy)';
end $$;

select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false) is not null as ok \gset

do $$
declare
  a uuid := (select id from ids where name = 'approval');
begin
  assert exists (select 1 from public.inbox_items where kind = 'approval_requested' and data ->> 'approval_id' = a::text),
    'approver gets an inbox item';
  perform public.decide_approval(a, 'changes_requested', 'Fix the headline');
  assert (select status from public.approval_requests where id = a) = 'changes_requested', 'changes requested';
  begin
    perform public.decide_approval(a, 'approved');
    raise exception 'a decided approval cannot be decided again';
  exception when check_violation then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

do $$
declare
  a uuid := (select id from ids where name = 'approval');
begin
  assert exists (
    select 1 from public.inbox_items
    where kind = 'approval_decided' and data ->> 'status' = 'changes_requested' and data ->> 'note' = 'Fix the headline'
  ), 'requester hears about the decision';
  perform public.resubmit_approval(a, 'Headline fixed');
  assert (select status from public.approval_requests where id = a) = 'pending', 'resubmitted';
end $$;

select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false) is not null as ok \gset

do $$
declare
  a uuid := (select id from ids where name = 'approval');
  t uuid := (select id from ids where name = 'approval_task');
begin
  perform public.decide_approval(a, 'approved');
  assert (select completed_at from public.tasks where id = (select subtask_id from public.approval_requests where id = a)) is not null,
    'approving completes the approval subtask';
  assert (select completed_at from public.tasks where id = t) is not null,
    'approval_completes_task completes the parent task';
  assert (select array_agg(kind order by created_at) filter (where kind like 'approval%') from public.task_stories where task_id = t)
    = array['approval_requested', 'approval_decided', 'approval_resubmitted', 'approval_decided'], 'approval history';
end $$;

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

-- Rules: validation + presets --------------------------------------------------------------------

do $$
declare
  p uuid := (select id from ids where name = 'p');
  r uuid;
begin
  begin
    insert into public.rules (project_id, name, trigger_type, trigger_config, actions)
    values (p, 'Bad', 'section_changed', jsonb_build_object('section_id', (select id from ids where name = 's_elsewhere')),
      '[{"type": "add_comment", "body": "x"}]');
    raise exception 'sections from other projects are rejected';
  exception when check_violation then null;
  end;
  begin
    insert into public.rules (project_id, name, trigger_type, actions) values (p, 'Bad', 'task_created', '[{"type": "explode"}]');
    raise exception 'unknown actions are rejected';
  exception when check_violation then null;
  end;

  insert into public.rules (project_id, name, trigger_type, actions)
  values (p, 'Draft rule', 'task_created', '[{"type": "add_comment", "body": "should never run"}]')
  returning id into r;
  assert not (select enabled from public.rules where id = r), 'new rules start disabled';
  insert into ids values ('draft_rule', r);

  perform public.install_rule_preset(p, 'requester_update_on_section',
    jsonb_build_object('section', (select id from ids where name = 's_review')), true);
  perform public.install_rule_preset(p, 'due_tomorrow_reminder', '{}', true);
  perform public.install_rule_preset(p, 'approval_routing', jsonb_build_object(
    'review_section', (select id from ids where name = 's_review'),
    'approver', '44444444-4444-4444-8444-444444444444',
    'approved_section', (select id from ids where name = 's_approved'),
    'changes_section', (select id from ids where name = 's_changes')
  ), true);
  perform public.install_rule_preset(p, 'stale_section_nudge',
    jsonb_build_object('section', (select id from ids where name = 's_doing'), 'hours', 2), true);
  perform public.install_rule_preset(p, 'tracking_update_email',
    jsonb_build_object('field', (select id from ids where name = 'f_tracking')), true);
  assert (select count(*) from public.rules where project_id = p and preset_key = 'approval_routing') = 3,
    'approval routing installs three rules';
  assert (select count(*) from public.rules where project_id = p and preset_key is not null and enabled) = 7,
    'installed presets are enabled when asked';
  assert (select message from (select (actions -> 0 ->> 'message') as message from public.rules where preset_key = 'requester_update_on_section') x)
    = 'Your request is now in {section}.', 'preset defaults fill unbound inputs';

  begin
    perform public.install_rule_preset(p, 'approval_routing', '{}', false);
    raise exception 'missing preset inputs must fail';
  exception when check_violation then null;
  end;
end $$;

-- Section email + approval routing: move the form task into Review.
do $$
declare
  t uuid := (select id from ids where name = 'form_task');
begin
  update public.task_projects set section_id = (select id from ids where name = 's_review') where task_id = t;
end $$;

do $$
declare
  t uuid := (select id from ids where name = 'form_task');
  a public.approval_requests;
begin
  assert exists (
    select 1 from public.email_outbox
    where task_id = t and template = 'requester_update' and to_email = 'requester@example.org'
      and payload ->> 'message' = 'Your request is now in Review.' and rule_id is not null
  ), 'section rule emails the submitter with the rendered message';
  assert exists (
    select 1 from public.task_stories where task_id = t and kind = 'email_queued' and actor_id is null and data ->> 'rule_name' = 'Requester update'
  ), 'rule-caused stories are attributed to the rule';
  select * into a from public.approval_requests where task_id = t;
  assert a.status = 'pending' and a.approver_id = '44444444-4444-4444-8444-444444444444' and a.requested_by is null and a.rule_id is not null,
    'approval routing requests approval from the preset approver';
  assert (select count(*) from public.rule_runs where task_id = t and status = 'succeeded') = 2, 'both rules logged a run';
  insert into ids values ('routed_approval', a.id);
end $$;

-- Moving out and back in does not stack a second open approval for the same approver.
do $$
declare
  t uuid := (select id from ids where name = 'form_task');
begin
  update public.task_projects set section_id = (select id from ids where name = 's_intake') where task_id = t;
  update public.task_projects set section_id = (select id from ids where name = 's_review') where task_id = t;
  assert (select count(*) from public.approval_requests where task_id = t) = 1, 'no duplicate open approvals';
end $$;

select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false) is not null as ok \gset

do $$
begin
  perform public.decide_approval((select id from ids where name = 'routed_approval'), 'approved');
  assert (select section_id from public.task_projects where task_id = (select id from ids where name = 'form_task'))
    = (select id from ids where name = 's_approved'), 'approval routing moves approved work';
end $$;

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

do $$
begin
  update public.task_projects set section_id = (select id from ids where name = 's_review')
  where task_id = (select id from ids where name = 'print_task');
end $$;

select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false) is not null as ok \gset

do $$
declare
  t uuid := (select id from ids where name = 'print_task');
begin
  perform public.decide_approval((select id from public.approval_requests where task_id = t), 'changes_requested', 'Wrong size');
  assert (select section_id from public.task_projects where task_id = t) = (select id from ids where name = 's_changes'),
    'changes requested sends the task back';
  assert exists (select 1 from public.comments where task_id = t and rule_id is not null and author_id is null and body like '%Wrong size%'),
    'rule comment includes the approval note';
end $$;

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

-- Tracking email: filling the field emails the requester with its value.
do $$
declare
  t uuid := (select id from ids where name = 'print_task');
begin
  insert into public.task_field_values (task_id, field_id, value)
  values (t, (select id from ids where name = 'f_tracking'), '"1Z999AA10123456784"');
  assert exists (
    select 1 from public.email_outbox
    where task_id = t and to_email = 'printer@example.org' and payload -> 'field' ->> 'value' = '1Z999AA10123456784'
  ), 'tracking preset emails the field value';
end $$;

-- Due tomorrow + delayed nudge (workflow_tick runs as the service role / pg_cron).
do $$
declare
  p uuid := (select id from ids where name = 'p');
  t uuid;
begin
  t := public.create_task(p, (select id from ids where name = 's_intake'), 'Due soon');
  update public.tasks set due_on = current_date + 1, assignee_id = '44444444-4444-4444-8444-444444444444' where id = t;
  insert into ids values ('due_task', t);
  t := public.create_task(p, (select id from ids where name = 's_intake'), 'Sits in doing');
  insert into ids values ('stale_task', t);
  t := public.create_task(p, (select id from ids where name = 's_intake'), 'Moves on');
  insert into ids values ('moved_task', t);
end $$;

do $$
begin
  update public.task_projects set section_id = (select id from ids where name = 's_doing')
  where task_id in ((select id from ids where name = 'stale_task'), (select id from ids where name = 'moved_task'));
  assert (select count(*) from public.scheduled_rule_actions where status = 'pending') = 2, 'delay schedules the remaining actions';
  update public.task_projects set section_id = (select id from ids where name = 's_shipped')
  where task_id = (select id from ids where name = 'moved_task');
end $$;

reset role;
update public.scheduled_rule_actions set run_at = now() - interval '1 minute';
set role service_role;

do $$
declare
  result jsonb;
begin
  result := public.workflow_tick();
  assert (result ->> 'due_rules')::int = 1, 'due-tomorrow rule fires once for the one task due tomorrow';
  assert (result ->> 'delayed_actions')::int = 2, 'both delayed jobs were processed';
  result := public.workflow_tick();
  assert (result ->> 'due_rules')::int = 0 and (result ->> 'delayed_actions')::int = 0, 'second tick is a no-op (deduped)';
end $$;

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false) is not null as ok \gset

do $$
declare
  due_t uuid := (select id from ids where name = 'due_task');
begin
  assert (select count(*) from public.comments where task_id = due_t and rule_id is not null and body like '@Later Person heads up%') = 1,
    'due-tomorrow comment mentions the assignee';
  assert exists (select 1 from public.inbox_items where task_id = due_t and kind = 'mention' and actor_id is null),
    'assignee is notified through the mention';
  assert exists (select 1 from public.email_outbox where task_id = due_t and template = 'due_tomorrow' and to_email = 'later@example.com'),
    'assignee gets the due-tomorrow email';
  assert exists (select 1 from public.comments where task_id = (select id from ids where name = 'stale_task') and body like '%still in Doing%'),
    'delayed nudge comments after the wait';
  assert not exists (select 1 from public.comments where task_id = (select id from ids where name = 'moved_task')),
    'delayed nudge is cancelled once the task left the section';
  assert (select status from public.scheduled_rule_actions where task_id = (select id from ids where name = 'moved_task')) = 'cancelled',
    'cancelled job is recorded';
end $$;

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false) is not null as ok \gset

-- Loop guard with the section-bound Status field ----------------------------------------------------

do $$
declare
  p uuid := (select id from ids where name = 'p');
  status_field uuid;
begin
  insert into public.custom_fields (project_id, name, field_type, bound_to_sections) values (p, 'Status', 'single_select', true)
  returning id into status_field;
  insert into ids values ('f_status', status_field);

  begin
    insert into public.rules (project_id, name, trigger_type, trigger_config, actions)
    values (p, 'Bad', 'field_changed', jsonb_build_object('field_id', status_field), '[{"type": "add_comment", "body": "x"}]');
    raise exception 'field_changed on the section-bound Status must be rejected';
  exception when check_violation then null;
  end;

  -- Two rules that fight: entering Loop A sets Status to Loop B; entering Loop B moves back to Loop A.
  insert into public.rules (project_id, name, enabled, trigger_type, trigger_config, actions) values
    (p, 'A sets status B', true, 'section_changed', jsonb_build_object('section_id', (select id from ids where name = 's_loop_a')),
      jsonb_build_array(jsonb_build_object('type', 'set_field', 'field_id', status_field, 'value', (select id from ids where name = 's_loop_b')))),
    (p, 'B moves to A', true, 'section_changed', jsonb_build_object('section_id', (select id from ids where name = 's_loop_b')),
      jsonb_build_array(jsonb_build_object('type', 'move_section', 'section_id', (select id from ids where name = 's_loop_a'))));
  insert into ids values ('loop_task', public.create_task(p, null, 'Ping pong'));
end $$;

do $$
declare
  t uuid := (select id from ids where name = 'loop_task');
begin
  update public.task_projects set section_id = (select id from ids where name = 's_loop_a') where task_id = t;
  assert (select section_id from public.task_projects where task_id = t) = (select id from ids where name = 's_loop_a'),
    'the chain stops: the task ends where the last allowed rule put it';
  assert exists (
    select 1 from public.rule_runs rr join public.rules r on r.id = rr.rule_id
    where rr.task_id = t and rr.status = 'skipped' and rr.detail ->> 'reason' = 'loop' and r.name = 'A sets status B'
  ), 'the re-entrant rule is logged as skipped (loop)';
  assert (select count(*) from public.task_stories where task_id = t and kind = 'section_changed') = 3,
    'exactly three moves: user → A, rule → B, rule → A';
  assert not exists (select 1 from public.task_field_values where task_id = t and field_id = (select id from ids where name = 'f_status')),
    'setting the section-bound Status stores no value';
end $$;

-- Disabled rules never fire; task_created runs at commit with the final state. ----------------------

do $$
declare
  p uuid := (select id from ids where name = 'p');
begin
  insert into public.rules (project_id, name, enabled, trigger_type, conditions, actions)
  values (p, 'Follow new intake', true, 'task_created',
    jsonb_build_array(jsonb_build_object('type', 'section_is', 'section_id', (select id from ids where name = 's_intake'))),
    '[{"type": "add_followers", "people": ["44444444-4444-4444-8444-444444444444"]}]');
  insert into ids values ('created_in_intake', public.create_task(p, (select id from ids where name = 's_intake'), 'New intake'));
  insert into ids values ('created_elsewhere', public.create_task(p, (select id from ids where name = 's_doing'), 'Not intake'));
end $$;

do $$
begin
  assert exists (select 1 from public.task_followers where task_id = (select id from ids where name = 'created_in_intake')
    and profile_id = '44444444-4444-4444-8444-444444444444'), 'task_created rule saw the initial section';
  assert not exists (select 1 from public.task_followers where task_id = (select id from ids where name = 'created_elsewhere')
    and profile_id = '44444444-4444-4444-8444-444444444444'), 'conditions filter task_created';
  assert not exists (select 1 from public.rule_runs where rule_id = (select id from ids where name = 'draft_rule')),
    'disabled rules never run';
end $$;

-- Form submitted trigger (intake triage preset).
do $$
begin
  perform public.install_rule_preset((select id from ids where name = 'p'), 'intake_triage',
    '{"owner": "44444444-4444-4444-8444-444444444444"}', true);
  insert into ids values ('triaged', (public.submit_form((select id from ids where name = 'form'), 'third@example.org',
    '{"title": "Menu board", "kind": "digital"}') ->> 'task_id')::uuid);
  assert (select assignee_id from public.tasks where id = (select id from ids where name = 'triaged'))
    = '44444444-4444-4444-8444-444444444444', 'form_submitted rule assigns the triage owner';
end $$;

-- Email delivery worker (service role) ---------------------------------------------------------------

reset role;
set role service_role;

do $$
declare
  claimed public.email_outbox;
  n integer := 0;
begin
  -- The drain's claim since Email live (claim_email_outbox is the legacy one and skips comment emails).
  for claimed in select * from public.claim_email_deliveries(100) loop
    n := n + 1;
    perform public.complete_email_outbox(claimed.id, 'mocked');
  end loop;
  assert n >= 6, 'worker claims queued emails';
  assert (select count(*) from public.email_outbox where status = 'pending') = 0, 'all claimed';
  assert (select count(*) from public.claim_email_deliveries(100)) = 0, 'nothing left to claim';
end $$;

-- Outsiders and anon -------------------------------------------------------------------------------

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false) is not null as ok \gset

do $$
begin
  assert (select count(*) from public.rules) = 0, 'outsider cannot read rules';
  assert (select count(*) from public.forms) = 0, 'outsider cannot read forms';
  assert (select count(*) from public.approval_requests) = 0, 'outsider cannot read approvals';
  assert (select count(*) from public.email_outbox) = 0, 'outsider cannot read the outbox';
  begin
    perform public.decide_approval((select id from ids where name = 'routed_approval'), 'approved');
    raise exception 'outsider must not decide';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
set role anon;

do $$
begin
  begin
    perform public.workflow_tick();
    raise exception 'anon must not run the scheduler';
  exception when insufficient_privilege then null;
  end;
  -- Since Review hardening anon has no table privileges at all, so this is a permission check, not RLS.
  assert not has_table_privilege('anon', 'public.forms', 'select'), 'anon cannot read forms directly';
end $$;

reset role;
select 'workflows smoke: all assertions passed' as result;
