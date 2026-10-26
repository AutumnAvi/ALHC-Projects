# ALHC Projects: AI Assistant Plan

> **PARKED.** Revisit after Avi finishes the end-to-end test checklist. Re-check against changes merged after PR #55 (79984cf) before building.

Written Oct 26, 2026, against `main` at `79984cf`. Docs only. No code or database changes.

---

## 1. Goals

1. **Start a project by chatting.** Describe the project, answer a few questions, see a preview, click Create.
2. **A project-aware helper during the project.** It already knows the project, asks only when it has to, and builds dashboards (first priority), views and boards that fit.
3. **Keep Asana's shape.** The assistant only builds things the app already has (sections, fields, tasks, forms, rules, views, widgets). No new kind of project.
4. **Safe by default.** Nothing gets created without a preview. Every change can be undone. The bot can never do more than the person using it.
5. **Cheap and capped.** A hard monthly spend cap, and it switches off cleanly when the cap is hit.

Non-goals for V1: the bot editing or completing tasks on its own, rules that call AI, AI "teammates" that act without being asked, and reading attachments.

---

## 2. V1 vs later

| Area | V1 | Later |
|---|---|---|
| Project starter bot | Chat → plan → preview → create (sections, fields, tasks, subtasks, forms, rules, views, dashboard) | Start from an existing template plus edits; import from a pasted brief or doc |
| Project helper bot | Reads the project, answers questions, proposes dashboard widgets, views and new fields/sections, all through preview | Weekly "how's it going" status draft, triage suggestions for form requests |
| Dashboards | 4 new widget kinds (see §7) plus the bot picking from all of them | Pie and line charts, goal widgets, cross-project widgets on personal dashboards |
| Actions | Additive only (create/add). Undo = delete what it added | Edits/moves with field-level undo |
| Scope | One project at a time | Portfolio and personal dashboards |
| Models | One model via one key | Per-task model choice (cheap for reads, stronger for plans) |

---

## 3. User flows

### 3a. Project starter ("New project → Build with assistant")

1. New project dialog (`src/components/shell/new-project-dialog.tsx`) gets a third choice next to Blank and Template: **Build with assistant**.
2. A side panel opens: "What's this project for?" Avi types, e.g. "Q1 video shoots for all 12 facilities, requests come in from facility admins."
3. The bot asks **at most 3–5 questions**, each with tap-to-answer chips plus free text. Examples: Who requests work? What stages does it go through? What do you need to track (facility, due date, type)? Who's on the team?
4. The bot returns a **plan**, shown as a preview card, not just text:
   - Sections (e.g. Requested → Scheduled → Shooting → Editing → Review → Done)
   - Fields with types and options (e.g. Facility: single select with 12 options)
   - Starter tasks and subtasks, with relative dates
   - Intake form with questions, mapped to fields
   - Rules in plain words ("When a form is submitted → put it in Requested and assign to Avi")
   - Views (Board by section, Calendar by due date)
   - Dashboard widgets
5. Each block has checkboxes and an Edit link. Avi can also say "drop the timeline view, add a Priority field" and the preview updates.
6. **Create** builds everything in one database transaction. The new project opens with a banner: "Built by the assistant. Undo all."
7. Nothing is written before Create. Closing the panel throws the draft away (the draft is kept for 7 days for "resume").

### 3b. Project helper ("Assistant" button in the project header)

1. A button in `project-header.tsx` opens a right panel. It shows a one-line read of the project first, e.g. "42 open tasks, 9 overdue (mostly Editing), 3 form requests unassigned."
2. Suggested chips: **Build a dashboard**, **What's behind?**, **Suggest a view**, **Clean up fields**.
3. **Build a dashboard:** the bot proposes 4–8 widgets with titles and a one-line reason each ("Overdue by assignee: Editing is the bottleneck"). Previews render with real data. Avi ticks what he wants → **Add to dashboard**.
4. Free requests: "Add a chart of video requests by facility." If it's clear, it goes straight to a preview. If not ("Which field means facility?"), it asks one question.
5. Read-only questions ("Who has the most overdue work?") get a plain answer with links to tasks. No actions.
6. Every applied change shows in the panel history with **Undo**.

---

