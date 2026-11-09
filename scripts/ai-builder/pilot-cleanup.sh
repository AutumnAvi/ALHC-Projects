#!/usr/bin/env bash
# AI builder pilot (experimental, feat/ai-builder): the one-command cleanup of the "Testing data" pilot.
# See docs/ai-builder-pilot.md.
#
#   npm run ai-pilot:cleanup -- --workspace <id> --marker <uuid>                                # dry run
#   npm run ai-pilot:cleanup -- --workspace <id> --marker <uuid> --execute --confirm "Testing data"
#
# Runs public.ai_pilot_cleanup() (the migration's hand-applied TAIL) as the database owner through psql:
# SUPABASE_DB_URL must be the project's database connection string (never printed). The function itself
# refuses anything but the registered pilot's id + marker + exact name, and a dry run changes nothing.
set -euo pipefail

workspace=""
marker=""
confirm=""
execute=false
while [ $# -gt 0 ]; do
  case "$1" in
    --workspace) workspace="${2:-}"; shift 2 ;;
    --marker) marker="${2:-}"; shift 2 ;;
    --confirm) confirm="${2:-}"; shift 2 ;;
    --execute) execute=true; shift ;;
    *) echo "ai-pilot cleanup: unknown argument $1" >&2; exit 2 ;;
  esac
done

uuid='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
[[ "$workspace" =~ $uuid ]] || { echo "ai-pilot cleanup: --workspace <uuid> is required" >&2; exit 2; }
[[ "$marker" =~ $uuid ]] || { echo "ai-pilot cleanup: --marker <uuid> is required" >&2; exit 2; }
if [ "$execute" = true ] && [ "$confirm" != "Testing data" ]; then
  echo 'ai-pilot cleanup: --execute needs --confirm "Testing data"' >&2
  exit 2
fi
[ -n "$confirm" ] || confirm="Testing data"
[ -n "${SUPABASE_DB_URL:-}" ] || { echo "ai-pilot cleanup: set SUPABASE_DB_URL (the database connection string)" >&2; exit 2; }
command -v psql >/dev/null || { echo "ai-pilot cleanup: psql is required" >&2; exit 2; }

# Values go in as psql variables (quoted by psql), never pasted into the SQL text.
printf '%s\n' "select jsonb_pretty(public.ai_pilot_cleanup(:'ws'::uuid, :'marker'::uuid, :'confirm', :'execute'::boolean));" |
  psql "$SUPABASE_DB_URL" -X -q -t -A -v ON_ERROR_STOP=1 -v ws="$workspace" -v marker="$marker" -v confirm="$confirm" -v execute="$execute"

if [ "$execute" != true ]; then
  echo 'Dry run: nothing was removed. Review the counts, then add --execute --confirm "Testing data".'
fi
