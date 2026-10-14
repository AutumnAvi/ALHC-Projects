# ALHC-Projects roadmap (everything not built yet)

Updated: 2026-10-14 (real-1 merged as `9e416ca`, real-2 as `8f72b44`, real-3 as `e03b2a4`, all with their migrations applied; real-4 makes data and calendar real — PR open, its migration not applied yet). App: https://alhc-projects.vercel.app · repo AutumnAvi/ALHC-Projects (main after PR #36 + `6dedf9f`).
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
- [x] CSV export has no row cap any more (real-4): files stream, so the old "cut at 10,000 rows" notice is gone.
- [x] **Add someone by email on a project, portfolio or team** (real-1): invites anyone in the workspace who hasn't signed in yet, and a workspace admin can invite a brand-new address (it joins the workspace too). The invitee gets an email with a Sign up link that lands on that project, portfolio or team, and joins with the chosen role on their first sign-in. Members lists and Share show them as Invited, with the email's status, Resend and Cancel. Someone who isn't a workspace admin still can't bring a new address into the workspace (the message says to ask an admin) — on purpose, since only admins manage who can sign in.
- [x] **Forward emails to create tasks** (real-1): Settings → Email forwarding gives everyone their own address on the reply domain (rotatable) and a project picker. An email sent or forwarded from their own address becomes a task assigned to them (subject = name, body = description, attachments copied into private storage), in that project while they can still add tasks there, else in My tasks. Mail from anyone else, or to an old address, is ignored and shown in the tab's "Recently forwarded".
- [x] **Attachment questions on forms** (real-1): public submitters attach up to 5 files per question (10 per response, 25 MB each, common file types); they land on the task the form creates.
- [x] **Create project / Create goal from a team page** preselect that team (real-1). A project falls back to the default team when you aren't on that team, because only members can put projects in a team.
- [x] **Home → Create task** is an inline row at the top of My tasks (real-1): Enter saves and keeps the row open, Esc cancels; Tab then Q does the same on Home.
- [x] **real-1's migration** (`20261013010000_real_1.sql`): done — real-1 merged as `9e416ca`, and the shipping rule applies a phase's migration before its merge, so Resend, attachment questions and forwarding are no longer hidden.
- [x] **Team Messages** (real-2): every team's Messages tab has real threads. Everyone who can see the team reads them (teams are a workspace directory); the team's members, leads and workspace admins post, reply and react. A new thread notifies everyone on the team; replies notify the thread's followers (its author, people who replied or were @mentioned, and anyone who clicked Follow); @mentions reach anyone in the workspace.
- [x] **Notification settings per kind** (real-2): Settings → Notifications has an Inbox and an Email switch for task assignments, @mentions, comments on tasks you follow, messages, status updates, approvals, completed tasks, field changes and rule notifications. The Inbox stops storing a kind you turn off, and every kind can now be emailed (checked again just before sending: not sent if you already read it in the Inbox, lost access, or turned it off). Defaults keep what happened before: everything on in the Inbox; email only for comments and @mentions.
- [x] **Status update notifications** (real-2): a new project status update notifies the project's members (Inbox on by default, email if they turn it on).
- [x] **Last activity** (real-2): Admin console → Users shows the last time each person changed a task, commented, posted a message or status update, or created a project — derived from the activity feeds, never invented — with their last sign-in under it.
- [x] **real-2's migration and tail** (`20261013020000_real_2.sql`): applied, and real-2 merged as `8f72b44`, so team messages, notification settings and status update notifications are live.
- [x] **Inbox email digest** (real-3): Settings → Notifications → Inbox email digest: Off (the default), Daily, or Weekly on a chosen day, at an hour in your own time zone. One email lists your unread, unarchived Inbox notifications since the last digest, grouped by project (or team), each linking to it. Empty digests are skipped; just before sending it re-checks that you can still open everything in it and leaves out what you read in the meantime; nothing is ever in two digests. Every digest has a "Turn off digest" link that works without signing in (it opens a page with one button, because email link scanners open every link), and Gmail / Apple Mail's own one-click Unsubscribe works too.
- [x] **Scheduled report emails** (real-3): Reports → Schedule email (on Overview with its current filters, or on All projects) sends the report to people in the workspace daily, weekly on a weekday, or monthly on a day (1–28) at an hour. Each person's copy (key numbers, a table by project, the oldest overdue tasks) is built with their own access: projects they can't open are left out, and anyone who can open none of them gets nothing — workspace admins included. Reports → Scheduled emails shows Last sent (to how many people) and the next run, with Pause / Resume, Edit and Remove. Recipients can turn off all report emails in Settings → Notifications or from the email.
- [x] **Bounce and complaint tracking** (real-3): the Resend webhook (same address and secret as reply-by-email, signature checked) now records delivered, delayed, bounced, complained and suppressed events on each email. Admin console → Email shows the last 30 days (Sent / Delivered / Bounced / Marked as spam / …), the latest emails with their real status (addresses outside the workspace partly hidden, never what an email was about), and a suppression list: after a permanent bounce, a spam complaint, or Resend's own suppression, no more email goes to that address (the Inbox still works) until a workspace admin clears it. Task activity and project Deliveries show Delivered / Bounced too.
- [x] **real-3's migration** (`20261014010000_real_3.sql`, no tail): applied, and real-3 merged as `e03b2a4`, so the digest, scheduled reports, and Admin → Email's delivery tracking are live. (Bounces and complaints still need the Resend webhook events — see Needs Avi.)
- [x] **Draggable Calendar** (real-4): the team Calendar and every project Calendar show each task as a bar from its start date to its due date. Anyone who can edit a task drags it to another day (the start moves too, so the length stays), drags its left or right end to change the start or due date, or opens the calendar button on the bar (also the keyboard path: Tab, Enter) for the date picker. It saves exactly like the task pane (activity, notifications, rules, due-date triggers, and the "move dependent tasks too?" prompt), moves at once, and snaps back with a message if the change is refused. People who can only view a task see it without any drag handles.
- [x] **iCal feed** (real-4): "Sync to calendar" on My tasks, a project's menu and Calendar, a team's Calendar, and Settings → Calendar sync gives a private subscribe link for Google Calendar, Outlook, or Apple Calendar. The link is shown once (only its last four characters after that), can be replaced (the old one stops at once) or turned off, and the feed is built with that person's own access every time their calendar refreshes: tasks they lose access to disappear, and it goes empty if they leave the workspace. Tasks with dates only (all-day, or timed when they have times), completed ones for 90 days with a ✓, each with a link back — never descriptions, comments, or files. At most 60 refreshes an hour per link.
- [x] **CSV export without a cap** (real-4): List and report exports stream every matching row with the same columns, escaping, and access rules (a 46,800-row List export: about 40 seconds on a laptop, the download starting at once).
- [x] **Status templates** (real-4): Customize → Status templates holds saved layouts for status updates (status, title, section headings with starting text); project editors and above add, edit, and remove them, and the status update panel's Template picker fills in a new update.
- [x] **People** (real-2): every person has a profile page (name, email, workspace role, teams, projects you share, their open tasks and recent activity you can see, last activity) with a link to their work in Reports. The search palette, Home → People, every members list, Admin → Users and message authors link to it.

