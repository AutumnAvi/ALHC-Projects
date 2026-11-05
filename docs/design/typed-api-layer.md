# The typed data-access layer (big move 1)

**Status: built.** Every screen, Server Action, and route reaches the database through the layer. Since
big move 2 (`docs/design/monorepo.md`) the layer and the domain vocabulary it uses live in the shared core
package: `packages/core/src/api/`, imported as `@alhc/core/api/…`; the Next.js adapters stay in
`apps/web/src/lib/`. A desktop app (Tauri, online-only) calls the same functions. Paths below are as of
big move 1 (`src/lib/api/` = `packages/core/src/api/`, `src/lib/server/` = `apps/web/src/lib/server/`).

## 1. What was there before

Two files did almost all database work: `src/lib/data.ts` (213 reads, each wrapped in React's `cache()`
and making its own Supabase client from Next.js cookies) and `src/lib/actions.ts` (298 Server Actions, each
validating its input, writing through Supabase, and mapping errors to `{ error }`). About fifteen more files
(`shell-actions.ts`, `review-actions.ts`, `exports.ts`, the routes, a few upload components) called
Supabase directly. Every one of them was tied to Next.js: `cookies()`, `cache()`, `"use server"`,
`refresh()`. Nothing could run outside the Next.js server.

## 2. The boundaries

```
src/lib/api/                      the layer: no Next.js, no React, no "server-only", no process.env
  core/
    context.ts                    ApiContext { db, memo }, Db, read()
    errors.ts                     ApiError + ApiErrorCode, Postgres / PostgREST code mapping
    db.ts                         maybe / rows (reads), check / checkUpdated (writes), readInChunks
    result.ts                     ApiResult<T> + attempt(); ActionResult (the Server Action wire shape)
    validate.ts                   id, text, optionalText, dates, email, roles … → ApiError("invalid")
    soft-read.ts, constants.ts
  <area>/                         one folder per area of the product
    model.ts                      types + pure mappers (no database; safe in the browser)
    queries.ts                    reads:  (ctx, …inputs) => Promise<Output>
    mutations.ts                  writes: (ctx, …inputs) => Promise<Output>, validate their own input
  client/                         the few calls that run in the browser (uploads, the unread count, OAuth start)
  public/                         anon, token-checked calls (calendar links, unsubscribe, inbound webhooks)
  system/                         background work run with the service role (outbox drains, cleanups)

src/lib/server/                   the Next.js adapters (server-only)
  context.ts                      renderContext / actionContext / routeContext / anonContext / adminContext, bind()
  action.ts                       run / runWith / readAction: ApiError → { error, code }, refresh, after()
src/lib/data.ts                   bindings of the reads Server Components call (bind(area.read))
src/lib/screen-loaders.ts         bindings of the one-call-per-screen loaders (M1)
src/lib/actions/<area>.ts         "use server" files: thin wrappers around the area's mutations
```

### The context, not a client, is the unit

Every layer function takes an `ApiContext` first: `{ db, memo }`.

- **`db` is the caller's own client.** The layer never makes one, so it can't choose a stronger one. The
  Next.js adapters pick: the person's session from cookies for screens, actions, and routes (RLS decides,
  exactly as before); a cookie-less anon client for public token-checked pages (review links, calendar
  links, one-click unsubscribe, inbound webhooks); the service role only in background work that already
  used it (outbox drains, cron, the verified inbound email webhook). A desktop app makes its own client
  with the person's session and gets the same RLS. **The layer can't widen anyone's access.**
