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

## Round 3: "AI everywhere" (branch `feat/ai-builder-p3` → `feat/ai-builder`; draft PR, do not merge to main)

Note 171: an AI assistant reachable from anywhere in the app that changes existing data of Testing data
projects. It shows every change first, asks before applying, and can undo. Automations are the priority.

### Entry points

- **Ask AI** in the top bar (between search and the avatar), and **Tab then A** anywhere (listed in the
  `?` shortcuts help; like Tab then Q it never fires while typing). Both only for workspace admins of the
  live Testing data pilot: the button stays hidden for everyone else, and the server checks again on every
  request (fails closed).
- The panel floats at the bottom right (the panel layer). It is not a right panel on purpose: the task
  pane stays open beside it, so the open task is the context. It works on project List / Board / every
  view, the task pane, My tasks, an automation list, and one automation.

### Context (server side only)

The browser sends the page as kinds and ids (`assistantPageFromPath`: project, task, my_tasks, rules,
rule, other). `loadAssistantContext` (`packages/core/src/api/ai-assistant/queries.ts`) loads everything
with the person's own client: the pilot projects they're in (with their role), sections, members, the focus
project's fields, its top-level tasks (open first, ≤ 60) plus the open task with its parent and subtasks
(or, on My tasks, their open tasks in pilot projects), open-blocker counts, and the project's automations.
A page outside the pilot is refused. The model sees refs (P1, S3, F2, T7, R1) and aliases (member:1) —
never an id, an email, or a person's name — and the prompt marks all workspace text as data.

### Change sets

`packages/core/src/ai-assistant.ts`. The model answers one flat object: `summary`, `unsupported`, `ops`
(every op has the same keys; unused ones are `""`), and `rules` (automation drafts the ops name by key).
Operations, in priority order:

| Area | Operations |
| --- | --- |
| Automations | `create_rule` (always created **off**), `update_rule` (whole new steps), `enable_rule`, `disable_rule`, `remove_rule` (Undo brings it back) |
| Sections | `create_section` (before a section or at the end), `rename_section`, `move_section` |
| Tasks / subtasks | `rename_task`, `set_description`, `move_task` (a section of its project, a section created in the same change set, or another pilot project), `assign_task` (project members only), `set_dates`, `set_field` (text, number, date, single / multi choice; not locked or Status fields), `complete_task` / `reopen_task` |

Automations use the round 2 vocabulary (`ai-automation.ts`) without Notify and Add comment (they post or
notify by themselves), and are checked by the rules engine's own `ruleProblems` (then `validate_rule` on
save). An automation with branches, Or groups, or other steps can still be turned on / off / removed but
not rewritten. `resolveAssistantPlan` maps refs back to ids from the same server-loaded context and drops
anything it can't do with a plain reason (shown as "Left out"): unknown refs, ops the person's role
doesn't allow (Editor+, Admin+ for automations, Owner when sections are locked), non-members, unknown
options, blocked / approval / repeating tasks for Complete, no-ops, repeats. Nothing invented is ever
written; a request it can't do at all fails with the explanation.

### Apply, Undo, and the log

- **Nothing is written before Confirm.** The panel lists each change with before → after (automations as
  the rule builder's sentence; edits show the old one struck through); each can be left out (a move into a
  new section keeps that section).
- **Apply** (`applyAssistantRun`): an apply key (the same Confirm twice answers the first result); every
  chosen op is checked again against the database (the project is a live pilot project, the person's role
  there now, the target belongs to it, open blockers for Complete) and against the state the AI saw
  (`expect`); anything changed → nothing is written ("stale"). Then each op runs through the existing
  typed-API mutation as the person (`updateTask`, `moveTask`, `addTaskToProject` / `removeTaskFromProject`,
  `setFieldValue`, `setTaskCompleted`, `createSection`, `renameSection`, `placeSection`, `createRule`,
  `updateRule`, `setRuleEnabled`, `deleteRule`) — RLS, the guards, `validate_rule`, and the dependency
  guard decide, no service role. A refusal part way rolls back what was written (status `rolled_back`).
  Each op's state before and after is recorded. Server Actions run with `deliver: false`.
- **Undo** (`undoAssistantRun`): first compares every change with the state right after apply; anything
  changed (or no longer allowed) → nothing is undone and the conflicts are listed. Else each change is put
  back in reverse (created sections and automations removed, a removed automation restored with
  `restoreRule`). Progress is kept per change, so Undo again is safe.