### Still simulated or missing (to build)
- [ ] **real-4 is not live until its migration is applied:** `20261014020000_real_4.sql` (no tail) goes in through the migration-applier before the PR merges. Until then the preview says Status templates and Sync to calendar need the database update; the calendar drag and the uncapped export already work (the export falls back to the old 10,000-row overdue report for that one table).
- [ ] **Bounce / complaint tracking waits for the Resend webhook events** (real-3 is live): until the five delivery event types are ticked on the existing Resend webhook (see Needs Avi), emails stay at "Sent" and nothing gets suppressed.
- [ ] **Per-project mute** of notifications: real-2 is per kind only (nothing existed to keep); muting one project or team is a follow-up.
- [ ] **Members' Settings → Workspace list** still shows no last activity: only workspace admins (and the person themselves, on their profile) see the time, so the members' read-only list leaves it out on purpose.
- [ ] **Asana importer attachments** become links back to Asana, not copied files (they break when Asana access ends). Needs a decision, since AGENTS.md says never call the Asana API.
- [ ] **Email extras left for later** (real-3 follow-ups, by choice): the digest can't fold in the per-kind notification emails (people keep both switches), a report schedule's filters are changed by scheduling again from Reports (Edit covers name, timing and recipients), report emails go only to people in the workspace, a recipient can turn off all report emails but not one schedule, and there's no open / click tracking (privacy, and Resend's open tracking would rewrite links). Addresses Resend itself suppressed must also be removed in Resend → Suppressions after clearing them here, because the app doesn't call Resend's suppression API.
- [ ] **No code yet:** push notifications.
- [ ] **Data and calendar left for later** (real-4 follow-ups, by choice): calendar feeds have no per-feed options yet (e.g. leave completed or private tasks out) and don't include subtasks (Calendars don't show them either); there's no feed for a portfolio or goal. Status templates aren't copied by project templates or Duplicate project. Very large exports are bounded by the time the database's access checks take per row (about 40 seconds for ~47,000 rows locally; a background export with an emailed link would be the next step past ~200,000). Calendar bars move with the mouse or the date picker, not with arrow keys.

