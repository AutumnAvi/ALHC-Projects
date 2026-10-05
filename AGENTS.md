<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# ALHC Projects — architecture source of truth

ALHC's own Asana-style work platform. The product is generic: **Workspace → Project → Section → Task → Subtask**, with tasks able to live in several projects. Team-specific workflows (e.g. Autumn Lake Creative Requests) are built *on top of* this model later; never bake one workflow into the schema.

## Stack

- Next.js 16 App Router, React 19, TypeScript strict, Tailwind CSS 4 (`src/` layout, app at repo root)
- Supabase Auth (email + password for now; Google OAuth is the long-term method) + Postgres + RLS via `@supabase/ssr` / `@supabase/supabase-js`
- Deployed on Vercel; `vercel.json` only declares the daily workflows cron
- Email through Resend's HTTP API (no SDK), mocked when not configured
- npm (`package-lock.json` is the lockfile)

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Local dev server |
| `npm run lint` / `npm run typecheck` / `npm run build` | Must all pass before merging |
| `npm run db:test` | Applies `supabase/migrations/*` to a throwaway local Postgres and runs every `supabase/tests/*_smoke.sql` in filename order (needs Postgres server binaries; `initdb` refuses root, so in a root container run it as the `postgres` user, e.g. `su postgres -s /bin/bash -c 'npm run db:test'`) |
| `npm run db:types` | Regenerates `src/lib/supabase/database.types.ts` from the linked Supabase project |

## Layout

```
src/
  proxy.ts                     Next 16 proxy (formerly middleware): refreshes the Supabase session, redirects signed-out users to /login
  app/
    login/, denied/            Public auth screens; login/actions.ts = password sign-in/sign-up + allowlist gate
    auth/callback/route.ts     OAuth / email-confirmation code exchange + allowlist gate (signs out non-allowlisted users)
    auth/denied/route.ts       Signs out a session that is no longer allowlisted, then shows /denied
    auth/signout/route.ts      POST sign-out
    attachments/[id]/route.ts  Signed-URL redirect for a task attachment (RLS-checked, 60 s URL)
    forms/[formId]/            Public intake form (no sign-in); embed/ is the same form without page chrome for iframes
    api/cron/workflows/route.ts  Scheduler entry (Bearer CRON_SECRET): workflow_tick() + email outbox drain
    (app)/                     Authenticated shell; layout calls requireMember() and loads the inbox unread count
      page.tsx                 Project home
      my-tasks/, inbox/, search/  Cross-project views; `?task=<id>` opens the pane on each
      projects/[projectId]/    Redirects to the project's first saved view
      projects/[projectId]/views/[viewId]     A saved view (list / board / calendar / timeline); `?f=` = unsaved filter draft, `?task=<id>` opens the pane
      projects/[projectId]/list|board|calendar|timeline  Redirect to the first view with that layout (old links keep working)
      projects/[projectId]/dashboard          Project dashboard widgets (counts + bar charts)
      projects/[projectId]/fields             Field management
      projects/[projectId]/forms[/[formId]]  Form list + builder
      projects/[projectId]/rules              Rules, templates, run log
      projects/[projectId]/settings           Req # numbering, approval-completes-task (admin+)
      projects/[projectId]/settings/members   Members: list, invite by allowlisted email, change role, remove, transfer ownership
      projects/[projectId]/settings/trash     Trash: soft-deleted tasks of the project, restore (editor+)
  lib/
    env.ts                     Public Supabase env (optional at build, required at request time); AUTH_GOOGLE_ENABLED flag
    supabase/{client,server,proxy}.ts  Browser / server / proxy clients
    supabase/database.types.ts Typed schema — keep in sync with migrations
    auth.ts                    getViewer(), requireMember(), safeNextPath()
    data.ts                    All reads (server-only). Every query filters deleted_at IS NULL
    actions.ts                 All writes (Server Actions). Return { error } and call refresh()
    fields.ts                  Custom field types, option colors, value → chip rendering
    attachments.ts             Bucket name, size limit, storage path builder
    realtime.ts                useRealtimeRefresh(): router.refresh() on postgres_changes
    forms.ts                   Form question shape, branching walk, client-side validation (mirrors submit_form)
    rules.ts                   Rule vocabulary (triggers, conditions, actions, presets) for the builder UI
    email.ts                   Outbox rendering + Resend delivery (server-only; mocked without a key)
    supabase/admin.ts          Service-role client, used only by email delivery and the cron route
    origin.ts                  Absolute origin for share links (NEXT_PUBLIC_APP_URL or request host)
    views.ts                   View config types, parser/sanitizer (mirrors the SQL validators), `?f=` encoding
    timezone.ts                getViewerTimeZone() from the `tz` cookie (server-only); timezone-shared.ts holds the cookie name
    roles.ts                   Project roles, labels, rank order (mirrors project_role_rank()), assignableRoles()
    recurrence.ts              Recurrence rule type, parser, describer (mirrors normalize_recurrence())
  components/                  UI; project/ (view page + toolbar, filter editor, list, board, calendar, timeline + timeline-scale, fields, settings, members, trash, project-access = role context + RoleGate), dashboard/, task/ (pane, dates/times, recurrence, dependencies, activity, fields, files, approvals), forms/, rules/, my-tasks/, inbox/, search/, shell/, popover.tsx
supabase/
  migrations/                  Schema, triggers, RLS (source of truth for the data model)
  seed.sql                     Placeholder allowlist entry (local `supabase db reset` only)
  tests/                       Local Postgres harness (auth/storage shim) + *_smoke.sql suites
```

## Auth model

1. **Interim: email + password.** `/login` posts to the `passwordAuth` Server Action (`src/app/login/actions.ts`). Sign in runs `signInWithPassword`. Sign up runs `signUp` with `emailRedirectTo` set to `/auth/callback`, so the confirmation link lands there. Supabase's Email provider must be on with **Confirm email** enabled: confirmation proves inbox ownership, and `is_allowlisted()` ignores unconfirmed users. Accounts can also be created in the dashboard (Auth → Users → Add user, auto-confirm).
2. **Later: Google.** `signInWithOAuth({ provider: "google" })` → Google → `/auth/callback`. The button (`login/google-sign-in-button.tsx`) is hidden unless `AUTH_GOOGLE_ENABLED=true`. Turn it on once the Supabase Google provider is configured (README "Setup: Google OAuth"). Google remains the intended long-term method.
3. Every path ends at the same gate. The callback exchanges the code, and `passwordAuth` uses the session it just created. Both then call `rpc("is_allowlisted")`. Not allowlisted ⇒ `signOut()` and redirect to `/denied` — a rejected user never keeps a session.
4. `(app)/layout.tsx` calls `requireMember()` on every render: no user ⇒ `/login`; user removed from the allowlist ⇒ `/auth/denied` (signs out).
5. RLS is the real boundary. `public.is_allowlisted()` (SECURITY DEFINER) is true only when `auth.uid()` maps to an `auth.users` row with a confirmed email present in `public.allowed_emails`.
6. **Inner gate: project membership** (Teams & permissions). The allowlist decides who can have a session; `project_members` decides which projects that session can read or change, and with which role. Every role helper also requires `is_allowlisted()`, so de-allowlisting someone revokes all project access at once. Project pages 404 for non-members (`(app)/projects/[projectId]/layout.tsx` checks `getProjectRole()`), and the home page, sidebar, My Tasks, search, and Inbox only ever show projects and tasks RLS lets the viewer read.

