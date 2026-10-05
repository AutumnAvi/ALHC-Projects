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
| `npm run db:test` | Applies `supabase/migrations/*` to a throwaway local Postgres and runs every `supabase/tests/*_smoke.sql` in filename order (needs Postgres server binaries) |
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
      projects/[projectId]/views/[viewId]     A saved view (list / board / calendar); `?f=` = unsaved filter draft, `?task=<id>` opens the pane
      projects/[projectId]/list|board|calendar  Redirect to the first view with that layout (old links keep working)
      projects/[projectId]/dashboard          Project dashboard widgets (counts + bar charts)
      projects/[projectId]/fields             Field management
      projects/[projectId]/forms[/[formId]]  Form list + builder
      projects/[projectId]/rules              Rules, templates, run log
      projects/[projectId]/settings           Req # numbering, approval-completes-task
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
  components/                  UI; project/ (view page + toolbar, filter editor, list, board, calendar, fields, settings), dashboard/, task/ (pane, activity, fields, files, approvals), forms/, rules/, my-tasks/, inbox/, search/, shell/, popover.tsx
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

Allowlist entries are managed in SQL (dashboard SQL editor or service role) — members cannot edit the allowlist through the API.

## Data model rules

- **Tables:** `allowed_emails`, `profiles`, `workspaces`, `projects`, `sections`, `tasks`, `task_projects`, `subtasks` (core spine); `comments`, `comment_mentions`, `task_followers`, `task_stories`, `inbox_items`, `custom_fields`, `task_field_values`, `task_attachments` (collaboration); `request_sequences`, `approval_requests`, `forms`, `form_submissions`, `rules`, `rule_runs`, `scheduled_rule_actions`, `rule_presets`, `email_outbox` (workflows); `project_views`, `dashboard_widgets` (views & insights).
- **Single workspace this phase:** migration seeds workspace `00000000-0000-4000-8000-000000000001` ("ALHC"); the app uses the oldest active workspace.
- **Profiles** mirror allowlisted auth users (name/avatar from Google; password users fall back to their email) via triggers on `auth.users` and on `allowed_emails` inserts. Assignees reference `profiles.id`.
- **Multi-homing:** `task_projects (task_id, project_id)` is the membership join. Section and `sort_order` live on the membership, so one task can sit in different sections/positions per project.
- **Home project rule:** `tasks.home_project_id` is the project the task was created in (its primary project). A trigger guarantees an active membership in the home project; removing the home membership is rejected — make another membership the home first. `tasks.workspace_id` always follows the home project.
- **Ordering:** fractional `double precision sort_order` (step 1024, midpoint inserts). No reindexing yet.
- **Soft delete only:** every content table has `deleted_at`. There are **no DELETE policies**, so hard deletes through the API affect zero rows. Reads in `src/lib/data.ts` always filter `deleted_at IS NULL`; RLS intentionally does not, so restore can be added later. Soft-deleting a section moves its tasks to "No section" (trigger). Soft-deleting a task hides it from every project.
- **RLS policy pattern:** `<table>_select_allowlisted`, `<table>_insert_allowlisted`, `<table>_update_allowlisted` using `(select public.is_allowlisted())`; `profiles_update_own`; `allowed_emails_select_allowlisted` (read-only). Author-owned rows use `_own` variants (`comments_insert_own`/`_update_own`, `task_attachments_insert_own`, `inbox_items_select_own`/`_update_own`).
- **Task creation** goes through `rpc("create_task", { target_project, target_section, task_title })` so the task row and its home membership land in one transaction (and `workspace_id` is filled by trigger).

## Collaboration model

