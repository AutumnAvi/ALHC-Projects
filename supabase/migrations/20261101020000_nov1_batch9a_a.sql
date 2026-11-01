-- Nov 1 notes, batch 9a (items 66, 67, 68, 69, 71, 72, comment links + comment pinning (Asana tests 10.3 /
-- 10.4), and two approval decisions). Additive: new tables, columns, functions, and asserted patches;
-- nothing is renamed or taken away. Ordered for a chunked apply: new columns and tables first, every
-- function before its callers, guards after the paths they rely on.
--
-- One TAIL section at the very end (applied by hand, like every tail): item 66's daily Trash purge, the
-- only code in this release that removes rows. Everything above it works without it (the Trash pages say
-- when things will go; nothing is purged until the tail is applied).
--
-- What the database gains (the app does the rest):
--   * 66 Trash retention: trash_retention_days() (90), trash_purged_items (what was purged, ids only),
--     trash_purge_runs (each run's counts), trash_storage_purges (the files a purge leaves for the app's
--     cron route to remove through the Storage API — SQL can't remove a Storage object's bytes) with
--     claim_trash_storage_purges / finish_trash_storage_purge (service_role). TAIL: alhc_purge_trash()
--     (definer, no client grants) and pg_cron job alhc-trash-purge (daily 03:47 UTC).
--   * 69 Verified domains: verified_email_domains (seeded with autumnhc.net and autumnlakemarketing.com;
--     workspace admins add / remove), workspaces.verified_domain_conversations (on by default),
--     forms.verified_domains_only, email_conversation_overrides (per request or per submitter address;
--     workspace admins), submitter_conversation_status / set_email_conversation_override (client
--     definers, pinned in suite 60). Only a submitter whose address is on a verified domain gets the
--     reply-by-email conversation (fill_comment_email, submitter_reply_token, post_submitter_reply
--     patched), unless an admin allowed it; submit_form refuses other addresses on a verified-only form.
--   * 10.4 Comment pinning: comments.pinned_at / pinned_by, set_comment_pinned (client definer, Editors+,
--     pinned in suite 60), comment_pin_events (the activity), task_comment_page returns the pin, and
--     task_pinned_comments (invoker) returns a task's pinned comments in the page's shape.
--   * Approvals (a): only an approval task's approvers ever complete it by hand, also after its latest
--     round is approved; rules' Mark complete always skips approval tasks (guard_task_kind,
--     execute_rule_actions, run_my_task_rule patched). This reverses batch 7's "anyone who can edit it,
--     once approved". Approvers often have only Commenter access, so complete_approval_as_approver
--     (client definer, pinned in suite 60) completes it for an active approver.
--   * Approvals (b): the guided setup's follow-up step is stored on task_approval_settings
--     (after_approval, after_section_id, reminders) through set_approval_followup (client definer,
--     Editors+, pinned in suite 60); approval_reminders_tick skips tasks with reminders off.
-- fire_rules, notify_with, notify_message, and add_story are untouched.

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

-- =================================================================================================
-- 1. New columns
-- =================================================================================================

-- 10.4 Comment pinning.
alter table public.comments add column if not exists pinned_at timestamptz;
alter table public.comments add column if not exists pinned_by uuid references public.profiles (id);
create index if not exists comments_pinned_idx on public.comments (task_id, pinned_at)
  where pinned_at is not null and deleted_at is null;
create index if not exists comments_pinned_by_idx on public.comments (pinned_by);
comment on column public.comments.pinned_at is
  'Nov 1 notes, batch 9a: when an Editor+ pinned the comment to the top of its task''s feed (set_comment_pinned only).';

-- 69 Verified domains: the workspace switch and the per-form switch.
alter table public.workspaces add column if not exists verified_domain_conversations boolean not null default true;
grant update (verified_domain_conversations) on public.workspaces to authenticated;
comment on column public.workspaces.verified_domain_conversations is
  'Nov 1 notes, item 69: on = only form submitters whose address is on a verified domain '
  '(verified_email_domains) get the reply-by-email conversation on their requests (workspace admins).';

alter table public.forms add column if not exists verified_domains_only boolean not null default false;
comment on column public.forms.verified_domains_only is
  'Nov 1 notes, item 69: only addresses on a verified domain may submit this form (submit_form refuses others).';

-- Approvals (b): what happens after approval, chosen in the guided setup (prefills Ready for approval).
alter table public.task_approval_settings add column if not exists after_approval text;
alter table public.task_approval_settings add column if not exists after_section_id uuid references public.sections (id);
alter table public.task_approval_settings add column if not exists reminders boolean not null default true;
create index if not exists task_approval_settings_after_section_idx on public.task_approval_settings (after_section_id);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'task_approval_settings_after_check') then
    alter table public.task_approval_settings add constraint task_approval_settings_after_check
      check (after_approval is null or after_approval in ('complete', 'move_section', 'notify'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'task_approval_settings_after_section_check') then
    alter table public.task_approval_settings add constraint task_approval_settings_after_section_check
      check (after_approval is distinct from 'move_section' or after_section_id is not null);
  end if;
end $$;
grant select (after_approval, after_section_id, reminders) on public.task_approval_settings to authenticated;
comment on column public.task_approval_settings.after_approval is
  'Nov 1 notes, batch 9a: the guided approval setup''s follow-up (complete | move_section | notify; null = '
  'not chosen yet: complete). Ready for approval starts from it.';

-- =================================================================================================
-- 2. New tables
-- =================================================================================================

-- 69. Verified email domains (workspace-level; everyone allowlisted reads, workspace admins manage).
create table if not exists public.verified_email_domains (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  domain text not null,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references public.profiles (id),
  constraint verified_email_domains_domain_check check (
    char_length(domain) between 3 and 253
    and domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
  )
);
create unique index if not exists verified_email_domains_live_key
  on public.verified_email_domains (workspace_id, domain) where removed_at is null;
create index if not exists verified_email_domains_created_by_idx on public.verified_email_domains (created_by);
create index if not exists verified_email_domains_removed_by_idx on public.verified_email_domains (removed_by);
alter table public.verified_email_domains enable row level security;
revoke all on public.verified_email_domains from anon, authenticated;
select public.alhc_revoke_anon_grants(array['verified_email_domains']);
select public.alhc_revoke_client_truncate(array['verified_email_domains']);
grant select on public.verified_email_domains to authenticated;
grant insert (workspace_id, domain) on public.verified_email_domains to authenticated;
grant update (removed_at) on public.verified_email_domains to authenticated;
create policy verified_email_domains_select_allowlisted on public.verified_email_domains
  for select to authenticated using ((select public.is_allowlisted()));
create policy verified_email_domains_insert_admin on public.verified_email_domains
  for insert to authenticated with check ((select public.is_workspace_admin(workspace_id)));
create policy verified_email_domains_update_admin on public.verified_email_domains
  for update to authenticated
  using ((select public.is_workspace_admin(workspace_id)))
  with check ((select public.is_workspace_admin(workspace_id)));
comment on table public.verified_email_domains is
  'Nov 1 notes, item 69: domains whose addresses count as verified for request email conversations and '
  'verified-only forms (Admin console → Security). Not the sign-up allowlist (allowed_emails).';

-- 69. A workspace admin's decision for one request (task_id) or one submitter address (email).
create table if not exists public.email_conversation_overrides (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  task_id uuid references public.tasks (id),
  email text,
  allowed boolean not null,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  cleared_at timestamptz,
  cleared_by uuid references public.profiles (id),
  constraint email_conversation_overrides_target_check check ((task_id is null) <> (email is null)),
  constraint email_conversation_overrides_email_check check (email is null or (email = lower(btrim(email)) and char_length(email) <= 320))
);
create unique index if not exists email_conversation_overrides_task_key
  on public.email_conversation_overrides (task_id) where task_id is not null and cleared_at is null;
create unique index if not exists email_conversation_overrides_email_key
  on public.email_conversation_overrides (workspace_id, email) where email is not null and cleared_at is null;
create index if not exists email_conversation_overrides_created_by_idx on public.email_conversation_overrides (created_by);
create index if not exists email_conversation_overrides_cleared_by_idx on public.email_conversation_overrides (cleared_by);
alter table public.email_conversation_overrides enable row level security;
revoke all on public.email_conversation_overrides from anon, authenticated;
select public.alhc_revoke_anon_grants(array['email_conversation_overrides']);
select public.alhc_revoke_client_truncate(array['email_conversation_overrides']);
comment on table public.email_conversation_overrides is
  'Nov 1 notes, item 69: workspace admins allow (or stop) the email conversation for one request or for '
  'every request from one address. No client access: set_email_conversation_override / '
  'submitter_conversation_status.';

-- 10.4. Pin / Unpin, for the task's activity (comments carry only the current pin).
create table if not exists public.comment_pin_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id),
  comment_id uuid not null references public.comments (id),
  actor_id uuid references public.profiles (id),
  pinned boolean not null,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists comment_pin_events_task_idx on public.comment_pin_events (task_id, created_at);
