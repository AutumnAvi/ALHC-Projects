<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# ALHC Projects — architecture source of truth

ALHC's own Asana-style work platform. The product is generic: **Workspace → Project → Section → Task → Subtask**, with tasks able to live in several projects. Team-specific workflows (e.g. Autumn Lake Creative Requests) are built *on top of* this model later; never bake one workflow into the schema.

## Stack

- Next.js 16 App Router, React 19, TypeScript strict, Tailwind CSS 4 (`src/` layout, app at repo root)
- Supabase Auth (Google OAuth) + Postgres + RLS via `@supabase/ssr` / `@supabase/supabase-js`
- Deployed on Vercel; no `vercel.json` needed
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
    login/, denied/            Public auth screens
    auth/callback/route.ts     OAuth code exchange + allowlist gate (signs out non-allowlisted users)
    auth/denied/route.ts       Signs out a session that is no longer allowlisted, then shows /denied
    auth/signout/route.ts      POST sign-out
    attachments/[id]/route.ts  Signed-URL redirect for a task attachment (RLS-checked, 60 s URL)
    (app)/                     Authenticated shell; layout calls requireMember() and loads the inbox unread count
      page.tsx                 Project home
      my-tasks/, inbox/, search/  Cross-project views; `?task=<id>` opens the pane on each
      projects/[projectId]/list|board|fields  Views + field management; `?task=<id>` opens the task detail pane
  lib/
    env.ts                     Public Supabase env (optional at build, required at request time)
    supabase/{client,server,proxy}.ts  Browser / server / proxy clients
    supabase/database.types.ts Typed schema — keep in sync with migrations
    auth.ts                    getViewer(), requireMember(), safeNextPath()
    data.ts                    All reads (server-only). Every query filters deleted_at IS NULL
    actions.ts                 All writes (Server Actions). Return { error } and call refresh()
    fields.ts                  Custom field types, option colors, value → chip rendering
    attachments.ts             Bucket name, size limit, storage path builder
    realtime.ts                useRealtimeRefresh(): router.refresh() on postgres_changes
  components/                  UI; project/ (list, board, fields), task/ (pane, activity, fields, files), my-tasks/, inbox/, search/, shell/
supabase/
  migrations/                  Schema, triggers, RLS (source of truth for the data model)
  seed.sql                     Placeholder allowlist entry (local `supabase db reset` only)
  tests/                       Local Postgres harness (auth/storage shim) + *_smoke.sql suites
```

## Auth model

1. `/login` → Supabase `signInWithOAuth({ provider: "google" })` → Google → `/auth/callback`.
2. The callback exchanges the code, then calls `rpc("is_allowlisted")`. Not allowlisted ⇒ `signOut()` and redirect to `/denied` — a rejected user never keeps a session.
3. `(app)/layout.tsx` calls `requireMember()` on every render: no user ⇒ `/login`; user removed from the allowlist ⇒ `/auth/denied` (signs out).
4. RLS is the real boundary. `public.is_allowlisted()` (SECURITY DEFINER) is true only when `auth.uid()` maps to an `auth.users` row with a confirmed email present in `public.allowed_emails`.

Allowlist entries are managed in SQL (dashboard SQL editor or service role) — members cannot edit the allowlist through the API.

## Data model rules

- **Tables:** `allowed_emails`, `profiles`, `workspaces`, `projects`, `sections`, `tasks`, `task_projects`, `subtasks` (core spine); `comments`, `comment_mentions`, `task_followers`, `task_stories`, `inbox_items`, `custom_fields`, `task_field_values`, `task_attachments` (collaboration).
- **Single workspace this phase:** migration seeds workspace `00000000-0000-4000-8000-000000000001` ("ALHC"); the app uses the oldest active workspace.
- **Profiles** mirror allowlisted auth users (name/avatar from Google) via triggers on `auth.users` and on `allowed_emails` inserts. Assignees reference `profiles.id`.
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
- **Inbox** (`inbox_items`) is fan-out on write by triggers; clients can't insert. Kinds: `assigned` (to the new assignee), `mention` (to each mentioned person), `comment` (to every other follower not already mentioned), `completed` (to followers). The actor never notifies themself. Recipients can only read their own items, and the column grant only lets them update `read_at`. No email.
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

## Conventions

- Server Components fetch via `src/lib/data.ts`; Client Components mutate via `src/lib/actions.ts` wrapped in `useServerAction()` (toasts errors, supports optimistic updates).
- Route params/searchParams are Promises (`await params`). Use `PageProps<"/route">` / `LayoutProps<"/route">` global types.
- Schema changes: add a new timestamped file in `supabase/migrations/`, update `database.types.ts` (or run `npm run db:types`), extend or add a `supabase/tests/NN_<area>_smoke.sql` suite (`10_core_smoke.sql`, `20_collaboration_smoke.sql`), run `npm run db:test`.
- Trigger functions that write on the user's behalf are `SECURITY DEFINER` with `set search_path = ''`, and their helpers are revoked from `public`, `anon`, and `authenticated`.
- Keep the UI restrained: zinc neutrals, one accent (`accent-*` in `globals.css`), no gradients, accessible labels on every control.

## Phases

- **Core spine** (done): auth + allowlist, projects/sections/tasks/subtasks, multi-homing, List/Board/pane.
- **Collaboration** (done): comments + @mentions, followers, activity stories, custom fields (incl. section-bound status), attachments, My Tasks, Inbox, search, Realtime.
- **Workflows** (next): approvals, forms (intake → task), rules/automation, request numbering (Req #). Build these on the generic model — e.g. a request type is a project + fields + form, not a schema of its own.

## Follow-ups (not yet built)

Approvals, forms, rules engine, Req # numbering, Asana importer (read-only export files, never the Asana API), @mention autocomplete, comment editing and reactions, workspace-level field library and field reordering, field filters/sorting in List, manual My Tasks sections, attachment previews/thumbnails and Storage cleanup of removed files, email/push notifications and digest, inbox archive, per-project membership/permissions (replace the "any allowlisted user" policies), restore/trash UI, reordering sections and list drag-and-drop, and Autumn Lake workflow migration (e.g. Creative Requests as a project template on the generic model). Never call the Asana API.
