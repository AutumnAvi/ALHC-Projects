# AI builder phase 1 — the Testing data pilot (experimental, do not merge)

Branch `feat/ai-builder`, draft PR “feat: AI builder phase 1 (do not merge)”. A project-first AI builder
for **workspace admins of one isolated workspace named `Testing data`** in the shared Supabase project
(`xsgmawawwstbrbukgsax`). Dashboards, rules / fields workflow building, and a production rollout are later
phases and not built.

## What it does

New project → **Build with AI** (shown only to a workspace admin of the registered pilot workspace) →
write a brief (≤ 2,000 characters), optionally pick a template **of the Testing data workspace** → the
server asks Anthropic (`claude-sonnet-5-5`, structured JSON output) for a proposal → an editable preview of
exactly what would be added (project name and description, sections, fields with options, starter tasks
with notes, due dates, values, and subtasks) → **Create project** applies it in one database transaction →
**Undo** moves the project to the Trash while nothing in it has changed. History: `/ai-builder`.

Nothing is created before Create; Cancel leaves nothing behind. The model never chooses an operation: it
returns data in a closed schema, which is validated by `parseProposal()` (`packages/core/src/ai-builder.ts`)
on generation and before Apply, and again by `ai_builder_proposal_problem()` inside `ai_builder_apply`.

## Guardrails

- **The pilot is a database fact, not a name.** A workspace is the pilot only while
  `ai_pilot_workspaces` has a row for it (with its marker) and `cleaned_at` is null, it is live, it isn't the
  main (oldest) workspace, and the caller is its workspace admin (`ai_pilot_admin()`). The browser never
  sends a workspace id: the server reads it from the registry. Every AI path checks this: generation (the
  route and the `ai_builder_runs` insert guard), proposal edits, apply, undo, history (RLS).
- **The signed-in person's own client, always.** No service role in the app. Apply is
  `ai_builder_apply` (SECURITY INVOKER): RLS and every existing trigger apply as for the person's own
  edits. New projects are private, in the pilot's team, with no automations, members, forms, or
  integrations, and nothing is assigned, so nothing notifies, emails, or posts anywhere
  (`deliver: false` on the actions too).
- **All or nothing, idempotent.** One transaction; a failure leaves no rows. A second Apply of the same
  run returns the first answer. Proposal edits are versions; applying a stale version is refused.
- **Undo** compares a fingerprint per category (project details, sections, fields, tasks and subtasks,
  memberships, values, comments, attachments, tags, followers, dependencies, members, views, forms,
  automations, messages, templates, portfolios, goals, shared library fields). Any change: nothing is
  removed and the conflict is shown and logged. Otherwise the project is soft-deleted (Delete project's
  own path: owners only; the Trash purge removes it for good after 90 days once its tail is applied).
- **Limits (database-enforced, so every server instance shares them):** 10 runs an hour and 30 a day per
  person, 60 a day for the pilot workspace, at most 2 generating at once per person. Per call:
  8,000 output tokens (thinking included; ≈ $0.08 at $10 / MTok), effort `low`, 55 s timeout, 1 retry, the
  route's own 120 s limit. A brief is ≤ 2,000 characters; a proposal ≤ 20 sections, 10 fields (20 options
  each), 50 tasks, 5 subtasks each.
- **What goes to the model:** the brief and, when chosen, the template's outline (section names, field
  names / types / option names, the first 30 task titles). Never notes, comments, attachments, people,
  rules, forms, or any other workspace's data. The brief text is not stored (only its length).
- **What is logged** (`ai_builder_runs`, readable by the pilot's admins only): actor, workspace, status,
  model, input / output tokens, the validated proposal and its version, error codes, created ids, the
  fingerprint, undo conflicts. Never the key, headers, the prompt, or the provider's raw answer.
- **Configuration:** the server reads only `ANTHROPIC_API_KEY` (never a `NEXT_PUBLIC_` variable). Without
  it the panel says the builder isn't configured and nothing is called. Server-side `fallbacks` (refusal
  rerouting) is deliberately **off**: a refusal is a failed run, so spend stays predictable.

## Migration (written, NOT applied)