- **Activity is trigger-written.** `task_stories` rows (`created`, `completed`, `reopened`, `renamed`, `deleted`, `assigned`, `unassigned`, `due_changed`, `section_changed`, `project_added`, `project_removed`, `attachment_added`, `field_changed`) are inserted by SECURITY DEFINER triggers; clients can only read them. Membership changes made in the same transaction that created the task (`tasks.created_at = now()`) are not logged, so new tasks get one `created` story. `data` holds name snapshots (section/project/field names) so history survives renames.
- **Comments** (`comments`) are plain text, author = `auth.uid()` (enforced by policy), soft-deleted by their author only. Soft-deleting a comment marks its inbox items read (`comments_after_soft_delete`) and `listInbox()` hides them. Edit is not exposed yet.
- **@mentions are parsed in the database** by the `comments_after_insert` trigger: `@Full Name` or `@emaillocalpart` (case-insensitive, word-bounded) of an allowlisted profile. Matches become `comment_mentions` rows; the author is never mentioned.
- **Followers** (`task_followers`, soft delete) — auto-follow on: creating a task, being assigned, commenting, being @mentioned. Anyone can follow/unfollow anyone from the pane (generic team tool; tighten with per-project permissions later).
- **Inbox** (`inbox_items`) is fan-out on write by triggers; clients can't insert. Kinds: `assigned` (to the new assignee), `mention` (to each mentioned person), `comment` (to every other follower not already mentioned), `completed` (to followers), plus `approval_requested`, `approval_decided`, and `rule` from Workflows (`data` jsonb carries status/note/message and the rule name). The actor never notifies themself. Recipients can only read their own items, and the column grant only lets them update `read_at`. Inbox items never send email; only workflow emails do (see Email).
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
- All state changes are RPCs (no client insert/update policy): `request_approval(target_task, approver, approval_note, as_subtask, subtask_title)`, `decide_approval(target_approval, decision, decision_note)` — **approver only, pending only** — `resubmit_approval`, `cancel_approval` (any member; open = pending or changes requested).
- By default a request also creates an **approval subtask** (title defaults to "Approval"). Clients can't tick an approval subtask while its approval is open (`subtasks_guard_approval`); `approved`/`rejected` completes it, `changes_requested` leaves it open.
- Notifications: the approver follows the task and gets an `approval_requested` inbox item (again on resubmit). A decision notifies the requester, the assignee, and all followers (`approval_decided`, `inbox_items.data` carries status + note). The decider is never notified of their own action.
- `projects.approval_completes_task` (Settings tab): when on, an `approved` decision also completes the task. Every decision fires `approval_decided` rules.

### Forms

- `forms (project_id, title, description, questions jsonb, destination_section_id, accepting_responses, send_confirmation, confirmation_message)`. New forms start closed. `questions` is an ordered array validated by `validate_form`:
  `{ id, type: short_text|long_text|number|date|single_select|multi_select|checkbox, label, help?, required?, options?: [{id,label}], maps_to?: { target: title|notes|due_on|section|field, field_id? }, show_if?: { question_id, option_ids[] } }`.
- **Branching:** `show_if` may only reference an *earlier* choice/checkbox question (checkbox option id is `"true"`). Visibility is walked in order; a question whose parent is hidden is hidden too. Hidden answers are dropped server-side. `src/lib/forms.ts` implements the same walk + validation for the browser; `submit_form` re-validates everything (the DB is the trust boundary).
- **Mapping:** `title` (else "<form title> — <email>"), `notes` (else every unmapped answer is summarized in the description), `due_on` (date questions), `section` (single choice; options match a section by id then name), `field` (writes `task_field_values`; select options match by option id then name; a **section-bound Status field maps to the section** instead of a stored value). Destination section otherwise.
- **Submitting:** `rpc("submit_form", { target_form, submitter_email, answers })` is granted to `anon` and `authenticated`. It checks the form is accepting, rate-limits (5/min per email per form), creates the task with `source = 'form'` (there is no "is submission" field — use the `source_is` rule condition or `tasks.source`), applies mappings, assigns a Req # (trigger), records `form_submissions` (email, profile if signed in, cleaned answers), writes a `form_submitted` story, queues the `form_confirmation` email, and fires `form_submitted` rules (plus `task_created` at commit). The Server Action adds a honeypot field and calls `get_public_form` first to validate with the same rules.
- **Public URLs:** `/forms/<id>` (standalone) and `/forms/<id>/embed` (no chrome, for `<iframe>`). Both are public paths in the proxy and read through `get_public_form`, which strips `maps_to` and returns no questions while closed (members still see them, for preview). The builder shows the link and a ready-made iframe snippet. **Marketing Request Forms hub:** a hub is just a page (Notion, website, intranet, or later an app page) that links or iframes several `/forms/<id>/embed` URLs, one per request type/project. Nothing in the schema knows about a hub; the project chosen per form determines where tasks land.

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