Allowlist entries are managed in SQL (dashboard SQL editor or service role) — members cannot edit the allowlist through the API.

## Data model rules

- **Tables:** `allowed_emails`, `profiles`, `workspaces`, `projects`, `sections`, `tasks`, `task_projects`, `subtasks` (core spine); `comments`, `comment_mentions`, `task_followers`, `task_stories`, `inbox_items`, `custom_fields`, `task_field_values`, `task_attachments` (collaboration); `request_sequences`, `approval_requests`, `forms`, `form_submissions`, `rules`, `rule_runs`, `scheduled_rule_actions`, `rule_presets`, `email_outbox` (workflows); `project_views`, `dashboard_widgets` (views & insights); `project_members` (teams & permissions); `task_dependencies` (task depth). Timeline added a column (`tasks.start_on`), not a table; Task depth added `tasks.due_at`, `start_at`, `time_zone`, `recurrence`, `recurrence_series_id`, `recurrence_seq`, `recurrence_next_id`.
- **Single workspace this phase:** migration seeds workspace `00000000-0000-4000-8000-000000000001` ("ALHC"); the app uses the oldest active workspace.
- **Profiles** mirror allowlisted auth users (name/avatar from Google; password users fall back to their email) via triggers on `auth.users` and on `allowed_emails` inserts. Assignees reference `profiles.id`.
- **Multi-homing:** `task_projects (task_id, project_id)` is the membership join. Section and `sort_order` live on the membership, so one task can sit in different sections/positions per project.
- **Home project rule:** `tasks.home_project_id` is the project the task was created in (its primary project). A trigger guarantees an active membership in the home project; removing the home membership is rejected — make another membership the home first. `tasks.workspace_id` always follows the home project.
- **Ordering:** fractional `double precision sort_order` (step 1024, midpoint inserts). No reindexing yet.
- **Soft delete only:** every content table has `deleted_at`. There are **no DELETE policies**, so hard deletes through the API affect zero rows. Reads in `src/lib/data.ts` always filter `deleted_at IS NULL` (the one exception is `listTrashedTasks()` for the Trash page); RLS intentionally does not, so restore works. Since Task depth, a soft-deleted **task** is readable only by Editors+ of one of its projects (`tasks_select_viewer`), and `rpc("restore_task")` brings it back (see “Task depth model”). Soft-deleting a section moves its tasks to "No section" (trigger). Soft-deleting a task hides it from every project.
- **RLS policy pattern (since Teams & permissions):** project-scoped tables use `<table>_<command>_<minimum role>`, e.g. `tasks_select_viewer`, `tasks_update_editor`, `rules_insert_admin`, checked with `(select public.has_project_role(project_id, '<role>'))` or, for rows that hang off a task, `(select public.has_task_role(task_id, '<role>'))`. Author/recipient-owned rows add `_own` (`comments_insert_own_commenter`, `task_attachments_insert_own_editor`, `inbox_items_select_own_viewer`). Workspace-level tables keep the allowlist pattern: `profiles_select_allowlisted`, `profiles_update_own`, `allowed_emails_select_allowlisted` (read-only), `workspaces_select_allowlisted`, `rule_presets_select_allowlisted`, and `projects_insert_allowlisted` (anyone allowlisted can start a project and owns it). See “Teams & permissions model” for the full matrix.
- **Dates:** `tasks.due_on` and `tasks.start_on` are plain `date`s. Both are optional; when both are set, `start_on <= due_on` (constraint `tasks_start_on_before_due_on`; `updateTask` turns a violation into “The start date must be on or before the due date”). Only Timeline reads `start_on`; Calendar, My Tasks, every filter (`due` kinds, including “No due date”), rules (`due_approaching`), and forms (`maps_to: due_on`) stay on `due_on`. Optional **times** (`due_at` / `start_at`, Task depth) never replace the dates: a trigger keeps each `_on` equal to its `_at`'s local date in `tasks.time_zone`, so all day-based code is unchanged.
- **Task creation** goes through `rpc("create_task", { target_project, target_section, task_title })` so the task row and its home membership land in one transaction (and `workspace_id` is filled by trigger).

## Collaboration model

