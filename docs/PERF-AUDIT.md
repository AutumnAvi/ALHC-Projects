# Performance audit

Local pass on `perf/alhc-audit-grok`. The migration is **not** applied to the hosted project. `20261014120000_perf_audit.sql` has **no TAIL**.

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

Local Postgres 17 again (`/tmp/alhc-perf-pg`, port 5433), rebuilt from `scripts/perf/seed.sql`: 10,000 tasks in one project, 50,000 comments with 5,005 on task 1, 1,700 open tasks assigned to `perf-seed@example.com`, 2,000 unread inbox rows for that person. Plans are `EXPLAIN (ANALYZE, BUFFERS)` as that member, warm cache, saved under `scripts/perf/plans/`. The migration is **not** applied to the hosted project. `20261015010000_perf_step2.sql` has an empty **TAIL**.

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

## Deferred

- `project_task_cards` still returns every task in the project. The browser paints 80; the database still builds the full jsonb.
- No `content-visibility` on long rows. Timeline is not windowed.
- Do not apply `20261014120000_perf_audit.sql` or `20261015010000_perf_step2.sql` to the hosted project from this branch. Use the usual migration-applier path after review.