## 4. How the bot reads the project

Built server-side by a new `src/lib/ai/context.ts`, using the **user's own Supabase client** (so RLS applies) and existing functions:

| Data | Source today | Limit |
|---|---|---|
| Project name, description, status, dates, members + roles | `projects`, `project_members`, `project_status_updates` (latest) | All |
| Sections with task counts | `project_section_task_counts` RPC | All |
| Fields with types and options | `custom_fields` | All |
| Counts: open, done, overdue, by assignee, by section | `project_metrics` RPC | All |
| Tasks: title, section, assignee, due, done, field values | `project_task_cards` / `filter_project_tasks` | Newest/most relevant 150; titles cut to 120 chars; **no descriptions or comments in V1** |
| Forms (questions), rules (plain-language labels), views, existing widgets | `forms`, `rules` via `toRuleDef`/`triggerLabel`, `project_views`, `dashboard_widgets` | All |
| Recent activity | `task_stories` | Last 50 events |

- Target **under ~15k input tokens** per call. If a project is bigger, the bot gets the counts plus a sample and can call a `search_tasks` read tool for more.
- Context is rebuilt per conversation turn (cheap, a few queries) and cached for 60 seconds.
- Starter bot context is small: the workspace's teams, people (names only), existing field names and template names, so it reuses names the team already knows.

---

## 5. Tool and action design

**Rule: the model never writes to the database.** It returns a typed **proposal** (JSON, validated with zod). The app shows it, the user approves it, and the app applies it through the same code paths a person uses.

### Read tools (the model can call these freely)
- `get_project_overview`, `search_tasks(filters)`, `get_metrics(filters, group_by)` (wraps `project_metrics`), `list_fields`, `list_people`.