- `project_views (project_id, name 1–100, layout list|board|calendar, config jsonb, sort_order, created_by)`, soft delete, full `_{select,insert,update}_allowlisted` RLS. Views are shared by everyone in the project (no private views yet). `project_id` is immutable and `config` is validated on write by `validate_view_config` (trigger `project_views_validate`): unknown keys/values, sections or fields from another project, a non-single-select or section-bound `group_by` field, or more than 3 sorts raise `check_violation`.
- **Defaults:** `projects_create_default_views` (SECURITY DEFINER) gives every new project **List**, **Board**, and **Calendar** views with an empty config; the migration backfilled existing projects. The last remaining view of a project can't be deleted (`deleteView`), so a project always has a tab. `/projects/<id>` redirects to the first view by `sort_order`; `/list`, `/board`, `/calendar` redirect to the first view with that layout (or render the default config if there is none).
- **Config schema** (documented in full at the top of the migration, mirrored by `src/lib/views.ts`):

  ```
  filters:  completion incomplete|completed|all (default incomplete = "show completed" off)
            completed_within_days N (requires completion = completed)
            sections [uuid | null]     assignees [uuid | "me" | null]   (any-of; null = none)
            due { kind: overdue | today | upcoming (days, default 7) | no_date | range (from, to) }
            fields [{ field_id, op: in | equals | empty | not_empty, values? | value? }]   (all must match)
            text   (title or notes contains, case-insensitive)
  sort:     up to 3 × { key: manual | due | title | created | assignee | field:<uuid>, dir }   default manual
  group_by: section (default) | assignee | none | field:<uuid> (single-select, not section-bound)
  columns:  [assignee | due | section | field:<uuid>]   List columns / Board card fields;
            absent = assignee, due, and every field pinned with show_in_views
  ```

  `show_completed` is not a separate key: the toolbar's "Show completed" checkbox toggles `filters.completion` between `incomplete` and `all`. Field conditions follow the field type: selects/people use `in` (any of the option/profile ids; multi-select and people match on overlap), text/number/date/checkbox use `equals` (text compares case-insensitively), and every type supports `empty` / `not_empty` (`null`, `""`, `[]`, and `false` count as empty). A section-bound Status field compares the task's section in the project.
- **Evaluation:** filtering happens in Postgres. `rpc("filter_project_tasks", { target_project, filters, tz })` (SECURITY INVOKER, so RLS applies) returns the matching active task ids in the project; `data.ts` `filterProjectTaskIds()` calls it and the page keeps only those tasks. Sorting, grouping, and columns are applied in the browser (`components/project/view-groups.ts`) because they don't change membership. `"me"` resolves to `auth.uid()`. The browser parser (`parseViewConfig`) drops invalid parts and `pruneConfig` drops references to deleted sections, fields, and people, so a stale view still renders.
- **Relative dates use the viewer's time zone.** `TimeZoneCookie` (in the app layout) writes the browser's IANA zone to the `tz` cookie and refreshes when it changes; `getViewerTimeZone()` validates it and `safe_timezone()` falls back to UTC. "Overdue" = due before local today and incomplete; "today", "upcoming", and "completed in the last N days" use local days.
- **Unsaved changes live in the URL.** Editing filters, sort, group, columns, or search in the toolbar writes the canonical config to `?f=` (max 8000 chars) without saving. The toolbar then shows "Unsaved changes" with **Reset**, **Save view** (`updateView`), and **Save as new view** (`createView`). Filter chips under the toolbar show every active filter and remove it on click. Shared `?f=` links reproduce the same view.
- **Tabs:** the project header lists views by `sort_order`, then fixed tabs (Dashboard, Fields, Forms, Rules, Settings). "+ View" creates a list/board/calendar view; each tab's menu has Rename, Duplicate ("<name> copy"), Move left/right, and Delete (soft).
- **List / Board with views:** groups come from `group_by`. Section groups show "No section" plus every section (only the filtered ones when a section filter is set), assignee groups end with "Unassigned", field groups end with "No <field>". Drag-and-drop on Board changes what the column represents: section → `moveTask`, assignee → `updateTask({ assigneeId })`, field option → `setFieldValue`. A precise drop position (fractional `sort_order`) is only used with manual sort and section grouping; otherwise the card is appended. Adding tasks inline is offered only in section groups.
- **Subtasks are never shown on views** (List, Board, or Calendar): subtasks have no due date, assignee filter, or project membership in this schema, so views list tasks only and the pane shows subtasks.

### Calendar

- Month view (weeks start Sunday) and week view; the period is in the URL (`?d=YYYY-MM-DD`, `?cal=week`), with Today and previous/next controls. Tasks are placed by **`tasks.due_on`** — the only due field (there is no due time or start date). Completed tasks that pass the view's filters are shown struck through; overdue incomplete tasks get a red dot.
- The view's filters apply to the grid. The right-hand **No due date** tray lists the filtered tasks that have no due date and are incomplete.
- Clicking a task opens the normal task pane (`?task=`). Dragging a task to a day sets its due date (`updateTask({ dueOn })`, optimistic, logged as `due_changed`); dropping it on the tray clears the due date. Month cells show three tasks, then "+N more" expands the day.

