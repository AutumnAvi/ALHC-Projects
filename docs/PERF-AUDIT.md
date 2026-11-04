# Performance audit

Local pass on `perf/alhc-audit-grok`. `20261014120000_perf_audit.sql` has **no TAIL**. Stage 1, stage 2, and stage 3 migrations are applied on the hosted project (`perf_audit_a`, `perf_step2_a`, `perf_step3_a`).

Seed for the EXPLAIN runs: one local Postgres 17 cluster (socket `/tmp/alhc-perf-pg`, port 5433 — **down now**), about 10,000 memberships in one project, about 50,000 comments, 5,005 of them on one task. Plans are `EXPLAIN (ANALYZE, BUFFERS)` as an authenticated member. Two captures:

- `/tmp/alhc-perf-explain-before.txt` (later script, includes a `LIMIT 80` comment plan)
- `/tmp/alhc-explain-before.txt` (earlier script, same joins)

The new RPCs were **not** re-planned on that seed. The cluster was already gone. Numbers below are the before plans, plus the same-file comment `LIMIT` as the shape the pane now uses.

## What was slow

A project List loaded every task, then more queries, and each row paid `has_task_role` / `has_project_role`. On that seed the follow-up queries alone were tens of seconds before a card could be drawn.

| Query | `/tmp/alhc-explain-before.txt` | `/tmp/alhc-perf-explain-before.txt` | Plan note |
| --- | ---: | ---: | --- |
| List memberships + tasks (10,000 rows) | 4,630 ms | 4,703 ms | Nested loop; bitmap heap on `task_projects` then `tasks` pkey, RLS per row |
| Subtask counts | 2,886 ms | 2,739 ms | `tasks_parent_idx`, then RLS per parent |
| Field values | 940 ms | 1,852 ms | Nested loop; `custom_fields_project_idx` |
| Comment counts (grouped) | 25,562 ms | 54,646 ms | HashAggregate over ~50,000 comment rows; bitmap heap of memberships inside |
| All comments on the heavy task (5,005) | 3,119 ms | 3,039 ms | Seq scan on `comments` plus a per-row RLS result |
| Same task, `LIMIT 80`, active only | — | **41 ms** | Backward index scan on `comments_task_idx`; stops at 80 |
| My open tasks (1,734) | 777 ms | 741 ms | `tasks_assignee_idx` is 0.15 ms; the rest is the heap + RLS |
| Inbox, newest 100 | 289 ms | 294 ms | Already limited; sort of the visible page |

List follow-ups in the first capture (memberships + subtasks + fields + comment counts) are about **34 s**. The second capture’s comment-count plan is colder (~55 s) and should not be averaged with the first.

Turbopack (`next build`, Next.js 16.3.8) does not print route-level First Load JS. Before any perf edit, client JS under the production build was about **2.78 MB**. This turn did not rebuild, so there is no after bundle number.

## Fixes in this branch

Migration `supabase/migrations/20261014120000_perf_audit.sql`, suite `supabase/tests/zz20_perf_audit_smoke.sql` (passed in `/tmp/alhc-perf-step1/db-test.log`: `perf audit smoke: all assertions passed`).

1. **`project_task_cards(project, only_ids?)`** — one `has_project_role(viewer)` check, then set-based SQL for the card (section, dates, subtask counts, readable project count, visible finish-to-start blockers, field values, tags, comment count, approval status). One jsonb value so PostgREST `max_rows` cannot cut the list. Non-members, including a workspace admin who is not a member, get `[]`. `listProjectTasks` calls it and falls back to the old row queries only when the function is missing.
2. **`project_section_task_counts(project)`** — section totals for the delete-section check, same access rule.
3. **`task_comment_page(task, before_at, before_id, max)`** — newest page (the pane asks for 100). A removed comment stays in the page with an empty body. Index `comments_task_timeline_idx` on `(task_id, created_at desc, id desc)` so the walk can stop. The before plan for “all 5,005 comments” was ~3.0–3.1 s; the before plan for “80 newest active comments” was **41 ms**.
4. **First paint** — List, Board, My Tasks, and Inbox draw 80 rows per group (`ROW_PAGE` in `src/components/show-more.tsx`), then “Show N more”.
5. **Code-splitting** — `next/dynamic` for the task pane, the Create / Settings dialogs, and the project Share dialog, so those graphs are not in the first project-page chunk.
6. **Realtime** — one `router.refresh` per page, coalesced at 400 ms; a refresh from our own write is not doubled; hidden tabs wait until visible; reconnect backs off from 800 ms to 15 s. List and Board drags stay optimistic (`use-project-tasks.ts`, `optimistic-session.ts`) until the server list absorbs them.