- **Activity is trigger-written.** `task_stories` rows (`created`, `completed`, `reopened`, `renamed`, `deleted`, `restored`, `assigned`, `unassigned`, `due_changed`, `start_changed`, `section_changed`, `project_added`, `project_removed`, `attachment_added`, `field_changed`, `recurrence_changed`, `recurrence_spawned`, `dependency_added`, `dependency_removed`) are inserted by SECURITY DEFINER triggers; clients can only read them. Membership changes made in the same transaction that created the task (`tasks.created_at = now()`) are not logged, so new tasks get one `created` story. `data` holds name snapshots (section/project/field names) so history survives renames.
- **Comments** (`comments`) are plain text, author = `auth.uid()` (enforced by policy), soft-deleted by their author only. Soft-deleting a comment marks its inbox items read (`comments_after_soft_delete`) and `listInbox()` hides them. Edit is not exposed yet.
- **@mentions are parsed in the database** by the `comments_after_insert` trigger: `@Full Name` or `@emaillocalpart` (case-insensitive, word-bounded) of an allowlisted profile who can read the task (a member of one of its projects). Matches become `comment_mentions` rows; the author is never mentioned.
- **Followers** (`task_followers`, soft delete) — auto-follow on: creating a task, being assigned, commenting, being @mentioned. Commenters and above can follow/unfollow from the pane; a follower must be able to read the task (`follow_task()` and the insert policy skip/reject anyone who can't).
- **Inbox** (`inbox_items`) is fan-out on write by triggers; clients can't insert. Kinds: `assigned` (to the new assignee), `mention` (to each mentioned person), `comment` (to every other follower not already mentioned), `completed` (to followers), plus `approval_requested`, `approval_decided`, and `rule` from Workflows (`data` jsonb carries status/note/message and the rule name). The actor never notifies themself, and nobody is notified about a task they can't read (`notify_with()` skips them). Recipients can only read their own items, and only while they can still read the task, and the column grant only lets them update `read_at`. Inbox items never send email; only workflow emails do (see Email).
- **Append-only tables** — `task_stories`, `comment_mentions`, `inbox_items`, and `task_field_values` have no `deleted_at`: stories are an immutable log, mentions are derived from a (soft-deletable) comment, inbox items are dismissed by `read_at`, and a field value is cleared by writing JSON `null`.
- **Custom fields** are defined per project (`custom_fields`: `text`, `number`, `date`, `boolean`, `single_select`, `multi_select`, `people`). Select options live in `options` as `[{ id, name, color }]`; values (`task_field_values.value` jsonb) store option ids, so renaming an option never rewrites values. The `task_field_values_validate` trigger enforces the shape per type, that option/profile ids exist, and that the task is in the field's project. `show_in_views` pins a field as a List column and a Board card chip.
- **Section-bound status** (`bound_to_sections = true`, single-select only, at most one per project): the field has no stored values — its options are the project's sections and its value is the task's section in that project. Editing it in the pane calls `moveTask`. This is the native "status ↔ section" bind; there is no rule engine syncing two sources of truth.
- **Attachments** — files live in the private Storage bucket `task-attachments` at `<task_id>/<uuid>-<safe name>`; `task_attachments` holds metadata (soft delete) and `storage_path` must start with the task id. Browser uploads go straight to Storage (policy `task_attachments_objects_insert_allowlisted`), then `registerAttachment` records metadata. Downloads go through `/attachments/[id]`, which checks the metadata row via RLS and redirects to a 60-second signed URL. Limit: 25 MB per file (bucket `file_size_limit`, DB check, and client check). Storage objects are not deleted when an attachment is removed.
- **Search** — `rpc("search_tasks", { query, max_results })` (SECURITY INVOKER, so RLS applies) does escaped ILIKE over task title and notes, backed by `pg_trgm` GIN indexes. Results are ordered open before completed, then title matches before notes-only matches, then most recently updated (max 100).
- **Realtime** — `comments`, `task_stories`, and `inbox_items` are added to the `supabase_realtime` publication when it exists. The task pane and Inbox call `useRealtimeRefresh`; the sidebar badge refetches its count on change. Everything degrades to server-rendered data plus a 60 s poll / window-focus refetch for the badge when Realtime isn't available.

## My Tasks

`/my-tasks` lists open tasks assigned to the viewer across every project (`tasks.assignee_id`), labelled with the home project. Grouping mirrors Asana's due-date buckets, computed in the browser against the viewer's local date:

1. **Overdue** — due before today
2. **Today** — due today
3. **Next 7 days** — due tomorrow through today + 7
4. **Later** — due after that
5. **No due date**

Each bucket is ordered by due date, then creation time. Below them, **Recently completed** (collapsed) shows the last 30 tasks the viewer completed. Completing a task from My Tasks is optimistic and it moves to "Recently completed" on refresh. Manual My Tasks sections are a follow-up.

## Workflows model

Migration `20261005020000_workflows.sql`, tests in `supabase/tests/30_workflows_smoke.sql`. Everything is generic: a **request type is a project + its custom fields + a form + rules**. The Autumn Lake patterns (due-tomorrow ping, requester updates, nudges, tracking emails, approval routing) ship only as installable rule templates with placeholder inputs.

### System-written tables and the rule context

- `approval_requests`, `form_submissions`, `rule_runs`, `scheduled_rule_actions`, `rule_presets`, and `email_outbox` are written only by SECURITY DEFINER functions/triggers. Like `task_stories`, they have a `_select_allowlisted` policy and **no insert/update policies**. The outbox is claimed and completed only by `service_role` RPCs.
- `request_sequences`, `forms`, and `rules` follow the full `<table>_{select,insert,update}_allowlisted` pattern with soft delete.
- `public.is_client_role()` (`current_user in ('anon','authenticated')`) lets invoker guard triggers block client writes to system columns while definer code passes. Example: `tasks_10_guard_system_columns` rejects client changes to `tasks.source`, `req_project_id`, `req_number`.
- While a rule runs, transaction-local GUCs `alhc.rule_id` / `alhc.rule_chain` are set. `current_actor_id()` returns null inside a rule, so stories and inbox items show the rule (`data.rule_id`, `data.rule_name`) as the actor and nobody is skipped as "the actor". `comments.author_id` is nullable only for rule comments (`comments.rule_id`, check: author or rule).

### Req # (native request numbering)

- **Choice: dedicated columns, not a custom field.** `tasks.req_project_id` + `tasks.req_number` (unique together) with the label computed by `format_request_label(project, number)` → `prefix || lpad(number, pad_width)`, e.g. `Req #042`. Columns keep the number immutable (clients can't edit it), unique, sortable, and independent of field renames. `task_request_label(task)` returns the label for display.
- `request_sequences` (one row per project): `enabled`, `prefix` (default `Req #`), `pad_width` 0–8, `add_to_title` (prefixes the title with `[Req #042] ` at insert), `assign_to` `all_tasks` | `form_submissions`, `last_number`. Settings tab → "Request numbers"; setting a "next number" continues an existing (e.g. Zapier-era) sequence. `last_number` can never decrease (guard trigger).
- Assignment is atomic: `next_request_number()` is `update request_sequences set last_number = last_number + 1 … returning`, so concurrent creates serialize on the row lock. It runs in the before-insert trigger `tasks_20_assign_request_number` against the **home project's** sequence, so a new task never gets a separate "renamed" story. `rpc("assign_request_number", { target_task })` numbers an older task on demand (task pane button). Multi-homing doesn't renumber: a task keeps the number from the project that issued it.

### Approvals

- `approval_requests (task_id, subtask_id?, approver_id, requested_by, rule_id?, note, status, decided_by, decided_at, decision_note)`. Status: `pending` → `approved` | `changes_requested` | `rejected`, or `cancelled`. `changes_requested` can be **resubmitted** back to `pending`. History is the task's stories (`approval_requested`, `approval_decided`, `approval_resubmitted`, `approval_cancelled`).
- All state changes are RPCs (no client insert/update policy): `request_approval(target_task, approver, approval_note, as_subtask, subtask_title)`, `decide_approval(target_approval, decision, decision_note)` — **approver only, pending only** — `resubmit_approval`, `cancel_approval` (open = pending or changes requested). Since Teams & permissions: requesting, resubmitting, and cancelling need **Editor** on the task; the approver must have at least **Commenter** (checked by `request_approval` and again by `decide_approval`). Rule-created approvals skip the request check, so a rule that names a non-member approver creates an approval nobody can decide.
- By default a request also creates an **approval subtask** (title defaults to "Approval"). Clients can't tick an approval subtask while its approval is open (`subtasks_guard_approval`); `approved`/`rejected` completes it, `changes_requested` leaves it open.
- Notifications: the approver follows the task and gets an `approval_requested` inbox item (again on resubmit). A decision notifies the requester, the assignee, and all followers (`approval_decided`, `inbox_items.data` carries status + note). The decider is never notified of their own action.
- `projects.approval_completes_task` (Settings tab): when on, an `approved` decision also completes the task. Every decision fires `approval_decided` rules.

### Forms

- `forms (project_id, title, description, questions jsonb, destination_section_id, accepting_responses, send_confirmation, confirmation_message)`. New forms start closed. `questions` is an ordered array validated by `validate_form`:
  `{ id, type: short_text|long_text|number|date|single_select|multi_select|checkbox, label, help?, required?, options?: [{id,label}], maps_to?: { target: title|notes|due_on|section|field, field_id? }, show_if?: { question_id, option_ids[] } }`.
- **Branching:** `show_if` may only reference an *earlier* choice/checkbox question (checkbox option id is `"true"`). Visibility is walked in order; a question whose parent is hidden is hidden too. Hidden answers are dropped server-side. `src/lib/forms.ts` implements the same walk + validation for the browser; `submit_form` re-validates everything (the DB is the trust boundary).
- **Mapping:** `title` (else "<form title> — <email>"), `notes` (else every unmapped answer is summarized in the description), `due_on` (date questions), `section` (single choice; options match a section by id then name), `field` (writes `task_field_values`; select options match by option id then name; a **section-bound Status field maps to the section** instead of a stored value). Destination section otherwise.
- **Submitting:** `rpc("submit_form", { target_form, submitter_email, answers })` is granted to `anon` and `authenticated`. It checks the form is accepting, rate-limits (5/min per email per form), creates the task with `source = 'form'` (there is no "is submission" field — use the `source_is` rule condition or `tasks.source`), applies mappings, assigns a Req # (trigger), records `form_submissions` (email, profile if signed in, cleaned answers), writes a `form_submitted` story, queues the `form_confirmation` email, and fires `form_submitted` rules (plus `task_created` at commit). The Server Action adds a honeypot field and calls `get_public_form` first to validate with the same rules.
- **Public URLs:** `/forms/<id>` (standalone) and `/forms/<id>/embed` (no chrome, for `<iframe>`). Both are public paths in the proxy and read through `get_public_form`, which strips `maps_to` and returns no questions while closed (members of the form's project still see them, for preview). Anonymous submitters never need a membership: `submit_form` is SECURITY DEFINER. The builder shows the link and a ready-made iframe snippet. **Marketing Request Forms hub:** a hub is just a page (Notion, website, intranet, or later an app page) that links or iframes several `/forms/<id>/embed` URLs, one per request type/project. Nothing in the schema knows about a hub; the project chosen per form determines where tasks land.

### Rules engine

- `rules (project_id, name, enabled default false, trigger_type, trigger_config, conditions jsonb[], actions jsonb[], preset_key)`; validated by `validate_rule` (sections/fields/forms must belong to the rule's project). Vocabulary is documented in the migration comment block above `rule_runs` and mirrored in `src/lib/rules.ts`:
  - triggers: `task_created`, `section_changed {section_id}`, `field_changed {field_id, option_id?}`, `assignee_changed`, `due_approaching {days, timezone?}`, `approval_decided {statuses?}`, `form_submitted {form_id?}`;
  - conditions (AND): `section_is[_not]`, `field_equals`, `field_is_set`/`_empty`, `assignee_is_set`/`_empty`, `is_complete`/`is_incomplete`, `source_is`;
  - actions (in order, max 10): `move_section`, `set_field`, `set_assignee`, `add_comment` (supports `@{assignee}`), `add_followers`, `notify` (inbox kind `rule`), `request_approval`, `send_email {to: submitter|assignee|field|address, template, subject?, message?, include_field_id?}`, `delay {hours}`. People = profile id or role `assignee`/`creator`. Text tokens: `{assignee} {creator} {task} {section} {req} {due} {approval_note}`.
- **Firing:** row triggers on `task_projects` (section), `task_field_values` (field), `tasks` (assignee); `task_created` is a deferred constraint trigger so it sees the fully built task at commit. Changes made in the task's creation transaction don't fire section/field rules (no double-firing on create) unless a rule made them. `fire_rules` only runs **enabled, non-deleted** rules of projects the task is in.
- **Loop guard:** a rule never re-enters its own chain (`alhc.rule_chain`), chains stop at depth 5, and a rule runs at most 20 times per task per hour. Skips are logged (`rule_runs.status = 'skipped'`, `detail.reason` = `loop` | `depth_limit` | `throttled`). Every run is logged in `rule_runs` (succeeded / failed / skipped / scheduled); the Rules tab shows the latest 50.
- **Section-bound Status:** the Status field has no stored values, so `set_field` on it becomes `move_section`, and `field_changed` can't target it (use `section_changed`). There is one source of truth, so rules can't fight Status.
- **Delays & due dates:** `delay` stores the remaining actions in `scheduled_rule_actions`; `workflow_tick()` (service_role) runs due jobs (re-checking enabled + conditions, else `cancelled`) and evaluates `due_approaching` rules once per task per due date (`rule_runs.dedupe_key = 'due:<date>'`). The migration schedules `alhc-workflow-tick` every 5 minutes **if `pg_cron` is installed**; otherwise `/api/cron/workflows` runs it.
- **Templates:** `rule_presets` rows hold rule JSON with `{"slot": "<key>"}` placeholders and an `inputs` list (section / field / person / text / number). `rpc("install_rule_preset", { target_project, preset, inputs, enable })` fills the slots and inserts ordinary rules (disabled unless `enable`). Seeded: `due_tomorrow_reminder`, `requester_update_on_section`, `stale_section_nudge` (24 h), `tracking_update_email`, `approval_routing` (3 rules), `intake_triage`. No ids, names, or teams are hard-coded. Importing rules from elsewhere must insert them **disabled**.

### Email

- The database never sends mail. `enqueue_email()` writes `email_outbox` (templates `form_confirmation`, `requester_update`, `due_tomorrow`, `custom`) and an `email_queued` story. After every Server Action (`after()`), and on each cron run, `drainOutbox()` claims rows with `claim_email_outbox` (`service_role`, `for update skip locked`), renders them in `src/lib/email.ts`, posts to Resend (`Idempotency-Key: outbox-<id>`), and records the result with `complete_email_outbox` (`sent` / `mocked`; errors go back to `pending` for retry and become `failed` after 5 attempts).
- **Mocking:** without `RESEND_API_KEY` + `EMAIL_FROM` rows are marked `mocked` and logged as `[email:mocked]`. Without `SUPABASE_SERVICE_ROLE_KEY` rows stay `pending` until a configured deployment drains them.
- **Scheduling:** `vercel.json` runs `/api/cron/workflows` daily (the Hobby-plan limit); on Pro, raise the schedule (e.g. `*/15 * * * *`) or point any external scheduler at it with `Authorization: Bearer $CRON_SECRET`.

## Views & Insights model

Migration `20261005030000_views_insights.sql`, tests in `supabase/tests/40_views_insights_smoke.sql`. Views and dashboards are generic project features; nothing knows about a team or request type.

### Saved views (`project_views`)

- `project_views (project_id, name 1–100, layout list|board|calendar|timeline, config jsonb, sort_order, created_by)`, soft delete, full `_{select,insert,update}_allowlisted` RLS. Views are shared by everyone in the project (no private views yet). `project_id` is immutable and `config` is validated on write by `validate_view_config` (trigger `project_views_validate`): unknown keys/values, sections or fields from another project, a non-single-select or section-bound `group_by` field, or more than 3 sorts raise `check_violation`.
- **Defaults:** `projects_create_default_views` (SECURITY DEFINER) gives every new project **List**, **Board**, **Calendar**, and **Timeline** views with an empty config. The views migration backfilled the first three; the timeline migration backfilled one **Timeline** view per project (after its current last tab) wherever none was active. The last remaining view of a project can't be deleted (`deleteView`), so a project always has a tab. `/projects/<id>` redirects to the first view by `sort_order`; `/list`, `/board`, `/calendar`, `/timeline` redirect to the first view with that layout (or render the default config if there is none).
- **Config schema** (documented in full at the top of the migration, mirrored by `src/lib/views.ts`):

  ```
  filters:  completion incomplete|completed|all (default incomplete = "show completed" off)
            completed_within_days N (requires completion = completed)
            sections [uuid | null]     assignees [uuid | "me" | null]   (any-of; null = none)
            due { kind: overdue | today | upcoming (days, default 7) | no_date | range (from, to) }
            fields [{ field_id, op: in | equals | empty | not_empty, values? | value? }]   (all must match)
            text   (title or notes contains, case-insensitive)
  sort:     up to 3 × { key: manual | due | start | title | created | assignee | field:<uuid>, dir }   default manual
  group_by: section (default) | assignee | none | field:<uuid> (single-select, not section-bound)
  columns:  [assignee | due | start | section | field:<uuid>]   List columns / Board card fields;
            absent = assignee, due, and every field pinned with show_in_views
  ```

  `show_completed` is not a separate key: the toolbar's "Show completed" checkbox toggles `filters.completion` between `incomplete` and `all`. Field conditions follow the field type: selects/people use `in` (any of the option/profile ids; multi-select and people match on overlap), text/number/date/checkbox use `equals` (text compares case-insensitively), and every type supports `empty` / `not_empty` (`null`, `""`, `[]`, and `false` count as empty). A section-bound Status field compares the task's section in the project.
- **Evaluation:** filtering happens in Postgres. `rpc("filter_project_tasks", { target_project, filters, tz })` (SECURITY INVOKER, so RLS applies) returns the matching active task ids in the project; `data.ts` `filterProjectTaskIds()` calls it and the page keeps only those tasks. Sorting, grouping, and columns are applied in the browser (`components/project/view-groups.ts`) because they don't change membership. `"me"` resolves to `auth.uid()`. The browser parser (`parseViewConfig`) drops invalid parts and `pruneConfig` drops references to deleted sections, fields, and people, so a stale view still renders.
- **Relative dates use the viewer's time zone.** `TimeZoneCookie` (in the app layout) writes the browser's IANA zone to the `tz` cookie and refreshes when it changes; `getViewerTimeZone()` validates it and `safe_timezone()` falls back to UTC. "Overdue" = due before local today and incomplete; "today", "upcoming", and "completed in the last N days" use local days.
- **Unsaved changes live in the URL.** Editing filters, sort, group, columns, or search in the toolbar writes the canonical config to `?f=` (max 8000 chars) without saving. The toolbar then shows "Unsaved changes" with **Reset**, **Save view** (`updateView`), and **Save as new view** (`createView`). Filter chips under the toolbar show every active filter and remove it on click. Shared `?f=` links reproduce the same view.
- **Tabs:** the project header lists views by `sort_order`, then fixed tabs (Dashboard, Fields, Forms, Rules, Settings). "+ View" creates a list/board/calendar view; each tab's menu has Rename, Duplicate ("<name> copy"), Move left/right, and Delete (soft).
- **List / Board with views:** groups come from `group_by`. Section groups show "No section" plus every section (only the filtered ones when a section filter is set), assignee groups end with "Unassigned", field groups end with "No <field>". Drag-and-drop on Board changes what the column represents: section → `moveTask`, assignee → `updateTask({ assigneeId })`, field option → `setFieldValue`. A precise drop position (fractional `sort_order`) is only used with manual sort and section grouping; otherwise the card is appended. Adding tasks inline is offered only in section groups.
- **Subtasks are never shown on views** (List, Board, Calendar, or Timeline): subtasks have no due date, assignee filter, or project membership in this schema, so views list tasks only and the pane shows subtasks.

### Calendar

- Month view (weeks start Sunday) and week view; the period is in the URL (`?d=YYYY-MM-DD`, `?cal=week`), with Today and previous/next controls. Tasks are placed by **`tasks.due_on`** only (there is no due time; `start_on` is ignored here — Timeline is the view that uses it). Dragging a task to a day before its start date is rejected with the start-after-due error. Completed tasks that pass the view's filters are shown struck through; overdue incomplete tasks get a red dot.
- The view's filters apply to the grid. The right-hand **No due date** tray lists the filtered tasks that have no due date and are incomplete.
- Clicking a task opens the normal task pane (`?task=`). Dragging a task to a day sets its due date (`updateTask({ dueOn })`, optimistic, logged as `due_changed`); dropping it on the tray clears the due date. Month cells show three tasks, then "+N more" expands the day.

### Timeline

Migration `20261005040000_timeline.sql`, tests in `supabase/tests/50_timeline_smoke.sql`. A Gantt-style layout built with plain CSS-positioned bars (no chart library).

- **Bars:** `start_on` → `due_on` (inclusive) when both are set. **Due only** = a one-day bar on the due day (not a milestone glyph, so it can be dragged and resized like any bar). **Start only** = a one-day bar on the start day drawn open-ended (dashed outline, “Starts <date>”). Neither = the **Unscheduled** tray. These rules live in `components/project/timeline-scale.ts` (`spanOf`).
- **Colour = status:** accent fill for open tasks, red for overdue (due before the viewer's local today, incomplete), zinc + struck-through title for completed tasks (shown only when the view shows completed tasks), dashed accent outline for start-only tasks. No per-section colours.
- **Scale:** Week (36 px/day, 6 weeks from the Sunday before the anchor's week, weekends shaded), Month (12 px/day, 4 months from the anchor's month), Quarter (4 px/day, 4 quarters). The zoom and anchor are URL state like Calendar (`?tl=month|quarter`, default week; `?d=YYYY-MM-DD`) with Today and earlier/later controls; they are not saved in the view config. A vertical accent line marks today. A task outside the window shows a “‹ Sep 12” / “Dec 3 ›” button on its row that jumps the window to it.
- **Rows:** one per scheduled task (start or due set) passing the view's filters, grouped and ordered by the view's `group_by` and `sort` exactly like List (`groupTasks`); empty groups are hidden. The toolbar offers Filter, Sort, Group, and Show completed (no Columns). The sticky left column lists task names as links — the keyboard and screen-reader path to the pane — with the dates, overdue/completed state, and assignee spelled out for screen readers; the bars themselves are pointer-only (`aria-hidden`).
- **Dependency arrows (Task depth):** an SVG overlay draws a finish-to-start arrow from each predecessor bar's end to its successor bar's start when both rows are shown and both bars are at least partly inside the window (`listProjectDependencies()`, loaded only for the timeline layout). Arrows are red when the successor starts before the predecessor is due. They are pointer-transparent and `aria-hidden`; the name link's screen-reader text says "blocked by N", and the pane lists the dependencies. Row positions are computed from fixed row heights (`HEADER_HEIGHT` / `GROUP_HEIGHT` / `ROW_HEIGHT` in `timeline-view.tsx`), so keep them in sync with the row classes.
- **Interactions:** clicking a bar or a name opens the task pane (`?task=`). Dragging a bar **moves** it (whichever dates are set shift by the same number of days); dragging either **end** resizes it (that edge is set and the other kept, so a single-date task gains both dates; edges never cross). Both commit `updateTask({ startOn, dueOn })` optimistically and log `start_changed` / `due_changed`. Dragging a task from the Unscheduled tray onto a day sets its **due date** only. Clearing dates happens in the pane.
- **Unscheduled tray:** incomplete filtered tasks with neither date (due-only and start-only tasks are bars, not tray items).
- **Start dates elsewhere:** the pane has a Start date input next to Due date (each limits the other with `min`/`max`, and a rejected change resets the input). List can show a **Start** column and Board cards a start chip via the `start` column key; views can sort by `start`.

### Dashboard (`dashboard_widgets`)

- `dashboard_widgets (project_id, kind count|by_section|by_assignee, title, filters, sort_order, created_by)`, soft delete, full allowlisted RLS. `filters` uses the same filter schema as views and is validated by `validate_view_filters` (trigger `dashboard_widgets_validate`).
- Metrics come from `rpc("project_metrics", { target_project, filters, group_by: none|section|assignee, tz })` (SECURITY INVOKER over `filter_project_tasks`, so counts never include rows the caller can't read): one row per bucket with `task_count`; a `null` bucket is "No section" / "Unassigned".
- Widgets: **number card** (`count`), **bar chart by section** (`by_section`, project section order, "No section" only if non-zero), **bar chart by assignee** (`by_assignee`, largest first, Unassigned last). Charts use Recharts (MIT) with an `sr-only` table for screen readers. Each widget shows its filters as chips and a "View tasks" link that opens the List view with the same filters as a `?f=` draft.
- Widgets can be added (blank or "Add starter widgets": Incomplete tasks, Overdue, Completed in the last 7 days, Incomplete by section, Incomplete by assignee), edited (title, kind, filters), moved earlier/later, and removed (soft).

## Teams & permissions model

Migration `20261005050000_teams_permissions.sql`, tests in `supabase/tests/60_teams_permissions_smoke.sql`. Still generic: membership is per project, with no team or department baked in.

### Membership (`project_members`)

- `project_members (id, project_id, profile_id, role, created_by, created_at, updated_at, deleted_at)`; role ∈ `owner | admin | editor | commenter | viewer`. One **active** row per (project, person) (partial unique index where `deleted_at is null`). Removal is a soft delete and is kept as history; re-inviting creates a new row. A soft-deleted membership grants nothing.
- Writes only through SECURITY DEFINER RPCs (no insert/update policy): `add_project_member(target_project, member_email, member_role)` (invite by email; re-inviting an active member changes their role), `update_project_member_role(target_project, target_profile, new_role)`, `remove_project_member(target_project, target_profile)` (anyone may remove themselves = leave), `transfer_project_ownership(target_project, target_profile)` (target becomes owner, caller steps down to admin). Members of a project can read its member list (`project_members_select_viewer`).
- **Invites:** the address must already be on `allowed_emails` **and** its owner must have signed in once with a confirmed email (so a `profiles` row exists); otherwise the RPC raises with a hint. Pending invites for people who never signed in are a follow-up. Invites do not create an inbox item (inbox items are task-scoped).
- **Guests** are not a separate account type: a guest is an allowlisted person invited to a project with a lower role (usually Viewer or Commenter). The Members page says so in its copy.
- **Invariants:** a project always keeps an active owner (`project_members_guard` rejects demoting or removing the last one, locking the project row so concurrent changes serialise); memberships can't move between projects/people; only owners can add, change, or remove owners; admins grant up to admin.
- **New projects:** `projects_add_owner` (AFTER INSERT, SECURITY DEFINER) makes the creator the owner. `projects_05_guard_columns` forces `created_by = auth.uid()` and `created_at = now()` on client inserts and makes them immutable, and rejects soft-deleting/restoring a project unless the caller is an owner. Because the owner row is written after `INSERT … RETURNING` is checked, `projects_select_viewer` also lets the creator read the row in its creating transaction (`created_by = auth.uid() and created_at = now()`); that can't be replayed later.
- **Backfill** (`backfill_project_members()`, idempotent, not an RPC; run once by the migration): every project without an owner gets its creator as owner, or — when `created_by` is null — the oldest allowlisted profile; then every other currently allowlisted (confirmed) profile joins every project as **Editor**, so the single team using the app keeps working. Owners/admins narrow access per project afterwards.

### Roles and helpers

Total order `viewer < commenter < editor < admin < owner` (`project_role_rank()`; `src/lib/roles.ts` mirrors it). Helpers (SECURITY DEFINER, `search_path = ''`, all require `is_allowlisted()`): `project_role(project)`, `has_project_role(project, min_role)`, `task_role(task)`, `has_task_role(task, min_role)`, `profile_can_read_task(profile, task)` (only answers for tasks the caller can read). **A task's role is the caller's highest role across the task's active project memberships plus its home project** — so a task multi-homed into a project you edit is editable by you, while its other projects stay invisible (`task_projects` rows are visible per project). Internal helpers (`profile_project_role`, `profile_task_role`, `profile_is_allowlisted`) are revoked from clients.

| Capability | owner | admin | editor | commenter | viewer |
| --- | :-: | :-: | :-: | :-: | :-: |
| Read project, tasks, sections, fields, views, dashboard, timeline, forms, rules, run log, members | ✓ | ✓ | ✓ | ✓ | ✓ |
| Comment, follow, be @mentioned; decide an approval you are the named approver of | ✓ | ✓ | ✓ | ✓ | |
| Create/edit/complete/move/multi-home tasks, subtasks, custom fields + values, attachments, sections; request/cancel/resubmit approvals; assign Req # | ✓ | ✓ | ✓ | | |
| Set due/start times and recurrence; add/remove dependencies; see the Trash and restore deleted tasks | ✓ | ✓ | ✓ | | |
| Saved views and dashboard widgets | ✓ | ✓ | ✓ | | |
| Rules, forms, request numbering, project name/description/settings | ✓ | ✓ | | | |
| Invite, change roles (up to admin), remove non-owners | ✓ | ✓ | | | |
| Add/promote/remove owners, transfer ownership, soft-delete the project | ✓ | | | | |

Being @mentioned, followed, assigned, or notified requires read access (viewer+); viewers can be assigned but can't complete tasks. Field values are gated by the **field's** project. Storage objects in `task-attachments` follow the task: read = viewer, upload = editor (`attachment_object_task(name)` parses the `<task_id>/` prefix).

### RPCs and RLS

- SECURITY INVOKER RPCs inherit the new RLS: `create_task` (editor of the home project), `filter_project_tasks` / `project_metrics` (return nothing for non-members), `install_rule_preset` (admin), `search_tasks` (only readable tasks; labelled with the home project when visible, else another visible project).
- SECURITY DEFINER RPCs check explicitly: `assign_request_number` (editor), `request_approval` (editor; approver commenter+), `decide_approval` (approver + commenter+), `cancel_approval` / `resubmit_approval` (editor), `get_public_form` (closed-form preview for project viewers+). `submit_form` stays public; rules and form submissions run as definer and are not limited by the triggering person's role.
- `rule_presets`, `profiles`, `workspaces`, and `allowed_emails` stay workspace-level (allowlisted read). `email_outbox` rows are readable with the task (viewer+).
- **EXECUTE surface** (asserted by `60_teams_permissions_smoke.sql`): `anon` can execute only `get_public_form` and `submit_form` among SECURITY DEFINER functions; `authenticated` exactly the intentional RPCs and the role helpers used inside policies (Task depth added `add_task_dependency`, `remove_task_dependency`, `restore_task`, and `open_blocker_count`). Internal ticks, outbox claim/complete, the backfill, and trigger helpers are not executable by clients.

### App

- `getProjectRole()` / `listProjectMembers()` / `listMyProjectRoles()` in `data.ts`; `TaskDetail.viewerRole` and `memberRoles` drive the pane (assignee and approver pickers list only people with access; approvers need commenter+).
- `ProjectAccessProvider` (project layout) exposes the viewer's role; `useCan(min)` hides or disables controls, and `RoleGate` wraps admin/editor pages (Fields, Forms, Rules, Settings, Dashboard) in a disabled `<fieldset>` with a notice. Viewers keep filtering views (unsaved `?f=` drafts) but can't save them, drag, add, or complete. The database remains the trust boundary; `updateTask`/`setTaskCompleted` turn an RLS "0 rows" into “Your role in this project doesn’t allow that”, and RLS errors in `check()` get the same message.
- **Members page** (`/projects/<id>/settings/members`, “Members” under the Settings tab): list with name/email/role, invite by email + role (owner/admin), role select, remove, leave, transfer ownership (owner), role legend, empty state.

## Task depth model

Migration `20261005060000_task_depth.sql`, tests in `supabase/tests/70_task_depth_smoke.sql`. Generic: nothing knows about a team or request type.

### Recurring tasks

- **Rule on the task:** `tasks.recurrence jsonb` (null = one-off), validated and normalized by `normalize_recurrence()` (trigger `tasks_16_validate_recurrence`) and mirrored by `src/lib/recurrence.ts`:
  `{ freq: daily|weekly|monthly|yearly, interval: 1–365, weekdays?: [0–6] (weekly only, 0 = Sunday), ends: {type: never} | {type: after, count: 1–1000} | {type: until, until: YYYY-MM-DD}, timezone: IANA (default UTC), month_day?: 1–31 (system) }`. Unknown keys and values raise `check_violation`. Editors set it through `updateTask`-style RLS (`setTaskRecurrence`); viewers' updates affect zero rows. A `recurrence_changed` story logs each change.
- **Spawn on complete (Asana style, not roll-forward):** `tasks_after_complete_recur` (SECURITY DEFINER `spawn_next_occurrence()`) fires when a task with a rule goes incomplete → complete, by anyone (person, rule, approval). It inserts **one** new incomplete task: same title (a `[Req #…] ` prefix is stripped so the new task gets its own number), notes, assignee, creator, home project, other projects + sections (end of each section), stored custom field values (values that no longer validate are skipped), followers, and open non-approval subtasks; not comments, attachments, approvals, or dependencies. Dates shift by the same number of days from the **anchor** (due date, else start date, else the completion day in the rule's zone) to `recurrence_next_date(rule, anchor)`; times keep their local time of day in `tasks.time_zone`; an undated task's next occurrence is due on the next date. The new task's `recurrence_seq` is +1 and `recurrence_series_id` is the first task's id; the completed task gets `recurrence_next_id` and a `recurrence_spawned` story (with a link in the pane). The new task fires `task_created` rules at commit like any new task.
- **Rules of the series:** reopening and completing again does not spawn a second copy while the spawned one is active (deleting the spawned occurrence lets the next completion spawn again). `ends.after N` stops once occurrence N is completed; `ends.until` stops when the next anchor would be after that date. Monthly/yearly remember the anchor's day (`month_day`) so Jan 31 → Feb 28 → Mar 31; Feb 29 yearly lands on Feb 28 in common years. Weekly with weekdays picks the next listed weekday in a week that is a multiple of `interval` weeks from the anchor's week (weeks start Sunday). Clients can't write `recurrence_series_id` / `recurrence_seq` / `recurrence_next_id` (`tasks_11_guard_recurrence_columns`).
- **UI:** pane row **Repeats** (frequency, every N, weekday toggles, ends never/after/on date, summary like “Every 2 weeks on Mon, Wed · until Dec 31, 2026”); a repeat icon on List rows and Board cards (`ProjectTask.recurring`).

### Due and start times

- `tasks.due_at` / `start_at` (timestamptz, optional) + `tasks.time_zone` (IANA, normalized by `safe_timezone()`). `tasks_15_sync_times` keeps `due_on`/`start_on` equal to the local date of the time: setting a time sets its date; changing only the date (Calendar/Timeline drag) moves the time to the new date at the same local time; clearing a date clears its time; clearing a time keeps the date. Constraints: `tasks_start_at_before_due_at`, `tasks_due_at_has_date`, `tasks_start_at_has_date`, plus the existing date constraint.
- The pane sends the browser's zone with every time it sets (`updateTask({ dueAt, timeZone })`); times are shown in the viewer's local zone (client-only render). Calendar, Timeline, List, Board, My Tasks, filters, rules, and forms stay day-based.

### Dependencies

- `task_dependencies (id, project_id, predecessor_id, successor_id, kind 'finish_to_start', created_by, created_at, updated_at, deleted_at)`; one **active** row per (predecessor, successor) (partial unique index); `predecessor_id <> successor_id`. Soft delete keeps history; re-adding creates a new row.
- **Writes only via SECURITY DEFINER RPCs** (no insert/update policy): `add_task_dependency(predecessor, successor)` (both tasks active and readable; they must share an active project where the caller is **Editor**, else `check_violation` “same project” / `insufficient_privilege`; idempotent for an existing pair; rejects cycles with a recursive walk under a transaction advisory lock) and `remove_task_dependency(target_dependency)` (Editor in the dependency's project). Both write `dependency_added` / `dependency_removed` stories on both tasks. Read: `task_dependencies_select_viewer` (viewer of `project_id`).
- **Blocking, not warning:** `tasks_12_guard_dependencies` (runs as the caller) rejects a person completing a task while any active, non-deleted predecessor is incomplete (`check_violation`, “This task is blocked by N incomplete tasks”, with a hint). System completions (rules, `approval_completes_task`) are not blocked. `open_blocker_count(task)` (returns 0 for tasks the caller can't read) backs the guard. Reopening a predecessor does not reopen its successors.
- **UI:** pane section **Dependencies** with **Blocked by** and **Blocking** lists (links, completion state, remove), and pickers of tasks from the task's projects where the viewer is an Editor (`TaskDetail.dependencyCandidates`, 300 per project). **Mark complete** is disabled with “Blocked by N tasks” while blocked. List/Board show a lock + count (`ProjectTask.blockedBy`). Timeline draws arrows (see Timeline).

### Trash

- A deleted task stays a row with `deleted_at`. `tasks_select_viewer` now shows **active** tasks to viewers+ and **trashed** tasks only to Editors+ (home project or any active membership), so Viewers/Commenters and non-members never read trashed titles. Views (`filter_project_tasks`), search (`search_tasks`), My Tasks, Inbox, rules, and the dashboard all filter `deleted_at` as before.
- `restore_task(target_task)` (SECURITY DEFINER, Editor on the task) clears `deleted_at` (refuses when the home project is deleted); `tasks_after_restore` writes a `restored` story. The plain RLS update path would also work for editors; the RPC gives a clear error and is what the app calls.
- **Trash page:** Settings → **Trash** (`/projects/<id>/settings/trash`) lists up to 200 trashed tasks with an active membership in the project (newest first, who deleted it from the `deleted` story, home project when different), with a confirmed **Restore**. Below Editor the page shows a notice instead of a list. There is no permanent delete.

## Conventions

- Server Components fetch via `src/lib/data.ts`; Client Components mutate via `src/lib/actions.ts` wrapped in `useServerAction()` (toasts errors, supports optimistic updates).
- Route params/searchParams are Promises (`await params`). Use `PageProps<"/route">` / `LayoutProps<"/route">` global types.
- Schema changes: add a new timestamped file in `supabase/migrations/`, update `database.types.ts` (or run `npm run db:types`), extend or add a `supabase/tests/NN_<area>_smoke.sql` suite (`10_core_smoke.sql`, `20_collaboration_smoke.sql`, `30_workflows_smoke.sql`, `40_views_insights_smoke.sql`, `50_timeline_smoke.sql`, `60_teams_permissions_smoke.sql`, `70_task_depth_smoke.sql`), run `npm run db:test`. Suites that act as a second person must give them a project membership first (`add_project_member`).
- New project-scoped tables: RLS with `<table>_<command>_<role>` policies via `has_project_role` / `has_task_role` (pick the lowest role from the matrix that should have the capability), soft delete, no DELETE policy. Don't add new `_allowlisted` policies to project data.
- Task filters (views, dashboard widgets, and anything new that needs "tasks matching X") go through `filter_project_tasks` and the one config schema in the views migration + `src/lib/views.ts`. Extend that schema (validators, parser, and smoke tests together) instead of adding a second filter format.
- Trigger functions that write on the user's behalf are `SECURITY DEFINER` with `set search_path = ''`, and their helpers are revoked from `public`, `anon`, and `authenticated`. Revoke EXECUTE on every new SECURITY DEFINER **trigger** function too (Supabase's default privileges grant it to `anon`/`authenticated`; triggers fire regardless). The timeline migration revoked it from all existing ones, and `50_timeline_smoke.sql` asserts that `anon` can execute no SECURITY DEFINER function except `get_public_form` and `submit_form`. `60_teams_permissions_smoke.sql` pins the exact SECURITY DEFINER list `authenticated` can execute: adding a client RPC means adding it there on purpose.
- Keep the UI restrained: zinc neutrals, one accent (`accent-*` in `globals.css`), no gradients, accessible labels on every control.

## Phases

- **Core spine** (done): auth + allowlist, projects/sections/tasks/subtasks, multi-homing, List/Board/pane.
- **Collaboration** (done): comments + @mentions, followers, activity stories, custom fields (incl. section-bound status), attachments, My Tasks, Inbox, search, Realtime.
- **Workflows** (done): approvals, public/branching forms (intake → task), rules engine with installable templates, native Req # sequences, email outbox + Resend. A request type is a project + fields + form + rules, not a schema of its own.
- **Views & Insights** (done): saved per-project views (list / board / calendar) with filters, sorts, grouping, and columns; removable filter chips and `?f=` drafts; month/week Calendar with a no-date tray and drag-to-reschedule; project Dashboard with count cards and section/assignee bar charts.
- **Timeline** (done): `tasks.start_on` with `start_changed` stories and a start ≤ due constraint; Timeline saved-view layout (week / month / quarter scale, status-coloured bars, drag to move or resize, Unscheduled tray, view filters/sort/grouping, `?f=` drafts); a Timeline view for every project; EXECUTE revoked from client roles on SECURITY DEFINER trigger functions.
- **Teams & permissions** (done): `project_members` with owner / admin / editor / commenter / viewer; membership-aware RLS on every project-scoped table and Storage; role checks in task/approval RPCs; invite by allowlisted email, role changes, removal, leave, and ownership transfer via RPCs with a last-owner invariant; backfill (creator owner, other allowlisted people editors); Members settings page and role-aware UI; pinned SECURITY DEFINER EXECUTE surface. The allowlist stays the outer gate.
- **Task depth** (done): recurring tasks (rule on the task, next occurrence spawned on completion with shifted dates and copied projects/sections/fields/followers/subtasks, end after N / until, weekday and month-end handling); optional due/start times synced to the date columns; finish-to-start `task_dependencies` with cycle checks, completion blocking, pane lists, List/Board badges, and Timeline arrows; trashed tasks visible to Editors+ only, `restore_task` RPC, and a per-project Trash page.
- **Next phase candidates:** Asana importer (read-only export files, never the Asana API; imported rules land disabled), Slack/webhook rule actions, iCal feed, critical path / auto-scheduling, workspace Teams directory.

## Follow-ups (not yet built)

Asana importer (read-only export files, never the Asana API), iCal feed for Calendar views, critical path and auto-shifting successors when a predecessor moves, cross-project dependencies, other dependency kinds (start-to-start, etc.), creating dependencies by dragging between Timeline bars, recurrence exceptions (skip/move one occurrence) and “repeat from completion date” mode, editing a whole series at once, showing times on List/Board/Calendar/My Tasks, section trash (restore deleted sections) and a workspace-wide trash, baselines, keyboard moving/resizing of Timeline bars, a saved Timeline zoom, Timeline on mobile (the tray is hidden below `md`), start-date filters and a `start_on` form mapping / rule trigger, time-aware rules (`due_at` reminders), Slack incoming-webhook and outbound webhook rule actions (needs an outbox drain like email plus new rule actions), a Slack OAuth app, universal cross-project reporting and portfolios, a richer dashboard builder (more chart types, grouping by custom field, date-series charts, widget sizes), My Tasks filter builder (My Tasks keeps its fixed due-date buckets; saved views are per project), private/personal views, creating a task on a Calendar or Timeline day and keyboard rescheduling, form file-upload questions and per-form submitter accounts, rule editing history and dry-run, email open/bounce tracking and unsubscribe, @mention autocomplete, comment editing and reactions, workspace-level field library and field reordering, manual My Tasks sections, attachment previews/thumbnails and Storage cleanup of removed files, push notifications and an inbox email digest, inbox archive, pending project invites for allowlisted people who haven't signed in yet (and an invite inbox/email notification), workspace-level Teams directory and group invites, workspace admin UI for the allowlist, per-task guest access (sharing a single task outside its projects), guest product polish (guest badge, limited sidebar), membership audit log, project-membership-aware assignee/people pickers in Board/List/rules, viewers completing tasks assigned to them, taking `task_request_label()` off the client API, reordering sections and list drag-and-drop, and Autumn Lake workflow migration (e.g. Creative Requests as a project template on the generic model). Never call the Asana API.
