# ALHC-Projects roadmap (everything not built yet)

Updated: 2026-10-13 (real-1 made the top five of Group 0 real; PR open, migration not applied yet). App: https://alhc-projects.vercel.app · repo AutumnAvi/ALHC-Projects (main after PR #36 + `6dedf9f`).
Sources: SHIP-STATUS.md, END-OF-BUILD-CHECKLIST.md, ai-actions-proposal.md, AGENTS.md "Follow-ups" + "Phases" on main, research/asana-feature-map-v1-2026-10-05.md, plus general Asana knowledge (marked "Asana").

**Size:** S = a small paste or part of a phase · M = about one Claude phase · L = several phases or outside setup.
**Needs Avi:** — = nothing · Decision · Key (an account, API key or DNS record) · $ (money).

**Plan right now:** stop building, run the end-of-build review and Avi's click-through (END-OF-BUILD-CHECKLIST.md), and start using the app. **The first feature after testing is 1.0, Form submitter conversation.** Then pick from this list.

---

## 0. Simulated or not live yet

Re-audited 2026-10-13 against `main` at `4c10798` and the live setup (read-only). Vercel Production now has `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_DOMAIN` and `RESEND_WEBHOOK_SECRET` (names checked, values never read). Not set: `NEXT_PUBLIC_APP_URL` (optional, Vercel's production URL is used), `AUTH_GOOGLE_ENABLED`, `INTEGRATIONS_MOCK` (unset means real sends). pg_cron jobs active: `alhc-delivery-kick` (every minute), `alhc-workflow-tick` (every 5 minutes), `alhc-log-purge` (daily). `email_outbox`: every row is `sent`, none stuck pending.

### Done (now real)
- [x] Background delivery of emails, Slack messages and webhooks (service key + every-minute `alhc-delivery-kick`), live since 2026-10-08.
- [x] Daily Vercel cron (`CRON_SECRET` set).
- [x] Due-date triggers and "Wait, then continue" delays (`alhc-workflow-tick` confirmed in `cron.job`).
- [x] Form confirmation emails and the rule action "Send email" go out through Resend.
- [x] Task activity shows the real email status (queued, sent or failed), not just "emailed".
- [x] Slack and "Call webhook" actions, plus Deliveries Send now / Retry, really send.
- [x] Reply-by-email: form submitters auto-follow their task, comments email them (with a per-form toggle), and their replies come back as comments.
- [x] Workspace invites send a real invite email.
- [x] CSV export tells you on screen when it hit the 10,000-row cap.
- [x] **Add someone by email on a project, portfolio or team** (real-1): invites anyone in the workspace who hasn't signed in yet, and a workspace admin can invite a brand-new address (it joins the workspace too). The invitee gets an email with a Sign up link that lands on that project, portfolio or team, and joins with the chosen role on their first sign-in. Members lists and Share show them as Invited, with the email's status, Resend and Cancel. Someone who isn't a workspace admin still can't bring a new address into the workspace (the message says to ask an admin) — on purpose, since only admins manage who can sign in.
- [x] **Forward emails to create tasks** (real-1): Settings → Email forwarding gives everyone their own address on the reply domain (rotatable) and a project picker. An email sent or forwarded from their own address becomes a task assigned to them (subject = name, body = description, attachments copied into private storage), in that project while they can still add tasks there, else in My tasks. Mail from anyone else, or to an old address, is ignored and shown in the tab's "Recently forwarded".
- [x] **Attachment questions on forms** (real-1): public submitters attach up to 5 files per question (10 per response, 25 MB each, common file types); they land on the task the form creates.
- [x] **Create project / Create goal from a team page** preselect that team (real-1). A project falls back to the default team when you aren't on that team, because only members can put projects in a team.
- [x] **Home → Create task** is an inline row at the top of My tasks (real-1): Enter saves and keeps the row open, Esc cancels; Tab then Q does the same on Home.

### Still simulated or missing (to build)
- [ ] **real-1 is not live until its migration is applied:** `20261013010000_real_1.sql` (no tail) goes in through the migration-applier before the PR merges. Until then the preview hides Resend, Attachment questions and forwarding and says they need the database update.
- [ ] **Team Messages**: placeholder that links to project Messages.
- [ ] **Inbox notification settings**: no per-kind on/off switches (in-app or email).
- [ ] **Last activity** in Admin/Members is only the last sign-in.
- [ ] **People**: clicking a person opens Reports filtered to them; there's no profile page.
- [ ] **Team Calendar** is read-only (no drag to reschedule).
- [ ] **Asana importer attachments** become links back to Asana, not copied files (they break when Asana access ends). Needs a decision, since AGENTS.md says never call the Asana API.
- [ ] **CSV export** is still capped at 10,000 rows (notice only).
- [ ] **Status templates** card in Customize: not built (no data behind it).
- [ ] **No code yet:** Inbox email digest, iCal feed, scheduled report emails, email bounce/complaint tracking, push notifications.

### Batches (by value)
1. ~~**real-1, invites and email-in**~~ built (PR open; apply the migration, then merge): pending invites for project/portfolio/team "add by email" (email + auto-join on first sign-in), Forward emails to create tasks, form attachment questions, team preselect on create, Home inline Create task.
2. **real-2, team and people:** real Team Messages, per-kind notification settings (respected by Inbox and email), real last activity, person profile pages.
3. **real-3, email extras:** Inbox email digest, scheduled report emails, bounce/complaint tracking from Resend webhooks.
4. **real-4, data and calendar:** draggable Team Calendar, iCal feed (token route), unlimited streaming CSV, Status templates, importer attachment copy (once Avi decides).

### Needs Avi (only you can do these)
- **Sign-up emails (Supabase Auth custom SMTP):** Supabase → Authentication → Emails → SMTP Settings → enable custom SMTP. Host `smtp.resend.com`, port `465`, username `resend`, password = a Resend API key, sender = the same verified address as `EMAIL_FROM`. Save.
- **Leaked-password protection:** Supabase → Authentication → Attack Protection (Passwords) → turn on "Prevent use of leaked passwords".
- **Google sign-in:** Google Cloud Console → APIs & Services → Credentials → OAuth client (Web), redirect URI `https://xsgmawawwstbrbukgsax.supabase.co/auth/v1/callback`. Paste the client ID/secret in Supabase → Authentication → Providers → Google. Then add `AUTH_GOOGLE_ENABLED=true` in Vercel Production and redeploy.
- **Importer attachments:** decide whether the importer may download files from Asana at import time.
- **Email forwarding (after real-1):** no new DNS or Resend route. Forwarding addresses (`f-…@reply.mail.autumnlakemarketing.com`) use the same reply domain, MX record, Resend webhook and `RESEND_WEBHOOK_SECRET` as reply-by-email. One check: forwards are accepted only when Resend reports **DMARC pass** for the sender, so `autumnlakemarketing.com` needs a DMARC record (a `TXT` at `_dmarc.autumnlakemarketing.com`, e.g. `v=DMARC1; p=none; rua=mailto:…` to start). If forwarding says "didn't pass the sender checks", that record is missing. Before merging real-1, have its migration applied (the migration-applier does it).

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
| Inbound email address per project (email → task). real-1 built a personal forwarding address (tasks go to your chosen project) | M | — (same reply domain) |
| Encrypt webhook/signing secrets at rest (they're plaintext today, behind RLS) | M | — |
| Workspace-wide delivery log, bulk retry, per-project retry limits; `{task_link}` in comments/emails; webhook payload options | S–M | — |
| Zapier-specific adapters | M | Decision |

### Admin, people, access
| Item | Size | Needs Avi |
|------|------|-----------|
| Workspace admin screen for the allowlist (today it's managed in SQL) | S | — |
| ~~Pending invites for people who haven't signed in yet, plus an invite email~~ (built in real-1) | — | — |
| Audit log of admin and membership changes | M | — |
| Per-task guest sharing; guest polish (badge, limited sidebar) | M | Decision |
| Membership-aware people pickers in Board/List/rules; mention autocomplete for more fields | S | — |
| ~~Form file-upload questions~~ (built in real-1); per-form submitter accounts; rule edit history and dry-run | M | — |
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