create index if not exists comment_pin_events_comment_idx on public.comment_pin_events (comment_id);
create index if not exists comment_pin_events_actor_idx on public.comment_pin_events (actor_id);
alter table public.comment_pin_events enable row level security;
revoke all on public.comment_pin_events from anon, authenticated;
select public.alhc_revoke_anon_grants(array['comment_pin_events']);
select public.alhc_revoke_client_truncate(array['comment_pin_events']);
grant select on public.comment_pin_events to authenticated;
create policy comment_pin_events_select_viewer on public.comment_pin_events
  for select to authenticated using ((select public.has_task_role(task_id, 'viewer')));
comment on table public.comment_pin_events is
  'Nov 1 notes, batch 9a: who pinned or unpinned which comment, when (the pane''s All activity). Written '
  'only by set_comment_pinned.';

-- 66. What the Trash purge removed (ids only, never content), each run's counts, and the files it left
--     for the app to remove. No client access to any of them.
create table if not exists public.trash_purged_items (
  kind text not null check (kind in ('project', 'task', 'comment', 'attachment')),
  item_id uuid not null,
  deleted_at timestamptz,
  purged_at timestamptz not null default now(),
  primary key (kind, item_id)
);
create table if not exists public.trash_purge_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  counts jsonb not null default '{}'::jsonb,
  error text
);
create table if not exists public.trash_storage_purges (
  id uuid primary key default gen_random_uuid(),
  bucket text not null check (char_length(bucket) between 1 and 100),
  path text not null check (char_length(path) between 1 and 1024),
  is_prefix boolean not null default false,
  queued_at timestamptz not null default now(),
  claimed_at timestamptz,
  attempts integer not null default 0,
  done_at timestamptz,
  removed integer,
  last_error text check (char_length(last_error) <= 500)
);
create unique index if not exists trash_storage_purges_open_key
  on public.trash_storage_purges (bucket, path) where done_at is null;
do $$
begin
  execute 'alter table public.trash_purged_items enable row level security';
  execute 'alter table public.trash_purge_runs enable row level security';
  execute 'alter table public.trash_storage_purges enable row level security';
end $$;
revoke all on public.trash_purged_items, public.trash_purge_runs, public.trash_storage_purges from anon, authenticated;
select public.alhc_revoke_anon_grants(array['trash_purged_items', 'trash_purge_runs', 'trash_storage_purges']);
select public.alhc_revoke_client_truncate(array['trash_purged_items', 'trash_purge_runs', 'trash_storage_purges']);
comment on table public.trash_purged_items is
  'Nov 1 notes, item 66: projects, tasks, comments, and attachments the daily Trash purge removed (ids only).';
comment on table public.trash_purge_runs is 'Nov 1 notes, item 66: each Trash purge run and what it removed (counts).';
comment on table public.trash_storage_purges is
  'Nov 1 notes, item 66: Storage files (a path, or a task''s whole folder) the Trash purge left for the '
  'app''s cron route to remove through the Storage API (claim_trash_storage_purges).';

-- =================================================================================================
-- 3. Seed the verified domains (every workspace)
-- =================================================================================================

insert into public.verified_email_domains (workspace_id, domain)
select w.id, d.domain
from public.workspaces w
cross join (values ('autumnhc.net'), ('autumnlakemarketing.com')) as d(domain)
where w.deleted_at is null
  and not exists (
    select 1 from public.verified_email_domains v
    where v.workspace_id = w.id and v.domain = d.domain and v.removed_at is null
  );

-- =================================================================================================
-- 4. Functions
-- =================================================================================================

-- 66. How long things stay in the Trash (mirrored by TRASH_RETENTION_DAYS in src/lib/trash.ts).
create or replace function public.trash_retention_days()
returns integer
language sql
immutable
set search_path = ''
as $$ select 90 $$;
revoke all on function public.trash_retention_days() from public, anon;
grant execute on function public.trash_retention_days() to authenticated, service_role;
select public.alhc_revoke_anon_execute(array['trash_retention_days()']);

-- 66. The cron route takes up to max_items queued files, never one a live row still points at: a folder
-- whose task still exists, or a path a task_attachments row still has (those are closed without removal).
create or replace function public.claim_trash_storage_purges(max_items integer default 50)
returns table (id uuid, bucket text, path text, is_prefix boolean)
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.trash_storage_purges q
  set done_at = now(), removed = 0, last_error = 'Kept: still in use'
  where q.done_at is null
    and (
      (q.is_prefix and exists (
        select 1 from public.tasks t where t.id::text = split_part(q.path, '/', 1)
      ))
      or (not q.is_prefix and exists (
        select 1 from public.task_attachments a where a.storage_path = q.path
      ))
    );
  return query
  with picked as (
    select q.id from public.trash_storage_purges q
    where q.done_at is null
      and q.attempts < 5
      and (q.claimed_at is null or q.claimed_at < now() - interval '10 minutes')
    order by q.queued_at, q.id
    limit greatest(1, least(coalesce(max_items, 50), 500))
    for update skip locked
  )
  update public.trash_storage_purges q
  set claimed_at = now(), attempts = q.attempts + 1
  from picked
  where q.id = picked.id
  returning q.id, q.bucket, q.path, q.is_prefix;
end;
$$;

create or replace function public.finish_trash_storage_purge(target uuid, removed_count integer, error_message text default null)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.trash_storage_purges
  set done_at = case when error_message is null then now() else done_at end,
      removed = coalesce(removed_count, 0),
      last_error = left(error_message, 500),
      claimed_at = case when error_message is null then claimed_at else null end
  where id = target;
$$;

