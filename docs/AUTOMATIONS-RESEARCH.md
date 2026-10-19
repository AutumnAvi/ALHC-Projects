# ALHC Automations V2: Research and Spec (Oct 19, 2026)

## 1. The most common Asana rules, ranked
These come from Asana's rule gallery, Asana Community threads, and posts by creative and marketing ops teams.
1. **Task moves to section → set status field, or assign someone.** Example: "In Review" → assign the reviewer and set Status to Review.
2. **Task added to project → assign by type, set due date, add subtasks or a checklist.** Teams usually use a form or a template for this.
3. **Form submitted → route by an answer.** If Request type is Video, assign the video lead and move the task to Video intake.
4. **Field changes → move section.** For example, Status set to Approved moves the task to Approved.
5. **Task completed → move to Done, notify the requester, or mark the parent complete when all subtasks are done.**
6. **Approval decided → move or reassign.** "Changes requested" goes back to the designer and comments with the feedback.
7. **Due date approaching or overdue → notify the assignee, raise the priority, or move to "At risk."**
8. **Assignee changes → add the old assignee as a follower, or post a comment.**
9. **Multi-home a task into another project,** such as a team-wide "Creative calendar."
10. **Integrations:** Slack message, email, or a webhook out to Zapier or Make.

Marketing and creative favorites: auto-assign by request type, approval loops, a requester update on every stage change, "Due in 2 days and still in Intake → alert," and creating an approval subtask when a task enters Review.

What Asana has today (verified Oct 2026):
- Up to 20 triggers and 20 actions per rule, and a hard cap of 50 rules per project.
- If/else branching: the first branch whose condition matches is the only one that runs.
- Scheduled triggers (V1 shipped January 2026; V2, which can act on tasks already in a project, shipped August 2026).
- Manual "run rule."
- Rule history: status, time, task, actions run, and edit history.
- Rule bundles that can be reused across projects.
- AI Studio: create a rule by typing a description.
- Cross-project actions.

What Asana users still complain about (forum posts and Reddit):
- **No delay or wait step.** This has been requested since 2021, and Asana's answer was scheduled triggers.
- **No switch-style branching** that runs *every* matching branch. Users end up making duplicate rules and running into the 50-rule cap.
- **The new builder (Sept–Oct 2026) has drawn strong backlash.** Each step went from 1 click to 3–4, the "Check if" conditions are hidden behind hovers and clicks, and users call it "confusing and overly complex."
- **Rules fire on accidental blank-row tasks,** so users want a short grace period before a rule runs.

ClickUp users (Reddit) report:
- There are no folders, search or ordering for hundreds of automations.
- When several automations share a trigger, the order they run in is random.
- Some automations are flaky, and paid plans cap how often automations can run.

