# Performance seed

Local data for the numbers in `docs/PERF-AUDIT.md`. It builds the same shape as the stage 1 EXPLAIN runs: one project, 10,000 tasks, 50,000 comments with 5,005 on one task, 1,700 open tasks assigned to one person, and 2,000 unread inbox items for that person.

This is a throwaway Postgres only. Do not run it on the hosted project, and it is not part of `npm run db:test`.

## What it creates

| Id | What |
| --- | --- |
| `a1000000-0000-4000-8000-000000000001` | `perf-seed@example.com`, owner of the project, assignee of the 1,700 open tasks |
| `a1000000-0000-4000-8000-000000000002` | `perf-other@example.com`, allowlisted, not a member of the project |
| `b1000000-0000-4000-8000-000000000001` | Project "Perf seed" |
| `b2000000-0000-4000-8000-000000000001` | Section "To do" (every task sits here) |
| `c1000000-0000-4000-8000-000000000001` | Task 1, the one with 5,005 comments |

The 30 tasks just after those 1,700 are completed and still assigned, so the recently-completed query has a full page. Bulk inserts turn user triggers off (no story, follower, request number, or notification email per row) and turn them back on at the end.

## Run

Postgres server binaries on `PATH` (or `PG_BIN`). The auth shim is the one the smoke tests use.

```bash
PG_BIN="${PG_BIN:-$(dirname "$(command -v initdb)")}"
DATA=/tmp/alhc-perf-pg
PORT=5433
"$PG_BIN/initdb" -D "$DATA" -U postgres --auth=trust
"$PG_BIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $DATA -c listen_addresses=''" -w start
PSQL=("$PG_BIN/psql" -h "$DATA" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1)
"${PSQL[@]}" -f supabase/tests/auth_shim.sql
for f in supabase/migrations/*.sql; do "${PSQL[@]}" -f "$f"; done
"${PSQL[@]}" -f scripts/perf/seed.sql
```

Plans in `scripts/perf/plans/` were taken on this seed as `perf-seed@example.com` (`set role authenticated` and `request.jwt.claim.sub` set to that id), with `EXPLAIN (ANALYZE, BUFFERS)`. `bundle.txt` is the production client JS from `next build` on the same commit as the stage 1 plans.

## Task pane timings (Oct 19 notes)

`seed-pane.sql` adds 3 subtasks under tasks 2–21 and a pinned Priority field (run it after `seed.sql`). `pane-timing.mjs` opens, closes, and switches tasks in headless Chrome against a running app on that database and prints JSON (medians, p95, server renders per action). It needs `playwright-core` (not a dependency: point `PLAYWRIGHT_CORE` at a copy) and Chrome (`CHROME`, default `/usr/bin/google-chrome`):

```bash
PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/perf/pane-timing.mjs http://localhost:3000 after 2 > pane-after.json
```

The script signs in as `perf-seed@example.com` with the password `local-password`, so the app needs an Auth service in front of that database that accepts it (the seed creates no password).
