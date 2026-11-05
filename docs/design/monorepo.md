# The monorepo and the shared core package (big move 2)

**Status: built.** The repository is an npm workspace with two packages: the Next.js app in `apps/web`
and a framework-free core package, `@alhc/core`, in `packages/core`. The core holds the typed API layer
(big move 1, `docs/design/typed-api-layer.md`), the product's domain vocabulary and rules, and the parts
of the client data cache that aren't React. A desktop app (Tauri, online-only) will be a third package
that imports `@alhc/core` and supplies its own Supabase client.

## 1. Layout

```
package.json            the workspace root: "workspaces", the root scripts, the supabase CLI
package-lock.json       the one lockfile (npm installs every package into the root's node_modules)
vercel.json             Vercel: framework, build command, output directory (apps/web/.next), the cron
supabase/               migrations and the SQL smoke suites (unchanged; npm run db:test)
docs/, scripts/perf/    unchanged
apps/web/               @alhc/web — the Next.js app (everything that was at the root before)
  src/                    app/, components/, proxy.ts, lib/ (the Next.js side, see below)
  tests/unit/             the app's unit and component tests (Node's runner)
  next.config.ts, tsconfig.json, eslint.config.mjs, postcss.config.mjs, .env.local.example
  AGENTS.md, CLAUDE.md    only Next.js's own agent-rules block, so `next dev` doesn't write them
packages/core/          @alhc/core — framework-free TypeScript source (no build step)
  src/api/                the typed data-access layer (big move 1)
  src/query/              the client data cache: keys, stores, transport (M4), without React
  src/supabase/           database.types.ts (npm run db:types writes here), retry-fetch.ts
  src/*.ts                the domain modules: views, fields, rules, roles, permissions, recurrence, …
  tests/                  the core's own tests, including its boundaries
  tsconfig.json, eslint.config.mjs
```

## 2. Why npm workspaces

- **It is the smaller, safer change.** The repo already used npm (`package-lock.json`), CI runs `npm ci`,
  and Vercel detects npm from the lockfile. Workspaces are built into npm: no new tool, no new lockfile
  format, nothing for Vercel or CI to learn. `npm ci` / `npm run <script>` still work from the root.
- **pnpm** would mean a new lockfile, a different install on Vercel and in CI, and a strict
  `node_modules` layout that changes how Next.js traces native and external packages
  (`@napi-rs/canvas`, `pdfjs-dist` in `serverExternalPackages`) — risk for no gain at two packages.
- **Turborepo / Nx** add task caching and graphs that two packages don't need; the root scripts run each
  workspace's script in order (`npm run lint --workspaces`).

## 3. What goes in core and what stays in the web app

**The rule.** A module goes into `packages/core` when it is free of Next.js, React, the DOM, Node
built-ins, `server-only`, and `process.env` — transitively — **and** it is either