### Dashboard (`dashboard_widgets`)

- `dashboard_widgets (project_id, kind count|by_section|by_assignee, title, filters, sort_order, created_by)`, soft delete, full allowlisted RLS. `filters` uses the same filter schema as views and is validated by `validate_view_filters` (trigger `dashboard_widgets_validate`).
- Metrics come from `rpc("project_metrics", { target_project, filters, group_by: none|section|assignee, tz })` (SECURITY INVOKER over `filter_project_tasks`, so counts never include rows the caller can't read): one row per bucket with `task_count`; a `null` bucket is "No section" / "Unassigned".
- Widgets: **number card** (`count`), **bar chart by section** (`by_section`, project section order, "No section" only if non-zero), **bar chart by assignee** (`by_assignee`, largest first, Unassigned last). Charts use Recharts (MIT) with an `sr-only` table for screen readers. Each widget shows its filters as chips and a "View tasks" link that opens the List view with the same filters as a `?f=` draft.
- Widgets can be added (blank or "Add starter widgets": Incomplete tasks, Overdue, Completed in the last 7 days, Incomplete by section, Incomplete by assignee), edited (title, kind, filters), moved earlier/later, and removed (soft).

## Conventions

- Server Components fetch via `src/lib/data.ts`; Client Components mutate via `src/lib/actions.ts` wrapped in `useServerAction()` (toasts errors, supports optimistic updates).
- Route params/searchParams are Promises (`await params`). Use `PageProps<"/route">` / `LayoutProps<"/route">` global types.
- Schema changes: add a new timestamped file in `supabase/migrations/`, update `database.types.ts` (or run `npm run db:types`), extend or add a `supabase/tests/NN_<area>_smoke.sql` suite (`10_core_smoke.sql`, `20_collaboration_smoke.sql`, `30_workflows_smoke.sql`, `40_views_insights_smoke.sql`), run `npm run db:test`.
- Task filters (views, dashboard widgets, and anything new that needs "tasks matching X") go through `filter_project_tasks` and the one config schema in the views migration + `src/lib/views.ts`. Extend that schema (validators, parser, and smoke tests together) instead of adding a second filter format.
- Trigger functions that write on the user's behalf are `SECURITY DEFINER` with `set search_path = ''`, and their helpers are revoked from `public`, `anon`, and `authenticated`.
- Keep the UI restrained: zinc neutrals, one accent (`accent-*` in `globals.css`), no gradients, accessible labels on every control.

## Phases

- **Core spine** (done): auth + allowlist, projects/sections/tasks/subtasks, multi-homing, List/Board/pane.
- **Collaboration** (done): comments + @mentions, followers, activity stories, custom fields (incl. section-bound status), attachments, My Tasks, Inbox, search, Realtime.
- **Workflows** (done): approvals, public/branching forms (intake → task), rules engine with installable templates, native Req # sequences, email outbox + Resend. A request type is a project + fields + form + rules, not a schema of its own.
- **Views & Insights** (done): saved per-project views (list / board / calendar) with filters, sorts, grouping, and columns; removable filter chips and `?f=` drafts; month/week Calendar with a no-date tray and drag-to-reschedule; project Dashboard with count cards and section/assignee bar charts.
- **Next phase candidates:** Asana importer (read-only export files, never the Asana API; imported rules land disabled), Slack/webhook rule actions, per-project membership, iCal feed, Timeline.

## Follow-ups (not yet built)

Asana importer (read-only export files, never the Asana API), iCal feed for Calendar views, Timeline/Gantt, Slack incoming-webhook and outbound webhook rule actions (needs an outbox drain like email plus new rule actions), a Slack OAuth app, recurring tasks, universal cross-project reporting and portfolios, a richer dashboard builder (more chart types, grouping by custom field, date-series charts, widget sizes), My Tasks filter builder (My Tasks keeps its fixed due-date buckets; saved views are per project), private/personal views, creating a task on a Calendar day and keyboard rescheduling, start dates / due times, form file-upload questions and per-form submitter accounts, rule editing history and dry-run, email open/bounce tracking and unsubscribe, @mention autocomplete, comment editing and reactions, workspace-level field library and field reordering, manual My Tasks sections, attachment previews/thumbnails and Storage cleanup of removed files, push notifications and an inbox email digest, inbox archive, per-project membership/permissions (replace the "any allowlisted user" policies), restore/trash UI, reordering sections and list drag-and-drop, and Autumn Lake workflow migration (e.g. Creative Requests as a project template on the generic model). Never call the Asana API.