The three functions are `SECURITY DEFINER`, revoked from `anon`, granted to `authenticated`, and pinned in suite 60. Suite `zz20` checks that a member’s cards match the old row shape and that a non-member sees nothing.

## Checks (this turn)

Logs: `/tmp/alhc-perf-step5/`.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Fail, then pass. `sortOrderFor` had been dropped from `use-project-tasks.ts` in `c901859` while List and Board still import it. Restored. Second run exit 0. |
| `npm run lint` | Exit 0 |
| Unit tests, `node --test --test-concurrency=2` | 21 passed, 0 failed, ~3.4 s |

`npm run db:test` was not re-run this turn. The earlier local run in `/tmp/alhc-perf-step1/db-test.log` reached `zz20` and passed.

## Stage 2

Local Postgres 17 again (`/tmp/alhc-perf-pg`, port 5433), rebuilt from `scripts/perf/seed.sql`: 10,000 tasks in one project, 50,000 comments with 5,005 on task 1, 1,700 open tasks assigned to `perf-seed@example.com`, 2,000 unread inbox rows for that person. Plans are `EXPLAIN (ANALYZE, BUFFERS)` as that member, warm cache, saved under `scripts/perf/plans/`. `20261015010000_perf_step2.sql` has an empty **TAIL**. It is applied on the hosted project, with stage 1.

| Query | Stage 1 before | Stage 1 after | Stage 2 |
| --- | ---: | ---: | ---: |
| List memberships + the card follow-ups (10,000 tasks) | ~34 s (first capture) | `project_task_cards` **339 ms** | same RPC, not changed |
| Section task counts | (folded into the list reads) | `project_section_task_counts` **8 ms** | same RPC |
| All 5,005 comments on the heavy task | 3.0–3.1 s | — | — |
| Newest comment page (80 before, 100 now) | 41 ms (80 active) | `task_comment_page` **6.6 ms** | same RPC |
| My open tasks (1,700–1,734) | 741–777 ms | 424 ms on this seed, still per-row `has_project_role` | `my_task_cards` **24 ms** |
| My Tasks section layout (1,700 placements) | — | 926 ms once placements existed | `my_tasks_layout` **21 ms** |
| Inbox, newest 100 | 289–294 ms | 82 ms on this seed, role check per row | `inbox_page` **15 ms** |
| Inbox unread count (2,000) | — | **1,315 ms** | `inbox_unread_count` **70 ms** |

`my_task_cards` returns the same open and completed rows the page already drew (home project when the viewer can see it, otherwise another visible project, private tasks with no project, parent title on a subtask). A task assigned in a project the person cannot open is left out. `my_tasks_layout` and `sync_my_task_placements` are security definer for the same reason: the layout was a second pass over those rows. What they return is unchanged.

`inbox_page` keeps the old shape: 100 task rows, 100 project messages, 100 team messages, and 100 status updates, then the same drops (a removed comment, a reply whose thread is gone), then the newest 100. `inbox_unread_count` is the badge: unread, not archived, still readable, including a trashed task or a removed message the page itself hides. Both fall back to the old queries when the function is missing. The browser badge calls `inbox_unread_count` the same way.

Production `next build` (Next.js 16.3.8, Turbopack) still does not print route-level First Load JS. Total client JS under `.next/static` is **3.27 MB** (115 files, 3,425,774 bytes), against about **2.78 MB** before any perf edit. The project view's first load (`entryJSFiles` plus the root and polyfill chunks, each file once) is **1.31 MB** (22 files, 1,309,469 bytes). The task pane, Create / Settings dialogs, and Share dialog are separate dynamic chunks on that route (9 files, 0.15 MB) and are not in that first load. Detail is `scripts/perf/plans/bundle.txt`.