1. needed by the API layer (everything the layer imports must live beside it), or
2. domain logic a second client must share to behave the same: vocabulary that mirrors the database
   (roles, task kinds, views, fields, rules, numbering, workdays, trash retention, …), validation,
   parsers and serializers (quick add, CSV, iCal), planners and reducers (the dependency plan, the
   checklist's groups, approval and live-update reducers), and the wording derived from domain data
   (activity lines, rule names, help tables), or
3. the client data cache's framework-free half (`query/`: keys, stamped entries, the task pane's and
   task edits' stores, the transport the desktop app points at the JSON routes).

**Stays in `apps/web`:** everything tied to Next.js or the server (`src/lib/server/` — the only place
that makes server Supabase clients —, `data.ts` and `screen-loaders.ts` bindings, `actions/`, `auth.ts`, the
email / Slack / webhook outbox renderers and drains, `safe-fetch.ts`, review thumbnails, `env.ts`,
`origin.ts`, `timezone.ts`, the Supabase client factories, the Asana importer — server-only on purpose),
everything React (`live.ts`, `dates.ts`, `pending-creates.ts`, `query/use-cache-entry.ts`, components),
and the web UI's own mechanics even when pure: the stacking order (`layers.ts`), focus trap, picker
keyboard models (`smart-picker.ts`, `vocab-picker.ts`), the right-panel slot, route freshness (Next's
router cache), the sidebar cookie, project colors (Tailwind classes), the error page's retry, the
browser-only stores (`completion-store`, `optimistic-session`, `rule-feedback-bus`, `rule-running`,
`pending-comments`, `task-pane-cache`), link chips in a textarea, pane seeds (`task-seed.ts`).

Two modules were split so the rule holds: `live-patch.ts` now owns the `TaskChange` type it produces
(it used to import it from a component), and `my-tasks.ts`'s cookie writer (`document.cookie`) moved
to `apps/web/src/lib/my-tasks-cookie.ts`. The web app's `src/lib/soft-read.ts` was the same function as the
layer's `api/core/soft-read.ts` (plus `server-only`); it is gone and the three pages import the core's.

## 4. How code imports it

- **From the web app:** `@alhc/core/<path inside src without .ts>` — `@alhc/core/views`,
  `@alhc/core/api/projects/queries`, `@alhc/core/query/keys`. There is no barrel file: client
  components keep importing only `model.ts` files of the layer (tested), and bundles take only what
  they use. `packages/core/package.json` maps `"./*"` to `"./src/*.ts"`; npm links the package into
  `node_modules/@alhc/core`.
- **Inside core:** relative paths only (`./views`, `../core/context`), never `@/…` or its own name, so any
  bundler (Next's Turbopack, Vite in a Tauri app) or Node's test runner follows them unchanged.
- **The web app's own code** keeps `@/…` (= `apps/web/src`).
- The core package ships TypeScript source; consumers compile it (Next.js:
  `transpilePackages: ["@alhc/core"]`). No build step, no `dist/` to keep in step.

## 5. The walls (checked on every run)

| Check | What it enforces |
| --- | --- |
| `packages/core/tsconfig.json` | `lib: ["ESNext", "WebWorker"]`, `types: []`: the web platform (fetch, URL, Web Crypto, streams, timers) without the DOM and without Node's globals. `window`, `document`, `HTMLElement`, `localStorage`, `process`, `Buffer` don't type-check (unless a stray `node:` import drags Node's types in, which the other two walls refuse). |
| `packages/core/eslint.config.mjs` | `no-restricted-imports` (Next.js, React, `@tanstack/react-query`, Node built-ins and `node:*`, `server-only`, `@supabase/ssr`, `@/…`, the web app, its own name), `no-restricted-globals` and `no-restricted-properties` on `globalThis` (browser, worker-only, and Node globals, `process.env` included). |
| `packages/core/tests/boundaries.test.ts` | only `.ts` modules, no `"use client"` / `"use server"`; imports stay inside `src/` or name a declared dependency; the dependencies are framework-free; globals by the type checker — a web-platform global must be one Node 20+, browsers, and webviews all have (an allowlist: fetch, URL, Request / Response, File / Blob, streams, TextEncoder, Web Crypto, timers, console, …), Node's are refused, `globalThis.X` counts as `X`; only `src/api/` talks to Supabase. |
| `packages/core/tests/api-layer.test.ts` | the layer's behavior (error mapping, `read()`'s memo, permission paths, typing) and its own rules: reads never import writes, the caller's context first, the layer never picks a client. |
| `apps/web/tests/unit/api-layer.test.ts` | the web side: no layer code in the app, client components take only browser-safe parts of the layer, no Supabase call outside the layer (but the proxy's session refresh and Realtime's token), only `src/lib/server/context.ts` makes server clients, the service role / anon key users pinned. |

A mutation check during the move planted `import "next/headers"`, `import "node:fs"`, `window`,
`process.env`, `self`, and later `globalThis.process` / `importScripts` in a core file: ESLint and the
boundary tests refused every one, and `tsc` refused `window` (a stray `node:` import brings Node's types
along, which is why the import rules and the type-checked globals test don't rely on `tsc` alone).

## 6. Building and deploying

- **Next.js** (`apps/web/next.config.ts`): `outputFileTracingRoot` and `turbopack.root` are the repo root,
  so functions trace files from the root's `node_modules` and from `packages/core` (Vercel sets the same
  root itself). pdf.js's tracing include / exclude (QW3) point at wherever npm installed it
  (`require.resolve`), now the root's `node_modules`.
- **Tailwind** scans only the app's folder by itself; `globals.css` adds `@source` for
  `packages/core/src` (field option colors, run outcomes, email schedule badges are class strings there).
- **Vercel, no dashboard change:** the project's Root Directory stays the repository root. The root
  `vercel.json` pins `"framework": "nextjs"`, `"buildCommand": "npm run build"` (the root script builds
  `@alhc/web`), and `"outputDirectory": "apps/web/.next"` (where Vercel's Next.js builder reads the build),
  next to the daily cron. Install is Vercel's default `npm install` at the root, which installs both
  workspaces.
- **Checked locally with `vercel build`** against the pre-move tree: the same 221 functions with the same
  handlers, runtimes, and shipped `node_modules` files (seven no longer carry the stray
  `.env.local.example`, which nothing loads), the same 463 routes (only Server Action IDs and their
  labels, which include the file path, and the per-build IDs differ), the same static files, the cron.
  `next build`'s 108 traced functions ship exactly the same files as before, and the compiled CSS has
  every class the app and core use (four junk classes Tailwind used to pick up from docs and SQL
  suites when it scanned the whole repository are gone).
- **The conventional alternative** (also checked): Root Directory = `apps/web` in the Vercel dashboard,
  with `vercel.json` moved to `apps/web/vercel.json` holding only the cron (no framework / build command /
  output directory). Vercel installs from the workspace root either way. Not needed now.

## 7. Running things

From the root: `npm ci`, `npm run dev` (the app), `npm run lint` / `typecheck` / `test` (both
packages), `npm run build` (the app), `npm run db:test`, `npm run db:types`. Per package:
`npm run test --workspace @alhc/core` (the core's tests import nothing from Next.js or React). Local env files live next to the app: `apps/web/.env.local` (from
`apps/web/.env.local.example`), since Next.js reads them from its own folder.

## 8. Left for the desktop step

**Done in big move 3, differently** ([desktop.md](desktop.md)): `apps/desktop` wraps the hosted web app in a Tauri
window instead of rebuilding its UI on the core (every page is a Server Component and every write a Server
Action, so the core alone isn't a UI). It shares `@alhc/core/desktop-links` with the core. The notes below
stay as the route to a local UI, should one ever be needed (offline, say).

- `apps/desktop` (Tauri, online-only): makes its own supabase-js client with the person's session (same
  RLS), wraps it in `createApiContext(db)`, and calls `@alhc/core/api/…` directly — or reaches the
  existing JSON routes through `@alhc/core/query/transport` (`configureTransport({ baseUrl, headers })`).
- Sign-in for a desktop app (PKCE / deep link) and where it keeps the session: the layer's auth calls
  take a client; the redirects and storage are the app's.
- A UI kit: components are still in `apps/web`. If the desktop app is React too, the shareable pure UI
  mechanics (picker keyboard models, focus trap, layers) and then components can move into a
  `packages/ui`, behind the same kind of wall (React allowed, Next.js not).
- The fallbacks for databases older than a release (`legacyAppShell` and the `PGRST202` branches) can go
  once the desktop app's minimum database version is fixed.
- If the core ever needs to be consumed outside this repository, add a build (`tsc` to `dist/` with
  declaration files) and point `exports` at it; inside the workspace, source is simpler.