- **`memo` replaces React's `cache()`.** Reads are defined with `read(fn)`, which shares answers within one
  context with React's semantics (primitives by value, objects by identity, a rejection stays rejected).
  `renderContext()` is itself `cache()`d per server render, so the layout, the page, and every nested read
  share one client and one memo: the M1 loaders still run once per screen, and nested reads (the task
  pane's viewer, workspace, roles) are now shared with the page's own calls instead of repeated. Server
  Actions get a context **without** a memo (`actionContext()`), so a read after a write sees the write, as
  before (React's `cache()` never held inside an action). Route handlers get one memo for the request.

### Reads and writes

- `queries.ts` only reads. One exception, documented where it is: `listMyTaskLayout` calls
  `my_tasks_layout()`, which places newly assigned tasks before answering (it always did).
- `mutations.ts` writes. A write validates its own input (so every caller — a Server Action, a route, a
  desktop app — gets the same checks and the same messages), may call any area's reads, and throws
  `ApiError` on any refusal. Reads never import writes.
- `model.ts` holds the types the UI renders and the pure mappers from database rows. Client components
  import types and mappers from here, never from `queries.ts` / `mutations.ts`.

### Errors and results

One error type, `ApiError`, with a code callers can branch on:

| code | when | from |
| --- | --- | --- |
| `invalid` | the input was refused | the layer's checks, `23514` check_violation, `22023`, `22P02`, `23502`, `22001`, `P0001`, `23503` |
| `forbidden` | the caller's role doesn't allow it | `42501` (RLS refusals read as the role message), an update RLS turned into zero rows |
| `not_found` | nothing the caller can see by that id | `P0002` no_data_found, `PGRST116` |
| `conflict` | taken, or changed meanwhile | `23505`, `23P01`, `40001`, `40P01` |
| `unavailable` | a passing failure; try again | `57014` timeout, `PGRST003`, `08xxx`, `55P03` |
| `not_deployed` | the database lacks this release's object | `PGRST202`, `42883`, `PGRST204`, `42703`, `PGRST205`, `42P01` |
| `unauthenticated` | no session | `PGRST301`, `PGRST302`, `28000` |
| `failed` | anything else | |

The message is the one people always read: a write's database error is the database's message plus its
hint, an RLS refusal is the role message the action passes (`NOT_ALLOWED` by default); a read's is "Failed
to load <what>: …". The database detail stays on `error.detail` for logs.

A Server Action still answers `ActionResult = { error?: string }` (now also `code?: ApiErrorCode`), plus
its own fields; `run()` turns an `ApiError` into that and rethrows anything else (a bug), as before. One
deliberate difference: a read that fails *inside* an action (a statement timeout, say) is an `ApiError`
now, so the person gets its message as a toast instead of the error page. A desktop app can use
`attempt(() => call(ctx, …))` to get `ApiResult<T>` instead of exceptions.

### What stays in Next.js

`cookies()`, `redirect()`, `refresh()` / `revalidatePath()`, `after()` (delivering the outboxes after the
response), the request's origin, and environment switches (`isEmailConfigured()`, the reply domain) are the
adapters'. A layer function that needs one of those values takes it as an argument.

## 3. What moved where

| Before | After |
| --- | --- |
| `src/lib/data.ts` (213 reads) | `src/lib/api/<area>/queries.ts` + `model.ts`, moved mechanically (the client became `ctx.db`, `cache()` became `read()`); `data.ts` keeps one `bind()` per read a Server Component calls |
| `src/lib/screen-loaders.ts` (M1) | `src/lib/api/screens/queries.ts` + `model.ts`; `screen-loaders.ts` keeps the five bindings |
| `src/lib/auth.ts` (viewer, allowlist) | `src/lib/api/auth/queries.ts`; `auth.ts` keeps `requireMember()` (redirects) and the bindings |
| `src/lib/actions.ts` (298 actions) | `src/lib/api/<area>/mutations.ts` + `src/lib/actions/<area>.ts` |
| `shell-actions.ts`, `people-actions.ts`, `project-page-actions.ts` | `src/lib/api/{shell,people,project-page}/` + `src/lib/actions/{shell,people,project-page}.ts` |
| `review-actions.ts`, `review-public-actions.ts`, the review / file routes | `src/lib/api/{reviews,attachments}/` + `src/lib/actions/{reviews,review-public}.ts` |
| `slack-actions.ts` | `src/lib/api/slack/` + `src/lib/actions/slack.ts` (Slack's own HTTP API stays in the adapter) |
| login / sign-up / password / callback / sign-out | `src/lib/api/auth/mutations.ts`, `src/lib/api/client/auth.ts` |
| `exports.ts`, the task-pane / rule-feedback / link-search routes | `src/lib/api/{exports,task-pane,automations,shell}/` with `routeContext()` |
| calendar links, one-click unsubscribe, inbound webhooks (anon) | `src/lib/api/public/` with `anonContext()` |
| outbox drains, cron, inbound email, trash / form-upload cleanup (service role) | `src/lib/api/system/` with `adminContext()` |
| uploads and the unread badge in the browser | `src/lib/api/client/{storage,inbox}.ts` with the browser client |

Deleted: `src/lib/actions.ts`, `shell-actions.ts`, `people-actions.ts`, `project-page-actions.ts`,
`review-actions.ts`, `review-public-actions.ts`, `slack-actions.ts`, `soft-read.ts`, nine reads nothing
called (team message readers left from the removed team Messages tab, an old collaborators read, …), and
every binding only the old actions used.

## 4. What didn't change

- **M1 (one call per screen):** `app_shell`, `project_frame`, `project_view_page`, `my_tasks_screen`,
  `home_screen`, `task_pane_rows` are called exactly as before (`src/lib/api/screens/queries.ts`), shared
  by the layout and the page through the render's memo.
- **M2 (per-query permission checks):** nothing about RLS or the RPCs changed; every read and write runs
  as the caller, through the same calls.
- **M3 (Broadcast live updates):** `src/lib/live.ts` / `live-patch.ts` are untouched; they're a transport,
  not data access.
- **M4 (the client data cache):** `src/lib/query/` is unchanged and still Next-free; its types now come
  from the layer's model files instead of the server-only `data.ts`.

## 5. Guards

`tests/unit/api-layer.test.ts` (since big move 2: `packages/core/tests/api-layer.test.ts` and
`boundaries.test.ts`, plus `apps/web/tests/unit/api-layer.test.ts`) checks the boundaries on every run: nothing under `src/lib/api/` imports
Next.js, React, `server-only`, the Supabase client factories, or the adapters; client components import only
`model.ts` files from the layer; nothing outside the layer and the adapters calls `.from(` / `.rpc(` /
`.storage` / `.auth.` on a Supabase client; and the error mapping, `read()`'s memo, and the action wrapper
behave as described here.

## 6. The monorepo step (big move 2, done)

- `src/lib/api/` and the pure domain modules it imports (`views.ts`, `fields.ts`, `rules.ts`, …) moved
  into `packages/core` (`@alhc/core`); the Next.js app (`apps/web`) keeps `src/lib/server/`, `data.ts`,
  `screen-loaders.ts`, and `src/lib/actions/`. The guards in section 5 were split: the layer's own rules
  and the wall around the whole core package are in `packages/core/tests/`, the web app's side in
  `apps/web/tests/unit/api-layer.test.ts`. See `docs/design/monorepo.md`.

## 7. Left for the desktop step

- The desktop app supplies its own `Db` (supabase-js with the person's session) and calls the layer
  directly, or the JSON routes through `@alhc/core/query/transport`.
- The fallbacks for databases older than a release (`legacyAppShell` and friends, `PGRST202` branches)
  can go once the desktop app's minimum database version is fixed.
