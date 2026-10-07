# ALHC-Projects roadmap (everything not built yet)

Updated: 2026-10-07 ~17:45 IDT (added Group 0, "Simulated or not live yet", and item 1.0). App: https://alhc-projects.vercel.app · repo AutumnAvi/ALHC-Projects (main after PR #26 + `f95700e`).
Sources: SHIP-STATUS.md, END-OF-BUILD-CHECKLIST.md, ai-actions-proposal.md, AGENTS.md "Follow-ups" + "Phases" on main, research/asana-feature-map-v1-2026-10-05.md, plus general Asana knowledge (marked "Asana").

**Size:** S = a small paste or part of a phase · M = about one Claude phase · L = several phases or outside setup.
**Needs Avi:** — = nothing · Decision · Key (an account, API key or DNS record) · $ (money).

**Plan right now:** stop building, run the end-of-build review and Avi's click-through (END-OF-BUILD-CHECKLIST.md), and start using the app. **The first feature after testing is 1.0, Form submitter conversation.** Then pick from this list.

---

## 0. Simulated or not live yet

Read-only audit of `main` at `f95700e`, 2026-10-07. The Vercel project `alhc-projects` has only **2 env vars**: `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (names checked, values not read). So `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `NEXT_PUBLIC_APP_URL`, `AUTH_GOOGLE_ENABLED` and `INTEGRATIONS_MOCK` are all unset.

**The big one:** without `SUPABASE_SERVICE_ROLE_KEY`, nothing queued ever leaves the app. That covers emails, Slack messages and webhooks. They aren't even marked "mocked"; they sit as **pending** in `email_outbox` / `integration_outbox` forever. Adding a Resend key alone won't fix email.