### Proposal types (the model returns these, the user approves)
| Proposal | Applies through |
|---|---|
| `project_plan` (sections, fields, tasks, subtasks, forms, rules, views, widgets) | The template content format already used by `project_templates.content` (sections/fields/tasks/rules/forms/views) and `create_project_from_template`. New RPC `create_project_from_plan(content jsonb, name, start_on)` reuses that function's body without saving a template row. |
| `add_widgets[]` | Same inserts as the dashboard UI (`dashboard_widgets`, with `filters` in the `ViewFilters` format from `src/lib/views.ts`) |
| `add_view` | `project_views` with `layout` (list/board/calendar/timeline) and `ViewConfig` |
| `add_field`, `add_section`, `add_form`, `add_rule` | The existing server actions in `src/lib/actions.ts` and rule validation in `rule-steps.ts` / `rule-params.ts` (every step's settings must be filled, same as PR #53) |

### Preview
- Proposals are validated **before** they're shown: unknown field IDs, empty required rule settings, or an unsupported widget kind are fixed by the bot or dropped with a note.
- Widget previews run the real metric query, so Avi sees real numbers.

### Undo
- Each applied proposal is logged in `ai_actions` with the IDs it created.
- **Undo** soft-deletes those rows (every target table already has `deleted_at`). Undo is offered for 7 days, and skips anything a person has edited since (with a note saying so).
- "Undo all" on a bot-built project archives the project (`set_project_archived`), it doesn't hard-delete.

---

## 6. Permissions

- All reads and writes use the **signed-in user's Supabase session**. No service-role key in the AI path. RLS decides what the bot can see and do.
- The bot gets the user's project role (`project_role` RPC, roles from `src/lib/roles.ts`) and only offers actions that role can do:
  - **Viewer / Commenter:** questions and read-only answers only. No Build buttons (matches the PR #55 rule: don't show what a role can't use).
  - **Editor:** widgets, views, fields, sections, tasks.
  - **Owner / Admin:** plus rules, forms, members.
- If a write fails RLS anyway, the panel shows "You don't have access to do that" and nothing partial is left (one transaction per proposal).
- Workspace admins get an on/off switch and a cap in Admin console → Settings. Off by default.

---

## 7. Dashboard widget catalog

**Exists today**
- Project dashboard (`dashboard_widgets.kind`): `count` (number), `by_section`, `by_assignee`. All take `ViewFilters` (due kind, assignee, fields, etc.).
- Personal dashboard (`personal_dashboard_widgets.kind`): those plus `by_project`, `completed_series`, `overdue_list`.

**New for V1 (project dashboards)** — needed so the bot can build dashboards that "make sense":
| Kind | Why |
|---|---|
| `by_field` | Bar chart grouped by any single-select/people field (e.g. requests by Facility). The single biggest gap. |
| `completed_series` | Already exists on personal dashboards; bring it to projects (done per week). |
| `overdue_list` | Same: bring to projects. |
| `task_list` | A short filtered list ("Waiting on approval", "Unassigned requests"). |

Later: `sum_by_field` (number fields, e.g. budget), `by_due_week` (workload ahead), pie/donut display option, goal progress, form submissions over time.

The bot picks only from this list. It may not invent a kind.

---

## 8. Model and provider options

| Option | Notes |
|---|---|
| **Vercel AI Gateway (recommended)** | One key in Vercel, swap models without code changes, usage per model visible in the Vercel dashboard. Works with the AI SDK already common in Next.js. Pay-as-you-go at provider list price. |
| Direct provider key (Anthropic or OpenAI) | Same cost, one less hop, but locks to one vendor and needs its own billing setup. |
| Free tiers | **Don't.** Free tiers often allow training on the prompts. Not OK for a healthcare company's data. |

**Models:** a mid-tier model (Claude Sonnet-class or GPT-mini/standard-class) for plans and dashboards. Small models are fine for read-only answers.

### Cost estimate (8 people)
Assumptions: ~300 assistant turns a month (heavy use), ~15k tokens in and ~2k out per turn.
- Mid-tier model (~$3 per million in / ~$15 per million out): about **$0.075 per turn → ~$20–25/month**.
- Small model for the read-only half of turns: brings it to **~$10–15/month**.
- Light use (100 turns): **under $10/month**.
- For comparison, Asana Agent at $0.50/request would be ~$150/month for the same 300 turns.

### Spend cap
1. **Provider/Gateway side:** set a monthly budget or prepaid credit limit in the AI Gateway or provider console (e.g. $25). This is the hard stop.
2. **App side:** `ai_usage` logs tokens and estimated cost per call. A workspace setting `ai_monthly_cap_usd` (default $25) turns the assistant off for the month when reached, with a clear message. Admins see the month-to-date total.
3. Per-user limit: 40 turns a day (stops runaway loops).

---

## 9. Data privacy

- Autumn Lake Healthcare **marketing** data: campaigns, videos, facility names, staff names. **No patient health information (PHI) is expected in this app, and none should be.** Put that in writing in the app: a one-line note in the assistant panel, "Don't paste patient information."
- Because PHI isn't expected, V1 does **not** need a HIPAA BAA. If that ever changes, stop and get a BAA-covered provider first.
- Use a provider/plan with **zero data retention or no training on API data** (Anthropic and OpenAI API defaults don't train on API data; confirm when picking).
- Send only what §4 lists: no task descriptions, comments, attachments, emails, or form submitter emails in V1.
- Form submissions can come from outside people (facility admins). The bot sees field values only, not submitter contact details.
- Logs (`ai_conversations`) are visible only to the user who ran them and admins, and are purged after 30 days.
- No secrets in prompts. The API key lives only in Vercel env vars (`AI_GATEWAY_API_KEY`).

---

## 10. Data model additions (one migration, `ai_assistant_a`)

| Table / change | Purpose |
|---|---|
| `ai_conversations` (id, workspace_id, project_id null, profile_id, kind `starter`/`helper`, messages jsonb, created_at, purge after 30 days) | Chat history and resumable drafts. Owner-only RLS. |
| `ai_actions` (id, conversation_id, project_id, profile_id, proposal jsonb, created_ids jsonb, applied_at, undone_at) | Preview → apply → undo log |
| `ai_usage` (id, workspace_id, profile_id, model, tokens_in, tokens_out, cost_usd, created_at) | Cap and reporting |
| `workspaces.ai_enabled boolean default false`, `ai_monthly_cap_usd numeric default 25` | Admin switch and cap |
| `dashboard_widgets.kind` CHECK widened to add `by_field`, `completed_series`, `overdue_list`, `task_list`; add `config jsonb default '{}'` (field id for `by_field`, interval for series, row limit for lists) | New widgets |
| `create_project_from_plan(content jsonb, project_name text, start_on date)` RPC, `security invoker` | Builds a project from a plan using the template copy logic |
| `ai_usage_month(workspace)` RPC | Month-to-date spend for the cap |

Purge job: add to the existing `alhc-log-purge` pg_cron job.

---

## 11. Screens

1. **New project dialog:** third option "Build with assistant."
2. **Starter panel:** chat on the left, live plan preview on the right (sections, fields, tasks, form, rules, views, dashboard, each with checkboxes). Create button at the bottom with a count ("Create 6 sections, 4 fields, 18 tasks…").
3. **Project Assistant panel:** right side panel from the project header. Project summary line, suggestion chips, chat, proposal cards with Apply / Edit / Dismiss, history with Undo.
4. **Dashboard tab:** "Ask the assistant" button next to Add widget. The four new widget kinds also in the manual Add widget picker (searchable grouped picker, no native selects).
5. **Admin console → Settings → AI:** on/off, monthly cap, month-to-date spend, model in use, "no patient info" note.
6. **Bot-built banner** on a new project: "Built by the assistant · Undo all."

---

## 12. Phased build (2–4 days, Claude Code T3 batches)

Each batch is one T3 run (claudeMax, Opus, high effort), one PR, auto-merged by the routine unless it touches auth/permissions (then Avi reviews).

| Day | Batch | Contents | Done when |
|---|---|---|---|
| 1 | **A: Foundations + widgets** | Migration `ai_assistant_a` (tables, workspace switch, widget kinds + `config`); 4 new widgets in the project dashboard UI and manual picker; Admin AI settings screen; no AI calls yet | New widgets work by hand; admin switch saves |
| 2 | **B: AI plumbing + helper bot (read + dashboards)** | AI SDK via Gateway, `context.ts`, read tools, cap + usage logging, Assistant panel, `add_widgets` and `add_view` proposals with preview and undo | Ask "build a dashboard" on a real project → preview → apply → undo |
| 3 | **C: Project starter** | `create_project_from_plan` RPC (security invoker), plan schema (zod) matching template content, starter panel with questions + preview + create + Undo all | Chat-built project matches its preview; Undo all archives it |
| 4 (buffer) | **D: More actions + hardening** | `add_field` / `add_section` / `add_form` / `add_rule` proposals; role gating tests (Viewer/Commenter see no Build); RLS denial tests; cap-reached test; prompt-injection test (task titles saying "ignore instructions") | All tests green; Avi's test steps added to Asana |

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Bot proposes something invalid (bad rule settings, unknown field) | Zod schema + existing rule validation before preview; drop with a note |
| Prompt injection via task titles or form answers | Project data is passed as data, not instructions; the bot can only produce proposals; a person always approves writes |
| Cost runaway | Provider budget + app cap + daily per-user limit |
| Bot sees more than the user should | User's own session + RLS; no service-role key in the AI path |
| PHI pasted by someone | Panel note, admin policy; no BAA in V1, so treat it as "don't" |
| Plans drift from the app as features change | **Re-check this plan against everything merged after 79984cf.** The plan format is the template content format, so it follows template changes automatically |
| Quality: generic dashboards | Seed the bot with 5–6 example dashboards for this team's real project types (video shoots, campaigns, social calendar, events) |
| Undo after people edit | Undo skips edited rows and says so |

---

## 14. Decisions for Avi

1. **Turn on paid AI?** Expected ~$10–25/month for the team with a **$25/month cap**. Yes / no / different cap.
2. **Gateway or direct key?** Recommend Vercel AI Gateway.
3. **Who can use it?** Everyone with Editor+, or admins only at first?
4. **Starter bot scope for V1:** include rules and forms, or sections/fields/tasks/views/dashboard only at first?
5. **New widgets:** OK with `by_field`, `completed_series`, `overdue_list`, `task_list` for V1? Any must-haves missing?
6. **Privacy line:** confirm "no patient information in ALHC Projects" as a written rule.
7. **Order:** build the helper bot (dashboards) first, or the starter bot first? Recommend dashboards first since that's the biggest gap vs Asana.
