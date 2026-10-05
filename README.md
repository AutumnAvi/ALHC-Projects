# ALHC Projects

Our own project management software: projects, sections, tasks, and subtasks, with List and Board views, a task detail pane, comments, custom fields, attachments, My Tasks, an Inbox, search, approvals, public intake forms, request numbers, and a rules engine with email. Built with Next.js 16 (App Router), Supabase (Auth + Postgres + RLS), and Tailwind CSS 4, and deployed on Vercel.

Architecture, data-model rules, and conventions are documented in [`AGENTS.md`](./AGENTS.md).

## What's here (core spine)

- Email + password sign-in through Supabase Auth (interim; Google sign-in returns later, see [Setup: sign-in](#setup-sign-in-email--password-interim)), gated by an email allowlist (`public.allowed_emails`). Non-allowlisted accounts are signed out and shown a denied screen.
- Data model: workspaces, projects, sections, tasks, subtasks, multi-project task membership (`task_projects`), and profiles. All deletes are soft (`deleted_at`).
- Row Level Security on every table. In this phase, any allowlisted user can read, create, and update all workspace data.
- Project home, List view (grouped by section), Board view (columns are sections, with drag-and-drop or a "move to section" menu), and a task detail pane (title, description, assignee, due date, subtasks, project memberships, delete).

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
npm run db:test   # applies migrations to a throwaway local Postgres and runs the RLS smoke tests
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
5. **Storage:** the collaboration migration creates the private bucket **`task-attachments`** (25 MB per-file limit) and its `storage.objects` policies (`task_attachments_objects_select_allowlisted`, `task_attachments_objects_insert_allowlisted`). Nothing to click, but check two things:
   - Storage → Settings → **Upload file size limit** (the project-wide cap) must be at least 25 MB, or uploads fail below the bucket limit.
   - Files are stored as `<task id>/<uuid>-<file name>` and are only reachable through short-lived signed URLs issued by the app (`/attachments/<id>`). Removing an attachment hides it but leaves the object in Storage.
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
   | `SUPABASE_SERVICE_ROLE_KEY` | Server-only. Needed to deliver email and run the cron route |
   | `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO` | Optional. Email via Resend; mocked when unset |
   | `CRON_SECRET` | Secret for `/api/cron/workflows` |
   | `NEXT_PUBLIC_APP_URL` | Optional. Canonical origin for public form links |
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
