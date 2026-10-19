-- ALHC Projects — Security review pass 2 fixes (docs/SECURITY-REVIEW.md).
--
-- 1. Webhook URLs: integration_url_ok also refuses the shared (100.64.0.0/10), protocol,
--    documentation, benchmarking, multicast, and reserved IPv4 literals. Host names are checked
--    where it matters, at send time: the app's drain resolves the host itself and refuses private,
--    loopback, and link-local answers (src/lib/safe-fetch.ts).
-- 2. custom_field_project / rule_project mapped any field or rule id to its project for any
--    signed-in caller. The policies that used them now call custom_field_has_role / rule_has_role
--    (a yes / no about the caller's own role, nothing else), and the two old helpers answer only
--    for projects the caller can read and are no longer granted to clients. (task_request_label
--    and format_request_label became SECURITY INVOKER in 20261018010000_task_numbering.sql.)
-- 3. Removing a comment now removes its text from everything a client can read: the comment's
--    body becomes "[deleted]", the copies in email_outbox payloads are blanked, and the original
--    text is kept in comment_removed_bodies (RLS on, no policies, no client privileges) so
--    nothing is lost for an operator. Existing removed comments get the same treatment.
--    task_comment_page no longer returns a removed comment's email address or subject.
-- 4. TRUNCATE, REFERENCES, and TRIGGER are revoked from anon and authenticated on every ALHC
--    table (RLS doesn't cover TRUNCATE) and on storage.objects. New tables call
--    alhc_revoke_client_truncate (kept on the hosted project, like alhc_revoke_anon_grants).
-- 5. Workspace logos stay in a public bucket (the sidebar, and later emails, need a plain URL),
--    but only workspace admins list the bucket's objects; the tail lets them remove old logos.
--
-- No new client SECURITY DEFINER function besides the two role booleans (pinned in suite 60).
-- fire_rules, notify_with, notify_message, and add_story are untouched. Additive: the release on
-- main keeps working once this is applied.

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

-- ---------------------------------------------------------------------------------------------
-- 1. Webhook URL literals
-- ---------------------------------------------------------------------------------------------

select public.alhc_patch_function(
  'public.integration_url_ok(text)'::regprocedure,
  E'    and public.integration_url_host(url) !~ ''^172\\.(1[6-9]|2[0-9]|3[01])\\.''\n',
  E'    and public.integration_url_host(url) !~ ''^172\\.(1[6-9]|2[0-9]|3[01])\\.''\n'
  || E'    -- Shared (CGNAT), protocol, documentation, benchmarking, multicast, and reserved ranges.\n'
  || E'    -- Host names that resolve to private addresses are refused by the app at send time.\n'
  || E'    and public.integration_url_host(url) !~ ''^(100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])|192\\.0\\.[02]|192\\.88\\.99|198\\.(1[89]|51\\.100)|203\\.0\\.113|22[4-9]|2[3-5][0-9])\\.''\n'
);

-- ---------------------------------------------------------------------------------------------
-- 2. Field and rule role checks without leaking the project id
-- ---------------------------------------------------------------------------------------------

-- Whether the caller has at least min_role in the field's project. False for an unknown field.
create or replace function public.custom_field_has_role(target_field uuid, min_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select public.has_project_role(f.project_id, min_role)
    from public.custom_fields f
    where f.id = target_field
  ), false);
$$;

create or replace function public.rule_has_role(target_rule uuid, min_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select public.has_project_role(r.project_id, min_role)
    from public.rules r
    where r.id = target_rule
  ), false);
$$;

revoke all on function public.custom_field_has_role(uuid, text) from public, anon;
revoke all on function public.rule_has_role(uuid, text) from public, anon;
grant execute on function public.custom_field_has_role(uuid, text) to authenticated, service_role;
grant execute on function public.rule_has_role(uuid, text) to authenticated, service_role;

