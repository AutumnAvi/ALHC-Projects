# Security review

## Pass 2 status (branch `security/review-fixes`)

Fixes are in `supabase/migrations/20261018020000_security_review_fixes.sql` (with a TAIL), `src/lib/safe-fetch.ts`, `src/lib/email-reply.ts`, and `setWorkspaceLogo`. `supabase/tests/zz24_security_review_smoke.sql` now asserts each fix; `tests/unit/safe-fetch.test.ts` and `tests/unit/reply-auth.test.ts` cover the app side. Nothing was applied to the hosted project.

| # | Finding | Status |
| --- | --- | --- |
| 1 | Webhook / Slack SSRF through DNS names | **Fixed.** The drain posts with `safePost()`: Node's `https.request` with a custom `lookup` that resolves the host and refuses the request when *any* answer is loopback, private, link-local (incl. `169.254.169.254`), shared `100.64.0.0/10`, multicast, reserved, documentation, or the IPv6 equivalents (`::1`, `fc00::/7`, `fe80::/10`, and IPv4 inside mapped, NAT64, and 6to4 addresses). The checked address is the one the socket connects to, so a second lookup can't rebind it. IP literals are checked before connecting. Redirects are never followed (a 3xx is a failed send), and the whole request times out after 10 s; responses are read up to 4 KB. A blocked send is logged as “resolves to a private or local address”. `integration_url_ok` / `isAllowedWebhookUrl` also refuse the shared and reserved literals when a URL is saved (SQL can't resolve names, so names are checked at send time). The guard doesn't depend on whether Vercel blocks link-local addresses. |
| 2 | Definer helpers without a membership check | **Fixed.** `task_request_label` and `format_request_label` were already SECURITY INVOKER after PR #46 (task numbering); verified (a non-member gets null). `custom_field_project` / `rule_project` were only used by five policies; those now call `custom_field_has_role(field, role)` / `rule_has_role(rule, role)`, which answer only “does the caller have this role in that project”. The old helpers are revoked from clients and answer only for readable projects. Suite 60's definer list was updated on purpose. |
| 3 | Removed comment text still selectable | **Fixed.** A BEFORE UPDATE trigger (`comments_zz_scrub_removed`) moves the text to `comment_removed_bodies` (RLS on, no policies, no client privileges), sets the body to `[deleted]`, and blanks the copies in `email_outbox` payloads (comment emails and submitter responses, which task viewers can read). Existing removed comments got the same treatment in the migration. The row stays, so the “Comment deleted” placeholder still renders. The suite searches every text / JSON column in `public` for the removed text and finds it only in the private table. A policy that hides removed rows was rejected: the delete action uses `UPDATE … RETURNING`, which a hidden new row would refuse. |
| 3b | `task_comment_page` returns the submitter address and subject | **Fixed for removed comments** (null now). For live emailed comments the address and subject stay visible to task viewers by design: the “Sent to / Replied via” card shows them, and `form_submissions` already gives task viewers the submitter's address. |
| 4 | Submitter replies accepted without an authentication result | **Fixed (fails closed).** `submitterReplyVerified()` requires DMARC pass, or SPF and DKIM both passing when Resend gives no DMARC verdict (or `none`). A missing or empty result is unverified: the reply is refused before `post_submitter_reply` runs (logged as `unverified_sender`, no address), so nothing is posted under the submitter's address. Forwards keep requiring DMARC pass. |
| 5 | `TRUNCATE` for clients | **Fixed.** TRUNCATE, REFERENCES, and TRIGGER revoked from `anon` and `authenticated` on all 89 ALHC tables (the list is ours; the other app's tables are untouched) and on `storage.objects` (anon keeps INSERT for form uploads). New tables call `alhc_revoke_client_truncate`; the suite fails on any ALHC table that keeps those grants. **Deferred:** revoking the unused INSERT / UPDATE / DELETE grants table by table. RLS already refuses them (there are no DELETE policies), and doing it safely needs per-table re-grants plus a tail for the DELETE keyword. |
| 6 | Logo bucket public, old logos kept | **Fixed (kept public).** Logo files stay public so the sidebar (and later emails) can use a plain URL. Listing the bucket is now limited to that workspace's admins (was everyone allowlisted). The TAIL adds an admin-only delete policy, and replacing or removing a logo removes the previous file. Until the tail is applied the old file simply stays, as before. |

Residual notes below are unchanged (CSP headers, `NEXT_PUBLIC_APP_URL`, form CAPTCHA).

---

# Pass 1 (read-only audit)

Read-only audit of ALHC Projects on this branch (`security/review-pass1`). No application code and no hosted database were changed. Evidence is `supabase/tests/zz24_security_review_smoke.sql`, run against a throwaway local Postgres 17 after every migration in `supabase/migrations/`. Catalog checks (RLS flags, `search_path`, anon `EXECUTE`, grants) were the same database.

Severity is what an attacker who is not supposed to have the data can do with the current code. Confidence is how sure the review is that the behavior is real.

## Attack surface

86 tables in `public`. Every one has row level security. Eight of them have no policies, so the Data API sees nothing: `email_replies`, `email_reply_tokens`, `email_suppressions`, `integration_outbox`, `integration_secrets`, `project_integrations`, `submitter_reply_threads`, `tag_field_migrations`.

`anon` can execute five `SECURITY DEFINER` functions in `public`, and no others: `get_public_form`, `submit_form`, `receive_inbound_webhook`, `email_unsubscribe`, `calendar_feed`. Every public definer function sets `search_path`. None of the policies found are `USING (true)` or `WITH CHECK (true)`, and no `UPDATE` policy is missing `WITH CHECK`.

HTTP routes that do not require a session (`src/proxy.ts` public paths, plus signed-in routes outside the app shell):

| Route | Auth |
| --- | --- |
| `POST /api/inbound/email` | Svix signature (`RESEND_WEBHOOK_SECRET`); then the service role |
| `POST /api/inbound/[token]` | Hashed endpoint token; anon key, never the service role |
| `GET /api/calendar/[token]` | Feed token; anon `calendar_feed` |
| `POST /api/email/unsubscribe` | Unsubscribe token; anon `email_unsubscribe`. GET does not change anything |
| `GET /api/cron/workflows` | `Authorization: Bearer` compared in constant time to `CRON_SECRET` |
| `GET /attachments/[id]` | Session and allowlist, then storage RLS |
| `GET /export/[kind]` | Session; the signed-in user's client |
| `/forms/[formId]` | Public form; `get_public_form` / `submit_form` |
| `/login`, `/signup`, `/auth/callback` | Supabase Auth, then `is_allowlisted()` |

Writes from the browser go through Server Actions in `src/lib/actions.ts`, `src/lib/shell-actions.ts`, `src/lib/project-page-actions.ts`, and `src/app/login/actions.ts`, using the caller's Supabase client. The service-role client is created only in `src/lib/supabase/admin.ts` (`import "server-only"`) and used by the email drain, the integration drain, the inbound-email route, and the cron route. It is not referenced from a `NEXT_PUBLIC_` variable.

## Findings

### 1. High — outbound webhooks accept DNS names that point at loopback and link-local addresses

**Where:** `public.integration_url_ok` in `supabase/migrations/20261005080000_integrations.sql` lines 37–56, and the same rules in `isAllowedWebhookUrl` in `src/lib/integrations-shared.ts` lines 31–66. The drain calls that check and then `fetch`es the URL (`src/lib/integrations.ts` lines 114–126) with `redirect: "manual"`.

**What happens:** Literal private, loopback, and link-local addresses are rejected, and so are hosts that end in `.internal` or start with `169.254.`. These are still accepted:

- `https://a.169.254.169.254.nip.io/latest` (nip.io ignores a leading label and answers with `169.254.169.254`)
- `https://customer.localtest.me/hook` (`localtest.me` and its subdomains resolve to `127.0.0.1`)
- `https://100.64.0.1/` (the `100.64.0.0/10` shared range is not in the denylist)

Any allowlisted person can create a project, become its owner, and save a Slack or webhook URL. A rule action then queues `integration_outbox`, and the drain POSTs the task payload plus the shared-secret header or HMAC signing key to whatever that name resolves to.

**Reproduce:** `supabase/tests/zz24_security_review_smoke.sql` (the `integration_url_ok` block). The same three strings pass `isAllowedWebhookUrl`.

**Fix:** Before every POST, resolve the host and refuse loopback, link-local, private, and shared (`100.64.0.0/10`) answers, including DNS rebinding on a second lookup. Keep rejecting the IP literals the function already rejects. Treat a failed lookup as a failed send.

**Confidence:** High that the filter accepts those URLs. The practical impact is high when the app runtime can open a connection to `127.0.0.1` or `169.254.169.254` (cloud instance metadata). Confirm that on the Vercel deployment; some platforms block link-local from functions.

### 2. Medium — request labels, field ids, and rule ids are readable without membership or an allowlist

**Where:**

- `public.task_request_label` — `supabase/migrations/20261005020000_workflows.sql` lines 248–261
- `public.format_request_label` — same file, lines 228–246
- `public.custom_field_project` — `supabase/migrations/20261005050000_teams_permissions.sql` lines 211–222
- `public.rule_project` — same file, lines 224–235

All four are `SECURITY DEFINER`, granted to `authenticated`, and none of them call `is_allowlisted()`, `has_project_role`, or `has_task_role`. They read `tasks`, `request_sequences`, `custom_fields`, and `rules` as the owner, so RLS does not apply.

**What happens:** A confirmed user who is not on the allowlist, and who cannot `SELECT` the task, still gets `SECRET-0041` from `task_request_label`. The same caller gets the project's number prefix from `format_request_label`, and the project uuid from `custom_field_project` / `rule_project`, given those ids. Task and project uuids travel in links. Being removed from the allowlist or from the project does not cut off these RPCs.

`next_request_number` is not granted to clients, so this does not let someone burn sequence numbers.

**Reproduce:** the first `FINDING` block in `zz24_security_review_smoke.sql`. The caller is `sec24-unlisted@example.com` (`is_allowlisted()` is false, and `SELECT` on the task, field, rule, and sequence returns no rows).

**Fix:** At the start of each function, return null unless `is_allowlisted()` and the caller has `has_project_role` / `has_task_role` on the row. `custom_field_project` and `rule_project` are also used inside policies; a null for a caller who cannot see the row keeps that use safe. Revoke `EXECUTE` from `authenticated` on `format_request_label` if nothing in the client needs it.

**Confidence:** High.

### 3. Medium — a deleted comment's text and submitter address are still readable

**Where:**

- `comments_select_viewer` — `supabase/migrations/20261005050000_teams_permissions.sql` lines 1051–1052. The policy is `has_task_role(task_id, 'viewer')` and does not care about `deleted_at`.
- `task_comment_page` — `supabase/migrations/20261014120000_perf_audit.sql` lines 267 and 284. A deleted comment's body is returned as `''`, but `email_direction`, `email_address`, and `email_subject` are returned anyway.

**What happens:** Soft-delete is supposed to leave a placeholder and not send the body to the browser. The page function does blank the body. The Data API does not: any task viewer can `select body from comments` and read the text the author removed. The page function still returns the form submitter's address and the email subject for that deleted comment.

**Reproduce:** the deleted-comment block in `zz24_security_review_smoke.sql`. A Viewer who was added after the delete reads `please delete this secret body` from the table, and `task_comment_page` returns `submitter@secret.example` and `Re: secret` with an empty body.

**Fix:** In `comments_select_viewer` (and the column list of `task_comment_page`), return the body, address, and subject only while `deleted_at` is null. Keep the row visible so the placeholder still renders. Do the same for any other client-readable copy of those columns (the inbox page already joins the comment; confirm it does not substitute a deleted body).

**Confidence:** High.

### 4. Medium — a submitter reply is accepted when Resend sends no authentication result

**Where:** `senderAuthenticated` in `src/app/api/inbound/email/route.ts` lines 63–71. The forward path next to it (`forwardSenderVerified`, lines 76–79) requires `authentication.dmarc === "pass"`.

**What happens:** If the Receiving API object has no `authentication` value, or omits both SPF and DKIM, the function returns true. The route then calls `post_submitter_reply` as the service role. That function still requires a live reply token and a From address equal to the thread's submitter, and the token is 40 hex characters. The gap is the second check: a message that merely spoofs that From is treated as authenticated whenever Resend does not attach a result. Forwards do not have this hole.

The Svix check itself is sound: HMAC over `id.timestamp.body`, a 300 second window, constant-time compare (`src/lib/email-reply.ts` lines 77–95). The route does not store `svix-id`. A replay inside the window is deduped by the provider email id in `post_submitter_reply`. Comment text is stored as text; the app has no `dangerouslySetInnerHTML`, and outbound HTML goes through `escapeHtml` in `src/lib/email-layout.ts` line 23.

**Reproduce:** Call `senderAuthenticated` with `{}`, with `{ authentication: null }`, and with `{ authentication: {} }`. All three return true. `{ authentication: { dmarc: "fail" } }` and `{ authentication: { spf: "fail", dkim: "fail" } }` return false. `forwardSenderVerified` returns false for all of the true cases above.

**Fix:** Treat a missing authentication object the way forwards do: refuse unless Resend reports DMARC pass (or both SPF and DKIM pass, if that is the receiving payload's real shape). Do not default to true.

**Confidence:** High on the branch in the route. Medium on how often Resend omits the object; the code comment says the check applies when Resend reports a result, and the implementation does the opposite when it does not.

### 5. Low — `authenticated` and `anon` still hold `TRUNCATE` (and other writes RLS is meant to refuse)

**Where:** Table privileges after all migrations. `TRUNCATE` is not subject to row level security. There is no `TRUNCATE` policy to tighten it.

**What happens:** `authenticated` can `TRUNCATE` `task_stories`, `comments`, and the other content tables it was granted at creation. `anon` can `TRUNCATE` `storage.objects`. `INSERT` into `allowed_emails` and `task_stories` is granted and then refused by RLS (no insert policy), which the evidence suite checks. PostgREST does not send `TRUNCATE`, so the Data API cannot wipe a table today. A later `SECURITY INVOKER` function that builds SQL from a parameter could.

**Reproduce:** `zz24_security_review_smoke.sql` asserts the privileges, then `TRUNCATE public.rule_presets` as `authenticated` inside a transaction that rolls back. The statement succeeds.

**Fix:** `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM authenticated, anon` and re-grant only the commands each table's policies actually use. Do the same for `storage.objects` (`anon` should keep `INSERT` only). Repeat that revoke at the end of every migration that creates a table, next to `alhc_revoke_anon_grants`.

**Confidence:** High that the privilege exists and that `TRUNCATE` succeeds. High that today's HTTP API does not issue it.

### 6. Low — workspace logos live in a public bucket and cannot be removed

**Where:** `supabase/migrations/20261008030000_asana_feel_2.sql` lines 760–788. `storage.buckets.public` is true for `workspace-assets`. The only policies are admin insert and allowlisted select. There is no delete or update policy.

**What happens:** Anyone who learns the object path can fetch it from `/storage/v1/object/public/workspace-assets/...` without a session. The path contains a random id, so it is not guessable. Replacing a logo inserts a new object and leaves the old one in place (the migration comment says old files are not deleted). The bucket's MIME list is PNG, JPEG, WebP, and GIF, so this is not an HTML upload.

**Reproduce:** `select public from storage.buckets where id = 'workspace-assets'` is true. Asserted in the evidence suite.

**Fix:** Make the bucket private and serve the logo through a short-lived signed URL, or accept that logos are public and add a delete policy so a replaced file can be removed.

**Confidence:** High.

## Checked and holding

These were examined and did not show a cross-tenant leak.

**Row level security.** All 86 `public` tables have RLS. No policy is `USING (true)`. Update policies that exist also have `WITH CHECK`. Secret tables listed above are deny-all for the Data API. `storage.buckets` has RLS off and `anon` can `SELECT` it; the rows are bucket name, size limit, and MIME list, not objects.

**Perf readers.** `project_task_cards`, `project_section_task_counts`, `project_task_card_page`, `project_schedule_cards`, `task_comment_page`, `my_task_cards`, `my_tasks_layout`, `sync_my_task_placements`, `inbox_page`, and `inbox_unread_count` are definer, set `search_path`, and are not granted to `anon`. Each returns empty for a null user or a failed `has_project_role` / `is_allowlisted()` check before it reads rows. The evidence suite calls the project and inbox readers as a user who is not allowlisted and gets empty results. Existing suites `zz20`–`zz23` pin the member versus non-member card shapes; this pass did not re-run those files.

**Allowlist as the outer gate.** `has_project_role` goes through `is_allowlisted()`. A non-member's `project_task_cards` is `[]`. Direct `INSERT` into `task_stories` and `allowed_emails` raises a row-level security error. Workspace-admin helpers used by the Admin console are not consulted by project read policies (unchanged from the model in `AGENTS.md`).

**Auth.** Sign-up and the OAuth callback both call `is_allowlisted()` and `signOut()` on failure (`src/app/login/actions.ts` lines 42–46, `src/app/auth/callback/route.ts` lines 24–30). `safeNextPath` (`src/lib/auth.ts` lines 16–27) allows only a same-origin path. The login page renders the error string as React text. There is no in-app password-reset route; reset, if enabled, is Supabase Auth's, and the redirect allowlist there is the control. The proxy only checks that a JWT exists; project data still depends on RLS, which requires the allowlist.

**Service role.** `createAdminClient` is server-only. Call sites are the two drains, `src/app/api/inbound/email/route.ts`, and `src/app/api/cron/workflows/route.ts`. Cron returns 401 when the bearer secret is missing or wrong, and 401 when `CRON_SECRET` is unset.

**Inbound email and replies.** Webhook bodies over 256 KB are rejected. The reply token must match `^[0-9a-f]{40}$` on the reply domain. `post_submitter_reply` and `submitter_reply_token` are `service_role` only (asserted in the evidence suite and in `zz19`). Follower reply tokens were revoked in `20261014030000_comments_email.sql`. Forwarding requires DMARC pass and the sender's own address.

**Inbound webhooks and forms.** `POST /api/inbound/[token]` uses the anon key, caps the body at 64 KB, and maps authentication failures to one 401. `alhc_storage.form_upload_allowed` is not in `public`; the path must be three uuid segments, the extension is an allowlist, and the key must not already be a task id. SVG may be uploaded and is not served inline (`previewKind`).

**Calendar feeds.** `calendar_feed` is anon-only, hashes the token, and sets `request.jwt.claim.sub` to the owner only after the token matches. Unknown tokens and a caller with no feed get no events. The route does not log the token.

**Imports and attachments.** The `imports` bucket is private. Object policies require the uploader's id in the path and project admin. Attachment download signs a URL only after the metadata row is visible to the caller, and inlines a file only when the name, the recorded type, and the stored type agree.

**HTML in mail and comments.** Outbound mail escapes `& < > " '`. Slack substitution escapes `& < >` in values. No component uses `dangerouslySetInnerHTML`.

## Residual notes (not filed as their own findings)

- Public forms are unauthenticated task creation by design, with a per-address rate limit inside `submit_form` and no CAPTCHA. Rotating the address avoids the limit.
- `requestOrigin` (`src/lib/origin.ts` lines 8–12) uses `X-Forwarded-Host` when `NEXT_PUBLIC_APP_URL` is unset. Set that variable in every deployed environment.
- `next.config.ts` adds no `Content-Security-Policy`, `X-Frame-Options`, or `X-Content-Type-Options`. Supabase session cookies default to `SameSite=Lax`, which keeps a cross-site iframe from sending the session.
- `storage.buckets` has RLS disabled. The exposed columns are not object bytes.

## How this was run

Local Postgres 17, `supabase/tests/auth_shim.sql`, then every file in `supabase/migrations/`, then `zz24_security_review_smoke.sql`. The full `npm run db:test` suite was not re-run in this pass. The hosted project `xsgmawawwstbrbukgsax` was not queried and not modified.