revoke all on function public.claim_trash_storage_purges(integer) from public, anon, authenticated;
revoke all on function public.finish_trash_storage_purge(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.claim_trash_storage_purges(integer) to service_role;
grant execute on function public.finish_trash_storage_purge(uuid, integer, text) to service_role;

-- 69. Verified domains: the guard (invoker) keeps a row's domain clean and its removal final.
create or replace function public.guard_verified_email_domain()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.domain := lower(btrim(regexp_replace(coalesce(new.domain, ''), '^\s*@', '')));
    if public.is_client_role() then
      new.created_by := auth.uid();
      new.created_at := now();
      new.removed_at := null;
      new.removed_by := null;
    end if;
    if new.domain !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' then
      raise exception 'Enter a domain like example.com' using errcode = 'check_violation';
    end if;
    if exists (
      select 1 from public.verified_email_domains v
      where v.workspace_id = new.workspace_id and v.domain = new.domain and v.removed_at is null
    ) then
      raise exception '% is already a verified domain', new.domain using errcode = 'unique_violation';
    end if;
    return new;
  end if;
  if new.workspace_id <> old.workspace_id or new.domain <> old.domain or new.created_at <> old.created_at
     or new.created_by is distinct from old.created_by then
    raise exception 'A verified domain can''t be changed; remove it and add another' using errcode = 'check_violation';
  end if;
  if old.removed_at is not null and new.removed_at is distinct from old.removed_at then
    raise exception 'This domain was already removed; add it again instead' using errcode = 'check_violation';
  end if;
  if old.removed_at is null and new.removed_at is not null then
    new.removed_at := now();
    new.removed_by := auth.uid();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.guard_verified_email_domain() from public, anon;
grant execute on function public.guard_verified_email_domain() to authenticated;
select public.alhc_revoke_anon_execute(array['guard_verified_email_domain()']);

create trigger verified_email_domains_05_guard
  before insert or update on public.verified_email_domains
  for each row execute function public.guard_verified_email_domain();

-- Whether an address is on one of the workspace's verified domains (exact domain after the @).
create or replace function public.email_on_verified_domain(address text, target_workspace uuid default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.verified_email_domains v
    where v.removed_at is null
      and v.workspace_id = coalesce(target_workspace, public.default_workspace_id())
      and v.domain = lower(split_part(btrim(coalesce(address, '')), '@', 2))
      and position('@' in btrim(coalesce(address, ''))) > 1
  );
$$;
revoke all on function public.email_on_verified_domain(text, uuid) from public, anon, authenticated;

-- The verified domains as a list ("autumnhc.net or autumnlakemarketing.com") for messages.
create or replace function public.verified_domains_text(target_workspace uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(string_agg(v.domain, ' or ' order by v.domain), 'a verified domain')
  from public.verified_email_domains v
  where v.removed_at is null and v.workspace_id = coalesce(target_workspace, public.default_workspace_id());
$$;
revoke all on function public.verified_domains_text(uuid) from public, anon, authenticated;

-- A task's request conversation (its top-level task's submitter): who, and whether it's on. Internal.
--   reason: override_request | override_submitter (a workspace admin decided), setting_off (the
--   workspace's switch is off: everyone), verified, unverified, no_submitter.
create or replace function public.submitter_conversation_info(target_task uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  root uuid;
  ws uuid;
  address text;
  setting_on boolean;
  verified boolean;
  o public.email_conversation_overrides;
begin
  select coalesce(t.root_task_id, t.id), t.workspace_id into root, ws from public.tasks t where t.id = target_task;
  if root is null then
    return jsonb_build_object('allowed', false, 'reason', 'no_submitter');
  end if;
  select s.submitter_email into address from public.task_submitter(root) s;
  if address is null then
    return jsonb_build_object('allowed', false, 'reason', 'no_submitter');
  end if;
  select coalesce(w.verified_domain_conversations, true) into setting_on from public.workspaces w where w.id = ws;
  setting_on := coalesce(setting_on, true);
  verified := public.email_on_verified_domain(address, ws);
  select * into o from public.email_conversation_overrides x
  where x.task_id = root and x.cleared_at is null limit 1;
  if found then
    return jsonb_build_object('allowed', o.allowed, 'reason', 'override_request', 'email', address,
      'domain', split_part(address, '@', 2), 'verified', verified, 'setting_on', setting_on);
  end if;
  select * into o from public.email_conversation_overrides x
  where x.workspace_id = ws and x.email = address and x.cleared_at is null limit 1;
  if found then
    return jsonb_build_object('allowed', o.allowed, 'reason', 'override_submitter', 'email', address,
      'domain', split_part(address, '@', 2), 'verified', verified, 'setting_on', setting_on);
  end if;
  return jsonb_build_object(
    'allowed', verified or not setting_on,
    'reason', case when not setting_on then 'setting_off' when verified then 'verified' else 'unverified' end,
    'email', address, 'domain', split_part(address, '@', 2), 'verified', verified, 'setting_on', setting_on);
end;
$$;
revoke all on function public.submitter_conversation_info(uuid) from public, anon, authenticated;

create or replace function public.submitter_conversation_allowed(target_task uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((public.submitter_conversation_info(target_task) ->> 'allowed')::boolean, false);
$$;
revoke all on function public.submitter_conversation_allowed(uuid) from public, anon, authenticated;

-- The pane: whether this request's email conversation is on, and why (task viewers; the address is the
-- one the task already shows them). Workspace admins also learn they may change it.
create or replace function public.submitter_conversation_status(target_task uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  ws uuid;
begin
  if target_task is null or not public.has_task_role(target_task, 'viewer') then
    return null;
  end if;
  select t.workspace_id into ws from public.tasks t where t.id = target_task;
  return public.submitter_conversation_info(target_task)
    || jsonb_build_object('can_override', public.is_workspace_admin(ws));
end;
$$;
revoke all on function public.submitter_conversation_status(uuid) from public, anon;
grant execute on function public.submitter_conversation_status(uuid) to authenticated;
select public.alhc_revoke_anon_execute(array['submitter_conversation_status(uuid)']);

-- Workspace admins: allow (true) or stop (false) the conversation for this request ('request') or for
-- every request from its submitter's address ('submitter'); null clears that decision.
create or replace function public.set_email_conversation_override(target_task uuid, scope text, allow boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  root uuid;
  ws uuid;
  address text;
begin
  select coalesce(t.root_task_id, t.id), t.workspace_id into root, ws
  from public.tasks t where t.id = target_task and t.deleted_at is null;
  if root is null or not public.has_task_role(target_task, 'viewer') then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if not public.is_workspace_admin(ws) then
    raise exception 'Only workspace admins can change who gets email conversations' using errcode = 'insufficient_privilege';
  end if;
  if scope not in ('request', 'submitter') then
    raise exception 'Choose this request or this submitter' using errcode = 'check_violation';
  end if;
  select s.submitter_email into address from public.task_submitter(root) s;
  if address is null then
    raise exception 'This task didn''t come from a form' using errcode = 'check_violation';
  end if;
  if scope = 'request' then
    update public.email_conversation_overrides set cleared_at = now(), cleared_by = auth.uid()
    where task_id = root and cleared_at is null;
    if allow is not null then
      insert into public.email_conversation_overrides (workspace_id, task_id, allowed, created_by)
      values (ws, root, allow, auth.uid());
    end if;
  else
    update public.email_conversation_overrides set cleared_at = now(), cleared_by = auth.uid()
    where workspace_id = ws and email = address and cleared_at is null;
    if allow is not null then
      insert into public.email_conversation_overrides (workspace_id, email, allowed, created_by)
      values (ws, address, allow, auth.uid());
    end if;
  end if;
  return public.submitter_conversation_status(target_task);
end;
$$;
revoke all on function public.set_email_conversation_override(uuid, text, boolean) from public, anon;
grant execute on function public.set_email_conversation_override(uuid, text, boolean) to authenticated;
select public.alhc_revoke_anon_execute(array['set_email_conversation_override(uuid,text,boolean)']);

-- 10.4. People can't pin through a plain write (no client grant would stop the table-level ones).
create or replace function public.guard_comment_pin()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_client_role() then
    if tg_op = 'INSERT' then
      new.pinned_at := null;
      new.pinned_by := null;
    elsif new.pinned_at is distinct from old.pinned_at or new.pinned_by is distinct from old.pinned_by then
      raise exception 'Use Pin / Unpin to pin a comment' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_comment_pin() from public, anon;
grant execute on function public.guard_comment_pin() to authenticated;
select public.alhc_revoke_anon_execute(array['guard_comment_pin()']);

create trigger comments_04d_guard_pin
  before insert or update on public.comments
  for each row execute function public.guard_comment_pin();

-- 10.4. Pin / Unpin a comment: Editors and above of the task (a subtask: its top-level task's projects).
-- At most 10 pinned comments per task. Each change is logged in comment_pin_events.
create or replace function public.set_comment_pinned(target_comment uuid, pin boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.comments;
begin
  select * into c from public.comments x where x.id = target_comment for update;
  if not found or c.deleted_at is not null or not public.has_task_role(c.task_id, 'viewer') then
    raise exception 'Comment not found' using errcode = 'no_data_found';
  end if;
  if not public.has_task_role(c.task_id, 'editor') then
    raise exception 'Only Editors and above can pin comments' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.tasks t where t.id = c.task_id and t.deleted_at is not null) then
    raise exception 'This task is in the Trash' using errcode = 'check_violation';
  end if;
  if coalesce(pin, false) and c.pinned_at is null then
    if (select count(*) from public.comments x
        where x.task_id = c.task_id and x.pinned_at is not null and x.deleted_at is null) >= 10 then
      raise exception 'A task can have up to 10 pinned comments. Unpin one first.' using errcode = 'check_violation';
    end if;
    update public.comments set pinned_at = clock_timestamp(), pinned_by = auth.uid() where id = c.id;
    insert into public.comment_pin_events (task_id, comment_id, actor_id, pinned) values (c.task_id, c.id, auth.uid(), true);
  elsif not coalesce(pin, false) and c.pinned_at is not null then
    update public.comments set pinned_at = null, pinned_by = null where id = c.id;
    insert into public.comment_pin_events (task_id, comment_id, actor_id, pinned) values (c.task_id, c.id, auth.uid(), false);
  end if;
  return jsonb_build_object('comment_id', c.id, 'pinned', coalesce(pin, false));
end;
$$;
revoke all on function public.set_comment_pinned(uuid, boolean) from public, anon;
grant execute on function public.set_comment_pinned(uuid, boolean) to authenticated;
select public.alhc_revoke_anon_execute(array['set_comment_pinned(uuid,boolean)']);

-- 10.4. The comment page carries each comment's pin.
select public.alhc_patch_function(
  'public.task_comment_page(uuid,timestamp with time zone,uuid,integer)'::regprocedure,
  $old$           case when c.deleted_at is null then c.email_subject end as email_subject
    from picked p$old$,
  $new$           case when c.deleted_at is null then c.email_subject end as email_subject,
           case when c.deleted_at is null then c.pinned_at end as pinned_at,
           case when c.deleted_at is null then c.pinned_by end as pinned_by
    from picked p$new$
);

-- 10.4. A task's pinned comments in task_comment_page's row shape (newest pin first; invoker: RLS
-- decides, and a rule's name shows only to readers of its project).
create or replace function public.task_pinned_comments(target_task uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.pinned_at desc, x.id), '[]'::jsonb)
  from (
    select c.id, c.author_id, c.rule_id,
           case
             when c.rule_id is null then null
             when public.has_project_role(r.project_id, 'viewer') then r.name
             else null
           end as rule_name,
           c.body, c.created_at, c.edited_at, c.deleted_at,
           coalesce((
             select jsonb_agg(m.profile_id) from public.comment_mentions m where m.comment_id = c.id
           ), '[]'::jsonb) as mention_ids,
           coalesce((
             select jsonb_agg(jsonb_build_object('emoji', rx.emoji, 'profile_id', rx.profile_id, 'created_at', rx.created_at)
                              order by rx.created_at)
             from public.comment_reactions rx
             where rx.comment_id = c.id and rx.deleted_at is null
           ), '[]'::jsonb) as reactions,
           c.email_direction, c.email_address, c.email_subject, c.pinned_at, c.pinned_by
    from public.comments c
    left join public.rules r on r.id = c.rule_id
    where c.task_id = target_task
      and c.pinned_at is not null
      and c.deleted_at is null
    order by c.pinned_at desc
    limit 10
  ) x;
$$;
revoke all on function public.task_pinned_comments(uuid) from public, anon;
grant execute on function public.task_pinned_comments(uuid) to authenticated;
select public.alhc_revoke_anon_execute(array['task_pinned_comments(uuid)']);

-- Approvals (b): the guided setup's follow-up step. Editors+ of an approval task; a section must be one
-- of the task's (its top-level task's) active projects'. Null after_approval = Complete the task.
create or replace function public.set_approval_followup(
  target_task uuid,
  followup text,
  followup_section uuid default null,
  send_reminders boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tasks;
begin
  select * into t from public.tasks where id = target_task and deleted_at is null for update;
  if not found or not public.has_task_role(target_task, 'viewer') then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if t.kind <> 'approval' then
    raise exception 'Only approval tasks have an approval follow-up' using errcode = 'check_violation';
  end if;
  if not public.has_task_role(target_task, 'editor') then
    raise exception 'You need Editor access to set up the approval' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(followup, 'complete') not in ('complete', 'move_section', 'notify') then
    raise exception 'Choose what happens after approval' using errcode = 'check_violation';
  end if;
  if coalesce(followup, 'complete') = 'move_section' then
    if followup_section is null or not exists (
      select 1 from public.sections s
      join public.task_projects tp on tp.project_id = s.project_id and tp.deleted_at is null
      where s.id = followup_section and s.deleted_at is null and tp.task_id = coalesce(t.root_task_id, t.id)
    ) then
      raise exception 'Pick a section of one of this task''s projects' using errcode = 'check_violation';
    end if;
  end if;
  insert into public.task_approval_settings as s (task_id, updated_by, after_approval, after_section_id, reminders)
  values (target_task, auth.uid(), coalesce(followup, 'complete'),
          case when coalesce(followup, 'complete') = 'move_section' then followup_section end,
          coalesce(send_reminders, true))
  on conflict (task_id) do update set
    after_approval = excluded.after_approval,
    after_section_id = excluded.after_section_id,
    reminders = excluded.reminders,
    updated_by = excluded.updated_by,
    updated_at = now();
  return jsonb_build_object('after_approval', coalesce(followup, 'complete'),
    'after_section_id', case when coalesce(followup, 'complete') = 'move_section' then followup_section end,
    'reminders', coalesce(send_reminders, true));
end;
$$;
revoke all on function public.set_approval_followup(uuid, text, uuid, boolean) from public, anon;
grant execute on function public.set_approval_followup(uuid, text, uuid, boolean) to authenticated;
select public.alhc_revoke_anon_execute(array['set_approval_followup(uuid,text,uuid,boolean)']);

-- Approvals (b): "Remind approvers" off in the setup's More options = no due-date reminders.
select public.alhc_patch_function(
  'public.approval_reminders_tick()'::regprocedure,
  $old$    join public.tasks t on t.id = x.task_id and t.deleted_at is null and t.completed_at is null
    where x.status = 'pending' and x.due_on is not null$old$,
  $new$    join public.tasks t on t.id = x.task_id and t.deleted_at is null and t.completed_at is null
    left join public.task_approval_settings st on st.task_id = x.task_id
    where x.status = 'pending' and x.due_on is not null
      and coalesce(st.reminders, true)$new$
);

-- =================================================================================================
-- 5. Approvals (a): only approvers complete an approval task, also once it's approved
--
-- Avi reversed batch 7's "once the latest round is approved, anyone who can edit it completes it":
-- a person completes an approval task only while they are one of its active approvers and no round is
-- pending — before or after an approval, with or without "More steps after approval". Rules' Mark
-- complete (and Convert to a project's "complete the task", and My Tasks rules' Mark complete) always
-- skip approval tasks with a logged reason. An approved round without more steps still completes the
-- task itself (finish_approved_round names its task in alhc.approval_finish); imports, copies, and
-- recurrence aren't checked. approval_round_approved() stays (the guard's message uses it).
-- =================================================================================================

select public.alhc_patch_function(
  'public.guard_task_kind()'::regprocedure,
  $old$      if not exists (
        select 1 from public.task_approvers a
        where a.task_id = new.id and a.profile_id = (select auth.uid()) and a.deleted_at is null
      ) and not public.approval_round_approved(new.id) then
        raise exception 'Only its approvers can complete an approval task. Send it with Ready for approval.'
          using errcode = 'check_violation';
      end if;
    elsif tg_op = 'UPDATE' and coalesce(current_setting('alhc.rule_id', true), '') <> ''
          and not public.approval_round_approved(new.id) then$old$,
  $new$      -- Nov 1 notes, batch 9a: approvers only, also after an approval (no "anyone can complete").
      if not exists (
        select 1 from public.task_approvers a
        where a.task_id = new.id and a.profile_id = (select auth.uid()) and a.deleted_at is null
      ) then
        if tg_op = 'UPDATE' and public.approval_round_approved(new.id) then
          raise exception 'This task was approved. Only its approvers can complete it.'
            using errcode = 'check_violation';
        end if;
        raise exception 'Only its approvers can complete an approval task. Send it with Ready for approval.'
          using errcode = 'check_violation';
      end if;
    elsif tg_op = 'UPDATE' and coalesce(current_setting('alhc.rule_id', true), '') <> '' then$new$
);

select public.alhc_patch_function(
  'public.execute_rule_actions(public.rules,uuid,jsonb,jsonb)'::regprocedure,
  $old$          if t.kind = 'approval' and t.completed_at is null and not public.approval_round_approved(target_task) then$old$,
  $new$          if t.kind = 'approval' and t.completed_at is null then$new$,
  $old$             and (t.kind is distinct from 'approval' or public.approval_round_approved(target_task)) then$old$,
  $new$             and t.kind is distinct from 'approval' then$new$,
  $old$            || case when coalesce((a ->> 'complete_task')::boolean, false) and t.kind = 'approval' and t.completed_at is null
                   and not public.approval_round_approved(target_task)
                 then$old$,
  $new$            || case when coalesce((a ->> 'complete_task')::boolean, false) and t.kind = 'approval' and t.completed_at is null
                 then$new$
);

select public.alhc_patch_function(
  'public.run_my_task_rule(public.my_task_rules,uuid,jsonb,text)'::regprocedure,
  $old$          if t.kind = 'approval' and not public.approval_round_approved(target_task) then$old$,
  $new$          if t.kind = 'approval' then$new$
);

-- An approver completes their approval task (the only people who may). Approvers need only Commenter
-- access, which can't edit a task, so this is a definer RPC: an active approver of the task with
-- Commenter+ (by their own role), no round pending, the task open and not in the Trash. It completes
-- the task as the system (alhc.approval_finish names it, so guard_task_kind lets it through); stories,
-- notifications, and rules run as for any completion. Returns the completion time.
create or replace function public.complete_approval_as_approver(target_task uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tasks;
  done_at timestamptz;
begin
  select * into t from public.tasks where id = target_task for update;
  if not found or t.deleted_at is not null or not public.has_task_role(target_task, 'viewer') then
    raise exception 'Task not found' using errcode = 'no_data_found';
  end if;
  if t.kind <> 'approval' then
    raise exception 'Only approval tasks are completed this way' using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.task_approvers a
    where a.task_id = target_task and a.profile_id = (select auth.uid()) and a.deleted_at is null
  ) or not public.has_task_role(target_task, 'commenter') then
    raise exception 'Only its approvers can complete an approval task' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.approval_rounds r where r.task_id = target_task and r.status = 'pending') then
    raise exception 'This task is waiting for approval. Approve it instead of marking it complete.' using errcode = 'check_violation';
  end if;
  if t.completed_at is not null then
    return t.completed_at;
  end if;
  if public.open_blocker_count(target_task) > 0 then
    raise exception 'This task is blocked by % incomplete %', public.open_blocker_count(target_task),
      case when public.open_blocker_count(target_task) = 1 then 'task' else 'tasks' end
      using errcode = 'check_violation';
  end if;
  perform set_config('alhc.approval_finish', target_task::text, true);
  update public.tasks set completed_at = now() where id = target_task returning completed_at into done_at;
  perform set_config('alhc.approval_finish', '', true);
  return done_at;
end;
$$;
revoke all on function public.complete_approval_as_approver(uuid) from public, anon;
grant execute on function public.complete_approval_as_approver(uuid) to authenticated;
select public.alhc_revoke_anon_execute(array['complete_approval_as_approver(uuid)']);

-- =================================================================================================
-- 6. Item 69: only verified-domain submitters get the email conversation; verified-only forms
-- =================================================================================================

-- A response to a submitter whose conversation is off is refused (the pane hides the checkbox and says
-- why; this is the backstop).
select public.alhc_patch_function(
  'public.fill_comment_email()'::regprocedure,
  $old$  new.email_address := s.submitter_email;$old$,
  $new$  if not public.submitter_conversation_allowed(new.task_id) then
    raise exception 'Email conversation is off for this request: % isn''t on a verified domain. A workspace admin can turn it on for this request.', s.submitter_email
      using errcode = 'check_violation';
  end if;
  new.email_address := s.submitter_email;$new$
);

-- No Reply-To while the conversation is off (a response queued before an admin stopped it).
select public.alhc_patch_function(
  'public.submitter_reply_token(uuid)'::regprocedure,
  $old$    and k.submitter_email = lower(btrim(o.to_email));$old$,
  $new$    and k.submitter_email = lower(btrim(o.to_email))
    and public.submitter_conversation_allowed(k.task_id);$new$
);

-- A reply while the conversation is off is refused (logged as not_verified).
select public.alhc_patch_function(
  'public.post_submitter_reply(text,text,text,text)'::regprocedure,
  $old$  select * into t from public.tasks x where x.id = k.task_id;$old$,
  $new$  if not public.submitter_conversation_allowed(k.task_id) then
    perform public.log_submitter_reply(provider, k.id, k.task_id, null, 'rejected', 'not_verified');
    return jsonb_build_object('ok', false, 'status', 'rejected', 'reason', 'not_verified');
  end if;

  select * into t from public.tasks x where x.id = k.task_id;$new$
);

-- A verified-only form refuses other addresses (checked after the address itself).
select public.alhc_patch_function(
  'public.submit_form(uuid,text,jsonb)'::regprocedure,
  $old$  if not public.is_email(email) then
    raise exception 'Enter a valid email address' using errcode = 'check_violation';
  end if;$old$,
  $new$  if not public.is_email(email) then
    raise exception 'Enter a valid email address' using errcode = 'check_violation';
  end if;
  if coalesce(f.verified_domains_only, false) and not public.email_on_verified_domain(
    email, (select p.workspace_id from public.projects p where p.id = f.project_id)
  ) then
    raise exception 'This form only accepts email addresses at %',
      public.verified_domains_text((select p.workspace_id from public.projects p where p.id = f.project_id))
      using errcode = 'check_violation';
  end if;$new$
);

-- The public form learns the switch and the domains (to say so before sending).
select public.alhc_patch_function(
  'public.get_public_form(uuid)'::regprocedure,
  $old$    'viewer_email', (select p.email from public.profiles p where p.id = public.current_profile_id())$old$,
  $new$    'viewer_email', (select p.email from public.profiles p where p.id = public.current_profile_id()),
    'verified_domains_only', coalesce(f.verified_domains_only, false),
    'verified_domains', case when coalesce(f.verified_domains_only, false) then (
      select coalesce(jsonb_agg(v.domain order by v.domain), '[]'::jsonb)
      from public.verified_email_domains v
      join public.projects pp on pp.id = f.project_id
      where v.workspace_id = pp.workspace_id and v.removed_at is null
    ) else '[]'::jsonb end$new$
);

-- =================================================================================================
-- 7. Realtime: pins and their activity refresh the pane like comments
-- =================================================================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'comment_pin_events'
     ) then
    execute 'alter publication supabase_realtime add table public.comment_pin_events';
  end if;
end $$;

-- =================================================================================================
-- TAIL
--
-- Applied by hand (Avi / Grok Bot), like every tail: the connector refuses the row-removal keyword this
-- function needs. Nothing above depends on it. Until it's applied nothing is purged and the Trash pages
-- still say how many days each item has left.
--
-- 66. alhc_purge_trash(): permanently removes projects, tasks (with their subtasks), comments, and
-- attachments 90 days (trash_retention_days()) after they were moved to the Trash, everything that hangs
-- off them, and queues their Storage files for the app's cron route (trash_storage_purges). Daily from
-- pg_cron alhc-trash-purge; definer; no client (or service_role) grant; idempotent (a second run finds
-- nothing past the cutoff, and every queued file is unique while open).
--
--   * What goes: the rows in the Trash past the cutoff; a purged project's tasks that live in no other
--     project (a task also in a live project stays there: its internal pointer moves first, the old
--     project's membership goes); every subtask of a purged task; and every row whose foreign key must
--     point at one of those (NOT NULL), found through the catalog, so new tables are covered too.
--     Nullable references from rows that stay are cleared (set null) instead — a template made from a
--     purged project, an email in the delivery log, a rule run, a live field linked to a purged
--     library field, a recurring task's link to a purged occurrence — except for rows that only make
--     sense with their target (Inbox items, goal links, curated work, calendar events and links, email
--     designs, pending invites, capacities, links to a purged file), which go with it.
--   * What stays: archived projects and Inbox items (archiving isn't the Trash), and the activity of
--     everything that stays: other tasks' dependency stories name "a deleted task", other tasks'
--     project stories "a deleted project" (data.purged = true). The purged items' own history goes
--     with them (nobody could open it). trash_purged_items records each purged id.
--   * Files: a purged task's whole folder (<task id>/ in task-attachments) and each purged attachment's
--     own file when nothing else points at it; the cron route removes them and never one a live row
--     still uses (claim_trash_storage_purges re-checks).
-- =================================================================================================
-- TAIL

create or replace function public.alhc_purge_trash(max_items integer default 2000)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cutoff timestamptz := now() - make_interval(days => public.trash_retention_days());
  lim integer := greatest(1, least(coalesce(max_items, 2000), 20000));
  run_id uuid;
  added integer;
  pass integer := 0;
  fk record;
  cur regclass;
  n integer;
  progress boolean;
  left_over integer;
  last_error text;
  settle_round integer;
  grew integer;
  stmt text;
  stmt_counts text;
  together jsonb;
  tally jsonb := '{}'::jsonb;
  task_ids uuid[];
  project_ids uuid[];
  next_project uuid;
  t record;
  -- Nullable references whose rows only make sense with their target: they go with it.
  goes_with text[] := array[
    'public.inbox_items.task_id', 'public.inbox_items.comment_id', 'public.inbox_items.project_id',
    'public.inbox_items.message_id', 'public.inbox_items.team_message_id', 'public.inbox_items.status_update_id',
    'public.calendar_events.project_id', 'public.calendar_feeds.project_id', 'public.email_designs.project_id',
    'public.goal_links.project_id', 'public.pending_memberships.project_id', 'public.team_curated_work.project_id',
    'public.workload_capacities.project_id', 'public.task_attachment_links.attachment_id',
    'public.tasks.parent_task_id', 'public.tasks.root_task_id'];
  -- Rows of these tables are never removed because a nullable reference couldn't be cleared.
  core text[] := array['public.tasks', 'public.projects', 'public.comments', 'public.task_attachments',
    'public.sections', 'public.custom_fields', 'public.forms', 'public.rules', 'public.portfolios',
    'public.goals', 'public.teams', 'public.profiles', 'public.workspaces'];
begin
  perform pg_advisory_xact_lock(hashtextextended('alhc.trash_purge', 0));
  insert into public.trash_purge_runs default values returning id into run_id;

  create temporary table if not exists alhc_purge_set (tbl regclass not null, id uuid not null, primary key (tbl, id)) on commit drop;
  create temporary table if not exists alhc_purge_done (tbl regclass primary key) on commit drop;
  truncate pg_temp.alhc_purge_set, pg_temp.alhc_purge_done;

  -- Projects in the Trash past the cutoff.
  insert into pg_temp.alhc_purge_set
  select 'public.projects'::regclass, p.id from public.projects p
  where p.deleted_at is not null and p.deleted_at < cutoff
  order by p.deleted_at limit lim;
  select coalesce(array_agg(s.id), '{}') into project_ids from pg_temp.alhc_purge_set s where s.tbl = 'public.projects'::regclass;

  -- A top-level task homed in a purged project but also in a live one moves its pointer there (the 55b
  -- path: its number follows); one in no live project goes with the project.
  for t in
    select x.id from public.tasks x
    where x.parent_task_id is null and x.home_project_id = any (project_ids)
  loop
    select tp.project_id into next_project
    from public.task_projects tp
    join public.projects p on p.id = tp.project_id and p.deleted_at is null
    where tp.task_id = t.id and tp.deleted_at is null and not (tp.project_id = any (project_ids))
    order by tp.created_at, tp.project_id
    limit 1;
    if next_project is null then
      insert into pg_temp.alhc_purge_set values ('public.tasks'::regclass, t.id) on conflict do nothing;
    else
      perform set_config('alhc.home_pointer_move', 'on', true);
      update public.tasks set home_project_id = next_project, req_label = req_label where id = t.id;
      perform set_config('alhc.home_pointer_move', '', true);
    end if;
  end loop;

  -- Tasks, comments, and attachments in the Trash past the cutoff.
  insert into pg_temp.alhc_purge_set
  select 'public.tasks'::regclass, x.id from public.tasks x
  where x.deleted_at is not null and x.deleted_at < cutoff
  order by x.deleted_at limit lim
  on conflict do nothing;
  insert into pg_temp.alhc_purge_set
  select 'public.comments'::regclass, c.id from public.comments c
  where c.deleted_at is not null and c.deleted_at < cutoff
  order by c.deleted_at limit lim
  on conflict do nothing;
  insert into pg_temp.alhc_purge_set
  select 'public.task_attachments'::regclass, a.id from public.task_attachments a
  where a.deleted_at is not null and a.deleted_at < cutoff
  order by a.deleted_at limit lim
  on conflict do nothing;

  -- Every subtask of a purged task, however deep.
  loop
    insert into pg_temp.alhc_purge_set
    select 'public.tasks'::regclass, x.id from public.tasks x
    where x.parent_task_id in (select s.id from pg_temp.alhc_purge_set s where s.tbl = 'public.tasks'::regclass)
    on conflict do nothing;
    get diagnostics added = row_count;
    exit when added = 0;
  end loop;

  if not exists (select 1 from pg_temp.alhc_purge_set) then
    update public.trash_purge_runs set finished_at = clock_timestamp(), counts = '{}'::jsonb where id = run_id;
    return jsonb_build_object('run_id', run_id, 'projects', 0, 'tasks', 0, 'comments', 0, 'attachments', 0, 'files_queued', 0, 'rows', '{}'::jsonb);
  end if;

  -- What hangs off them: every row that must point at a purged row (NOT NULL), and the nullable
  -- references that go with their target, until nothing new turns up. Rows of tables with no id column
  -- (memberships, followers, settings: leaves) go right away by their reference, so clearing references
  -- next never fires a trigger on a row that is going anyway. Then nullable references from rows that
  -- stay are cleared; a row that can't be cleared joins the purge, and the search runs again (also to
  -- catch anything a trigger wrote meanwhile) until a round finds nothing new.
  settle_round := 0;
  <<settle>>
  loop
  settle_round := settle_round + 1;
  grew := 0;
  pass := 0;
  loop
    pass := pass + 1;
    added := 0;
    for fk in
      select c.conrelid::regclass as child, a.attname as col, c.confrelid::regclass as parent, a.attnotnull as notnull,
             exists (select 1 from pg_attribute ia where ia.attrelid = c.conrelid and ia.attname = 'id'
                     and ia.atttypid = 'uuid'::regtype and not ia.attisdropped) as has_id
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1] and pa.attname = 'id'
      where c.contype = 'f'
        and c.confrelid in (select distinct s.tbl from pg_temp.alhc_purge_set s)
    loop
      if (fk.notnull or (fk.child::text || '.' || fk.col) = any (goes_with)) and fk.has_id then
        execute format(
          'insert into pg_temp.alhc_purge_set select %L::regclass, x.id from %s x where x.%I in (select s.id from pg_temp.alhc_purge_set s where s.tbl = %L::regclass) on conflict do nothing',
          fk.child, fk.child, fk.col, fk.parent);
        get diagnostics n = row_count;
        added := added + n;
      end if;
    end loop;
    grew := grew + added;
    exit when added = 0;
    if pass > 50 then
      raise exception 'Trash purge: references kept turning up new rows';
    end if;
  end loop;

  for fk in
    select c.conrelid::regclass as child, a.attname as col, c.confrelid::regclass as parent
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1] and pa.attname = 'id'
    where c.contype = 'f'
      and a.attnotnull
      and c.confrelid in (select distinct s.tbl from pg_temp.alhc_purge_set s)
      and not exists (select 1 from pg_attribute ia where ia.attrelid = c.conrelid and ia.attname = 'id'
                      and ia.atttypid = 'uuid'::regtype and not ia.attisdropped)
  loop
    execute format('delete from %s x where x.%I in (select s.id from pg_temp.alhc_purge_set s where s.tbl = %L::regclass)',
      fk.child, fk.col, fk.parent);
    get diagnostics n = row_count;
    if n > 0 then
      tally := tally || jsonb_build_object(fk.child::text, coalesce((tally ->> fk.child::text)::integer, 0) + n);
    end if;
  end loop;

  select coalesce(array_agg(s.id), '{}') into task_ids from pg_temp.alhc_purge_set s where s.tbl = 'public.tasks'::regclass;
  select coalesce(array_agg(s.id), '{}') into project_ids from pg_temp.alhc_purge_set s where s.tbl = 'public.projects'::regclass;

  -- Nullable references from rows that stay are cleared (a task's issuing project clears its number with
  -- it). When a row can't be cleared (a CHECK needs the reference) and it isn't a core row, it goes too.
  added := 0;
  for fk in
    select c.conrelid::regclass as child, a.attname as col, c.confrelid::regclass as parent,
           exists (select 1 from pg_attribute ia where ia.attrelid = c.conrelid and ia.attname = 'id'
                   and ia.atttypid = 'uuid'::regtype and not ia.attisdropped) as has_id
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1] and pa.attname = 'id'
    where c.contype = 'f'
      and not a.attnotnull
      and c.confrelid in (select distinct s.tbl from pg_temp.alhc_purge_set s)
      and not ((c.conrelid::regclass::text || '.' || a.attname) = any (goes_with))
  loop
    if fk.child = 'public.tasks'::regclass and fk.col = 'home_project_id' then
      if exists (
        select 1 from public.tasks x where x.home_project_id = any (project_ids) and not (x.id = any (task_ids))
      ) then
        raise exception 'Trash purge: a task outside the purge still points at a purged project';
      end if;
      continue;
    end if;
    begin
      if fk.child = 'public.tasks'::regclass and fk.col = 'req_project_id' then
        perform set_config('alhc.home_pointer_move', 'on', true);
        update public.tasks x
        set req_project_id = null, req_number = null, req_period = null, req_counter_key = null,
            req_subindex = null, req_path = null, req_label = null
        where x.req_project_id = any (project_ids) and not (x.id = any (task_ids));
        perform set_config('alhc.home_pointer_move', '', true);
      elsif fk.has_id then
        execute format(
          'update %s x set %I = null where x.%I in (select s.id from pg_temp.alhc_purge_set s where s.tbl = %L::regclass) and x.id not in (select s.id from pg_temp.alhc_purge_set s where s.tbl = %L::regclass)',
          fk.child, fk.col, fk.col, fk.parent, fk.child);
      else
        execute format(
          'update %s x set %I = null where x.%I in (select s.id from pg_temp.alhc_purge_set s where s.tbl = %L::regclass)',
          fk.child, fk.col, fk.col, fk.parent);
      end if;
    exception when check_violation or not_null_violation then
      if fk.child::text = any (core) or not fk.has_id then
        raise;
      end if;
      execute format(
        'insert into pg_temp.alhc_purge_set select %L::regclass, x.id from %s x where x.%I in (select s.id from pg_temp.alhc_purge_set s where s.tbl = %L::regclass) on conflict do nothing',
        fk.child, fk.child, fk.col, fk.parent);
      get diagnostics n = row_count;
      added := added + n;
    end;
  end loop;
  exit settle when settle_round > 1 and grew = 0 and added = 0;
  if settle_round > 20 then
    raise exception 'Trash purge: references kept changing';
  end if;
  end loop settle;

  -- Files: each purged task's folder, and each purged attachment's own file (task kept) when nothing else
  -- points at it.
  insert into public.trash_storage_purges (bucket, path, is_prefix)
  select 'task-attachments', x || '/', true from unnest(task_ids) x
  on conflict do nothing;
  insert into public.trash_storage_purges (bucket, path, is_prefix)
  select distinct 'task-attachments', a.storage_path, false
  from public.task_attachments a
  where a.id in (select s.id from pg_temp.alhc_purge_set s where s.tbl = 'public.task_attachments'::regclass)
    and not (a.task_id = any (task_ids))
    and not exists (
      select 1 from public.task_attachments o
      where o.storage_path = a.storage_path
        and o.id not in (select s.id from pg_temp.alhc_purge_set s where s.tbl = 'public.task_attachments'::regclass)
    )
  on conflict do nothing;
  get diagnostics n = row_count;

  -- The activity of what stays names "a deleted task" / "a deleted project".
  update public.task_stories st
  set data = st.data || jsonb_build_object('task_title', null, 'purged', true)
  where st.kind in ('dependency_added', 'dependency_removed', 'dependency_changed')
    and not (st.task_id = any (task_ids))
    and (st.data ->> 'task_id') = any (task_ids::text[]);
  update public.task_stories st
  set data = st.data || jsonb_build_object('project_name', 'a deleted project', 'purged', true)
  where st.kind in ('project_added', 'project_removed', 'section_changed', 'converted_to_task')
    and not (st.task_id = any (task_ids))
    and (st.data ->> 'project_id') = any (project_ids::text[]);

  -- Removal, children first: tables without an id column by their reference, then each table's rows;
  -- a table whose rows something not yet removed still points at waits for the next pass.
  for fk in
    select c.conrelid::regclass as child, a.attname as col, c.confrelid::regclass as parent
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1] and pa.attname = 'id'
    where c.contype = 'f'
      and a.attnotnull
      and c.confrelid in (select distinct s.tbl from pg_temp.alhc_purge_set s)
      and not exists (select 1 from pg_attribute ia where ia.attrelid = c.conrelid and ia.attname = 'id'
                      and ia.atttypid = 'uuid'::regtype and not ia.attisdropped)
  loop
    execute format('delete from %s x where x.%I in (select s.id from pg_temp.alhc_purge_set s where s.tbl = %L::regclass)',
      fk.child, fk.col, fk.parent);
    get diagnostics n = row_count;
    if n > 0 then
      tally := tally || jsonb_build_object(fk.child::text, coalesce((tally ->> fk.child::text)::integer, 0) + n);
    end if;
  end loop;

  pass := 0;
  loop
    pass := pass + 1;
    progress := false;
    left_over := 0;
    for cur in
      select distinct s.tbl from pg_temp.alhc_purge_set s
      where s.tbl not in (select d.tbl from pg_temp.alhc_purge_done d)
    loop
      begin
        execute format('delete from %s x where x.id in (select s.id from pg_temp.alhc_purge_set s where s.tbl = %L::regclass)', cur, cur);
        get diagnostics n = row_count;
        insert into pg_temp.alhc_purge_done values (cur);
        tally := tally || jsonb_build_object(cur::text, coalesce((tally ->> cur::text)::integer, 0) + n);
        progress := true;
      exception when foreign_key_violation then
        left_over := left_over + 1;
        last_error := sqlerrm;
      end;
    end loop;
    exit when left_over = 0;
    -- Rows that point at each other (a comment and the review check it reports on) never go one table
    -- at a time: the rest goes in one statement (every foreign key here is checked at its end).
    if not progress or pass > 60 then
      select string_agg(format('d%s as (delete from %s x where x.id in (select s.id from pg_temp.alhc_purge_set s where s.tbl = %L::regclass) returning 1)', i, r.tbl, r.tbl), ', '),
             string_agg(format('%L, (select count(*) from d%s)', r.tbl::text, i), ', ')
        into stmt, stmt_counts
      from (
        select s.tbl, row_number() over (order by s.tbl::text) as i
        from (select distinct x.tbl from pg_temp.alhc_purge_set x where x.tbl not in (select d.tbl from pg_temp.alhc_purge_done d)) s
      ) r;
      begin
        execute format('with %s select jsonb_build_object(%s)', stmt, stmt_counts) into together;
      exception when foreign_key_violation then
        raise exception 'Trash purge: % could not be removed (something outside the purge still points at them: %)',
          (select string_agg(distinct x.tbl::text, ', ') from pg_temp.alhc_purge_set x
           where x.tbl not in (select d.tbl from pg_temp.alhc_purge_done d)), sqlerrm;
      end;
      for cur, n in select key::regclass, value::integer from jsonb_each_text(together) loop
        tally := tally || jsonb_build_object(cur::text, coalesce((tally ->> cur::text)::integer, 0) + n);
        insert into pg_temp.alhc_purge_done values (cur) on conflict do nothing;
      end loop;
      exit;
    end if;
  end loop;

  insert into public.trash_purged_items (kind, item_id, deleted_at)
  select case s.tbl when 'public.projects'::regclass then 'project' when 'public.tasks'::regclass then 'task'
                    when 'public.comments'::regclass then 'comment' else 'attachment' end,
         s.id, null
  from pg_temp.alhc_purge_set s
  where s.tbl in ('public.projects'::regclass, 'public.tasks'::regclass, 'public.comments'::regclass, 'public.task_attachments'::regclass)
  on conflict do nothing;

  tally := jsonb_build_object(
    'run_id', run_id,
    'projects', coalesce((tally ->> 'public.projects')::integer, 0),
    'tasks', coalesce((tally ->> 'public.tasks')::integer, 0),
    'comments', coalesce((tally ->> 'public.comments')::integer, 0),
    'attachments', coalesce((tally ->> 'public.task_attachments')::integer, 0),
    'files_queued', (select count(*) from public.trash_storage_purges q where q.done_at is null),
    'rows', tally);
  update public.trash_purge_runs set finished_at = clock_timestamp(), counts = tally where id = run_id;
  return tally;
end;
$$;

revoke all on function public.alhc_purge_trash(integer) from public, anon, authenticated, service_role;
comment on function public.alhc_purge_trash(integer) is
  'Nov 1 notes, item 66: daily Trash purge (pg_cron alhc-trash-purge): permanently removes projects, tasks, '
  'comments, and attachments 90 days after they were moved to the Trash, and queues their files '
  '(trash_storage_purges). No client can execute it.';

-- Daily at 03:47 UTC (after alhc-log-purge); a no-op where pg_cron isn't installed.
do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('alhc-trash-purge', '47 3 * * *', 'select public.alhc_purge_trash()');
  end if;
end;
$$;