alter policy task_field_values_select_viewer on public.task_field_values
  using ((select public.custom_field_has_role(field_id, 'viewer')));
alter policy task_field_values_insert_editor on public.task_field_values
  with check ((select public.custom_field_has_role(field_id, 'editor')));
alter policy task_field_values_update_editor on public.task_field_values
  using ((select public.custom_field_has_role(field_id, 'editor')))
  with check ((select public.custom_field_has_role(field_id, 'editor')));
alter policy rule_runs_select_viewer on public.rule_runs
  using ((select public.rule_has_role(rule_id, 'viewer')));
alter policy scheduled_rule_actions_select_viewer on public.scheduled_rule_actions
  using ((select public.rule_has_role(rule_id, 'viewer')));

-- Nothing calls these any more. They answer only for readable projects, and only the owner and
-- service_role can run them.
create or replace function public.custom_field_project(target_field uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select f.project_id from public.custom_fields f
  where f.id = target_field and public.has_project_role(f.project_id, 'viewer');
$$;

create or replace function public.rule_project(target_rule uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.project_id from public.rules r
  where r.id = target_rule and public.has_project_role(r.project_id, 'viewer');
$$;

revoke all on function public.custom_field_project(uuid) from public, anon, authenticated;
revoke all on function public.rule_project(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Removed comments keep no readable text
-- ---------------------------------------------------------------------------------------------

-- The text of removed comments, out of every client's reach.
create table public.comment_removed_bodies (
  comment_id uuid primary key references public.comments (id),
  body text not null,
  removed_at timestamptz not null default now()
);
alter table public.comment_removed_bodies enable row level security;
revoke all on public.comment_removed_bodies from public, anon, authenticated;
comment on table public.comment_removed_bodies is
  'Original text of removed comments (security review pass 2). No client access: RLS on, no policies, no privileges.';

create or replace function public.scrub_removed_comment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null and old.body <> '[deleted]' then
    insert into public.comment_removed_bodies (comment_id, body, removed_at)
    values (new.id, old.body, new.deleted_at)
    on conflict (comment_id) do nothing;
    new.body := '[deleted]';
    -- The emailed copies: comment emails to followers and responses to a form's submitter.
    update public.email_outbox o
    set payload = o.payload || jsonb_build_object('comment_body', '')
    where o.comment_id = new.id and o.payload ? 'comment_body';
    update public.email_outbox o
    set payload = o.payload || jsonb_build_object('message', '')
    where o.task_id = new.task_id
      and o.payload ->> 'kind' = 'submitter_response'
      and o.payload ->> 'comment_id' = new.id::text;
  end if;
  return new;
end;
$$;

revoke all on function public.scrub_removed_comment() from public, anon, authenticated;

-- After every other BEFORE UPDATE trigger (the guards look at the change the person made).
create trigger comments_zz_scrub_removed
before update of deleted_at on public.comments
for each row
when (old.deleted_at is null and new.deleted_at is not null)
execute function public.scrub_removed_comment();

-- Comments removed before this migration.
insert into public.comment_removed_bodies (comment_id, body, removed_at)
select c.id, c.body, c.deleted_at
from public.comments c
where c.deleted_at is not null and c.body <> '[deleted]'
on conflict (comment_id) do nothing;

update public.email_outbox o
set payload = o.payload || jsonb_build_object('comment_body', '')
from public.comments c
where o.comment_id = c.id and c.deleted_at is not null and o.payload ? 'comment_body';

update public.email_outbox o
set payload = o.payload || jsonb_build_object('message', '')
from public.comments c
where o.task_id = c.task_id
  and o.payload ->> 'kind' = 'submitter_response'
  and o.payload ->> 'comment_id' = c.id::text
  and c.deleted_at is not null;

alter table public.comments disable trigger comments_set_updated_at;
update public.comments set body = '[deleted]'
where deleted_at is not null and body <> '[deleted]';
alter table public.comments enable trigger comments_set_updated_at;

select public.alhc_patch_function(
  'public.task_comment_page(uuid,timestamptz,uuid,integer)'::regprocedure,
  'c.email_direction, c.email_address, c.email_subject',
  'case when c.deleted_at is null then c.email_direction end as email_direction,'
  || E'\n           case when c.deleted_at is null then c.email_address end as email_address,'
  || E'\n           case when c.deleted_at is null then c.email_subject end as email_subject'
);

-- ---------------------------------------------------------------------------------------------
-- 4. No TRUNCATE (or REFERENCES / TRIGGER) for clients
-- ---------------------------------------------------------------------------------------------

-- New ALHC tables call this next to alhc_revoke_anon_grants. Missing tables are skipped.
create or replace function public.alhc_revoke_client_truncate(tables text[])
returns void
language plpgsql
set search_path = ''
as $$
declare
  t text;
begin
  foreach t in array tables loop
    if to_regclass('public.' || quote_ident(t)) is not null then
      execute format('revoke truncate, references, trigger on public.%I from public, anon, authenticated', t);
    end if;
  end loop;
end;
$$;

revoke all on function public.alhc_revoke_client_truncate(text[]) from public, anon, authenticated;

select public.alhc_revoke_client_truncate(array[
  'allowed_emails', 'comment_removed_bodies', 'approval_requests', 'calendar_feeds',
  'comment_mentions', 'comment_reactions', 'comments', 'custom_fields', 'dashboard_widgets',
  'email_forwarding_addresses', 'email_forwards', 'email_outbox', 'email_preferences',
  'email_replies', 'email_reply_tokens', 'email_suppressions', 'form_submissions', 'forms',
  'goal_links', 'goal_status_updates', 'goals', 'import_external_ids', 'import_runs',
  'inbound_calls', 'inbound_endpoints', 'inbox_items', 'integration_outbox',
  'integration_secrets', 'list_column_widths', 'my_task_placements', 'my_task_sections',
  'notification_settings', 'pending_memberships', 'personal_dashboard_widgets',
  'personal_dashboards', 'portfolio_children', 'portfolio_field_values', 'portfolio_fields',
  'portfolio_members', 'portfolio_projects', 'portfolios', 'profiles', 'project_integrations',
  'project_members', 'project_message_mentions', 'project_message_reactions',
  'project_messages', 'project_stars', 'project_status_templates', 'project_status_updates',
  'project_stories', 'project_templates', 'project_views', 'projects', 'report_schedules',
  'request_counters', 'request_number_gaps', 'request_sequences', 'rule_presets', 'rule_runs',
  'rules', 'scheduled_rule_actions', 'sections', 'submitter_reply_threads', 'subtasks',
  'tag_field_migrations', 'tags', 'task_attachment_links', 'task_attachments',
  'task_dependencies', 'task_field_values', 'task_followers', 'task_likes', 'task_projects',
  'task_stories', 'task_tags', 'task_templates', 'tasks', 'team_curated_work', 'team_members',
  'team_message_followers', 'team_message_mentions', 'team_message_reactions', 'team_messages',
  'team_projects', 'teams', 'workload_capacities', 'workspace_admins', 'workspaces'
]);

-- storage.objects: the Storage API never truncates. Skipped (with a notice) where this role
-- can't change the table's grants.
do $$
begin
  revoke truncate, references, trigger on storage.objects from anon, authenticated;
exception when insufficient_privilege then
  raise notice 'storage.objects grants left unchanged: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 5. Workspace logos: public files, admin-only listing
-- ---------------------------------------------------------------------------------------------

-- The storage.objects policy changes (admin-only listing, admin delete) live in
-- supabase/manual/20261018020000_storage_logo_policies.sql. storage.objects is owned by
-- supabase_storage_admin, so the migration role (postgres) can't alter its policies
-- ("must be owner of table objects"). Run that file by hand as the storage owner.
