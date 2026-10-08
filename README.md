# ALHC Projects

Our own project management software: projects, sections, tasks, and subtasks (real tasks, nested up to 4 levels), with saved List, Board, Calendar, and Timeline views, project dashboards, portfolios (nestable, with custom fields, a timeline, and cross-project progress and reporting), goals with sub-goals and progress, a teams directory with group invites, a task detail pane, multi-select bulk edits and keyboard shortcuts, recurring tasks, due/start times, task dependencies (lag, start-to-start, across projects and subtasks) with a critical path and confirmed auto-shift, a per-project Trash, comments, custom fields, attachments, My Tasks, an Inbox, search, approvals, public intake forms, request numbers, and a rules engine with email, Slack messages (plain or Block Kit task cards), and signed outbound webhooks with a delivery log and retries. Built with Next.js 16 (App Router), Supabase (Auth + Postgres + RLS), and Tailwind CSS 4, and deployed on Vercel.

Architecture, data-model rules, and conventions are documented in [`AGENTS.md`](./AGENTS.md).

## What's here (core spine)

- Email + password sign-in through Supabase Auth (interim; Google sign-in returns later, see [Setup: sign-in](#setup-sign-in-email--password-interim)), gated by an email allowlist (`public.allowed_emails`). Non-allowlisted accounts are signed out and shown a denied screen.
- Data model: workspaces, projects, sections, tasks (a subtask is a task with a parent, since Real subtasks), multi-project task membership (`task_projects`), and profiles. All deletes are soft (`deleted_at`).
- Row Level Security on every table. Since Teams & permissions, the allowlist only decides who can sign in; project data is visible and editable according to each person's role in that project (see [What's here (teams & permissions)](#whats-here-teams--permissions)).
- Project home, List view, Board view (drag-and-drop or a "move to" menu), and a task detail pane (title, description, assignee, due date, subtasks, project memberships, delete).

## What's here (collaboration)

- **Comments and @mentions** in the task pane, shown in time order alongside an activity history (created, completed, assigned, moved, renamed, fields changed, files added). Type `@Full Name` or `@emailname` to mention someone.
- **Followers.** You follow a task automatically when you create it, are assigned to it, comment on it, or are mentioned. Follow or unfollow it from the comment box.
- **Inbox** (`/inbox`) with an unread badge in the sidebar. You get an item when you're assigned a task or @mentioned, and when someone comments on or completes a task you follow. Items can be marked read or unread, or all marked read at once. There's no email.
- **Custom fields** per project (Fields tab). Types are text, number, date, checkbox, single-select, multi-select, and people, plus an optional **Status** field that mirrors the project's sections. Values are edited in the task pane. Pinned fields show as List columns and Board card chips.
- **Attachments** on tasks: upload, open, and remove (soft delete), up to 25 MB per file.
- **My Tasks** (`/my-tasks`): everything assigned to you across projects, in your own sections (Recently assigned, Do today, Do next week, Do later, plus any you add) or — with the **Due dates** toggle — grouped by Overdue, Today, Next 7 days, Later, and No due date.
- **Search** (sidebar box or `/search`) over task titles and descriptions.

## What's here (workflows)

- **Approvals** in the task pane: ask someone to approve a task (optionally as an approval subtask). The approver can approve, request changes, or reject, with a note. Changes can be resubmitted, and open requests can be cancelled. Every step is logged in the activity history and reaches the requester, assignee, and followers through the Inbox. Settings tab: optionally complete the task when it's approved.
- **Forms** (Forms tab): build intake forms with short/long text, number, date, single/multiple choice, and checkbox questions. Questions can show or hide based on earlier answers. Answers can fill the task name, description, due date, section (or Status), and custom fields. Each form has a public link (`/forms/<id>`, no sign-in) and an iframe-friendly embed (`/forms/<id>/embed`). Submitting creates the task, assigns a request number, logs the submission, emails the submitter a confirmation, and runs rules.
- **Request numbers** (Settings tab): a per-project counter with a prefix and zero padding (e.g. `Req #042`), optionally added to the task name, for every task or only form submissions. Set the next number to continue an existing sequence.
- **Rules** (Rules tab): when a task is added, moves into a section, has a field or assignee change, is due soon, gets an approval decision, or comes from a form, check conditions and then move it, set a field or assignee, comment, add followers, send an inbox notification, request approval, send an email, or wait N hours before continuing. Rules are off until enabled. They can't trigger themselves in a loop, and each run is logged. Templates cover common patterns: due-tomorrow reminder, requester update when a section is entered, 24-hour nudge, tracking/shipping email, approval routing, and intake triage. You fill in the sections, fields, and people when installing a template.
- **Email** through [Resend](https://resend.com): form confirmations, requester updates, and due-tomorrow reminders. With no key configured, emails are mocked (logged and marked `mocked`) so everything else still works.

## What's here (views & insights)

- **Saved views.** Each project has tabs for its views. Every project starts with List, Board, Calendar, and Timeline views. Add more with **+ View**, and use a tab's **…** menu to rename, duplicate, reorder, or delete it (the last view can't be deleted). Views are shared by everyone in the project.
- **Filters, sort, group, columns.** The toolbar above every view can filter by completion (including "completed in the last N days"), due date (overdue, today, next N days, no date, or a date range), section, assignee (including "Me" and Unassigned), any custom field, and text. You can sort by up to three keys, group by section, assignee, or a single-select field, and choose which columns or card fields to show. Active filters show as removable chips. Changes stay in the URL as "Unsaved changes" until you **Save view** or **Save as new view**, so you can also share a filtered link. On Board, dragging a card between columns moves its section, assignee, or field value, depending on how the board is grouped.
- **Calendar.** Month and week views place tasks on their due date. Incomplete tasks without a due date sit in a **No due date** tray. Drag a task to another day to reschedule it, or onto the tray to clear its date. Click a task to open it.
- **Dashboard** (Dashboard tab): number cards and bar charts by section or by assignee, each with its own filters. Click **Add starter widgets** for a ready-made set (incomplete, overdue, completed this week, by section, by assignee). Widgets can be edited, reordered, and removed. "View tasks" opens the List view with the widget's filters.
- "Today", "overdue", and "last N days" use your browser's time zone. No new environment variables are needed.

## What's here (timeline)

- **Start dates.** Tasks have an optional start date next to the due date in the task pane (the start can't be after the due date). Lists can show a Start column, Board cards a start chip, and views can sort by start date. Changes are logged in the task's activity.
- **Timeline.** A Gantt-style view: each task is a bar from its start date to its due date. A task with only a due date is a one-day bar on that day; a task with only a start date is a one-day bar drawn with a dashed outline. Switch between Week, Month, and Quarter scales, and use Today and the arrows to move around. Bars are coloured by status (open, overdue in red, completed in grey). Drag a bar to move it, or drag either end to change its start or due date. Incomplete tasks with no dates sit in an **Unscheduled** tray; drag one onto a day to give it a due date. Filters, sorting, grouping, and "Show completed" work as on List. Calendar still places tasks by due date only.

## What's here (teams & permissions)

- **Project members and roles.** Every project has members with one of five roles: **Owner**, **Admin**, **Editor**, **Commenter**, **Viewer**. Viewers can read everything in the project; Commenters can also comment, follow, and decide approvals sent to them; Editors can change tasks, fields, sections, and views; Admins also manage rules, forms, settings, and members; Owners can also transfer ownership and delete the project. People who aren't members don't see the project at all (not in the sidebar, search, My Tasks, or Inbox).
- **Members page.** Settings → **Members**: invite someone by email (anyone in the workspace; people who haven't signed in yet get a pending invite that starts on their first sign-in), change roles, remove people, leave a project, or transfer ownership. A project always keeps at least one owner. "Guests" are simply people invited with a lower role such as Viewer or Commenter.
- **Existing projects** were backfilled when the migration ran: the creator became the owner and everyone else on the allowlist became an Editor, so nobody lost access. Narrow access per project from the Members page.
- **New projects** are owned by whoever creates them and start with only that person. Public forms keep working for anyone with the link.

## What's here (task depth)

- **Recurring tasks.** In the task pane, **Repeats** sets a task to repeat daily, weekly (optionally on chosen weekdays), monthly, or yearly, every N days/weeks/months/years, ending never, after a number of occurrences, or on a date. Completing a repeating task creates the next one (Asana style) with its dates moved forward, in the same projects and sections, with the same assignee, field values, followers, and subtasks (reopened, with their dates moved forward too). A task repeating monthly on the 31st lands on the last day of shorter months and comes back to the 31st. List rows and Board cards show a small repeat icon.
- **Due and start times.** Next to each date in the pane there is an optional time, entered in your own time zone. Calendar, Timeline, filters, rules, and forms keep working by day; dragging a timed task to another day keeps its time. The start can't be after the due date, to the minute.
- **Dependencies.** In the pane, **Blocked by** and **Blocking** link tasks (finish-to-start; since Scheduling depth and polish also start-to-start, with lag, across projects and between subtasks). A task can't be marked complete while a task it's blocked by is incomplete, and loops (A waits on B waits on A) are rejected. Blocked tasks show a lock with a count on List and Board, and the Timeline draws an arrow from each task to the one waiting on it (red when the waiting task starts before the first one is due). Editors and above can add or remove dependencies.
- **Trash.** Settings → **Trash** lists the project's deleted tasks, with who deleted them and when, and a **Restore** button. Restoring puts a task back in every project it was in, with its history. Only Editors and above can see the Trash; deleted tasks never appear in views, search, My Tasks, or the Inbox. Nothing is ever deleted permanently.

## What's here (portfolios and reporting)

- **Portfolios.** A portfolio groups projects so you can follow them together. Anyone can create one from the sidebar (**Portfolios → +**) and becomes its owner. The sidebar lists your portfolios with their progress.
- **Overview.** Each portfolio shows overall progress, completed / incomplete / overdue counts, and tasks completed in the last 7 days, plus a card per project with its status, progress, and counts. Editors can add projects (only projects they're a member of), remove them, reorder them, and edit the notes.
- **How progress is counted.** Completed ÷ (completed + incomplete) over the active tasks in the portfolio's projects, rounded down. A task that's in several of those projects counts once. A portfolio with no tasks shows “No tasks”. Overdue means incomplete and due before today in your time zone.
- **Report.** The Report tab has a table by project (status, incomplete, overdue, completed in the last 7 days, complete, progress, and a portfolio total) and a table by assignee.
- **Members and privacy.** Portfolios have their own members: **Owner**, **Admin**, **Editor**, **Viewer** (invite by email from Settings, same rules as projects). Being in a portfolio never gives access to its projects: you only see, and the numbers only count, the projects you're a member of. If some are hidden from you, the page says how many.
- **Project status.** In a project's Settings, Editors and above can set the status (On track, At risk, Off track, Complete) with an optional note. It shows as a badge on portfolio cards and in the report.

## What's here (integrations)

- **Send Slack message** (rule action): posts a message to a Slack channel through an [incoming webhook](https://api.slack.com/messaging/webhooks). The message can use the same tokens as comments and emails (`{task}`, `{section}`, `{project}`, `{assignee}`, `{req}`, `{due}`, …). Task details are escaped, so a task title can't ping `@channel`.
- **Call webhook** (rule action): POSTs a small JSON summary of the task (event, rule, project, task id/title/request number/section/assignee/due date, and a link) to an `https://` address, for Zapier, Make, or your own service. An optional shared secret is sent in a header (`X-ALHC-Webhook-Secret` by default), never in the body.
- **Settings → Integrations** (Admins and above): a default Slack webhook URL and a default outbound webhook URL + shared secret per project, used when a rule doesn't name its own. Saved URLs and secrets are never shown again: you see the host and last 4 characters, with **Replace** and **Clear**.
- **Delivery** works like email: a rule only queues the message; the app sends it right after the next change in the app, or on the scheduled cron. Failed deliveries are retried up to 5 times. The task's activity shows “queued a Slack message to hooks.slack.com …abcd” (and a failure line if it gives up), never the full URL.

## What's here (redesign)

- **Denser, Asana-like chrome.** A tighter sidebar (project swatches, smaller section labels, one-click "create your first project / portfolio"), a slimmer project header with the project's status badge and a **…** menu (settings, members, delete), and one toolbar style across List, Board, Calendar, and Timeline.
- **Task pane.** Quieter field rows (controls show a border on hover), a link to the task's home project in the pane header, consistent section headings, and a skeleton that appears as soon as you click a task while it loads.
- **Empty and loading states** on Home, My Tasks, Inbox, Search, Portfolios, and every project tab, with short copy saying what goes there and how to start. No data, settings, or permissions changed.

## What's here (Asana importer)

- **Settings → Import** (Admins and above): upload the **JSON** and/or **CSV** export of an Asana project (in Asana: the arrow next to the project name → **Export/Print**). The files are read on the server; the app never connects to Asana and never asks for an Asana token.
- **Dry run first.** The preview counts tasks, subtasks, comments, attachment links, sections, custom fields, tags, and dependencies, says how many are already here, and lists the people it found: matched to members (by email), with an account but not in this project (optionally invite them as Editors first), with no account, and with no email in the export. Upload the CSV next to the JSON to match assignees by email; Asana's JSON export often leaves emails out.
- **What comes across:** sections (matched by name), tasks with notes, due/start dates, completion, and assignee; subtasks with their assignee, dates, notes, and completion, nested as in Asana up to 4 levels (deeper ones land on the 4th); custom fields and their values (Asana dropdowns become single/multi-select, formula and ID fields become text); tags as a **Tags** multi-select field; comments (by the matching member, or by you with “<name> wrote in Asana:”); followers; dependencies; memberships in other Asana projects you imported here before. Attachments come across as **name + link only** (shown in the pane as “In Asana · not copied”); files are not copied.
- **Unmatched people** stay unassigned, with “Assignee in Asana: Name <email>” noted at the end of the task's description.
- **Safe to repeat.** Every row remembers its Asana id, so re-uploading the same export adds only what's new and never overwrites anything edited here. Large exports are imported in batches with a progress bar; if one stops, **Try again** resumes it.
- **Quiet.** An import doesn't run the project's rules, doesn't notify anyone, and writes one “imported this task from Asana” activity line per task. Rules supplied with an import (Asana's exports contain none) always land turned off.

## What's here (bulk edit and shortcuts)

- **Select many tasks** in List and My Tasks: tick the checkbox by a task, **Shift**-click for a range, **⌘/Ctrl**-click to add or remove one. A bar at the bottom completes or reopens them, assigns or unassigns, sets or clears the due date, moves them to a section, adds them to another project, sets a custom field (List), or moves them to the Trash — up to 200 at a time.
- **Partial apply, like Asana.** Every task that can change does; the rest are skipped and listed by name with the reason (blocked by a dependency, your role in its project, the assignee can't see it, …). Each task gets its usual activity line, notifications, and rules.
- **Drag to reorder** tasks within and between sections in List (manual sort, grouped by section), and drag sections (or use their ↑/↓ buttons) to reorder them.
- **Keyboard shortcuts** (press **?** for the list): **/** search, **↑/↓** select (**Shift** extends), **Enter** open, **Esc** close or clear, **⌘/Ctrl+Enter** complete, **Tab** then **Q** quick-add a task, **Tab** then **M** assign to me. They never fire while you're typing in a field.

## What's here (templates)

- **Templates** (sidebar) lists the workspace's project templates and the task templates of projects you're in. A seeded **Creative Requests** template (sections Intake, In Progress, Review, Approved, Delivered; fields Request type and Due date priority) is marked **Example**: edit it by using it, changing the new project, then **Save as template → Replace “Creative Requests”**.
- **Save as template** (project … menu → Settings → Templates, Admins and above) copies sections, tasks with subtasks and field values, custom fields, rules, forms, saved views, and request numbering. Task dates are stored as days from a project start date; **Use template** asks for a start date and works every date out from it. Assignees, members, comments, files, and completion stay behind. Everyone in the workspace can see templates.
- **Duplicate project** (project … menu, Editors and above) uses the same copy engine, with switches for tasks, assignees, dates (optionally shifted to a new start date), rules, forms, and members.
- **Quiet and safe.** A copy never runs rules or notifies anyone, and every copied rule arrives **turned off** until you turn it on (Slack/webhook URLs are not copied). The new project's Settings page says where it came from.
- **Task templates** (title, notes, subtasks, field values, optional assignee) are saved from a task's header or in Settings → Templates, and used from **Add task → Template** in List and Board. Tasks made this way are normal tasks: rules and notifications run as usual.

## What's here (workspace admin and comments)

- **Settings → Workspace** (gear next to your name) lists the **workspace admins**. Admins add other admins by allowlisted email and can remove them (the last admin can't leave). Workspace admins can rename, replace, or delete any project template, including the Creative Requests example, and see past Asana imports for the projects they can open. **It gives no access to private projects**: you still only see projects you're a member of. Imports still run from each project's Settings → Import.
- **Comments:** edit or delete your own (edited comments say “(edited)”; deleted ones leave a “Comment deleted” placeholder). Type `@` to pick a project member; the mention notifies them in their Inbox. Editing a comment notifies only people it newly mentions. React with 👍 ❤️ 🎉 😄 👀 ✅ (Commenters and above).
- **Inbox:** archive one notification or **Archive all**; the **Archived** tab keeps them and can move them back. Mark read / unread as before.

## What's here (My Tasks sections and workload)

- **My Tasks sections.** New assignments land in **Recently assigned**; drag tasks into **Do today**, **Do next week**, **Do later**, or sections you add (rename or delete them from the section's … menu — a deleted section's tasks go back to Recently assigned). Drag or use the arrows to reorder sections. Select tasks and use **Move** in the bar to file many at once. Sections are personal: nobody else sees or changes yours. **Due dates** (top right) switches back to the due-date buckets; your choice is remembered.
- **Workload** tab on every project and portfolio: one row per person, one column per day or week, counting their open tasks with a due date (from the start date to the due date when both are set). **Measure** switches between task counts and a number field (e.g. Effort, spread evenly over the task's days). Editors set each person's **weekly capacity**; cells over it turn red. Click a cell to list its tasks, then drag one onto another person or day to reassign or reschedule it — that's a normal task edit, so history, notifications, and rules run as usual. A portfolio's workload only counts projects you're a member of.

## What's here (Goals and Teams directory)

- **Teams** (sidebar → Teams): a workspace-wide directory everyone can read. Anyone can start a team and becomes its lead; leads and workspace admins add people by email, change roles (lead / member), remove people, and delete the team. **A team never opens a project by itself.** To give a team access, a project Owner or Admin uses **Settings → Members → Add a team**: everyone on the team who isn't in the project yet becomes an ordinary member with the role you pick (people already in the project keep theirs; later team changes don't touch the project). A team's page lists only the projects you can already open.
- **Goals** (sidebar → Goals): department and team goals in a tree with sub-goals, filtered by team and time period. Each goal has an owner, an optional team, a time period, a status (on track, at risk, off track, achieved, missed, dropped), and progress that is set manually, averaged from its sub-goals, or computed from the tasks of linked projects and portfolios. Everyone reads every goal; the owner, a lead of its team, or a workspace admin edits it and posts status updates. Progress from projects only counts the projects *you* can open — anything else is shown as "N linked projects aren't counted", never by name — so two people can see different numbers.

## What's here (critical path and portfolio depth)

- **Critical path** on every Timeline view: the **Critical path** button outlines the chain of dependencies that ends at the project's last due date with no slack and fades everything else. Hover a bar (or open the task) to see its **slack** — how many days its due date can slip before it pushes a waiting task or the project's end. It's read-only (nothing moves for you), and tasks without a due date are left out with a short note.
- **Project status history:** every saved project status is kept with its note, who, and when; the feed sits under the status form in project Settings, and portfolios show the latest update as a column.
- **Portfolios inside portfolios:** add a portfolio you're a member of to another one (Editors and above). Its projects roll into the parent's progress, report, and timeline — but only for people who are members of the nested portfolio *and* of each project; everyone else sees "N projects aren't shown". A portfolio can't end up inside itself.
- **Portfolio fields** (portfolio Settings → Fields): text, number, single-select, or date, with one value per project. Editors set them on the Overview cards; they show as Report columns, only for projects you can open.
- **Portfolio Timeline** tab: one bar per project from the earliest start to the latest due date of its open tasks, coloured by status, grouped by nested portfolio.

## What's here (task types and nested rollups)

- **Task types:** pick **Task**, **Milestone**, or **Approval** in the task pane's Type row or next to the quick-add box. Templates, Duplicate project, repeating tasks, and Asana imports keep the type.
- **Milestones** have only a due date and show as a diamond in List, Board, Calendar, and Timeline (drag to move it). The portfolio Timeline shows each project's open milestones as diamonds.
- **Approval tasks:** the assignee is the approver. Assigning one (or switching a task to Approval) asks them in their Inbox; they **Approve**, **Request changes**, or **Reject** at the top of the task. Approving or rejecting completes the task; reassigning asks the new person instead. Imported or copied approval tasks don't ask anyone until an editor clicks **Ask … to approve**.
- **Nested portfolios** now also count in a portfolio's **Workload** and in goal progress from linked portfolios — still only projects you can open.

## What's here (real subtasks)

- **Subtasks are tasks.** Each one has its own assignee, start and due dates, description, type, custom fields (the parent project's), comments, followers, attachments, and its own subtasks — up to 4 levels below a task.
- **In the task pane:** add subtasks inline, rename and tick them, pick an assignee and dates right in the list, reorder them (drag, or the up/down buttons), and open one in its own pane, which shows a breadcrumb back to its parent. A task shows how many of its subtasks are done (e.g. 2/5), in the pane and on List rows and Board cards.
- **Who sees them:** exactly the people who can see the top-level task — subtasks live in its projects and are never added to a project of their own.
- **Where they show up:** the assignee's **My Tasks** (with “in <parent task>”), **Inbox**, **Workload**, and search. In List, turn on **Show subtasks** in the toolbar to see each task's subtasks under it (off by default).
- **Deleting** a task moves its subtasks to the Trash with it; restoring it brings them back.
- **Rules and request numbers** apply to top-level tasks only; subtasks never trigger rules or get a Req #.
- **Copies keep them:** project templates, Duplicate project, repeating tasks, and Asana imports bring whole subtask trees; task templates keep subtask titles.
- **Existing checklists** became real subtasks automatically, keeping their completion, order, and approvals.

## What's here (reporting and export)

- **Reports** (sidebar): charts across every project you can open — tasks by status (open, overdue, completed), by project, by assignee, and by section, tasks completed per day or week, and an overdue list. Filter by projects, assignees, a date range (tasks due or completed in it), and **Include subtasks** (off by default; subtasks count in their top-level task's projects). Projects you can't open are never named, only counted (“N projects you're not a member of are left out”). Workspace admins see nothing extra.
- **All projects** (Reports tab): one row per project you can open with its status, latest update, incomplete / overdue / recently completed / complete counts, and progress.
- **My dashboards** (Reports tab): your own dashboards of widgets — numbers, bar charts by section / assignee / project, completed over time, and overdue lists — each with its own filters. Only you can see them. A widget limited to a project you can no longer open stays empty.
- **Export CSV** from List (the view's current filters, order, and columns, custom fields included), search results, the project Dashboard, Reports, and the portfolio Report. Exports only contain what you can read, up to 10,000 rows, and open cleanly in Excel (UTF-8; cells that look like formulas are kept as text).
- **Print / Save as PDF:** reports, dashboards, and the portfolio Report have a Print button and print without the sidebar or buttons (use the browser's Save as PDF).

## What's here (tags and collaboration extras)

- **Tags** work across every project. Add them from a task's **Tags** row in the pane (type to find one, or to create a new one), or to many tasks at once from the bulk bar (**Tag** → Add / Remove) in List and My Tasks. Tags show as coloured chips on List rows, Board cards, and search results.
- **Find tasks by tag:** filter a List / Board / Calendar / Timeline view by tag (or “No tag”), group List and Board by tag (a task with two tags shows under both; dragging a Board card between tag columns swaps the tag), search by tag name, and filter Reports and dashboard widgets by tag.
- **Managing tags:** Settings → Workspace → **Tags**. Anyone can create one; its creator or a workspace admin can rename, recolour, or archive it (archived tags stay on tasks but can't be added again). A tag never opens a project: you only see tagged tasks in projects you're a member of.
- **Copies keep tags:** project templates, Duplicate project, task templates, and repeating tasks carry them. Asana imports bring tags in as workspace tags (matched by name). Projects imported before this phase had a “Tags” field; its values were copied into real tags once, and the field itself was left in place (you can delete it from the Fields tab when you no longer need it).
- **Messages tab** on every project: start a thread with a title, reply, @mention people in the project, and react — like task comments, for things that aren't about one task. Everyone in the project can read them; Commenters and above can post. Mentions and replies to your threads land in your Inbox.
- **Attachment previews:** PNG, JPEG, GIF, and WebP images show as thumbnails in the task pane and open in a viewer (arrow keys move between images); PDFs open in the browser's PDF viewer. Other files (SVG included) always download. Files stay in the private bucket behind short-lived links.
- **CSV exports** now say so when a file was cut at 10,000 rows, and cells starting with a tab or line break are kept as text too.

## What's here (scheduling depth and polish)

- **Richer dependencies.** Each link in the pane's **Blocked by** / **Blocking** lists has a type and a lag: **Finish → start** (the later task starts on or after the earlier one's due date, and can't be completed before it) or **Start → start** (it starts on or after the earlier one's start; it never blocks completion), plus a lag in whole days (−365 to 365; negative = overlap). Links work between subtasks and across projects, as long as you're an Editor of both tasks. You only see a link when you can open both tasks; a task you can't open never shows up by name — the pane just says it's also waiting on “a task you can't open”.
- **Timeline and critical path** follow type and lag: start-to-start arrows leave the earlier bar's start, an arrow turns red when the later task starts before the link allows, and slack counts the lag.
- **Auto-shift, with a confirm.** Moving a task later (drag on Timeline or Calendar, or a new date in the pane) checks the tasks that depend on it. If any would start too early, a dialog lists what would move (and by how much, following the chain) and what won't — completed tasks and tasks you can't edit stay put. Untick any you want to leave, then **Move … too**, **Only move this task**, or **Cancel**. Nothing else moves without that click, and the toast offers **Undo**, which puts every moved date back (tasks changed since keep their new dates). Moving earlier never pulls tasks in.
- **Tag activity:** adding or removing a tag shows in the task's activity.
- **Decide approvals from the Inbox:** an approval request in your Inbox has **Approve**, **Request changes**, and **Reject** buttons while it's waiting on you (only the approver sees them; Viewers can't decide).
- **Convert a task to a subtask, and back.** Under **Projects** in the pane: “Convert to a subtask of …” (it leaves its projects and lives under the new parent) or, on a subtask, “Convert to a task in [project / section]”. Tags, field values, comments, dependencies, and its own subtasks stay with it; you need Editor on both sides, and the 4-level limit and loop checks still apply.
- **Show subtasks is saved with the view** (List): toggling it is an unsaved change like grouping or columns; **Save view** keeps it for everyone.

## What's here (daily essentials)

- **Private tasks in My Tasks.** The **Add task** box at the top of My Tasks creates a task with no project, assigned to you. Only you and whoever you assign it to can see it — nobody else can open it, find it in search, be @mentioned in it, follow it, or get notified about it (workspace admins included). Its subtasks follow the same rule. Add it to a project from the task pane (Projects → Add to a project…) and it becomes an ordinary task of that project; a project task can't be made private again.
- **Duplicate task.** The copy button in the task pane header opens **Duplicate task**: name the copy and choose what comes along (subtasks, assignee, dates, tags, field values, followers, attachments as links to the original files, dependencies). The copy lands where you can edit — the task's projects where you're an Editor, right below the original (a subtask's copy sits next to it; a private task's copy stays private) — and opens in the pane. It starts open, gets its own Req #, and leaves out people who couldn't see it.
- **Archive a project.** Project admins and owners use the project's **…** menu → **Archive project**. An archived project is read-only for everyone (no edits, comments, likes, rules, or form responses), shows a banner, and leaves the sidebar, Home, and every project picker. Its members still open it from **Archived projects** (linked on Home), where admins can **Unarchive** it. Non-members never see it. A task that's also in an active project stays editable there. Reports still count archived projects.
- **Likes.** A heart in the task pane header: Commenters and above like a task (and unlike it); everyone who can open the task sees the count and, on hover, who liked it.
- **Auto-shift everywhere you change dates.** The confirm-and-Undo prompt for dependent tasks now also comes up for a bulk **Due date** change in List and My Tasks and for drags in Workload (Timeline, Calendar, and the pane already had it). Moving a task earlier can now offer **Also pull dependents earlier (keep the gap)** — unticked by default, so nothing is pulled unless you ask. Rules never shift anything.

## Local development

```bash
npm install
cp .env.local.example .env.local   # fill in Supabase URL + anon key
npm run dev                        # http://localhost:3000
```

Checks:

```bash
npm run lint
npm run typecheck
npm run build
npm run db:test   # applies migrations to a throwaway local Postgres and runs the RLS smoke tests (10–99, then zz01 … zz06)
```

## What's here (integration depth)

- **Slack task cards.** A **Send Slack message** action can use **Message style → Block Kit (task card)**: your message, then the task title linked to it, project, assignee, due date, status, and an **Open task** button (the plain message is still sent for notifications). Any Slack message can include `{task_link}` — the task's title linked to it in the app. The link is the normal signed-in task link: people still sign in to open it, and nothing public or token-based is ever sent. Task details stay escaped, so a title can't ping `@channel` or add a link.
- **Signed webhooks.** **Settings → Integrations → Signing secret → Generate** (Admins and above) creates a secret for the project webhook, and a **Call webhook** action with its own URL can generate its own. The secret is shown **once** — copy it into the receiver. Each request then carries `X-ALHC-Timestamp` and `X-ALHC-Signature` (an HMAC of the timestamp and the body) so the receiver can prove it came from here; see “Setup: Slack and webhooks”. The shared-secret header keeps working alongside it.
- **Deliveries.** **Settings → Deliveries** (Admins and above) lists every Slack message and webhook call the project's rules queued: status, attempts, the receiver's response code, the last error, and when it was sent or will be tried next. Destinations show as host + last 4 characters only. A failed send is retried automatically after 5, 10, 20, then 30 minutes and marked failed after 5 attempts; **Retry** gives it one more attempt with the same content (up to 10), **Send now** skips the wait, and **Cancel** stops one that hasn't gone out.

## What's here (inbound integrations)

- **Inbound webhooks.** **Settings → Inbound** (Admins and above) creates an endpoint per project: a name, the section new tasks land in, a default assignee, and default tags. Anything that can POST JSON — Zapier's *Webhooks* action, a website form, a script — sends `{ "title": … }` to the endpoint's URL and a task appears in the project, created as the person who made the endpoint. The URL's token is shown **once** (stored only as a hash); **Rotate token** replaces it, **Turn off** pauses it, **Delete** retires it. Optionally require signed requests (the same `X-ALHC-Timestamp` / `X-ALHC-Signature` scheme as outbound webhooks; stale timestamps and replays are refused). **Recent calls** lists each call's result, HTTP status, the task it created, and any error or warning — never the body or the token.
- **Rules.** The new trigger **Created by inbound webhook** (any endpoint, or one) and the condition **Task came from → An inbound webhook** let existing rules react, e.g. ping Slack or route by a field.
- See “Setup: inbound webhooks” for a curl example and signature code.

`npm run db:test` needs PostgreSQL server binaries (`initdb`, `pg_ctl`) installed locally, e.g. `brew install postgresql@16` or `apt install postgresql`. It doesn't touch any Supabase project.

## What's here (email live)

- **Email goes out within a minute.** Server actions still send right after they finish. On top of that, a database job (`alhc-delivery-kick`, every minute) asks the app to deliver anything due: email, Slack, and webhooks. It only calls the app when something is waiting. Set it up once in “Setup: email (Resend) and the workflows cron”.
- **Honest status.** A task's activity says “queued an email to …”, then **Sent**, **Retrying (attempt n of 5 failed: reason)**, or **Failed: reason**. **Settings → Deliveries** (Admins and above) lists the project's emails next to Slack and webhooks, with **Retry** / **Send now**.
- **Form submitters follow their request.** When someone with an ALHC account submits a form, and can open the project the form feeds, they follow the new task. Requesters without access keep getting the requester emails only.
- **Comment emails.** A new comment emails every follower except its author: task, project, the comment, and an **Open task** link. Each email is checked again just before sending, so someone who lost access gets nothing. Everyone can turn this off in **Settings → Profile → Email me about comments** (on by default).
- **Reply by email.** With inbound replies set up (“Setup: reply by email”), replying to a comment email posts the reply as a comment by you. Only the text above the quoted message is posted, and only from the address the email was sent to.

## What's here (Asana feel, batch 2)

- **Teams are required.** The workspace has a default team (**Autumn Lake**, created by the migration; every existing project joined it). New projects pick a team — the default team is preselected — and a privacy: **Public to team** (everyone on the team can find and join it) or **Private to members**. Existing projects stayed private. New members join the default team on their first sign-in. Team pages show members, when each joined, pending invites, and the team's projects.
- **Members in the app.** Settings → Workspace → **Members** lists everyone (name, email, Admin / Member, signed in or invited, teams). Workspace admins invite by email (an invite email with a sign-up link goes through the email outbox), resend, remove (sign-in stops; their tasks, comments, and memberships stay), add back, and make people admins (never the last one).
- **Invite before sign-in.** Projects, portfolios, and teams accept people who haven't signed in yet: the invite waits and becomes a membership on their first confirmed sign-in.
- **Browse projects** (sidebar, Home, and team pages): your projects plus public projects of your teams, with **Join** (as an Editor). Private projects never appear for non-members, workspace admins included.
- **Workspace settings** like Asana's admin console: General (name, logo, default team, past imports), Members, Teams, Tags, Email (sender name, delivery status, links to each project's Deliveries log), Security (sign-in methods, read-only). Everyone sees the same sections; admin-only ones are read-only for members.
- **Softer inputs** everywhere: rounded corners, lighter borders, more padding, a soft focus ring, muted placeholders.

## Setup: Supabase

1. **Create a project** at [supabase.com/dashboard](https://supabase.com/dashboard). Note the project ref (the `xxxx` in `https://xxxx.supabase.co`).
2. **Apply the migrations.** Either:
   - CLI: `npx supabase login`, then `npx supabase link --project-ref <ref>`, then `npx supabase db push`
   - or open the SQL editor and run each file in `supabase/migrations/` in filename order.
   - The production project is shared with another app, so each new phase's migration file is applied with the Supabase connector's `apply_migration` (in small chunks, `<phase>_a`, `_b`, …) once its PR's checks pass and **before** the PR is merged; never reset or `db push --include-all` it. See “Shipping a phase” in `AGENTS.md`.
3. **Add people to the allowlist** in the SQL editor (the emails they sign in with; they're normalised to lowercase):

   ```sql
   insert into public.allowed_emails (email, note)
   values ('avi@yourdomain.com', 'Avi');
   ```

   Since Asana feel, batch 2, workspace admins do this in the app instead: Settings → Workspace → **Members** → *Invite people* adds the address and emails a sign-up link (through the email outbox), and *Remove* blocks future sign-ins without touching the person's work (`allowed_emails.removed_at`; their next request gets signed out). The SQL route still works for the very first people. `supabase/seed.sql` only contains a placeholder (`owner@example.com`) and is applied by `supabase db reset` for local stacks.
4. **Workspace admin:** the Workspace admin and comments migration makes `avweinreb@autumnlakemarketing.com` the first workspace admin if that account already exists (signed in once, allowlisted); otherwise it does nothing. To set the first admin later, run in the SQL editor:

   ```sql
   select public.seed_workspace_admin('name@yourdomain.com');
   ```

   After that, admins add each other in Settings → Workspace.
5. **Configure sign-in** as described in [Setup: sign-in](#setup-sign-in-email--password-interim). The allowlist also requires a confirmed email.
6. **Storage:** the collaboration migration creates the private bucket **`task-attachments`** (25 MB per-file limit) and its `storage.objects` policies (since Teams & permissions: `task_attachments_objects_select_viewer` and `task_attachments_objects_insert_editor`, which follow the task's project roles). Nothing to click, but check two things:
   - Storage → Settings → **Upload file size limit** (the project-wide cap) must be at least 25 MB, or uploads fail below the bucket limit.
   - Files are stored as `<task id>/<uuid>-<file name>` and are only reachable through short-lived signed URLs issued by the app (`/attachments/<id>`). Removing an attachment hides it but leaves the object in Storage.
   - Previews (Tags and collaboration extras) are served inline only when the file name, the recorded type, and the type Storage reports for the object all say PNG / JPEG / GIF / WebP / PDF; the app reads that with Storage's object info endpoint (`storage-js` `info()`). If that endpoint isn't available on your Storage version, every file simply downloads instead of previewing.
   - The Asana importer migration adds a second private bucket, **`imports`** (50 MB per file), for uploaded export files at `<project id>/<uploader id>/<uuid>-<file name>`. Only the uploader can read or remove them, and only while they're an Admin of the project; the app removes them when an import finishes. Raise the project-wide upload limit to 50 MB if you import large exports.
7. **Realtime (optional):** the migrations add `comments`, `comment_reactions`, `task_stories`, `inbox_items`, `approval_requests`, `project_messages`, `project_message_reactions`, and `task_likes` to the `supabase_realtime` publication, so comments, activity, approvals, messages, and the inbox update live. If Realtime is disabled, the app still works: pages refresh after your own actions and the inbox badge polls every 60 seconds.
8. **Scheduled rules (recommended):** enable the **`pg_cron`** extension (Database → Extensions) *before* applying the workflows migration, and it schedules `alhc-workflow-tick` every 5 minutes. That runs "wait N hours" steps and "due date is approaching" rules. If you enable `pg_cron` later, schedule it yourself in the SQL editor:

   ```sql
   select cron.schedule('alhc-workflow-tick', '*/5 * * * *', 'select public.workflow_tick()');
   ```

   Without `pg_cron`, the Vercel cron below runs `workflow_tick()` once a day instead.

## Setup: email (Resend) and the workflows cron

1. In [Resend](https://resend.com), verify a sending domain and create an API key.
2. Set `RESEND_API_KEY`, `EMAIL_FROM` (e.g. `ALHC Projects <requests@yourdomain.com>`), and optionally `EMAIL_REPLY_TO`.
3. Set `SUPABASE_SERVICE_ROLE_KEY` (server-only). The app uses it only to claim and deliver queued emails and for the cron route.
4. Set `CRON_SECRET` to a long random string. `vercel.json` calls `/api/cron/workflows` daily, and Vercel sends the secret automatically. On a Pro plan you can make it more frequent (e.g. `*/15 * * * *`), or call it from any scheduler with `Authorization: Bearer <CRON_SECRET>`.

5. **Delivery within a minute (pg_cron + pg_net).** The Email live migration enables `pg_net` and schedules `alhc-delivery-kick` every minute. When an email, Slack message, or webhook is due, it calls `<app url>/api/cron/workflows` with the cron secret. It reads both values from Supabase Vault and does nothing until they exist. Add them once in the SQL editor, pasting the real values (don't commit them anywhere):

   ```sql
   select vault.create_secret('https://<your production domain>', 'alhc_app_url', 'ALHC delivery kick: app origin');
   select vault.create_secret('<the CRON_SECRET value from Vercel>', 'alhc_cron_secret', 'ALHC delivery kick: bearer secret');
   ```

   To change one later: `select vault.update_secret((select id from vault.secrets where name = 'alhc_cron_secret'), '<new value>');`. To check the kick: `select public.alhc_kick_delivery();` returns `true` when it made a request (only while something is due), and `select status_code, created from net._http_response order by created desc limit 5;` shows the app's answers (200 = delivered; 401 = the secret doesn't match `CRON_SECRET`).

Emails are also delivered right after any action in the app, so the kick covers emails queued by scheduled rules, delayed steps, and anything that failed and is due for a retry. Leave the Resend variables empty to mock email. To inspect what would have been sent, run `select to_email, template, subject, status from public.email_outbox order by created_at desc;`.

## Setup: reply by email

Comment emails get a per-person, per-task **Reply-To** address (`r-<token>@reply.mail.autumnlakemarketing.com`) only when `RESEND_WEBHOOK_SECRET` is set. Without it, `/api/inbound/email` answers 503 and emails carry no Reply-To.

1. **DNS:** add one MX record at the DNS host for `autumnlakemarketing.com`:

   | Type | Host / name | Value | Priority |
   | --- | --- | --- | --- |
   | MX | `reply.mail` (= `reply.mail.autumnlakemarketing.com`) | the receiving server Resend shows for that domain (Resend → Domains → the domain → Receiving) | the priority Resend shows (usually 10) |

   It's a new subdomain, so the root domain's Google Workspace mail is unaffected. It must be the only (lowest-priority) MX for that subdomain.
2. **Resend → Domains:** add `reply.mail.autumnlakemarketing.com` (or turn on **Receiving** for an existing domain that covers it), add the MX record it shows, click **I've added the record**, and wait for Receiving to show **Verified**.
3. **Resend → Webhooks → Add webhook:** endpoint `https://<your production domain>/api/inbound/email`, event **`email.received`** only. Copy its **signing secret** (`whsec_…`).
4. **Vercel → Environment Variables (Production):** `RESEND_WEBHOOK_SECRET` = that signing secret. Optional `EMAIL_REPLY_DOMAIN` if you use another receiving domain. Redeploy.
5. Test it: comment on a task someone else follows, have them reply to the email, and the reply shows up as their comment. If it doesn't, the Resend webhook's delivery log shows the route's answer. The route also logs `Reply by email: rejected (sender_mismatch | no_access | unknown_token | empty)` without the body or address.

A reply is posted only when the token matches, the sender's address is that person's ALHC address, Resend didn't report a failed DMARC check, and the person can still comment on the task.

## Setup: Slack and webhooks

1. **Slack:** in Slack, create an app (or open one) at api.slack.com/apps → **Incoming Webhooks** → turn it on → **Add New Webhook to Workspace** → pick a channel. Copy the `https://hooks.slack.com/services/…` URL into the project's **Settings → Integrations**, or into a single rule's **Send Slack message** action. No Slack OAuth app is needed.
2. **Outbound webhooks:** paste the receiver's `https://` URL (plain `http`, local, and private-network addresses are rejected) and, optionally, a shared secret and header name. The receiver should compare the header to the secret.
3. **Signed webhooks (recommended):** generate a signing secret (project: Settings → Integrations; a single rule with its own URL: the action's **Request signing**), copy it when it's shown, and verify every request in the receiver:

   ```js
   // Node receiver: verify before trusting the body. `raw` is the exact request body string.
   import { createHmac, timingSafeEqual } from "node:crypto";
   function verify(raw, headers, secret) {
     const ts = Number(headers["x-alhc-timestamp"]);
     if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false; // stale or missing
     const expected = "sha256=" + createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
     const given = String(headers["x-alhc-signature"] ?? "");
     return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
   }
   ```

   Retries send the same body with a new timestamp and the same `Idempotency-Key: integration-outbox-<id>`, so receivers can drop duplicates.
4. Delivery needs `SUPABASE_SERVICE_ROLE_KEY` (same as email). Set `INTEGRATIONS_MOCK=true` to log deliveries as `[integration:mocked]` instead of POSTing (useful for previews). `NEXT_PUBLIC_APP_URL` (or Vercel's production URL) adds `task.url` deep links to webhook payloads and turns `{task_link}` / the Block Kit **Open task** button into links (without it they show the plain title and no button).
4. To inspect deliveries (service role / SQL editor only — clients can't read this table): `select channel, target_hint, status, attempts, last_error from public.integration_outbox order by created_at desc;`.

## Setup: inbound webhooks

1. In the project, open **Settings → Inbound → Add inbound webhook**. Pick the section, default assignee, and default tags, and whether requests must be signed. Copy the URL (and signing secret) when they're shown — they can't be shown again; **Rotate token** / **Replace signing secret** issue new ones.
2. Send a request (unsigned endpoint; `<token>` is the part of the URL that starts with `alhc_in_`):

   ```bash
   curl -X POST 'https://<your app>/api/inbound/<token>' \
     -H 'Content-Type: application/json' \
     -H 'Idempotency-Key: order-1042' \
     -d '{"title": "New flyer request", "notes": "From the website", "due_on": "2026-11-02",
          "assignee_email": "someone@yourdomain.com", "tags": ["Web"],
          "fields": {"Priority": "High", "Budget": 250}}'
   ```

   Body (JSON object, UTF-8, ≤ 64 KB): `title` (required, ≤ 500 characters), `notes`, `due_on` (`YYYY-MM-DD`), `assignee_email` (a project member, else the default assignee), `tags` (names of existing workspace tags, added to the defaults), `fields` (custom field values **by field name**: text, number, date, `true`/`false`, an option name or a list of them, member emails for people fields, a section name for a Status field bound to sections). Unknown tags, fields, keys, and non-member emails are skipped and reported as `warnings`. Answers: `201 {"ok": true, "task_id": …}`, `200` with `"duplicate": true` when the `Idempotency-Key` was already used (same task, nothing new), `400` / `413` / `422` with the reason, `429` past 60 calls a minute per endpoint, and a generic `401 {"ok": false, "error": "Unauthorized"}` for every authentication problem (unknown, rotated, turned-off, or deleted token; missing, wrong, stale, or replayed signature; an endpoint whose creator lost Editor access or whose project is archived) — so no answer confirms that a token exists. The **Recent calls** log tells admins which one it was.
3. **Signed endpoints** also need `X-ALHC-Timestamp` (Unix seconds, within 300 seconds of the server clock) and `X-ALHC-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>` over the exact bytes you send. Each signature works once. In Node:

   ```js
   import { createHmac } from "node:crypto";
   const body = JSON.stringify({ title: "New flyer request" });
   const ts = Math.floor(Date.now() / 1000);
   const signature = "sha256=" + createHmac("sha256", process.env.ALHC_SIGNING_SECRET).update(`${ts}.${body}`).digest("hex");
   await fetch(url, {
     method: "POST",
     headers: { "Content-Type": "application/json", "X-ALHC-Timestamp": String(ts), "X-ALHC-Signature": signature },
     body, // send exactly the string you signed
   });
   ```

   Or from a shell: `sig=$(printf '%s' "$ts.$body" | openssl dgst -sha256 -hmac "$secret" -hex | sed 's/^.* //')`, then send `X-ALHC-Signature: sha256=$sig`.
4. Tasks are written through the public (anon) key by the database function `receive_inbound_webhook` — never the service role — as the endpoint's creator, who must still be an Editor or above of the project. Rules the new task fires (Slack, email, webhooks) are delivered right after the response, like form submissions (that delivery needs `SUPABASE_SERVICE_ROLE_KEY`, as for every rule delivery).

## Setup: sign-in (email + password, interim)

Until Google OAuth is configured, the login page shows an email + password form with **Sign in** and **Sign up**. The allowlist works the same as with Google: after Supabase accepts the credentials, the app checks `is_allowlisted()`. If the email isn't allowlisted, the session is signed out and the denied screen is shown.

1. In Supabase, open Authentication → Sign In / Providers → **Email**. Make sure it's **enabled**, and keep **Confirm email** turned on. Confirmation is what proves the person owns the inbox. Without it, anyone who knows an allowlisted address could sign up as that person first. `is_allowlisted()` also ignores unconfirmed users.
2. Under Authentication → **URL Configuration**, set **Site URL** to the production URL (`https://alhc-projects.vercel.app`) and add `https://alhc-projects.vercel.app/**` and `http://localhost:3000/**` to **Redirect URLs**. Confirmation links go to `/auth/callback`, which applies the allowlist gate.
3. Create accounts in one of two ways:
   - **Sign up in the app.** Enter an allowlisted email and a password, then click **Sign up**. Supabase emails a confirmation link. Open it in the same browser, then sign in. If the link opens in another browser, you'll land on the login page with an error. The email is still confirmed, so just sign in. A non-allowlisted email can still confirm its address, but it's signed out at the callback and sent to the denied screen. It never holds a session in the app.
   - **Create the user in the dashboard** (most reliable). Supabase's built-in email sender only delivers to your organization's team members and is heavily rate-limited unless custom SMTP is set up. Open Authentication → Users → **Add user** → *Create new user*, enter the allowlisted email and a password, and tick **Auto Confirm User**. Then sign in on `/login`. You can also turn off **Allow new users to sign up** (Authentication → Sign In / Providers) so accounts can only be created here.

To sign Avi in, his addresses must be in `public.allowed_emails` (see the Supabase setup above). Then create a password user for one of them with either method.

## Setup: Google OAuth (later)

Google is the long-term sign-in method. The Google button code is still in the app (`src/app/login/google-sign-in-button.tsx`), but it's hidden until `AUTH_GOOGLE_ENABLED=true` is set (on Vercel, then redeploy). To turn it back on:

1. Complete the steps below in Google Cloud and Supabase.
2. Set `AUTH_GOOGLE_ENABLED=true`. The login page then shows **Continue with Google** below the password form.
3. Once everyone has signed in with Google, you can turn the Email provider off in Supabase. Existing users keep the same `auth.users` row when the email matches, so their profile, tasks, and history stay the same.

These steps have to be done by hand in the Google Cloud and Supabase consoles:

1. In [Google Cloud Console](https://console.cloud.google.com/), open APIs & Services → **OAuth consent screen**. Choose *Internal* if everyone uses one Google Workspace domain; otherwise choose *External* and add test users or publish the app.
2. Go to APIs & Services → **Credentials** → *Create credentials* → **OAuth client ID** → *Web application*.
   - **Authorized JavaScript origins:** `http://localhost:3000` and your production URL (e.g. `https://projects.example.com`).
   - **Authorized redirect URIs:** `https://<project-ref>.supabase.co/auth/v1/callback`
3. In Supabase, open Authentication → Sign In / Providers → **Google**. Enable it and paste the client ID and secret.
4. In Supabase, open Authentication → **URL Configuration**:
   - **Site URL:** your production URL
   - **Redirect URLs:** add all of these:
     - `http://localhost:3000/**`
     - `https://<production-domain>/**`
     - `https://*-<vercel-team-slug>.vercel.app/**` (lets Vercel preview deployments complete sign-in)

The app sends users to `/auth/callback?next=…` after Google sign-in. Supabase will only redirect to URLs that match the list above.

## Setup: Vercel

1. Import `AutumnAvi/ALHC-Projects` in Vercel. The framework preset (Next.js) and build command (`npm run build`) are detected automatically; `vercel.json` only declares the workflows cron.
2. Under Settings → Environment Variables, set these for **Production** and **Preview**:

   | Name | Value |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon (or publishable) key |
   | `SUPABASE_SERVICE_ROLE_KEY` | Server-only. Needed to deliver email, Slack messages, and webhooks, and to run the cron route |
   | `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO` | Optional. Email via Resend; mocked when unset |
   | `INTEGRATIONS_MOCK` | Optional. `true` logs Slack/webhook deliveries instead of sending them |
   | `CRON_SECRET` | Secret for `/api/cron/workflows` (also stored in Supabase Vault as `alhc_cron_secret` for the every-minute delivery kick) |
   | `RESEND_WEBHOOK_SECRET` | Optional. Resend webhook signing secret (`whsec_…`) for reply by email; without it replies are off |
   | `EMAIL_REPLY_DOMAIN` | Optional. Receiving domain for reply addresses (default `reply.mail.autumnlakemarketing.com`) |
   | `NEXT_PUBLIC_APP_URL` | Optional. Canonical origin for public form links, webhook `task.url` links, and Slack task links |
   | `AUTH_GOOGLE_ENABLED` | Optional. `true` shows "Continue with Google" once the Google provider is configured |

   The Supabase ↔ Vercel Marketplace integration sets the same names automatically if you prefer it.
3. Deploy. If you add or change env vars later, redeploy so they take effect. Without them, every page shows a "Supabase isn't configured" screen instead of crashing.

## Project scripts

| Script | What it does |
| --- | --- |
| `dev` / `build` / `start` | Next.js |
| `lint` | ESLint (`eslint-config-next`) |
| `typecheck` | `tsc --noEmit` |
| `db:test` | Local migration + RLS smoke tests (`supabase/tests/*_smoke.sql`, in filename order; after `99_` new suites are named `zz01_`, `zz02_`, …, never `100_` or `991_`). Optional `supabase/tests/fixtures/before_<migration>.sql` files load old-model rows just before that migration |
| `db:types` | Regenerate `src/lib/supabase/database.types.ts` from the linked project (`npx supabase link` first) |
