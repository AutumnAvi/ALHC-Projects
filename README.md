# ALHC Projects

Our own project management software: projects, sections, tasks, and subtasks, with saved List, Board, Calendar, and Timeline views, project dashboards, portfolios with cross-project progress and reporting, a task detail pane, recurring tasks, due/start times, task dependencies, a per-project Trash, comments, custom fields, attachments, My Tasks, an Inbox, search, approvals, public intake forms, request numbers, and a rules engine with email, Slack messages, and outbound webhooks. Built with Next.js 16 (App Router), Supabase (Auth + Postgres + RLS), and Tailwind CSS 4, and deployed on Vercel.

Architecture, data-model rules, and conventions are documented in [`AGENTS.md`](./AGENTS.md).

## What's here (core spine)

- Email + password sign-in through Supabase Auth (interim; Google sign-in returns later, see [Setup: sign-in](#setup-sign-in-email--password-interim)), gated by an email allowlist (`public.allowed_emails`). Non-allowlisted accounts are signed out and shown a denied screen.
- Data model: workspaces, projects, sections, tasks, subtasks, multi-project task membership (`task_projects`), and profiles. All deletes are soft (`deleted_at`).
- Row Level Security on every table. Since Teams & permissions, the allowlist only decides who can sign in; project data is visible and editable according to each person's role in that project (see [What's here (teams & permissions)](#whats-here-teams--permissions)).
- Project home, List view, Board view (drag-and-drop or a "move to" menu), and a task detail pane (title, description, assignee, due date, subtasks, project memberships, delete).

## What's here (collaboration)

- **Comments and @mentions** in the task pane, shown in time order alongside an activity history (created, completed, assigned, moved, renamed, fields changed, files added). Type `@Full Name` or `@emailname` to mention someone.
- **Followers.** You follow a task automatically when you create it, are assigned to it, comment on it, or are mentioned. Follow or unfollow it from the comment box.
- **Inbox** (`/inbox`) with an unread badge in the sidebar. You get an item when you're assigned a task or @mentioned, and when someone comments on or completes a task you follow. Items can be marked read or unread, or all marked read at once. There's no email.
- **Custom fields** per project (Fields tab). Types are text, number, date, checkbox, single-select, multi-select, and people, plus an optional **Status** field that mirrors the project's sections. Values are edited in the task pane. Pinned fields show as List columns and Board card chips.
- **Attachments** on tasks: upload, open, and remove (soft delete), up to 25 MB per file.
- **My Tasks** (`/my-tasks`): everything assigned to you across projects, grouped by Overdue, Today, Next 7 days, Later, and No due date.
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
- **Members page.** Settings → **Members**: invite someone by email (they must already be on the allowlist and have signed in once), change roles, remove people, leave a project, or transfer ownership. A project always keeps at least one owner. "Guests" are simply people invited with a lower role such as Viewer or Commenter.
- **Existing projects** were backfilled when the migration ran: the creator became the owner and everyone else on the allowlist became an Editor, so nobody lost access. Narrow access per project from the Members page.
- **New projects** are owned by whoever creates them and start with only that person. Public forms keep working for anyone with the link.

## What's here (task depth)

- **Recurring tasks.** In the task pane, **Repeats** sets a task to repeat daily, weekly (optionally on chosen weekdays), monthly, or yearly, every N days/weeks/months/years, ending never, after a number of occurrences, or on a date. Completing a repeating task creates the next one (Asana style) with its dates moved forward, in the same projects and sections, with the same assignee, field values, followers, and open subtasks. A task repeating monthly on the 31st lands on the last day of shorter months and comes back to the 31st. List rows and Board cards show a small repeat icon.
- **Due and start times.** Next to each date in the pane there is an optional time, entered in your own time zone. Calendar, Timeline, filters, rules, and forms keep working by day; dragging a timed task to another day keeps its time. The start can't be after the due date, to the minute.
- **Dependencies.** In the pane, **Blocked by** and **Blocking** link tasks in the same project (finish-to-start). A task can't be marked complete while a task it's blocked by is incomplete, and loops (A waits on B waits on A) are rejected. Blocked tasks show a lock with a count on List and Board, and the Timeline draws an arrow from each task to the one waiting on it (red when the waiting task starts before the first one is due). Editors and above can add or remove dependencies.
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
- **What comes across:** sections (matched by name), tasks with notes, due/start dates, completion, and assignee; subtasks (title + completion; nested ones are flattened); custom fields and their values (Asana dropdowns become single/multi-select, formula and ID fields become text); tags as a **Tags** multi-select field; comments (by the matching member, or by you with “<name> wrote in Asana:”); followers; dependencies; memberships in other Asana projects you imported here before. Attachments come across as **name + link only** (shown in the pane as “In Asana · not copied”); files are not copied.
- **Unmatched people** stay unassigned, with “Assignee in Asana: Name <email>” noted at the end of the task's description.
- **Safe to repeat.** Every row remembers its Asana id, so re-uploading the same export adds only what's new and never overwrites anything edited here. Large exports are imported in batches with a progress bar; if one stops, **Try again** resumes it.
- **Quiet.** An import doesn't run the project's rules, doesn't notify anyone, and writes one “imported this task from Asana” activity line per task. Rules supplied with an import (Asana's exports contain none) always land turned off.

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
npm run db:test   # applies migrations to a throwaway local Postgres and runs the RLS smoke tests (10–91)
```

`npm run db:test` needs PostgreSQL server binaries (`initdb`, `pg_ctl`) installed locally, e.g. `brew install postgresql@16` or `apt install postgresql`. It doesn't touch any Supabase project.

## Setup: Supabase

1. **Create a project** at [supabase.com/dashboard](https://supabase.com/dashboard). Note the project ref (the `xxxx` in `https://xxxx.supabase.co`).
2. **Apply the migrations.** Either:
   - CLI: `npx supabase login`, then `npx supabase link --project-ref <ref>`, then `npx supabase db push`
   - or open the SQL editor and run each file in `supabase/migrations/` in filename order.
3. **Add people to the allowlist** in the SQL editor (the emails they sign in with; they're normalised to lowercase):

   ```sql
   insert into public.allowed_emails (email, note)
   values ('avi@yourdomain.com', 'Avi');
   ```

   To remove access later, run `delete from public.allowed_emails where email = '...';`. Their next request gets signed out. `supabase/seed.sql` only contains a placeholder (`owner@example.com`) and is applied by `supabase db reset` for local stacks.
4. **Configure sign-in** as described in [Setup: sign-in](#setup-sign-in-email--password-interim). The allowlist also requires a confirmed email.
5. **Storage:** the collaboration migration creates the private bucket **`task-attachments`** (25 MB per-file limit) and its `storage.objects` policies (since Teams & permissions: `task_attachments_objects_select_viewer` and `task_attachments_objects_insert_editor`, which follow the task's project roles). Nothing to click, but check two things:
   - Storage → Settings → **Upload file size limit** (the project-wide cap) must be at least 25 MB, or uploads fail below the bucket limit.
   - Files are stored as `<task id>/<uuid>-<file name>` and are only reachable through short-lived signed URLs issued by the app (`/attachments/<id>`). Removing an attachment hides it but leaves the object in Storage.
   - The Asana importer migration adds a second private bucket, **`imports`** (50 MB per file), for uploaded export files at `<project id>/<uploader id>/<uuid>-<file name>`. Only the uploader can read or remove them, and only while they're an Admin of the project; the app removes them when an import finishes. Raise the project-wide upload limit to 50 MB if you import large exports.
6. **Realtime (optional):** the migrations add `comments`, `task_stories`, `inbox_items`, and `approval_requests` to the `supabase_realtime` publication, so comments, activity, approvals, and the inbox update live. If Realtime is disabled, the app still works: pages refresh after your own actions and the inbox badge polls every 60 seconds.
7. **Scheduled rules (recommended):** enable the **`pg_cron`** extension (Database → Extensions) *before* applying the workflows migration, and it schedules `alhc-workflow-tick` every 5 minutes. That runs "wait N hours" steps and "due date is approaching" rules. If you enable `pg_cron` later, schedule it yourself in the SQL editor:

   ```sql
   select cron.schedule('alhc-workflow-tick', '*/5 * * * *', 'select public.workflow_tick()');
   ```

   Without `pg_cron`, the Vercel cron below runs `workflow_tick()` once a day instead.

## Setup: email (Resend) and the workflows cron

1. In [Resend](https://resend.com), verify a sending domain and create an API key.
2. Set `RESEND_API_KEY`, `EMAIL_FROM` (e.g. `ALHC Projects <requests@yourdomain.com>`), and optionally `EMAIL_REPLY_TO`.
3. Set `SUPABASE_SERVICE_ROLE_KEY` (server-only). The app uses it only to claim and deliver queued emails and for the cron route.
4. Set `CRON_SECRET` to a long random string. `vercel.json` calls `/api/cron/workflows` daily, and Vercel sends the secret automatically. On a Pro plan you can make it more frequent (e.g. `*/15 * * * *`), or call it from any scheduler with `Authorization: Bearer <CRON_SECRET>`.

Emails are also delivered right after any action in the app, so the cron mainly matters for emails queued by scheduled rules. Leave the Resend variables empty to mock email. To inspect what would have been sent, run `select to_email, template, subject, status from public.email_outbox order by created_at desc;`.

## Setup: Slack and webhooks

1. **Slack:** in Slack, create an app (or open one) at api.slack.com/apps → **Incoming Webhooks** → turn it on → **Add New Webhook to Workspace** → pick a channel. Copy the `https://hooks.slack.com/services/…` URL into the project's **Settings → Integrations**, or into a single rule's **Send Slack message** action. No Slack OAuth app is needed.
2. **Outbound webhooks:** paste the receiver's `https://` URL (plain `http`, local, and private-network addresses are rejected) and, optionally, a shared secret and header name. The receiver should compare the header to the secret.
3. Delivery needs `SUPABASE_SERVICE_ROLE_KEY` (same as email). Set `INTEGRATIONS_MOCK=true` to log deliveries as `[integration:mocked]` instead of POSTing (useful for previews). `NEXT_PUBLIC_APP_URL` (or Vercel's production URL) adds `task.url` deep links to webhook payloads.
4. To inspect deliveries (service role / SQL editor only — clients can't read this table): `select channel, target_hint, status, attempts, last_error from public.integration_outbox order by created_at desc;`.

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
   | `CRON_SECRET` | Secret for `/api/cron/workflows` |
   | `NEXT_PUBLIC_APP_URL` | Optional. Canonical origin for public form links and webhook `task.url` links |
   | `AUTH_GOOGLE_ENABLED` | Optional. `true` shows "Continue with Google" once the Google provider is configured |

   The Supabase ↔ Vercel Marketplace integration sets the same names automatically if you prefer it.
3. Deploy. If you add or change env vars later, redeploy so they take effect. Without them, every page shows a "Supabase isn't configured" screen instead of crashing.

## Project scripts

| Script | What it does |
| --- | --- |
| `dev` / `build` / `start` | Next.js |
| `lint` | ESLint (`eslint-config-next`) |
| `typecheck` | `tsc --noEmit` |
| `db:test` | Local migration + RLS smoke tests (`supabase/tests/*_smoke.sql`) |
| `db:types` | Regenerate `src/lib/supabase/database.types.ts` from the linked project (`npx supabase link` first) |