| Feature | What the UI suggests | What actually happens today | Where in code | What makes it real | Size |
|---------|----------------------|-----------------------------|---------------|--------------------|------|
| **Background delivery (root cause)** | Emails, Slack messages and webhooks go out "within moments of the next change in the app, or by the scheduled job". | Every drain needs the service-role client, which returns null without the key. Nothing gets claimed, and every row stays `pending`. | `src/lib/supabase/admin.ts`, `drainOutbox()` in `src/lib/email.ts`, `drainIntegrationOutbox()` in `src/lib/integrations.ts`, `deliverQueuedEmail()` in `src/lib/actions.ts` | Env var: `SUPABASE_SERVICE_ROLE_KEY` in Vercel (Production, server-only, never `NEXT_PUBLIC_`), then redeploy. Before adding it, check which rules are enabled: queued Slack/webhook rows will then really send, since `INTEGRATIONS_MOCK` is unset. | S |
| Daily scheduled job | `vercel.json` cron calls `/api/cron/workflows` daily at 13:00 UTC (16:00 IDT) to run rules and drain the outboxes. | `CRON_SECRET` is unset, so the route answers **401 to every call**. It does nothing, even after the service key is added. | `src/app/api/cron/workflows/route.ts`, `vercel.json` | Env vars: `CRON_SECRET` + `SUPABASE_SERVICE_ROLE_KEY`. Hobby only allows a daily schedule. For faster runs, use a free external scheduler or Vercel Pro (see Operations). | S |
| "Due date is approaching" trigger and "Wait, then continue" delays (incl. the due-tomorrow and 24-hour-nudge templates) | Rules fire on time. | Only `workflow_tick()` in the database runs these. `pg_cron` is installed on the project, and the workflows migration schedules `alhc-workflow-tick` every 5 minutes *if* pg_cron existed when it ran. **Not verified** that the job exists. If it doesn't, these never fire, because the Vercel cron is refused (row above). Any email/Slack they queue still waits on the service key. | `workflow_tick()` and `cron.schedule` in `supabase/migrations/20261005020000_workflows.sql` | Cron: confirm `alhc-workflow-tick` exists in `cron.job` (read-only check), or fix the Vercel cron (row above). | S |
| Form confirmation email | Form builder: "Email a confirmation to the submitter". The thank-you text is "shown after submitting and in the confirmation email". | `submit_form` queues a `form_confirmation` row and nothing is sent. With only the service key it would be marked `mocked` and logged, not sent. | `src/components/forms/form-builder.tsx`, `submit_form` / `enqueue_email` in `supabase/migrations/20261005020000_workflows.sql`, `src/lib/email.ts` | Env vars: `SUPABASE_SERVICE_ROLE_KEY` + `RESEND_API_KEY` + `EMAIL_FROM` (a sender on a domain verified in Resend). | S |
| Rule action "Send email" (requester update, due tomorrow, custom; to form submitter, assignee, an email field or a fixed address), incl. the "requester update" and "tracking/shipping email" templates | Rule runs show as succeeded, and the requester gets updates. | The row is queued and stays `pending` (it would be `mocked` without Resend). | `src/lib/rules.ts`, `src/components/rules/rule-editor.tsx`, `run_rule` in `supabase/migrations/20261005020000_workflows.sql` and `20261005080000_integrations.sql` | Same three env vars as above. | S |
| "emailed {address}" in task activity | The email was sent. | The story is written when the email is **queued**, so it shows "emailed" even though nothing went out. | `email_queued` in `src/components/task/task-activity.tsx`, `enqueue_email` | Env vars above, plus a small build change to say "queued" and show sent/failed status. | S |
| Slack message and "Call webhook" rule actions, plus Deliveries "Send now" / "Retry" | Activity says "queued a Slack message / webhook call". The Integrations page says they're sent within moments. Send now / Retry pushes one out right away. | Never POSTed. Rows stay `pending` in Settings → Deliveries, and Send now / Retry re-queues with no visible effect. | `src/lib/integrations.ts`, `src/components/project/integrations-settings.tsx`, `src/components/project/delivery-log.tsx`, `retryIntegrationDelivery` in `src/lib/actions.ts` | Env var: `SUPABASE_SERVICE_ROLE_KEY`. Optional `NEXT_PUBLIC_APP_URL` keeps `{task_link}` / Open-task buttons on the right domain (otherwise Vercel's production URL is used). | S |
| Replying to an app email | Confirmation text says "We'll follow up by email as it moves along". | No reply path exists. Replies go to the sender address (or `EMAIL_REPLY_TO`, unset), never back into the task, and comments never email the submitter. | `src/lib/email.ts` | Build phase: **Form submitter conversation** (1.0), plus inbound email on the sending domain. | M–L |
| Invite / "Add someone by email" (project, portfolio, team) | Inviting someone. | No email is sent. The person must already be on the allowlist (added in SQL) **and** have signed in once, otherwise the action errors ("allowlisted but has not signed in yet"). | `src/components/project/members-manager.tsx`, `src/components/portfolio/portfolio-members.tsx`, `src/components/teams/team-detail.tsx`, `add_project_member` in `supabase/migrations/20261005050000_teams_permissions.sql` | Build phase: pending invites + invite email + an allowlist admin screen. Needs the Resend setup. | M |
| Sign-up confirmation email (Supabase Auth, "Confirm email" on) | New teammates get a confirm link. | **Not verified for this project.** Supabase's built-in sender is for testing only: it is heavily rate-limited and only delivers to the Supabase org's own team members unless custom SMTP is set. New teammates may never get the link. | Supabase → Authentication settings (not in the repo) | Service account: custom SMTP in Supabase Auth (e.g. Resend's SMTP, same verified domain). Avi makes this Auth change himself. | S |
| Asana importer attachments | The import preview counts attachments. | Tasks get **links back to Asana**; no files are copied. They break once Asana access ends. | `src/lib/asana-import.ts`, `src/components/project/import-settings.tsx` | Build phase: download each file at import time and store it in Supabase Storage. AGENTS.md says never call the Asana API, so the approach needs a quick decision. | M |
| CSV export | You download the whole view or report. | Silently capped at 10,000 rows. Only an `X-Export-Truncated` header is set, with no notice in the UI. | `src/lib/csv.ts`, `/export/[kind]` route | Build: S for an on-screen notice, M for unlimited (streaming) exports. | S–M |
| Google sign-in | Hidden, so nothing pretends. | Off until `AUTH_GOOGLE_ENABLED=true`. | `src/lib/env.ts`, `src/app/login/page.tsx` | Service account: Google Cloud OAuth client + Supabase Google provider, then the env var (see 1.6). | S |

**Checked and real today:** in-app Inbox notifications, @mentions, approvals, file attachments (private Supabase Storage with 60-second signed links), live updates, public forms creating tasks, and inbound webhooks creating tasks (anon RPC `receive_inbound_webhook`; any email/Slack their rules queue still waits on the service key).
**No code at all, so nothing pretends:** push notifications, the Inbox email digest, the iCal feed, scheduled report emails, and email open/bounce tracking (see Groups 1–2).

**Quickest path to "email + Slack actually work":** add `SUPABASE_SERVICE_ROLE_KEY` and `CRON_SECRET` in Vercel (Slack and webhooks go live right away). Set up Resend with a verified domain, then add `RESEND_API_KEY` + `EMAIL_FROM`. Set custom SMTP in Supabase Auth for sign-up emails. Redeploy. Avi enters every value himself, never in chat.

---

## 1. Already decided but parked (needs Avi)

| # | Item | What it is | Size | Needs Avi |
|---|------|------------|------|-----------|
| **1.0 ⭐ TOP PRIORITY** | **Form submitter conversation (Asana-style)** | **Avi: very important, and the first feature to build after his testing.** The person who submits a form is automatically added as a follower and collaborator on the task it creates. Each new comment emails them with a link back to the task. A reply to that email posts back on the task as a comment, so the back-and-forth works even if they never open the app. It builds on what exists: the app already records the submitter's email, and the "requester update" email template is there but not live (see Group 0). | M–L (1–2 phases + email setup) | Key: a Resend account and API key, a verified sending domain (e.g. a subdomain of autumnlakemarketing.com, via DNS records), and inbound email on that domain for replies. Also `SUPABASE_SERVICE_ROLE_KEY` in Vercel (see Group 0). Decision: what an outside submitter (not a workspace member) can see from the email link. |
| 1.1 | AI assistant | ai-actions-proposal.md has 5 buttons: summarize task, draft a project status, draft or improve a comment, suggest triage for form requests, and an "AI: classify into field" rule action. Settings → Workspace gets an on/off switch and a monthly cap. | M–L (2 packs) | Decision + $. "Free only" clashes with the proposal (about $10/month via Vercel AI Gateway, $25 cap). Free model tiers usually allow training on our data, which is a problem for a healthcare company. Also needs a "no patient info" rule. Design talk first. |
| 1.2 | Inbox email digest | Daily email of unread Inbox items. `src/lib/email.ts` (Resend) already exists. **The same key also switches on the email features that aren't live today:** form confirmations, requester updates, "due tomorrow", and rule emails (see Group 0). They also need `SUPABASE_SERVICE_ROLE_KEY`, which is not set in Vercel either. | S to switch on, M for the digest | Key: free Resend account, verified sender domain (DNS on autumnlakemarketing.com), `RESEND_API_KEY` + `EMAIL_FROM` in Vercel. Resend's free tier is about 3,000 emails/month and 100/day. |
| 1.3 | iCal calendar feed | Subscribe to My Tasks or a project in Google/Outlook Calendar. The team used Asana's iCal before. | S–M | Decision: secret-link feed (anyone with the link can read it), which tasks it covers, and private tasks excluded? |
| 1.4 | Two-way Slack app | Create tasks from Slack messages or a slash command (could replace the Video Requests Slack form), interactive Approve buttons, link previews. Today Slack is one-way (incoming webhooks only). | L | Key + Decision: a Slack app installed in Autumn Lake's Slack (admin approval, OAuth). Slack apps are free. |
| 1.5 | Mobile push / installable app (PWA) | "Add to home screen" app plus web push for Inbox items. Native iOS/Android is out of scope. | M | Decision. Free (VAPID keys). On iPhone, push works only after installing to the home screen. |
| 1.6 | Google login | The button exists but is hidden (`AUTH_GOOGLE_ENABLED`). Email + password is the interim method. | S | Key: a Google Cloud OAuth client + the Supabase Google provider. Auth changes are done outside Claude phases. |

## 2. Logged follow-ups from Claude's phases (deduped, plain English)

### Tasks, subtasks, My Tasks
| Item | Size | Needs Avi |
|------|------|-----------|
| Private tasks with more collaborators than the assignee, plus a "make private" option for project tasks | M | — |
| Quick-add into a chosen My Tasks section; private-task filter in search | S | — |
| Rules for My Tasks (e.g. due today → Do today) and auto-moving Do next week / Do later as dates get close | M | — |
| Subtasks on Board / Calendar / Timeline, in the critical path, and in goal / portfolio counts | M | — |
| Filter, sort and bulk-edit subtasks in List; drag a subtask to another parent | M | — |
| Recurring subtasks don't copy their field values yet | S | — |
| Recurrence exceptions (skip or move one occurrence), "repeat from completion date", edit a whole series | M | — |
| Show times on List / Board / Calendar / My Tasks; time-aware reminders (`due_at`) | M | — |
| Duplicate task: copy recurrence and comments, duplicate several tasks at once, add a "duplicated from" note | S | — |
| Section trash (restore deleted sections) and a workspace-wide trash | M | — |
| Viewers can complete tasks assigned to them | S | Decision |

### Scheduling, Timeline, dependencies
| Item | Size | Needs Avi |
|------|------|-----------|
| Auto-shift "pull earlier" everywhere, plus a per-project "always shift / never ask" setting | S–M | Decision |
| Auto-shift from rules (never happens today) | M | Decision |
| Finish-to-finish and start-to-finish dependency types | S | — |
| Dependency picker that searches any task; Timeline arrows to other projects and to subtasks | M | — |
| Create a dependency by dragging between Timeline bars; keyboard move/resize; saved zoom | M | — |
| Timeline baselines; critical path across a portfolio; critical-path filter in List/Board | M | — |
| Timeline on mobile (the tray is hidden on small screens) | S | — |
| Start-date filters, start date in forms, and a start-date rule trigger | S | — |

### Approvals and task types
| Item | Size | Needs Avi |
|------|------|-----------|
| Approvals with several approvers, and "approve with changes" | M | Decision |
| Note in the Inbox when someone else decides an approval; request approvals on imported/copied tasks in bulk | S | — |
| Milestones in Workload and a milestone-only filter; bulk "set type" | S | — |

### Collaboration: comments, messages, tags, Inbox
| Item | Size | Needs Avi |
|------|------|-----------|
| Message threads: follow, pin/resolve, attachments, rich text, link to tasks, search | M | — |
| Notify all project members of a new thread | S | Decision |
| Tag merge/delete, private or per-team tags, tag-based rules, a tag page, tags on more views and reports | M | — |
| Comment edit history, custom reactions, likes on comments and messages, like notifications | S | — |
| Video / audio / Office previews, server-side thumbnails, an image gallery per task | M | — |
| Bulk Inbox actions on a selection; auto-archive old notifications | S | — |
| Push notifications and email digest (see 1.2 and 1.5) | — | see Group 1 |

### Reporting, dashboards, export
| Item | Size | Needs Avi |
|------|------|-----------|
| Reports caching (every request recalculates; fine at today's size) | S | — |
| More charts (line, stacked, pie, burn-up/down), group by custom field or task type, saved report filters | M | — |
| Share a personal dashboard; widget sizes and drag-to-reorder; portfolio dashboards | M | — |
| Scheduled report emails | S | Needs 1.2 key |
| XLSX export, exports over 10,000 rows, CSV for Board / Calendar / Timeline / My Tasks | M | — |
| Created-per-period and cycle-time charts; Timeline/Calendar print layouts | S | — |

### Portfolios, goals, teams, workload
| Item | Size | Needs Avi |
|------|------|-----------|
| Goal metrics (target + unit), goals linked to tasks, auto-status from progress, progress history charts | M | — |
| Goal / strategy-map timeline view; private goals; notifications and followers for status updates | M | — |
| Team-scoped visibility of projects and templates; sync project members when a team changes; nested teams; team inbox | M–L | Decision |
| Portfolio PDF/CSV export, field filters/sorting, people fields, task-level bars on the portfolio Timeline | M | — |
| Status-update comments, notifications, edit and delete | S | — |
| Workload in hours with per-day capacity and time off; unscheduled work per person; workspace-wide workload | M | — |
| Archived projects in portfolio/goal pickers; bulk archive; auto-archive finished projects | S | — |

### Templates, bulk edit, importer
| Item | Size | Needs Avi |
|------|------|-----------|
| Edit a template in place (today you save a project over it); template previews; per-team templates | M | — |
| Templates copy times, recurrence, followers, dashboard widgets, integration settings, inbound endpoints; over 2,000 tasks | M | — |
| Task templates with date offsets; save a section or a set of tasks as a template | S | — |
| Bulk edit on Board / Calendar / Timeline / search; drag several rows; undo toast; over 200 tasks; more bulk fields | M | — |
| Importer: copy attachment files into Storage (today only links back to Asana) | M | — |
| Importer: subtask assignees/dates/notes, keep Asana created-at, re-import updates, multi-project / workspace import page, clean up abandoned uploads | M | — |

### Integrations (outbound + inbound)
| Item | Size | Needs Avi |
|------|------|-----------|
| Transfer an inbound endpoint to another admin (today it stops working if its creator loses Editor) | S | — |
| Inbound payloads: create unknown tags or sections, `section` key, attachments, subtasks | M | — |
| Inbound: per-endpoint and workspace rate limits, edge limit for unknown tokens, test-send button, prune old call logs | S | — |
| Signing-secret rotation with an overlap window (outbound and inbound) | S | — |
| Inbound email address per project (email → task) | M | Key: inbound email provider + DNS |
| Encrypt webhook/signing secrets at rest (they're plaintext today, behind RLS) | M | — |
| Workspace-wide delivery log, bulk retry, per-project retry limits; `{task_link}` in comments/emails; webhook payload options | S–M | — |
| Zapier-specific adapters | M | Decision |

### Admin, people, access
| Item | Size | Needs Avi |
|------|------|-----------|
| Workspace admin screen for the allowlist (today it's managed in SQL) | S | — |
| Pending invites for people who haven't signed in yet, plus an invite email | M | Needs 1.2 key |
| Audit log of admin and membership changes | M | — |
| Per-task guest sharing; guest polish (badge, limited sidebar) | M | Decision |
| Membership-aware people pickers in Board/List/rules; mention autocomplete for more fields | S | — |
| Form file-upload questions and per-form submitter accounts; rule edit history and dry-run | M | — |
| Workspace-level custom field library and field reordering | M | — |
| Storage cleanup of removed attachment files | S | — |
| Turn Creative Requests and other Autumn Lake workflows into ready project templates | M | Decision (which workflows) |

## 3. Asana features not built yet

| Feature (Asana) | Status here | Size | Needs Avi |
|-----------------|-------------|------|-----------|
| Universal reporting depth (cross-project charts, line/burn-up, saved reports, shared dashboards) | **Partly.** Reports page, All projects, personal dashboards, CSV | M | — |
| Proofing (pin comments on images/PDFs → subtasks) | Not built (image lightbox and PDF preview exist) | L | Decision |
| Time tracking (estimated vs actual time, timesheets) | Not built | M | Decision |
| Form branching | **Built**; missing file-upload questions, reply-by-email request tracking, CAPTCHA | S–M | — |
| Project brief / Overview page / Notes | Not built (Messages tab exists) | M | — |
| Status-update cadence reminders ("post your weekly status") | Not built (status history exists) | S | — |
| Goals auto-progress | **Partly.** Progress from sub-goals/projects; no metric targets or auto-status | S–M | — |
| Workload with effort points / hours | **Partly.** Count or number-field effort with weekly capacity; no hours or time off | M | — |
| Mobile app | **Partly.** Responsive web with mobile bar; no PWA or native (see 1.5) | M / L | Decision |
| Guest access | **Partly.** Per-project roles for allowlisted people; no per-task or external guest flow | M | Decision |
| SSO (Google / Microsoft / SAML) | Not built (Google is 1.6) | S (Google), L (SAML) | Key |
| Audit log | Not built (task activity history exists) | M | — |
| Full data export / backup | **Partly.** CSV per view and report; no whole-workspace export | M | — |
| Gmail / Outlook add-ons | Not built | L | Key + Decision (Google/Microsoft add-in publishing) |
| Email-to-task project addresses | Not built (inbound webhooks exist) | M | Key (email provider + DNS) |
| Rich text in task notes and comments (bold, lists, mention pills) | Not found in the build docs | M | — |
| Formula fields | Not built (native Req # IDs exist) | M | — |
| Custom task types with their own statuses | **Partly.** Task / milestone / approval; section-bound Status field | M | — |
| Project Files tab (all attachments in one place) | Not built | S | — |
| Saved searches / advanced search across projects | **Partly.** Search + per-project saved views; no saved cross-project searches | M | — |
| Favorites / starred projects in the sidebar | Not built | S | — |
| Notification settings (per-project mute, per-event email choices) | Not built | M | — |
| Public API / personal access tokens | Not built (inbound + outbound webhooks exist) | M | Decision |
| Dark mode | Not built | S | — |
| AI (summaries, smart status, AI Studio, AI Teammates) | Not built (see 1.1) | M–L | $ + Decision |
| Bundles (Asana Enterprise) | Skip: templates cover it | — | — |

## 4. Operational items

| Item | What's going on | Size | Needs Avi |
|------|-----------------|------|-----------|
| **Supabase plan (correction)** | The Supabase org "Avi Weinreb" is on **Pro**, not Free. Pro includes 8 GB of database disk, 100 GB of file storage, 7 days of daily backups, and no auto-pausing. Read-only check today: **database 19 MB, 0 stored files**. The app caps each attachment at 25 MB (`src/lib/attachments.ts`). An earlier note said "Free plan, 1 GB". That was wrong, and there's plenty of room. | — | — (confirm the monthly bill in Supabase Billing) |
| Backups | Pro keeps daily database backups for 7 days. Storage files are **not** in those backups. There's no off-site copy, and point-in-time recovery costs extra (about $100/month). Option: a free weekly `pg_dump` + Storage copy to a private place. | S–M | Decision (where to keep the copy) |
| Shared database with Isaiah Approval | Project `xsgmawawwstbrbukgsax` is named "shared-internal-tools-2 (isaiah-approval + ALHC-Projects)". Both apps live in `public`, so a mistake or reset hits both. Pending: the rename, and maybe moving ALHC to its own project later (another project adds about $10/month compute on Pro). | S (rename) / L (split) | Decision |
| Vercel hosting + scheduler | `vercel.json` runs the cron once a day (the Hobby limit). **Today it does nothing:** `CRON_SECRET` and `SUPABASE_SERVICE_ROLE_KEY` aren't set in Vercel, so the route refuses every call (see Group 0). Delayed rule actions, due-date rules, and queued emails/webhooks only drain daily, or right after someone acts in the app. Fixes: free external scheduler (GitHub Actions / cron-job.org hitting `/api/cron/workflows` with `CRON_SECRET`), check whether `pg_cron` runs the 5-minute tick, or Vercel Pro. Hobby is meant for non-commercial use. | S | Decision / $ (Vercel Pro is about $20 per seat/month) |
| Confirm production deploys | Claude can't read Vercel production status. Check PR #25 / #26 and docs commits are Ready during the review. | S | — |
| Migrate Autumn Lake's real Asana data | Settings → Import (Admin+) takes Asana JSON + CSV exports (it never calls the Asana API). Never tested on a real export. Try one small project first, then the 15 core projects (Creative Requests has about 430 tasks). Team members need accounts first so assignees match. Imported rules land **disabled**. Attachments come in as **links back to Asana**, so keep Asana access until files are copied (see the importer follow-up). | M (mostly Avi's time) | Decision (cutover date, keep Asana until when) + export files |
| Onboard the team | Add allowlisted emails (SQL today) and have people sign up with email + password. Avi is the only workspace admin, so add a second one. | S | Decision (who, and their emails) |
| Patient info policy (PHI) | Autumn Lake is healthcare marketing. No HIPAA agreement covers this stack (Supabase HIPAA needs Team plan + add-on). Team rule: no patient information in tasks, comments, forms or files. | S | Decision |
| End-of-build review | Security and safety checks across all phases: hosted DB vs repo, the applies marked "unverified" (Scheduling polish, Daily essentials, Integration depth g), the duplicate `real_subtasks_f` record, then Avi's click-through checklist. | M | Avi's click-through time |
| Optional custom domain | e.g. projects.autumnlakemarketing.com instead of the vercel.app URL. | S | Key (DNS) |
| Error alerts | No alerting on server errors or failed cron runs today. Options: Vercel log alerts or a free monitor. | S | Decision |
