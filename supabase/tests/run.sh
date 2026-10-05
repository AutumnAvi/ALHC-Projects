#!/usr/bin/env bash
# Applies every migration to a throwaway local Postgres (with a Supabase auth shim) and runs the
# RLS smoke test. Requires Postgres server binaries (initdb, pg_ctl) on PATH or in PG_BIN.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PG_BIN="${PG_BIN:-$(dirname "$(command -v initdb 2>/dev/null || ls -d /usr/lib/postgresql/*/bin/initdb | tail -1)")}"
DATA_DIR="$(mktemp -d)"
PORT="${PG_TEST_PORT:-54329}"

cleanup() {
  "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

"$PG_BIN/initdb" -D "$DATA_DIR" -U postgres --auth=trust >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -o "-p $PORT -k $DATA_DIR -c listen_addresses=''" -w start >/dev/null

PSQL=("$PG_BIN/psql" -h "$DATA_DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

"${PSQL[@]}" -f "$ROOT/supabase/tests/auth_shim.sql"
for migration in "$ROOT"/supabase/migrations/*.sql; do
  echo "applying $(basename "$migration")"
  "${PSQL[@]}" -f "$migration"
done
"${PSQL[@]}" -f "$ROOT/supabase/seed.sql"
for test in "$ROOT"/supabase/tests/*_smoke.sql; do
  echo "running $(basename "$test")"
  "${PSQL[@]}" -f "$test"
done