- **Log** `ai_assistant_runs`: actor, workspace, page kind and ids, instruction length (never the text),
  model, effort, why that model (`route_reason`, `escalated`), tokens (both calls when escalated), op
  count and per-op summary, the resolved change set, what was applied (before / after, touched ids), Undo
  conflicts, and failures (`error_code` + the provider's HTTP status, type, and message, scrubbed — never a
  key, a header, or a prompt). Shown under **AI assistant** on `/ai-builder`.

### Models

`AI_BUILDER_CALLS.assistant_small` = Haiku 5.5 (low effort, 3,000 tokens, 25 s) for a small single-step
edit; `assistant_large` = Sonnet 5.5 (medium effort, 6,000 tokens, 55 s) for automations or several
steps. `routeAssistant` decides (automation pages or words → `rules_page` / `mentions_rules`; > 240
characters → `long_request`; "and then", "also", "then", ";", two "and"s, three sentences →
`multi_step`; else `small_edit`). A Haiku answer with automation ops, more than 5 ops, or invalid output is
asked again of Sonnet (`escalated_rules` / `escalated_size` / `escalated_invalid`). Overrides:
`AI_BUILDER_ASSISTANT_SMALL_MODEL` / `_EFFORT`, `AI_BUILDER_ASSISTANT_LARGE_MODEL` / `_EFFORT`
(allowlisted values only).

**Schema rule (the Anthropic structured-output lesson):** at most 16 `anyOf` unions per schema, and a
nullable key counts as one. The change-set schema has **no** union and no nullable key (one flat op object,
an `op` enum, blanks instead of null). `packages/core/tests/ai-assistant.test.ts` walks it and fails on any
nullable union or more than 16 `anyOf`, and `structuredOutputIssues` must be empty.

### Migration (written, NOT applied)

`supabase/migrations/20261108152314_ai_assistant_round3_a.sql` — additive, no tail, no `DROP` / `DELETE`:
the `ai_assistant_runs` table (RLS: pilot admins read, each person writes their own; column grants),
`guard_ai_assistant_run()` (invoker: identity fixed, state machine, change set set once, apply key once,
rate limits 2 generating / 30 an hour / 150 a day per person / 400 a day per workspace), indexes on every
foreign key. No new client SECURITY DEFINER function; nothing for anon. Suite
`supabase/tests/zz58_ai_assistant_smoke.sql`.

Apply steps (only after Avi authorizes): the round 1 and round 2 migrations first; then hand
`20261108152314_ai_assistant_round3_a.sql` (slug `ai_assistant_round3_a`) to the `migration-applier`
subagent; confirm with `list_migrations`. Until it's applied the assistant fails closed (the run insert
fails, no model call).

### Known limits

- No creating or deleting tasks, comments, tags, followers, dependencies, approvals, fields, or projects;
  no notifications, emails, Slack, or webhooks; nothing outside the Testing data pilot.
- The assistant's own writes queue nothing to send, but they are ordinary edits: assigning someone else
  gives them the usual in-app assignment item, and a project's existing automations react to the changes
  like to any edit. AI-made automations start off.
- Context is bounded (60 tasks of the focus project, 30 subtasks, 30 automations, 20 projects); a task
  not in it can't be named.
- A move to another project goes to a section by ref (only sections of loaded projects) or none.
- Undo is all or nothing per run; a run that changed something since can't be undone in part.

### Manual checks (preview, after the migration is applied)

1. On a Testing data project's List: Ask AI → "add a Blocked section before Doing and move the print
   run there" → two changes, the move marked "Needs change 1"; untick 1 → 2 unticks too. Confirm; Undo.
2. On the Automations page: "whenever a task is completed move it to Done" → a new automation (off) as a
   sentence; Confirm; it's in the list, off. Then "turn off Triage", "remove …" → Undo brings it back.
3. Open a task → Tab then A → "due next Friday, assign to Dana, priority High". Edit the task by hand,
   then Undo → it lists the conflict and changes nothing.
4. "Complete the print run" on a blocked task → left out with the blocked reason.
5. As a non-admin or on a main-workspace page: no button; Tab then A does nothing; the route answers 403.