`npm run db:test` passed in UTC (the first local run failed the due-tomorrow rule because the machine was past midnight in UTC+3 and still on the previous UTC day). `npm run typecheck`, `npm run lint`, unit tests (21 passed), and `npm run build` passed.

## Stage 3

Same seed and role as stage 2. `20261015020000_perf_step3.sql` has an empty **TAIL**. It is applied on the hosted project, with stage 1 and stage 2. List and Board call `project_task_card_page` (80 cards per group, plus the group's total and the id of the next task). Show more, search, filter, and sort ask for that page again. Calendar and Timeline still call `project_task_cards`. A database without the new function keeps the full list.

| Query | Stage 3 before | Stage 3 after |
| --- | ---: | ---: |
| `project_task_cards`, all 10,000 cards | 202–277 ms warm (last run 277 ms) | unchanged; List and Board no longer call it for the first paint |
| `project_task_card_page`, first 80 incomplete cards, total 9,970 | — | **41 ms** warm (76 ms on the first call in a session) |

The 80 cards match `project_task_cards` for the same tasks. A non-member, including a workspace admin who is not a member, gets `{"groups":[]}`. Suite `zz22_perf_step3_smoke.sql`.

Off-screen List, Board, My tasks, and Inbox rows use `content-visibility: auto` (fallback size 2.25rem for a row, 5.5rem for a card). The nodes stay in the document, so keyboard navigation, drag-and-drop, and multi-select still reach them. The Timeline paints rows in the scrollport plus 12 rows of overscan. Arrows still use every row's position, and the bar being dragged stays mounted.

Client JS, production `next build` (Next.js 16.3.8, Turbopack), same method as stage 2:

| | Total under `.next/static` | Project view first load |
| --- | ---: | ---: |
| Before any perf edit | about 2.78 MB | — |
| Stage 2 | 3.27 MB (115 files, 3,425,774 bytes) | 1.31 MB (22 files, 1,309,469 bytes) |
| This branch before the chart change | 3.35 MB (116 files, 3,512,751 bytes) | 1.31 MB (22 files, 1,314,617 bytes) |
| After replacing the Recharts bar charts with plain markup | **3.01 MB** (115 files, 3,153,789 bytes) | **1.31 MB** (22 files, 1,314,609 bytes) |

Recharts was one 359 KB chunk. The screen-reader tables are unchanged, and a bar's title still names the count. Splitting the four project layouts into dynamic imports did not shrink the first load, so those imports stay direct. Detail is `scripts/perf/plans/bundle-step3.txt`.

`npm run db:test` passed in UTC, including `zz22`.

## Stage 4

Same seed and role as stage 2. Anchor for the windows below is 2026-10-15. `20261015030000_perf_step4.sql` has an empty **TAIL**. It is not applied to the hosted project. Stages 1–3 are (`perf_audit_a`, `perf_step2_a`, `perf_step3_a`).

Calendar and Timeline call `project_schedule_cards` for the visible dates, plus incomplete tasks with no due date (the tray). List and Board stay on `project_task_card_page`. A database without the new function still uses `project_task_cards`. Changing month, week, or timeline scale loads the next window. Drag, filters, and create are the same paths as before. An arrow is drawn only when both bars are inside the scale, which was already the rule.

| Query | Before | After |
| --- | ---: | ---: |
| `project_task_cards`, all 10,000 cards | **220 ms** warm (347 / 220 / 220 ms), 5,361,560 bytes | unchanged; Calendar and Timeline no longer call it |
| Calendar month, Sep 27–Oct 31, plus the undated tray | (the full list above) | **102 ms** warm (134 / 109 / 102 ms), 5,994 cards, 1,643,839 bytes |
| Calendar week, Oct 11–17, plus the undated tray | (the full list above) | **70 ms** warm (87 / 70 / 70 ms), 2,829 cards |
| Timeline week scale, Oct 4–Nov 14, plus the unscheduled tray | (the full list above) | **118 ms** warm (141 / 132 / 118 ms), 7,648 cards, 2,110,357 bytes |

On this seed most due dates already sit in those six timeline weeks, so the timeline window is still most of the open tasks. The saving is the tasks outside it, and not building comment counts. A member's window matches the tasks they would see there. A non-member, including a workspace admin who is not a member, gets `[]`. Suite `zz23_perf_step4_smoke.sql`.

Client JS, production `next build` (Next.js 16.3.8, Turbopack), same method as stage 3. Megabytes below are bytes ÷ 1024². Stage 3's "1.31 MB" label for the project view was 1,314,609 bytes, the same size as the 1.25 MB row here.

| | Total under `.next/static` | Project view first load |
| --- | ---: | ---: |
| Before any perf edit | about 2.78 MB | — |
| Stage 3 | 3.01 MB (115 files, 3,153,789 bytes) | 1.25 MB (22 files, 1,314,609 bytes) |
| This branch before the trim | 3.02 MB (115 files, 3,163,106 bytes) | 1.25 MB (22 files, 1,315,392 bytes) |
| After one shared copy of the date-shift dialog and add-task row | **2.81 MB** (115 files, 2,951,590 bytes) | **1.25 MB** (21 files, 1,315,293 bytes) |

The project view already had one copy of that code, so its first load stays put. The total drops by the extra copies that other routes were carrying. Recharts was already absent from the client build; the unused package is removed. Splitting Calendar and Timeline into dynamic imports still does not shrink the first load, so those imports stay direct. Detail is `scripts/perf/plans/bundle-step4.txt`.

`TZ=UTC npm run db:test` passed, including `zz23`. `npm run typecheck`, `npm run lint`, unit tests (21 passed), and `npm run build` passed.

## Oct 19 notes: opening a task

Avi's note: opening a task must feel instant. Target: the pane shows the task in under 100 ms from what the row already has; comments, activity, subtasks, and attachments follow; closing and switching tasks are instant too.

**Setup.** A local stack on `scripts/perf/seed.sql` plus `scripts/perf/seed-pane.sql` (3 subtasks under tasks 2–21, a Priority field on tasks 1–200): Postgres 17, PostgREST, a small auth stand-in, and `next build` + `next start` of each commit side by side. Timings come from `scripts/perf/pane-timing.mjs` in headless Chrome (1440 × 900), measured inside the page from the click event to the first animation frame where the condition holds. The pointer rests on the row for 150 ms before the click, as a person's does. "Server renders" counts RSC requests (a server render of the whole page) per action. Before = `c815303`, after = this branch. Two rounds each.

| Action (median / p95, ms) | Before | After |
| --- | ---: | ---: |
| Open: the pane appears | 137 / 165 (a skeleton) | **49 / 147** (the task) |
| Open: the task's name shows | 4,215 / 4,736 | **49 / 147** |
| Open: full detail (editable, comments, activity, subtasks) | 4,215 / 4,736 | **49 / 147** |
| Close | 138.5 / 160 | **47.5 / 98** |
| Switch to another task (full detail) | 4,236.5 / 4,382 | **36 / 71** |
| Open a subtask from the pane (full detail) | 4,180 / 4,375 | **36 / 41** |
| Server renders per open / close / switch / subtask | 1 / 1 / 1 / 1 | **0 / 0 / 0 / 0** |

n = 16 opens, 16 closes, 10 switches, 10 subtasks on each side, no timeouts. With 16 samples the p95 is the slowest one: 14 of the 16 opens took 42–88 ms, the other two 114 and 147 ms. Without the hover (a cold fetch), the pane's data route answers in **42 ms** median over 11 tasks (25–30 ms of it on the server, `Server-Timing: pane`); the first open of a visit also loads the pickers' people, projects, and tags (153 ms) while the row's own data is already drawn.

**Why it was slow.**

1. Opening, closing, and switching were `router.push` / `router.replace` of `?task=`: a server render of the whole page (the 10,000-card List included) before the pane could change.
2. `getTaskDetail` made about 14 round trips one after another.
3. Two parts of it took 3–5 s each on this project, for every task: the critical path (`project_critical_path`, only for the slack line under Dependencies) and the dependency picker's candidate tasks (only used once someone opens Add dependencies or Convert).

**What changed.**

- Opening a task pins it in a client store and moves the URL with `history.pushState` (Next 16 keeps its router in step; Back / Forward work, and a later refresh renders with the new `?task=`). Rows and cards are `TaskLink`s: a plain click opens in place, ⌘ / Ctrl / middle click still opens a new tab. Closing is `pushState` without `?task=`.
- The pane draws at once from what the row knows (`TaskSeed`: name, number, done, kind, assignee, dates, project, section, tags, pinned field values, counts) and swaps to the full detail when it arrives; hover (75 ms) and focus prefetch it, three at a time.
- The detail comes from `GET /api/task-pane/<id>` (the person's own client and RLS, `private, no-store`), not a server action, because server actions run one at a time per tab. A small client cache (50 tasks, newest copy wins) makes reopening and Back instant; it is revalidated after 10 s and dropped after every write.
- `getTaskDetail` runs its independent reads in two waves (about 3 round trips), and the critical path and the dependency candidates moved to `?part=schedule` / `?part=candidates`, loaded only when the slack line can show and when the picker or Convert opens.
- A cold `?task=` link still renders the pane on the server (the same loader, streamed to the client host).

Browser checks on the same stack (`/tmp` script, not committed): row click, open link, switch, Back / Forward, rename from the pane reaching the List row, a comment, the dependency picker loading on open, Customize closing the pane (and a task closing Customize), the close button, Escape, a subtask and its breadcrumb, a cold link, Ctrl-click to a new tab, My tasks, and an Inbox card — 26 of 26 passed with no page errors.

## Nov 3 notes (batch 18, note 135): moving between pages

Avi's note: moving between projects and pages is slow, worse with lots of data. Local Postgres 17 with every migration, `scripts/perf/seed.sql` + `seed-pane.sql`, plus 150 more projects the seed person is a member of (40 tasks each; 16,060 tasks in all), 25 automations on the perf project, 200,000 automation runs, and a portfolio over 61 projects. Each query was run as `perf-seed@example.com` (`set role authenticated`, RLS on), the median of 3–5 warm runs, forcing the whole result to be read. DB time only; the app adds one PostgREST round trip per wave.

**Root cause.** Every row of `tasks`, `task_projects`, and `rule_runs` was checked with `has_project_role` / `rule_has_role` (four nested SECURITY DEFINER functions, ~0.17 ms a call), so anything reading thousands of rows waited seconds; `task_project_labels` (every list outside a project) also walked every membership of every readable project. In the app, My tasks' access reads went one 200-id chunk after another (~18 round trips in a row for 1,700 tasks), and opening a project was two server renders (a redirect to its view).

| Query (page) | Before | After |
| --- | ---: | ---: |
| Automations: newest 50 runs | > 60,000 ms (timed out) | **85 ms** |
| Automations: `rule_run_stats` (25 automations) | 8,460 ms | **68 ms** |
| My tasks / Home / search: `task_project_labels`, 100 tasks | 5,523 ms | — |
| My tasks: `task_project_labels`, a 2,000-task chunk | > 18,000 ms (5 runs > 90 s) | **82 ms** |
| My tasks: access reads, per 200-id chunk (tasks / memberships) | 32 / 33 ms, 18 in a row | **0.9 / 0.7 ms**, in parallel |
| Portfolios: `list_portfolio_progress` | 4,268 ms | **57 ms** |
| Portfolio report by project | 6,537 ms | **100 ms** |
| Reports: `workspace_report` (total / by project) | 5,988 / 5,485 ms | **119 / 119 ms** |
| Reports: `all_projects_report` | 5,443 ms | **175 ms** |
| Home: `home_dashboard` | 424 ms | **245 ms** |
| Project List first page (`project_task_card_page`) | 43 ms | 42 ms (already paged) |
| Opening a project (`/projects/<id>`) | 2 server renders (redirect) | **1** |

**What changed.** `viewer_project_ids()` / `viewer_rule_ids()` (the caller's readable projects / automations, once per statement) in the three hot read policies — same rows, pinned by `zz48`; `task_project_labels` reads memberships by task and checks each project once; `readInChunks` runs chunked reads in parallel; `/projects/<id>` renders its view and fixes the URL on the client (`CanonicalUrl`). Not changed: `open_blocker_counts` (1.2 s for 3,650 tasks; it counts blockers the caller can't open, so a cheaper prefilter needs its own definer) and the client bundle.

## Nov 4 notes (batch 22, M1): screen loaders — one database call per screen

The infra review: opening a project started ~30 separate Supabase calls (the app frame, the project frame, then the page), several waiting on each other. Each screen now reads through one invoker RPC (or a very few), `20261104030000_nov4_batch22_a.sql`; shapes in `src/lib/screen-shapes.ts`, loaders in `src/lib/screen-loaders.ts`.

**How it was measured.** Local Postgres 17 with every migration plus `scripts/perf/seed.sql` + `seed-pane.sql` (1 project, 10,000 tasks, 1,700 open tasks assigned to the seed person), PostgREST 12.2.3 behind `scripts/perf/local-api.mjs` (JWKS for `getClaims()`, ES256 session cookie for `perf-seed@example.com`), `next dev` with `ALHC_DB_TRACE` set (`src/lib/supabase/db-trace.ts` logs every Supabase request the server makes: start, end, method, path). `scripts/perf/screen-calls.mjs` fetches each screen once to warm up, then 5 times, and reports medians: **calls** = Supabase requests in that render, **steps** = the longest chain of calls each starting after the previous one ended (round trips in a row), **DB wall** = first call's start → last call's end, **DB sum** = the calls' durations added up (the load on PostgREST / Postgres), **response** = the whole page. Before = `main` at 95ce4a0; after = this branch.

| Screen | Calls | Steps | DB wall (ms) | DB sum (ms) | Response (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| App shell (`/help/roles`: the frame + 2 reads of the page) | 14 → **4** | 3 → **2** | 212 → **45** | 974 → **94** | 296 → **202** |
| Project List view | 38 → **4** | 6 → **2** | 331 → **108** | 2,644 → **147** | 586 → **279** |
| Project Board view | 35 → **4** | 5 → **2** | 297 → **104** | 2,184 → **146** | 507 → **243** |
| Project frame (`/overview`: frame + its own 8 reads) | 34 → **10** | 3 → **2** | 196 → **100** | 2,027 → **375** | 327 → **171** |
| My tasks (checklist) | 64 → **5** | 9 → **3** | 1,172 → **1,040** | 5,348 → **1,130** | 1,802 → **1,608** |
| Home | 60 → **3** | 8 → **2** | 1,157 → **1,070** | 5,570 → **1,095** | 1,549 → **1,531** |
| Task pane (`GET /api/task-pane/<id>`) | 35 → **8** | 5 → **4** | 157 → **84** | 1,040 → **150** | 175 → **105** |

My tasks and Home stay near a second on this seed because one read inside them, `open_blocker_counts` over 1,700 open tasks, takes ~850 ms by itself (it was 1.2 s in batch 18 and is unchanged here: making it cheaper is a permission-check rewrite, M2). Everything else on those screens now costs ~150 ms of database time instead of ~4.5 s.

**Same data.** Each loader returns the rows the separate reads returned (same columns, same order) and the app maps them with the same code. Checked on two databases: the perf seed, and one with every smoke suite's data — 14 people × (shell, the frames of up to 6 of their projects plus one they're not in, List pages grouped three ways, My tasks, Home, the My Tasks automation context) = 444 comparisons of loader vs. old reads, all equal; and 720 task pane payloads (6 people × 120 tasks) with the loader vs. without, equal except 3 where followers share one `created_at` (their order is arbitrary either way). `zz52_nov4_batch22_smoke.sql` pins the loaders against the functions and tables they read, and that a non-member gets nothing.

**Left as separate calls.** `my_tasks_layout()` and the sections read after it (it writes — seeds sections, places new tasks — and a STABLE loader can't call it); the List's subtask trees (they depend on which rows are open); in the pane, `listTeams` (mention teams), `listMyProjectRoles`, and the third wave that depends on the comments (names of linked tasks / projects, automation projects, subtask labels); each project tab's own reads (Overview's status updates, stories, roles, goals). The `/api/task-pane` route asks `viewer_member` twice because React's per-request cache doesn't apply in route handlers (it asked `is_allowlisted` twice before too).

## Deferred

Deferred: none.