`supabase/migrations/20261108122112_ai_builder_pilot_a.sql` (made with `supabase migration new`).
Additive above its **TAIL**; the tail is `ai_pilot_cleanup()` (it removes rows, so it's applied by hand).
Tests: `supabase/tests/zz56_ai_builder_pilot_smoke.sql` (runs in CI's throwaway Postgres). Suite 60 pins
the one new client definer, `ai_pilot_ensure_workspace`.

Operator steps, **only after Avi authorizes the pilot**:

1. Apply everything above the `-- TAIL` marker (the `migration-applier` subagent, in chunks, as for any
   phase), then the tail by hand as the database owner.
2. Confirm with `list_migrations`. Until then the app hides the builder (`not_deployed`).
3. Set `ANTHROPIC_API_KEY` for the branch's **Preview** environment only (Vercel project `alhc-projects`).

## Seed (written, NOT run)

The practice data is the local Asana export (never committed). One command, dry run by default:

```bash
export NEXT_PUBLIC_SUPABASE_URL=…            # public
export NEXT_PUBLIC_SUPABASE_ANON_KEY=…       # the public anon key (a service-role / secret key is refused)
export ALHC_PILOT_EMAIL=<the selected account's email>
export ALHC_PILOT_PASSWORD=…                 # read from the environment, never printed
npm run ai-pilot:seed -- \
  --source /workspace/alhc-projects/ai-builder-seed/ai-builder-seed-export.json \
  --manifest /workspace/alhc-projects/ai-builder-seed/manifest.json \
  --account <the selected account's email> \
  --map <source person's Asana gid or email>=account \
  --report /tmp/ai-pilot-seed-report.json
# review the report, then the same command with --execute
```

Without credentials (or with `--offline`) it only checks the export against the manifest. With
`--execute`, as the signed-in account (a workspace admin of the main workspace):

- `ai_pilot_ensure_workspace(marker)` creates `Testing data` once (refusing an unregistered workspace of
  that name, or a second pilot), registers it with its marker, makes the account its workspace admin, and
  keeps only the account on its team. A new marker is printed on first run (and is in the registry).
- Each project gets a deterministic id (UUID v5 of the marker and its Asana gid), named
  “<name> (Testing data)”, private; the existing importer (`start_import_run` / `import_batch` /
  `finish_import_run`) brings sections, fields and options, tasks, subtasks, field values, followers,
  top-level comments, and multi-homing — muted (no rules, no Inbox items). Every external id is namespaced
  `pilot:<marker>:<gid>`, so it can never match a real project imported from the same Asana project.
- Supplements the importer can't carry (subtask comments, subtask values, a multi-homed task's other
  project's values) go through `ai_pilot_seed_comment` / `ai_pilot_seed_field_value`: once per source key,
  never overwriting.
- It refuses to write into a practice project that has any other member or any automation, and verifies
  the counts afterwards. Reruns skip what exists; an interrupted run resumes; later edits are never
  overwritten; a project removed in the app isn't recreated.
- People: nobody is invited or created. `--map <gid or email>=account` maps a source person to the
  selected account; everyone else is a name-only placeholder (unassigned with “Assignee in Asana: <name>”,
  comments posted by the account with “<name> wrote in Asana:”).

Not carried (the report lists them): option colors, 16 disabled options become ordinary options, task
creation times, People-field values of placeholders, and everything not in the export (rules, forms,
attachments, views, portfolios, project colors, members). Rules and forms are never fabricated.

## Cleanup (written, NOT run)

One command, dry run by default (needs the tail applied and the database connection string):

```bash
export SUPABASE_DB_URL=…     # never printed
npm run ai-pilot:cleanup -- --workspace <pilot workspace id> --marker <marker>
npm run ai-pilot:cleanup -- --workspace <pilot workspace id> --marker <marker> --execute --confirm "Testing data"
```

`ai_pilot_cleanup()` refuses unless the id is registered, the marker matches, the workspace is live and
named exactly `Testing data` (and confirmed), and it isn't the main workspace. It removes the workspace and
every row that must point at it or at something removed (found through the catalog), clears other rows'
nullable references to them, queues the tasks' file folders for the cron route, and **aborts with nothing
removed** if anything in that set belongs to another workspace, to profiles / the allowlist / the registry,
or to another schema. Auth identities and other workspaces are never touched. The registry row stays as the
audit record; running it again answers `already_cleaned`.

## Admin manual test checklist (preview)

1. As a pilot admin: New project shows **Build with AI**; as anyone else (or before the migration) it
   doesn't, and `/ai-builder` is a 404.
2. Generate from a short brief; edit a section name, remove a task, Create. The project is private, in the
   Testing data workspace, with the previewed items only; nobody got an email or Inbox item.
3. Click Create twice quickly: one project.
4. Cancel a proposal: no project; the run reads Cancelled in History.
5. Undo right away: the project goes to the Trash. Apply another, rename a task, Undo: refused with
   “Changed since it was created: tasks or subtasks.”
6. Without `ANTHROPIC_API_KEY`: the panel says it isn't configured.
7. 11 generations within an hour: the 11th is refused with the limit message.