### Batches (by value)
1. ~~**real-1, invites and email-in**~~ built and merged (`9e416ca`): pending invites for project/portfolio/team "add by email" (email + auto-join on first sign-in), Forward emails to create tasks, form attachment questions, team preselect on create, Home inline Create task.
2. ~~**real-2, team and people**~~ built and merged (`8f72b44`): real Team Messages, per-kind notification settings (respected by Inbox and email, with notification emails), status update notifications, real last activity, person profile pages.
3. ~~**real-3, email extras**~~ built and merged (`e03b2a4`): Inbox email digest, scheduled report emails, bounce/complaint tracking from Resend webhooks with a suppression list.
4. ~~**real-4, data and calendar**~~ built (PR open; apply its migration, then merge): draggable Calendar (team and project), iCal feed (token route), unlimited streaming CSV, Status templates. Not built: the importer attachment copy (waits for Avi's decision; the importer is unchanged).

### Needs Avi (only you can do these)
- **Sign-up emails (Supabase Auth custom SMTP):** Supabase → Authentication → Emails → SMTP Settings → enable custom SMTP. Host `smtp.resend.com`, port `465`, username `resend`, password = a Resend API key, sender = the same verified address as `EMAIL_FROM`. Save.
- **Leaked-password protection:** Supabase → Authentication → Attack Protection (Passwords) → turn on "Prevent use of leaked passwords".
- **Google sign-in:** Google Cloud Console → APIs & Services → Credentials → OAuth client (Web), redirect URI `https://xsgmawawwstbrbukgsax.supabase.co/auth/v1/callback`. Paste the client ID/secret in Supabase → Authentication → Providers → Google. Then add `AUTH_GOOGLE_ENABLED=true` in Vercel Production and redeploy.
- **Importer attachments:** decide whether the importer may download files from Asana at import time.
- **Email forwarding (after real-1):** no new DNS or Resend route. Forwarding addresses (`f-…@reply.mail.autumnlakemarketing.com`) use the same reply domain, MX record, Resend webhook and `RESEND_WEBHOOK_SECRET` as reply-by-email. One check: forwards are accepted only when Resend reports **DMARC pass** for the sender, so `autumnlakemarketing.com` needs a DMARC record (a `TXT` at `_dmarc.autumnlakemarketing.com`, e.g. `v=DMARC1; p=none; rua=mailto:…` to start). If forwarding says "didn't pass the sender checks", that record is missing.
- **Before merging real-4:** have `20261014020000_real_4.sql` applied (the migration-applier; there is no tail). Nothing else to set up: calendar links need no new environment variable (they use the anon key, like public forms), and links point at `NEXT_PUBLIC_APP_URL` when it's set, else the address the calendar app used.
- **Resend webhook events (real-3, for bounce / complaint tracking):** Resend → Webhooks → open the existing webhook (endpoint `https://<production domain>/api/inbound/email`) → Events → keep `email.received` and also tick `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, and `email.suppressed` → Save. Same endpoint, same signing secret (`RESEND_WEBHOOK_SECRET`), no new environment variable. Without it, digests and scheduled reports still work; emails just stay at "Sent" and nothing gets suppressed.

---

## 1. Already decided but parked (needs Avi)

| # | Item | What it is | Size | Needs Avi |
|---|------|------------|------|-----------|
| **1.0 ⭐ TOP PRIORITY** | **Form submitter conversation (Asana-style)** | **Avi: very important, and the first feature to build after his testing.** The person who submits a form is automatically added as a follower and collaborator on the task it creates. Each new comment emails them with a link back to the task. A reply to that email posts back on the task as a comment, so the back-and-forth works even if they never open the app. It builds on what exists: the app already records the submitter's email, and the "requester update" email template is there but not live (see Group 0). | M–L (1–2 phases + email setup) | Key: a Resend account and API key, a verified sending domain (e.g. a subdomain of autumnlakemarketing.com, via DNS records), and inbound email on that domain for replies. Also `SUPABASE_SERVICE_ROLE_KEY` in Vercel (see Group 0). Decision: what an outside submitter (not a workspace member) can see from the email link. |
| 1.1 | AI assistant | ai-actions-proposal.md has 5 buttons: summarize task, draft a project status, draft or improve a comment, suggest triage for form requests, and an "AI: classify into field" rule action. Settings → Workspace gets an on/off switch and a monthly cap. | M–L (2 packs) | Decision + $. "Free only" clashes with the proposal (about $10/month via Vercel AI Gateway, $25 cap). Free model tiers usually allow training on our data, which is a problem for a healthcare company. Also needs a "no patient info" rule. Design talk first. |
| 1.2 | ~~Inbox email digest~~ | **Built in real-3** (see Group 0): daily or weekly at a chosen hour, per person. Resend, the service-role key, and the sender domain are all live now. | — | — (only the Resend webhook events in Group 0 → Needs Avi, for bounce tracking) |
| 1.3 | ~~iCal calendar feed~~ | **Built in real-4** (see Group 0): a secret subscribe link per person for My tasks, each project, and each team, shown once, rotatable and revocable, built with that person's own access at every refresh; private tasks appear only in their own My tasks feed (they're the only ones who can open them). | — | — |
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
| Message threads: pin/resolve, attachments, rich text, link to tasks, search; follow for project threads (team threads have Follow since real-2) | M | — |
| Notify all project members of a new thread | S | Decision |
| Tag merge/delete, private or per-team tags, tag-based rules, a tag page, tags on more views and reports | M | — |
| Comment edit history, custom reactions, likes on comments and messages, like notifications | S | — |
| Video / audio / Office previews, server-side thumbnails, an image gallery per task | M | — |
| Bulk Inbox actions on a selection; auto-archive old notifications | S | — |
| Push notifications (see 1.5); the email digest is built (real-3) | — | see Group 1 |

### Reporting, dashboards, export
| Item | Size | Needs Avi |
|------|------|-----------|
| Reports caching (every request recalculates; fine at today's size) | S | — |
| More charts (line, stacked, pie, burn-up/down), group by custom field or task type, saved report filters | M | — |
| Share a personal dashboard; widget sizes and drag-to-reorder; portfolio dashboards | M | — |
| ~~Scheduled report emails~~ built in real-3 (Reports → Schedule email) | — | — |
| XLSX export, CSV for Board / Calendar / Timeline / My Tasks | M | — |
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
| Notification settings (per-project mute, per-event email choices) | **Partly.** Per-kind Inbox / Email switches (real-2); no per-project mute | S–M | — |
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
