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

## Round 2 (branch `feat/ai-builder-p2` → `feat/ai-builder`; draft PR, do not merge to main)

Avi's notes 168–170. Migration `supabase/migrations/20261108140817_ai_builder_round2_a.sql` (made with
`supabase migration new`; additive, **no tail**, **not applied**), suite
`supabase/tests/zz57_ai_builder_round2_smoke.sql`. No new client SECURITY DEFINER function (suite 60
unchanged); nothing for anon. Everything in phase 1 still holds: the registry + `ai_pilot_admin()` gate,
the signed-in person's own client (no service role), idempotent all-or-nothing Apply, ownership-checked
Undo, the run log, database-enforced limits, and the brief / instruction as data.

### What's new

- **A preview that looks like the project (168).** The draft is drawn with the app's own `ListView` and
  `BoardView` (List / Board toggle), not a form. The views read their writes from
  `useProjectData()` (`apps/web/src/components/project/project-data-source.tsx`); outside the AI builder
  that is exactly the Server Actions they imported before, so real projects behave as they did. In the
  preview it is an in-memory source (`components/ai-builder/draft-data-source.ts`) over the draft model
  (`packages/core/src/ai-builder-draft.ts`): rename tasks and sections in place, add, delete, and drag
  tasks and sections, pick assignees, start / due dates, and field values in the cells, add or edit a field
  and its options ("+" column, column menu → Edit field, or Add field), and open a task (row click) for its
  notes, subtasks, a new placeholder, and Remove task. Starter tasks are created open (no tick box).
  Every edit goes through the draft's rules first; the server's own check (`checkAiDraft` →
  `parseProposal` with the pilot's people) runs a moment after each edit and again on Create.
- **Assignees** are people of the Testing data workspace (`ai_pilot_members()`: its workspace admins and
  active team members) or **placeholders** ("Designer"), which become a project role with nobody in it on
  Create (Overview → Project roles; the tasks are linked to it as their assignee role). Anyone assigned
  other than you joins the new project as an Editor first (the Share dialog's own `add_project_member`)
  and gets the usual assignment notice; nothing else notifies or sends. The model never sees a person:
  people are aliases (`member:1` = you).
- **Ask AI to change the draft.** A text box under the preview (with a mic: the browser's Web Speech API
  fills the box, you send it; hidden where the browser has no speech recognition) sends the current
  draft and the instruction to `POST /api/ai-builder/edit`. The model answers a bounded list of edits
  (`packages/core/src/ai-builder-ops.ts`: ≤ 40 operations in a closed schema), applied through the same
  draft rules and checked again on the server; one bad edit refuses the whole change. The preview lists
  what changed, and **Undo AI change** puts the draft back (locally). Each request is a child run in the
  log (`kind = 'edit'`, `parent_run_id` = the build).
- **Models (169).** `AI_BUILDER_CALLS` in `packages/core/src/ai-builder.ts`: the first build is
  `claude-sonnet-5-5` (8,000 output tokens, 55 s, effort `low`, as in phase 1); AI changes and automation
  drafts are `claude-haiku-5-5` (3,000 / 2,000 output tokens, 25 s, effort `low`; Haiku 5.5 defaults to
  `medium`, so it's set explicitly). Haiku 5.5 accepts that effort and JSON structured output. A schema
  with a null (`anyOf`) on every key is over the provider's 16-union limit and is rejected before any
  tokens, so an edit or an automation draft uses blanks (`""`, `-1`, `[]`) instead of null. A failed call
  logs the provider's HTTP status, error type, and message on the run (never the key or the prompt).
  Optional server-side overrides `AI_BUILDER_{BUILD,EDIT,AUTOMATION}_MODEL`
  / `_EFFORT` are accepted only from `AI_BUILDER_ALLOWED_MODELS` (`claude-sonnet-5-5`, `claude-haiku-5-5`,
  `claude-opus-5-5`) and `low | medium | high`. Every run logs its model and effort
  (`ai_builder_runs.effort`).
- **Ask AI for an automation (170).** On the project's Automations page (Testing data projects, pilot
  admins who are the project's Owner / Admin; checked again by the route and the database). The
  description goes to Haiku, which answers a draft limited to these existing steps and to the project's
  own sections, fields (single choice, text, number), and members:
  - **When:** task added, moves into / out of a section, a field changes, assignee changes, completed,
    reopened, all subtasks done, comment added, file attached, due date changes, due date approaching,
    overdue, start date changes, run manually.
  - **If:** section is / isn't, complete / incomplete, field equals / is set / is empty, has / has no
    assignee, assignee is / isn't, overdue, due within, has / has no due date, name contains, open / all-done
    subtasks, blocked / not blocked, attachment, comment.
  - **Then:** move to section, set field, set assignee, add followers, add comment, send Inbox
    notification, mark complete / incomplete, rename, add to the description, create subtasks, set due date.
  - Never: email, Slack, webhooks, other projects, schedules, waits, approvals, templates, converting.
  The draft is translated to ids and checked with the rules engine's own checks (`ruleProblems`); anything
  else is refused with a plain message. It opens in the **normal rule canvas** (`/rules/new?ai=<run>`),
  starts off, and is saved only by the canvas's Create (`createRule`, `validate_rule`); the run then
  records the rule (`rule_id`; the guard accepts only a live rule of that project created by the same
  person). Mark complete is the ordinary `{ type: "complete_task" }`, so the database's blocked-completion
  guard (notes 163 / 163b) holds for AI-made automations like any other (zz57 runs one on a blocked task).
  The AI flow itself sends nothing.
- **Limits** (database-enforced, `guard_ai_builder_run()`): first builds keep phase 1's (10 an hour,
  30 a day per person, 60 a day per workspace); AI changes 30 an hour / 100 a day per person; automation
  drafts 10 an hour / 30 a day per person; 300 runs a day per workspace in all; at most 2 generating at once.

### Apply steps (only after Avi authorizes)

1. Apply `20261108122112_ai_builder_pilot_a.sql` first (phase 1: everything above its `-- TAIL`, then the
   tail by hand), if it isn't already.
2. Apply `20261108140817_ai_builder_round2_a.sql` (the `migration-applier` subagent, in chunks:
   `ai_builder_round2_a`, `_b`, …). It has no tail.
3. Confirm with `list_migrations`. Until it's applied the builder fails closed: setup can't read the
   pilot's people (`ai_pilot_members` is missing), so Build with AI and Ask AI for an automation stay hidden,
   and the routes answer with an error instead of calling the model.
4. Optional: `AI_BUILDER_*_MODEL` / `_EFFORT` for the branch's Preview environment only.

### Known limits

- The preview has no task pane (a row opens the draft's own editor), no tags, no bulk edits, no column
  widths or collapsed groups remembered, and no dependency shifting; draft subtasks only have a name.
- Undo AI change goes back one change (the last); manual edits after it are lost if you undo.
- Assigning a teammate other than yourself sends them the normal assignment notice when the project is
  created.
- AI automations use one branch (no Else if / Otherwise) and the steps listed above; the person can add
  anything else in the canvas before saving.

### Manual checks (preview)

1. Build with AI → the preview is the List (and Board via the toggle); rename a section in place, drag a
   task to another section, set a start and due date in the cells, open a task and add a placeholder and
   a subtask, add a choice field from "+". Create: the project matches the preview; the placeholder is a
   project role.
2. Type (or dictate) "add a QA section before Done and move every review task into it" → the change list
   shows; Undo AI change restores the previous draft. History shows an "AI change" run with
   `claude-haiku-5-5 · low`.
3. On a Testing data project's Automations page: Ask AI for an automation → the canvas opens filled in and
   off; Create; History shows "Automation · Saved" linking to it. Ask for "email the client" → refused.
4. As a non-admin or on a main-workspace project: no AI button; the routes answer 403.
