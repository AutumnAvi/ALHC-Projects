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
| `npm run db:test` | Applies `supabase/migrations/*` to a throwaway local Postgres and runs `supabase/tests/rls_smoke.sql` (needs Postgres server binaries) |
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
    (app)/                     Authenticated shell; layout calls requireMember()
      page.tsx                 Project home
      projects/[projectId]/list|board  Views; `?task=<id>` opens the task detail pane
  lib/
    env.ts                     Public Supabase env (optional at build, required at request time)
    supabase/{client,server,proxy}.ts  Browser / server / proxy clients
    supabase/database.types.ts Typed schema — keep in sync with migrations
    auth.ts                    getViewer(), requireMember(), safeNextPath()
    data.ts                    All reads (server-only). Every query filters deleted_at IS NULL
    actions.ts                 All writes (Server Actions). Return { error } and call refresh()
  components/                  UI; project/ (list, board), task/ (detail pane), shell/
supabase/
  migrations/                  Schema, triggers, RLS (source of truth for the data model)
  seed.sql                     Placeholder allowlist entry (local `supabase db reset` only)
  tests/                       Local Postgres harness + RLS smoke test
```

## Auth model

1. `/login` → Supabase `signInWithOAuth({ provider: "google" })` → Google → `/auth/callback`.
2. The callback exchanges the code, then calls `rpc("is_allowlisted")`. Not allowlisted ⇒ `signOut()` and redirect to `/denied` — a rejected user never keeps a session.
3. `(app)/layout.tsx` calls `requireMember()` on every render: no user ⇒ `/login`; user removed from the allowlist ⇒ `/auth/denied` (signs out).
4. RLS is the real boundary. `public.is_allowlisted()` (SECURITY DEFINER) is true only when `auth.uid()` maps to an `auth.users` row with a confirmed email present in `public.allowed_emails`.

Allowlist entries are managed in SQL (dashboard SQL editor or service role) — members cannot edit the allowlist through the API.

## Data model rules

- **Tables:** `allowed_emails`, `profiles`, `workspaces`, `projects`, `sections`, `tasks`, `task_projects`, `subtasks`.
- **Single workspace this phase:** migration seeds workspace `00000000-0000-4000-8000-000000000001` ("ALHC"); the app uses the oldest active workspace.
- **Profiles** mirror allowlisted auth users (name/avatar from Google) via triggers on `auth.users` and on `allowed_emails` inserts. Assignees reference `profiles.id`.
- **Multi-homing:** `task_projects (task_id, project_id)` is the membership join. Section and `sort_order` live on the membership, so one task can sit in different sections/positions per project.
- **Home project rule:** `tasks.home_project_id` is the project the task was created in (its primary project). A trigger guarantees an active membership in the home project; removing the home membership is rejected — make another membership the home first. `tasks.workspace_id` always follows the home project.
- **Ordering:** fractional `double precision sort_order` (step 1024, midpoint inserts). No reindexing yet.
- **Soft delete only:** every content table has `deleted_at`. There are **no DELETE policies**, so hard deletes through the API affect zero rows. Reads in `src/lib/data.ts` always filter `deleted_at IS NULL`; RLS intentionally does not, so restore can be added later. Soft-deleting a section moves its tasks to "No section" (trigger). Soft-deleting a task hides it from every project.
- **RLS policy pattern:** `<table>_select_allowlisted`, `<table>_insert_allowlisted`, `<table>_update_allowlisted` using `(select public.is_allowlisted())`; `profiles_update_own`; `allowed_emails_select_allowlisted` (read-only).

## Conventions

- Server Components fetch via `src/lib/data.ts`; Client Components mutate via `src/lib/actions.ts` wrapped in `useServerAction()` (toasts errors, supports optimistic updates).
- Route params/searchParams are Promises (`await params`). Use `PageProps<"/route">` / `LayoutProps<"/route">` global types.
- Schema changes: add a new timestamped file in `supabase/migrations/`, update `database.types.ts` (or run `npm run db:types`), extend `supabase/tests/rls_smoke.sql`, run `npm run db:test`.
- Keep the UI restrained: zinc neutrals, one accent (`accent-*` in `globals.css`), no gradients, accessible labels on every control.

## Follow-ups (not in this phase)

Per-project membership/permissions (replace the "any allowlisted user" policies), restore/trash UI, reordering sections and list drag-and-drop, My Tasks, search, comments, custom fields, rules/automation, forms, notifications, attachments, and Autumn Lake workflow migration (e.g. Creative Requests as a project template on the generic model). Never call the Asana API.