## 2. What other tools offer that Asana doesn't
| Capability | Who has it |
|---|---|
| If/else branching, multiple branches | Jira Automation, Make, Zapier Paths, ClickUp (conditions), Airtable |
| Delays ("wait 2 days") and wait-until-condition | Zapier Delay, Make, Jira (scheduled), HubSpot |
| Scheduled triggers (cron, every weekday 9am) | Jira, Airtable, Zapier, Monday, ClickUp |
| Variables and smart values (`{{task.name}}`, date math) | Jira smart values with a `{}` picker panel and a "Check for errors" button; Monday's new builder exposes trigger data in every picker and supports date math (another date column ± days) |
| Lookups, then acting on related items (parent, subtasks, linked) | Jira (branch rules on related issues), Airtable, Notion |
| Create task, subtask or project from a template | Monday, ClickUp, Asana (limited) |
| Audit log or run history with per-step results | Jira (audit log), Zapier/Make (full run replay), Airtable |
| Test run with sample data | Zapier Test step / Test run, Make Run once, Airtable test. **Note: Zapier and Make tests are LIVE.** They really perform the actions, and Airtable test runs don't appear in the history. A true dry run is open space nobody covers well. |
| Replay or re-run past runs | Make scenario replay, Zapier replay, Airtable Rerun failed run (re-runs the *old* rule version, which confuses people) |
| Error alerts and auto-disable after repeated failures | Zapier, Jira (owner emailed) |
| Loop prevention (a rule can't trigger itself, or only N times) | Jira (rule-triggered checkbox), Monday |
| Rule ownership and "run as" actor | Jira (actor), Airtable |
| Workspace or global rules across projects | Jira (multi-project), Monday (board-level), ClickUp (space-level) |
| AI natural-language rule creation, AI actions (summarize, categorize) | Jira, ClickUp, Notion, Monday, Airtable AI |
| Template gallery with recipes for each use case | Monday, ClickUp, Zapier |
| Linear-style automatic workflows (Git PR → status, auto-close/archive stale) | Linear |
| Counters and rollups (e.g. "when all subtasks done") | Jira, ClickUp, Asana (partial) |

## 3. Current ALHC builder (origin/main 3bde676)
Files: `src/lib/rules.ts`, `src/components/rules/{rules-view,rule-editor,rule-canvas,rule-shared}.tsx`.
- **Triggers (8):** task added to project, task moves into a section, a field changes, assignee changes, due date approaching, approval decided, form submitted, created by inbound webhook.
- **Conditions (10):** section is or is not, field equals / is set / is empty, has or has no assignee, is complete or incomplete, task came from (source).
- **Actions (11):** move section, set field, set assignee, add comment, add followers, inbox notify, request approval, send email (submitter, assignee, field, or fixed address; three message templates), Slack, webhook, delay.
- **Already there:** enable/disable toggle, presets (`RulePreset` with inputs), up to MAX_RULE_BRANCHES branches, a run log (`RuleRun`: succeeded, failed, skipped, scheduled), and a canvas view.
- **The UX problem:** the editor uses **14 native `<select>`s** (8 in rule-editor, 2 in rule-canvas, 4 in rule-shared). On macOS these open the system menu. That menu has no search, no grouping, icons or descriptions, and it covers the screen. This is the "Apple selector" issue Avi raised.

## 4. Gaps vs. best in class
Triggers that are missing:
- Task completed or reopened
- Due date changed
- Overdue
- Comment added
- Attachment added
- Tag added
- Subtask(s) all complete
- Task added from another project (multi-home)
- Scheduled (daily, weekly, cron)
- Rule-called (manual "Run" button on a task)

Conditions that are missing:
- AND/OR groups
- Field comparisons (>, <, contains, before/after a date)
- Tag has
- Assignee is a specific person or team
- Due date in or out of a range
- Task type
- Parent or subtask state
- Created by
- Form answer contains

Actions that are missing:
- Complete or reopen
- Set due date (relative: +3 workdays, Sun–Thu)
- Add or remove tag
- Add to another project
- Create a subtask or a task from a template
- Duplicate
- Set priority
- Remove assignee
- Update the parent
- Wait until a condition is true
- AI summarize or categorize (later)

Platform features that are missing:
- Variables / smart values in every text field
- Test run against a real task (dry run)
- Run detail per step
- Error alerts to the rule owner
- Auto-pause after N failures
- Loop guard (depth limit plus "ignore changes made by rules")
- Rule owner and last editor
- Version history and undo
- Workspace or cross-project rules
- Duplicate a rule or copy it to another project
- Templates gallery

## 5. Recommended V2 feature set
**Changes after the web pass:**
- Keep every condition visible inline. Never hide them behind clicks. Add "Expand all."
- Build-a-rule should take about one click per step. There is no "pick the app" step, because ALHC is the default.
- Branch mode: "first match" or "run all matching."
- A dry-run test is the main differentiator.
- Re-run uses the *current* rule version.
- Add a short grace period (around 10 seconds) on "Task added" so accidental blank tasks don't fire rules.
- Rules list: search, filter by trigger or action, and group or reorder. Set the order rules run in when they share a trigger.

**Must-have (V2):**
1. A searchable grouped picker that replaces every native select (see §6).
2. Sentence builder as the default view, with the canvas as an optional "Advanced" view.
3. New triggers: completed or reopened, due date changed, overdue, comment added, tag added, all subtasks complete, scheduled, manual run.
4. New actions: complete or reopen, relative due date (respects the Sun–Thu workweek), tags, add to project, create subtask or checklist, apply task template, set priority.
5. AND/OR condition groups plus comparison operators.
6. Variables: `{{task.name}}`, `{{task.url}}`, `{{assignee}}`, `{{field:Request type}}`, `{{submitter.email}}`, `{{due_date}}`. Insert them through an "{ }" picker.
7. Templates gallery of about 20 marketing and creative recipes, with a one-click fill-in.
8. Dry-run test (nothing is written, unlike Zapier and Make): pick a task, see each step's would-be result, and send nothing.
9. Run history with expandable per-step detail, filters (failed only), and "Re-run."
10. Safety: a loop guard (max depth 3, a "rule-caused" flag), auto-pause after 5 consecutive failures with an inbox alert to the owner, an owner field, and a confirm before any send_email or Slack action to external addresses.

**Later:**
- Workspace and cross-project rules
- Version history and restore
- AI "describe your rule" creation
- AI actions
- Wait-until-condition
- Counters and rollups
- Rule analytics (runs per week, time saved)
- Import of Asana rules through the importer

## 6. UX design spec
**Builder layout:** a full-width panel. It must follow the single-right-panel rule.
- **Header:** rule name (inline edit), enabled toggle, owner avatar, and the buttons ⋯ / Test / Save.
- **Body:** a sentence read top to bottom:
  - **When** [trigger chip]
  - **and** [condition chips] (+ add condition, + OR group)
  - **then** [action cards, numbered] (+ add action, + branch "Otherwise…")
- Each chip is a token. Click it to open the picker in place. Unfilled slots show a dashed underline, e.g. "Move to *choose section*."
- A live English summary sits at the top, e.g. "When a form is submitted and Request type is Video, assign Dana and move to Video intake." The rules list shows the same summary.

**Picker** (command-palette style, built from a cmdk or Radix Popover combobox):
- Autofocused search box with fuzzy matching on label, synonyms and description. Typing "assign" finds Set assignee, Assignee changes and Has an assignee.
- Grouped sections with headers: Task (created, completed, moved), Fields, People, Dates, Approvals and forms, Integrations, Flow (delay, branch).
- Each row has an icon, a bold label, and a one-line gray description: "Fires when a task enters a section you pick."
- Keyboard: ↑↓ to move, Enter to choose, Esc to close. Recently used items appear at the top.
- Dependent values (section, field, person, option) use the same picker with colored option pills and avatars.
- Unavailable items appear disabled with a reason ("Add a form to this project first").
- The same component is used for the trigger, condition, action and value pickers, so there are no native `<select>`s anywhere.

**Templates gallery:**
- The empty state and "New rule" open a gallery with these categories: Intake & routing, Reviews & approvals, Requester updates, Deadlines, Handoffs, Integrations.
- Each card has a name, a sentence preview, and a "Use" button. "Use" opens the builder prefilled, with the slots that still need values highlighted.
- Starter set:
  - Route by request type
  - Review → assign reviewer
  - Approved → move and notify the requester
  - Changes requested → back to the designer
  - Due in 2 days and still in Intake → alert
  - Overdue → raise priority
  - Completed → email the requester
  - New form request → create the creative checklist
  - Weekly Monday digest comment
  - All subtasks done → complete the parent

**Test and history:**
- **Test:** pick a task in a combobox to get a dry-run timeline. Each step shows ✓ would run, ⨯ condition failed (and why), or ⏱ would wait. Nothing is written.
- **History tab:** a table with time (Asia/Hebron), task link, outcome badge and duration. Expand a row for per-step detail and the error text. Rows have a "Re-run" action, and the tab has a filter.
- **Rules list:** each rule shows its enabled toggle, its summary, "Last run 2h ago · 3 failures" in red when failing, owner, a ⋯ menu (Duplicate, Copy to project, Pause, Delete with undo toast), and a project scope badge.

## 7. Build batches
1. **Picker and sentence builder:** a shared `<SmartPicker>`, all 14 selects replaced, the live summary, the canvas behind "Advanced."
2. **Engine breadth:** the new triggers and actions, AND/OR groups, operators, the scheduled trigger (cron through Vercel Cron or pg_cron), relative dates that respect the workweek.
3. **Variables and templates:** the token picker, the variable renderer, and a gallery of about 20 recipes (data-driven presets).
4. **Trust layer:** test run (dry-run mode in the engine), the run history UI with per-step detail and re-run, the loop guard, auto-pause with an owner alert, owner and last-edited fields.
5. **Later:** workspace rules, version history, AI natural-language creation.

## 8. Sources (accessed Oct 19, 2026)
- Asana rules help: https://help.asana.com/s/article/rules
- Asana rule history: https://help.asana.com/s/article/rule-history
- Asana rules feature page (bundles, integrations): https://asana.com/features/workflow-automation/rules
- Asana templates gallery (Creative requests, Work requests, Creative asset approvals): https://asana.com/templates/
- Scheduled Triggers launch: https://forum.asana.com/t/introducing-scheduled-triggers-automate-your-workflows-with-time-based-rules/1113456
- Scheduled Triggers V2 (product updates): https://forum.asana.com/c/forum-en/news/product-updates/60
- Conditions and branching launch: https://forum.asana.com/t/introducing-conditions-and-branching-in-rules/520062
- Switch-style branching request: https://forum.asana.com/t/switch-style-branching-in-rules/1152630
- Delay for rules request: https://forum.asana.com/t/delay-for-asana-rules/136845
- New builder: too many clicks: https://forum.asana.com/t/new-automations-default-to-asana-in-triggers-actions/1156656
- New builder: hidden conditions: https://forum.asana.com/t/option-to-expand-check-if-conditions-in-new-rule-builder-ui/1155916
- Reddit, ClickUp automation folders: https://www.reddit.com/r/clickup/comments/1nsxgds/
- Reddit, ClickUp automation order: https://www.reddit.com/r/clickup/comments/1h42j2l/
- Reddit, ClickUp drawbacks: https://www.reddit.com/r/clickup/comments/1decvpl/
- Monday new automation builder: https://support.monday.com/hc/en-us/articles/31585338491922-New-Automation-Builder
- Jira smart values: https://support.atlassian.com/cloud-automation/docs/what-are-smart-values/
- Jira debugging: https://support.atlassian.com/cloud-automation/docs/debug-an-automation-rule/
- Jira audit log: https://confluence.atlassian.com/automation112/use-the-audit-log-1688902303.html
- Zapier test steps: https://help.zapier.com/hc/en-us/articles/18811411817741-Test-Zap-steps
- Zapier history: https://help.zapier.com/hc/en-us/articles/8496291148685-View-and-manage-your-Zap-history
- Make scenario history: https://help.make.com/scenario-history
- Airtable automation management: https://support.airtable.com/docs/managing-airtable-automations
