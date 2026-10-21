# Automations gap check: Avi's Asana rules doc vs ALHC Automations V2
Date: Oct 21, 2026. Code checked at main `f90403f` (PR #50): `src/lib/rules.ts` registries (20 triggers, 26 conditions, 20 actions), `20261020010000_automations_v2.sql`, branches (Check if / Else if / Otherwise, up to 5).
Legend: ✅ supported · 🟡 partial · ❌ missing

## 1. Project rules — Triggers ("When…")
| # | Asana item (Avi's doc) | ALHC | Notes |
|---|---|---|---|
|1|Manual trigger|✅|`manual` (task … menu)|
|2|Scheduled: daily/weekly/monthly, how often, time of day, days|🟡|`scheduled` daily/workdays/weekly/monthly. Missing "every N", time of day, multiple days per week|
|3|Section changed / is now in / is not in / is one of|🟡|`section_changed` = moves into a picked section. Missing "any change", "moved out of", "one of" multi-pick|
|4|Task added to project — manually / from form (pick form)|✅|`task_created`, `form_submitted`, `task_added_from_project`; `source_is` condition|
|5|Assignee changed / empty / not empty / is / is not / one of|🟡|`assignee_changed` only; specifics via conditions. No "assigned to X" trigger filter|
|6|Task type is changed|❌||
|7|Due date changed / cleared / not empty / before / after / between|🟡|`due_date_changed` (set/moved/cleared); no value filters in trigger, no "between"|
|8|Due date approaching (min/hr/day/week)|🟡|`due_approaching` in days only|
|9|Task is overdue (min/hr/day/week)|🟡|`task_overdue` day-after only; no custom offset|
|10|Start date changed / cleared / before / after / between|❌||
|11|Start date approaching|❌||
|12|Start date passed ("overview")|❌||
|13|Approval status changed / approved / changes requested / rejected|✅|`approval_decided` with decision filter|
|14|Task no longer blocked (dependency)|❌|Dependencies exist in app; no trigger|
|15|Task / all subtasks changed / incomplete / complete|🟡|`task_completed`, `task_reopened`, `subtasks_completed`; no "a subtask is reopened"|
|16|Custom field changed (+ Check if)|✅|`field_changed` (optional value)|
|17|Attachment added|✅|`attachment_added`|
|18|Comment sent to / received from form submitter|🟡|`comment_added` covers submitter email replies; no "direction" filter (sent-to vs from submitter)|
| – |(ALHC extras)|✅|tag added, inbound webhook|

## 2. Project rules — Conditions ("Check if…")
| # | Asana item | ALHC | Notes |
|---|---|---|---|
|1|Custom AI condition|❌|No AI in rules|
|2|Section is / is not / is one of|✅|`section_is` / `section_is_not` (verify multi-pick for "one of")|
|3|Task added by form X|🟡|`source_is` = "a form"; can't pick which form|
|4|Assignee empty / not empty / is / is not / one of|✅||
|5|Due date empty / not empty / before / after / between|🟡|has/no due date, overdue, due within N days. No absolute before/after/between|
|6|Start date …|❌||
|7|Task type is / is not (task, milestone, approval)|🟡|`task_type_is` only; no "is not"|
|8|Task / subtasks complete / incomplete|✅||
|9|Approval status is|❌|Only as trigger|
|10|Task is no longer blocked / is blocked|❌||
|11|Number field = ≠ > ≥ < ≤ empty/not empty|✅|`field_equals`, `field_compare`, set/empty|
|11b|Select field empty / set to / isn't / one of|🟡|"one of" not explicit|
|12|Task has attachments|❌||
|13|Task has a comment|❌||
| – |(ALHC extras)|✅|tags, creator is, name contains, form answer contains, Else-if branches|

## 3. Project rules — Actions ("Do this…")
| # | Asana item | ALHC | Notes |
|---|---|---|---|
|1|Move to section (+AI picks)|🟡|`move_section`; no AI|
|2|Add / move to another project (+AI)|🟡|`add_to_project` adds only; no "move" (remove from this one); no AI|
|3|Remove task from project|❌||
|4|Complete / mark incomplete|✅||
|5|Set creative-request status (+AI)|🟡|`set_field` on a status field covers it; no AI|
|6|Change assignee|✅|person / creator / nobody. Missing round robin & "from a People field"|
|7|Set due date (+start date, +AI) / clear|🟡|due date relative/business days/clear ✅; **set start date ❌**; AI ❌|
|8|Set task title|✅|placeholders|
|9|Set description (+AI)|❌||
|10|Change custom field (+AI)|🟡|no AI|
|11|Create a task / milestone / approval (AI fills fields, AI decides how many)|❌|Only subtasks/template; no standalone task creation|
|12|Create subtask|✅|`create_subtasks`, `apply_task_template`|
|13|Create approval|✅|`request_approval`|
|14|Convert task to project (blank/template, portfolio, members, attachments)|❌||
|15|Set task type|❌||
|16|Add comment|✅||
|17|Add **or remove** collaborator|🟡|add only|
| – |(ALHC extras)|✅|notify, email, Slack, webhook, delay, tags|

## 4. Portfolio rules (Avi's doc section 2)
ALHC has **no portfolio rules** at all. All of these are ❌:
- Triggers: manual, work added / removed / archived, owner changed, status changed, due date (changed/cleared/before/after/between), due approaching, work overdue, custom field changed.
- Conditions: status is, owner, due date, start date, custom field.
- Actions: move/add to portfolio, remove, archive, mark complete, **draft status update with AI**, **status reminder**, change owner, change due date, set name, add/remove members with access level, set custom field.

## 5. Builder features mentioned in the doc
| Item | ALHC |
|---|---|
|Multiple outcomes from one cause|✅ (multi-action, branches)|
|Bundles (rules applied across projects, edit once updates everywhere)|❌ (templates gallery copies only)|
|"Browse before creating" rule gallery|✅ templates gallery|
|My Tasks rules (due approaching → move section, overdue → move)|❌ (verify; rules are project-scoped)|

## 6. Counts
Project-rule items scored: **49** — ✅ 15 · 🟡 18 · ❌ 16 (triggers 5/8/5, conditions 4/4/6, actions 6/6/5). Portfolio rules: ~32 options, all ❌. Builder: 2 ❌ (bundles, My Tasks rules).

## 7. What Asana added or changed since the doc (2025–2026)
| When | Change | Source |
|---|---|---|
|Winter 2026|Scheduled trigger "Every time period" incl. custom cadence; duplicate/reorder branches; rule duplication; auto AI model pick|https://assets.asana.biz/m/3e34462ee2b77742/original/Asana-Winter-2026-Release-Kit.pdf|
|Mar 2026|**Text field triggers & conditions**; rule duplication within project; reorder rules (display only); "Let AI Decide" model; Slack intake + comment sync rules (AI Studio); "Dropped"/"Completed" status options|https://forum.asana.com/t/asana-release-notes-march-2026/1133536|
|Apr 2026|**"Collaborator is added" trigger**; pause individual rules in a bundle; branch duplicate/reorder; AI toolbar in builder; trigger rules in bulk from portfolio grid|https://forum.asana.com/t/asana-release-notes-april-2026/1138067|
|Jul 2026|**More People conditions** (dynamic comparisons, e.g. assignee = creator; Task creator condition); **assign from People custom fields** (assignee, subtasks, approvals, roles); AI credit usage in rule run history|https://forum.asana.com/t/asana-release-notes-july-2026/1150306 · https://help.asana.com/s/article/release-notes|
|Aug 2026|AI Studio instruction suggestions; AI Teammates build/edit rules (human review) and summarize rules + run history|https://forum.asana.com/t/asana-release-notes-august-2026/1154956|
|Sep 2026|**Round robin in Set assignee**; recoverable custom fields (restores their rules); Dash/AI builds simple rules or pre-fills builder|https://forum.asana.com/t/asana-release-notes-september-2026/1157124|
|Ongoing|AI Studio: AI conditions, "Use AI" variable in actions|https://help.asana.com/s/article/ai-studio-smart-workflows|
|Note|"Task is no longer blocked" doesn't fire reliably for start-to-start deps — design ours to handle all 4 types|https://forum.asana.com/t/start-to-start-dependency-doesnt-trigger-when-task-is-no-longer-blocked-rule-trigger/865360|

Nothing in the doc appears removed; Asana only added.
ALHC status of new items: collaborator added ❌, text-field trigger 🟡 (field_changed works on any field; condition `contains` ✅), dynamic people compare ❌, creator condition ✅, People-field assign ❌, round robin ❌, rule duplicate (verify; likely 🟡 via templates), branch duplicate/reorder ❌, run history ✅ (dry-run tests + run log), AI anything ❌.

## 8. Missing items ranked by value for a marketing team
1. **Round robin / load-balanced assignment** — spreads creative requests across designers.
2. **Assign from a People field** (e.g. "Designer", "Reviewer" fields) — for subtasks, approvals, assignee.
3. **Start date triggers & conditions + "Set start date" action** — campaign kickoffs, move to "In progress" on start.
4. **Task no longer blocked** trigger (+ is blocked condition) — handoffs copy → design → review.
5. **Create a task** (standalone, in this or another project, with fields) — e.g. approved request spawns a production task.
6. **Portfolio rules (core set)** — status changed, owner changed, work added; actions: status reminder, set field, notify. Campaign portfolios need it.
7. **Approval status condition** + **remove collaborator** + **move (not just add) to project / remove from project**.
8. **Overdue / approaching in hours & custom offsets; scheduled time of day + every N**.
9. **Task type trigger/condition "is not" + set task type** action.
10. **Collaborator added** trigger; **has attachment / has comment** conditions; **form X** pick in source condition; dynamic people compare (assignee = creator).
11. **Convert task to project (from template)** — event request → full campaign project.
12. **Set description** action.
13. **AI in rules** (AI condition, AI-picked section/field, AI comment/description) — needs a paid model key; Avi said no paid tiers, so park unless he okays.
14. Bundles (shared rule sets) and branch duplicate/reorder; My Tasks rules.

## 9. Partial items — what's lacking
- Scheduled: time of day, every N weeks/months, multiple weekdays.
- Section trigger: "moved out of", "any section change", one-of multi-pick.
- Assignee/due date triggers: value filters inside the trigger (sentence builder can map these to auto-conditions).
- Approaching/overdue: minutes/hours/weeks offsets.
- Subtask trigger: "a subtask reopened".
- Submitter comment: direction filter.
- Form source: pick which form.
- Due date condition: absolute before/after/between.
- Select field: "is one of".
- Add to project: "move" option and "remove from this project".
- Collaborators: remove.
- Set assignee: round robin, from People field.

## 10. Proposed build batches (not started)
- **Batch A – People & routing:** round robin, assign from People field (assignee/subtasks/approvals), remove followers, collaborator-added trigger, assignee = creator dynamic compare, form-X picker.
- **Batch B – Dates:** start date triggers (changed, approaching, passed), start date conditions, set/clear start date, absolute before/after/between, hour/week offsets, scheduled time of day + every N + multi-day.
- **Batch C – Flow & structure:** task no longer blocked trigger + blocked condition, create standalone task/milestone/approval, move/remove from project, set task type + type-changed trigger + "is not", approval status condition, has attachment/comment, set description, section trigger moved-out/any/one-of, select "is one of".
- **Batch D – Portfolio rules:** triggers (work added/removed, status/owner/field changed, due approaching/overdue), conditions, actions (status reminder, set owner/date/field, add/remove members with access level, archive, complete).
- **Batch E – Builder polish:** duplicate rule (within/across projects), duplicate/reorder branches, pause rule in a set, convert task to project from template, My Tasks rules.
- **Later (needs Avi's OK on a paid model):** AI conditions and "Use AI" in actions; AI-drafted portfolio status updates.
