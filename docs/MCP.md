# MCP server (AI builder round 5, experimental — branch feat/ai-builder-p5, do not merge to main)

ALHC Projects exposes the AI assistant's capability registry (`packages/core/src/ai-tools.ts`, handlers in
`packages/core/src/api/capabilities/`) as a Model Context Protocol server, so Claude Desktop, Claude Code,
Cursor, or any MCP client can read and change the **Testing data** pilot workspace as you — never more than
your role in each project allows by hand.

## Endpoint

- `POST /api/mcp` — MCP Streamable HTTP, stateless (`@modelcontextprotocol/sdk`, JSON responses).
- Auth: `Authorization: Bearer alhc_pat_…` (a personal access token). **Only that header counts**: the route
  never reads cookies, so a browser session can't reach it.
- Only workspace admins of the Testing data pilot can make tokens, and every tool stays inside that workspace.

## Tokens (Settings → AI & MCP, `/settings/mcp`)

- Make a token with a name, scopes (**read**, or **read + write**), and an expiry (1–90 days; default 30).
  It is shown **once**. At most 10 live tokens per person. Revoke any time (a revoked token stays revoked).
- Stored only as `HMAC-SHA256(ALHC_MCP_TOKEN_PEPPER, token)` plus a short prefix to recognise it
  (`personal_access_tokens`, own rows only, the hash never readable by clients). The pepper is a server
  secret the database never sees, so a copy of the table can't be used to check guesses.
- 120 calls a minute per token; `last_used_at` is recorded.

### How a request becomes "you" (and why it's safe)

1. The route hashes the bearer token with the pepper and calls `mcp_token_verify(hash)` with the service
   role — the **only** service-role use. That definer function answers just `{ status, token_id,
   profile_id, workspace_id, scopes }`, and only when the token is live, unexpired, within its rate limit, and
   its owner is still allowlisted and still a workspace admin of the live pilot.
2. The route then mints a **5-minute HS256 access token for that person** (`sub` = their id, `role` =
   `authenticated`) with the project's JWT secret (`SUPABASE_JWT_SECRET`) and makes a cookie-less client with
   it. Every read and write runs through PostgREST and **RLS as that person**, exactly as if they were signed
   in; the typed API's own checks and the registry's role table apply on top.
3. Without `ALHC_MCP_TOKEN_PEPPER` (≥ 32 characters), `SUPABASE_JWT_SECRET`, and the service role key the
   endpoint answers 503 and reads nothing (fails closed).

No token, prompt, tool input, or tool result is logged. OAuth 2.1 (the MCP authorization spec) is not built:
personal access tokens cover the pilot; an OAuth authorization server would hand out the same per-person
tokens later (TODO).

> Note: minting needs the project's JWT secret (legacy HS256 key). If the Supabase project only accepts its
> asymmetric signing keys, set the legacy secret as still accepted, or swap step 2 for a definer that sets
> `request.jwt.claim.sub` per call. Decide before enabling on the preview.

## Connect a client

Claude Desktop / Claude Code (`claude mcp add`), Cursor, and others take a URL and a header:

```json
{
  "mcpServers": {
    "alhc": {
      "type": "http",
      "url": "https://<preview host>/api/mcp",
      "headers": { "Authorization": "Bearer alhc_pat_…" }
    }
  }
}
```

## How tools behave

- **Read tools** answer at once (search, read a task / project / automation, list your own things). Things
  are named by id.
- **Write tools** need a token with the **write** scope. Each call is staged exactly like the in-app
  assistant's (resolved, the role checked as by hand, previewed), then applied through the same Confirm path
  (checked again against the database, written through the typed API, rolled back on a refusal) and logged
  as a run (`source = mcp`, the token named) with **Undo** in the app's AI history (`/ai-builder`).
- **Destructive** tools, and changes that **message people**, only return a preview until the call says
  `confirm: true`. Pass `confirm: false` to preview anything.
- Automations are always created **off**; turning on one that messages people needs `confirm: true`.

## Read tools

| Tool | What |
|---|---|
| `search_tasks` | Search tasks |
| `search_projects` | Search projects |
| `search_people` | Find people |
| `get_task` | Read a task |
| `get_project` | Read a project |
| `get_automation` | Read an automation |
| `list_my_things` | List your own things |
## Write tools and who may use them (generated from the registry)

"Who" is the lowest project role that may do it by hand; Commenters and Viewers change nothing (the in-app assistant answers their questions only). Archived projects are read-only for everyone; locked sections change only by Owners; locked fields follow the field rules.

| Tool | What | Who | Owner | Admin | Editor | Flags | Undo | Also |
|---|---|---|:-:|:-:|:-:|---|---|---|
| `create_task` | Create a task | Editor+ | ✓ | ✓ | ✓ |  | Undo |  |
| `create_subtask` | Add a subtask | Editor+ | ✓ | ✓ | ✓ |  | Undo |  |
| `duplicate_task` | Duplicate a task | Editor+ | ✓ | ✓ | ✓ |  | Undo |  |
| `rename_task` | Rename a task or subtask | Editor+ | ✓ | ✓ | ✓ |  | Undo |  |
| `set_description` | Change a description | Editor+ | ✓ | ✓ | ✓ |  | Undo |  |
| `move_task` | Move a task | Editor+ | ✓ | ✓ | ✓ |  | Undo | Editor of both projects to move it to another |
| `add_task_to_project` | Also add a task to another project | Editor+ | ✓ | ✓ | ✓ |  | Undo | Editor of both projects |
| `remove_task_from_project` | Remove a task from a project | Editor+ | ✓ | ✓ | ✓ | destructive | Undo | not its last project |
| `assign_task` | Assign a task | Editor+ | ✓ | ✓ | ✓ |  | Undo | only to the project's members |
| `set_dates` | Set dates | Editor+ | ✓ | ✓ | ✓ |  | Undo |  |
| `set_recurrence` | Make a task repeat | Editor+ | ✓ | ✓ | ✓ |  | Undo |  |
| `complete_task` | Complete a task | Editor+ | ✓ | ✓ | ✓ |  | Undo | never a blocked task; an approval task only by its approvers |
| `reopen_task` | Reopen a task | Editor+ | ✓ | ✓ | ✓ |  | Undo |  |
| `delete_task` | Delete a task | Editor+ | ✓ | ✓ | ✓ | destructive | Undo | goes to the Trash with its subtasks |
| `restore_task` | Restore a task from the Trash | Editor+ | ✓ | ✓ | ✓ |  | Undo |  |
| `convert_to_subtask` | Make a task a subtask | Editor+ | ✓ | ✓ | ✓ |  | Undo |  |
| `convert_to_task` | Make a subtask a task | Editor+ | ✓ | ✓ | ✓ |  | Undo |  |
| `set_task_type` | Set a task's type | Editor+ | ✓ | ✓ | ✓ |  | Undo |  |
| `bulk_edit` | Change many tasks at once | Editor+ | ✓ | ✓ | ✓ |  | Undo | each task is checked on its own; more than 10 tasks is marked as a big change |
| `set_approvers` | Set an approval task's approvers | Editor+ | ✓ | ✓ | ✓ |  | Undo | approvers need Commenter+; while a round is pending only Owners and Admins |
| `set_approval_follow_up` | What happens after approval | Editor+ | ✓ | ✓ | ✓ |  | Undo |  |
| `send_for_approval` | Send for approval | Editor+ | ✓ | ✓ | ✓ |  notifies | Undo | notifies the approvers; Undo withdraws it |
| `withdraw_approval` | Withdraw an approval round | Editor+ | ✓ | ✓ | ✓ |  | no Undo |  |
| `acknowledge_approval` | Feedback / rejection received | Commenter+ | ✓ | ✓ | ✓ |  | no Undo | the assignee or an Editor |
| `hand_off_approval` | Hand off your approval | Commenter+ | ✓ | ✓ | ✓ |  notifies | no Undo | only an approver who hasn't decided; notifies the new approver |
| `request_approval` | Request approval (approval subtask) | Editor+ | ✓ | ✓ | ✓ |  notifies | Undo | notifies the approver; Undo cancels it |
| `cancel_approval` | Cancel an approval request | Editor+ | ✓ | ✓ | ✓ |  | no Undo |  |
| `resubmit_approval` | Resubmit an approval request | Editor+ | ✓ | ✓ | ✓ |  notifies | no Undo | notifies the approver |
| `add_comment` | Comment on a task | Commenter+ | ✓ | ✓ | ✓ |  notifies | Undo | notifies the task's followers and anyone @mentioned |
| `edit_comment` | Edit your comment | Commenter+ | ✓ | ✓ | ✓ |  | Undo | your own comments only |
| `delete_comment` | Delete your comment | Commenter+ | ✓ | ✓ | ✓ | destructive | no Undo | your own comments only; can't be undone |
| `pin_comment` | Pin a comment | Editor+ | ✓ | ✓ | ✓ |  | Undo |  |
| `react_to_comment` | React to a comment | Commenter+ | ✓ | ✓ | ✓ |  | Undo |  |
| `follow_task` | Follow / unfollow a task | Commenter+ | ✓ | ✓ | ✓ |  | Undo | removing someone else needs Editor |
| `add_tag` | Tag a task | Editor+ | ✓ | ✓ | ✓ |  | Undo | tags must be on in the workspace |
| `remove_tag` | Untag a task | Editor+ | ✓ | ✓ | ✓ |  | Undo |  |
| `create_tag` | Create a tag | its own rule | ✓ | ✓ | ✓ |  | Undo |  |
| `add_dependency` | Add a dependency | Editor+ | ✓ | ✓ | ✓ |  | Undo | Editor on both tasks |
| `remove_dependency` | Remove a dependency | Editor+ | ✓ | ✓ | ✓ | destructive | Undo |  |
| `shift_with_dependents` | Move dates and their dependents | Editor+ | ✓ | ✓ | ✓ |  | Undo | lists every task that moves before Confirm |
| `delete_attachment` | Remove a file | Editor+ | ✓ | ✓ | ✓ | destructive | no Undo | can't be undone (no uploads from the AI) |
| `create_section` | Add a section | Editor+ | ✓ | ✓ | ✓ |  | Undo | Owners only while sections are locked |
| `rename_section` | Rename a section | Editor+ | ✓ | ✓ | ✓ |  | Undo | Owners only while sections are locked |
| `move_section` | Reorder sections | Editor+ | ✓ | ✓ | ✓ |  | Undo | Owners only while sections are locked |
| `delete_section` | Delete an empty section | Editor+ | ✓ | ✓ | ✓ | destructive | Undo | only an empty section; Undo makes it again |
| `lock_sections` | Lock / unlock sections | Owner+ | ✓ |  |  |  | Undo |  |
| `create_project` | Create a project | its own rule | ✓ | ✓ | ✓ |  | Undo | in the Testing data workspace; you own it |
| `update_project` | Rename / describe a project | Admin+ | ✓ | ✓ |  |  | Undo |  |
| `set_project_status` | Post a status update | Editor+ | ✓ | ✓ | ✓ |  notifies | no Undo | notifies the project's members; stays in the status history |
| `archive_project` | Archive / unarchive a project | Admin+ | ✓ | ✓ |  |  | Undo |  |
| `delete_project` | Delete a project | Owner+ | ✓ |  |  | destructive | no Undo | Owners only; can't be undone here |
| `duplicate_project` | Duplicate a project | Editor+ | ✓ | ✓ | ✓ |  | Undo | rules copied off |
| `save_as_template` | Save a project as a template | Admin+ | ✓ | ✓ |  |  | Undo |  |
| `save_task_template` | Save a task as a task template | Editor+ | ✓ | ✓ | ✓ |  | Undo |  |
| `add_member` | Add someone to a project | Admin+ | ✓ | ✓ |  |  | Undo | people of the Testing data workspace only; Owners add Owners |
| `change_member_role` | Change someone's role | Admin+ | ✓ | ✓ |  |  | Undo | only Owners change Owners |
| `remove_member` | Remove someone from a project | Admin+ | ✓ | ✓ |  | destructive | Undo | never the last Owner; Undo adds them back with their role |
| `create_project_role` | Add a project role | Editor+ | ✓ | ✓ | ✓ |  | Undo |  |
| `rename_project_role` | Rename a project role | Editor+ | ✓ | ✓ | ✓ |  | Undo |  |
| `set_project_role_person` | Change who fills a project role | Editor+ | ✓ | ✓ | ✓ |  | Undo | open tasks follow |
| `remove_project_role` | Remove a project role | Editor+ | ✓ | ✓ | ✓ | destructive | no Undo |  |
| `create_field` | Add a custom field | Editor+ | ✓ | ✓ | ✓ |  | Undo |  |
| `rename_field` | Rename a custom field | Editor+ | ✓ | ✓ | ✓ |  | Undo | locked: Owners and Admins; shared: editors of the project that published it |
| `update_field_options` | Add, rename, or remove a field's options | Editor+ | ✓ | ✓ | ✓ |  | Undo | locked: Owners and Admins; shared: editors of the project that published it |
| `set_field_description` | Describe a custom field | Editor+ | ✓ | ✓ | ✓ |  | Undo | locked: Owners and Admins |
| `lock_field` | Lock / unlock a custom field | Admin+ | ✓ | ✓ |  |  | Undo |  |
| `remove_field` | Remove a custom field from the project | Editor+ | ✓ | ✓ | ✓ | destructive | Undo | locked: Owners and Admins; values are kept |
| `set_field_value` | Set a field value | Editor+ | ✓ | ✓ | ✓ |  | Undo | a locked field: Owners and Admins |
| `create_automation` | Create an automation | Admin+ | ✓ | ✓ |  |  | Undo | it's created off |
| `update_automation` | Edit an automation | Admin+ | ✓ | ✓ |  |  | Undo |  |
| `enable_automation` | Turn an automation on / off | Admin+ | ✓ | ✓ |  |  | Undo | turning on one that messages people needs its own confirmation |
| `delete_automation` | Remove an automation | Admin+ | ✓ | ✓ |  | destructive | Undo |  |
| `duplicate_automation` | Duplicate an automation | Admin+ | ✓ | ✓ |  |  | Undo |  |
| `pause_automation` | Pause an automation for a while | Admin+ | ✓ | ✓ |  |  | Undo |  |
| `run_automation` | Run an automation on a task | Editor+ | ✓ | ✓ | ✓ |  | no Undo | "Run manually" automations; what it does can't be undone here |
| `create_my_automation` | Create a My Tasks automation | you (your own) | ✓ | ✓ | ✓ |  | Undo | your own; created off |
| `update_my_automation` | Edit a My Tasks automation | you (your own) | ✓ | ✓ | ✓ |  | Undo |  |
| `enable_my_automation` | Turn a My Tasks automation on / off | you (your own) | ✓ | ✓ | ✓ |  | Undo |  |
| `delete_my_automation` | Delete a My Tasks automation | you (your own) | ✓ | ✓ | ✓ | destructive | no Undo |  |
| `create_portfolio_automation` | Create a portfolio automation | its own rule | ✓ | ✓ | ✓ |  | Undo | portfolio Admins+; created off |
| `update_portfolio_automation` | Edit a portfolio automation | its own rule | ✓ | ✓ | ✓ |  | Undo | portfolio Admins+ |
| `enable_portfolio_automation` | Turn a portfolio automation on / off | its own rule | ✓ | ✓ | ✓ |  | Undo | portfolio Admins+ |
| `delete_portfolio_automation` | Delete a portfolio automation | its own rule | ✓ | ✓ | ✓ | destructive | no Undo | portfolio Admins+ |
| `create_view` | Add a view | Editor+ | ✓ | ✓ | ✓ |  | Undo |  |
| `rename_view` | Rename a view | Editor+ | ✓ | ✓ | ✓ |  | Undo |  |
| `delete_view` | Delete a view | Editor+ | ✓ | ✓ | ✓ | destructive | no Undo | never the last one; the default view only by Owners |
| `set_default_view` | Set the default view | Owner+ | ✓ |  |  |  | Undo |  |
| `add_widget` | Add a dashboard widget | Editor+ | ✓ | ✓ | ✓ |  | Undo |  |
| `delete_widget` | Remove a dashboard widget | Editor+ | ✓ | ✓ | ✓ | destructive | no Undo |  |
| `create_form` | Add a form | Admin+ | ✓ | ✓ |  |  | Undo | starts off |
| `rename_form` | Rename a form | Admin+ | ✓ | ✓ |  |  | Undo |  |
| `set_form_live` | Turn a form on / off | Admin+ | ✓ | ✓ |  |  | Undo | a live form takes public responses |
| `delete_form` | Delete a form | Admin+ | ✓ | ✓ |  | destructive | no Undo |  |
| `create_portfolio` | Create a portfolio | its own rule | ✓ | ✓ | ✓ |  | Undo | you own it |
| `update_portfolio` | Rename a portfolio | its own rule | ✓ | ✓ | ✓ |  | Undo | portfolio Editors+ |
| `add_project_to_portfolio` | Add a project to a portfolio | its own rule | ✓ | ✓ | ✓ |  | Undo | portfolio Editors+ who can read the project |
| `remove_project_from_portfolio` | Remove a project from a portfolio | its own rule | ✓ | ✓ | ✓ | destructive | Undo | portfolio Editors+ |
| `create_goal` | Create a goal | its own rule | ✓ | ✓ | ✓ |  | Undo | Goals must be on in the workspace |
| `update_goal` | Edit a goal | its own rule | ✓ | ✓ | ✓ |  | Undo | its owner, a lead of its team, or a workspace admin |
| `post_goal_status` | Post a goal status update | its own rule | ✓ | ✓ | ✓ |  | no Undo | goal editors |
| `create_team` | Create a team | its own rule | ✓ | ✓ | ✓ |  | no Undo | you become its lead |
| `update_team` | Rename / describe a team | its own rule | ✓ | ✓ | ✓ |  | Undo | its leads and workspace admins |
| `create_my_section` | Add a My Tasks section | you (your own) | ✓ | ✓ | ✓ |  | Undo |  |
| `rename_my_section` | Rename a My Tasks section | you (your own) | ✓ | ✓ | ✓ |  | Undo |  |
| `move_to_my_section` | Move a task in My Tasks | you (your own) | ✓ | ✓ | ✓ |  | Undo | tasks assigned to you |
| `star_project` | Star a project | you (your own) | ✓ | ✓ | ✓ |  | Undo |  |
| `create_sidebar_folder` | Add a sidebar folder | you (your own) | ✓ | ✓ | ✓ |  | Undo |  |
| `file_project` | Put a project in a sidebar folder | you (your own) | ✓ | ✓ | ✓ |  | Undo |  |
| `mark_inbox` | Read / archive / bookmark Inbox items | you (your own) | ✓ | ✓ | ✓ |  | Undo |  |
| `create_dashboard` | Create a personal dashboard | you (your own) | ✓ | ✓ | ✓ |  | no Undo |  |

## Left out on purpose (typed-API writes the registry doesn't reach)

A test (`packages/core/tests/ai-assistant-round5.test.ts`) fails when a new typed-API mutation has neither a registry tool nor a line here.

| Left out | Why |
|---|---|
| `auth/mutations.ts` | Signing in and out, passwords, and the allowlist: never through the AI. |
| `system/mutations.ts` | Background work (outbox drains, cron, inbound email): system functions with the service role, never a person’s request. |
| `public/mutations.ts` | Public token-checked endpoints (calendar feeds, unsubscribe, inbound webhooks): anonymous, not a person. |
| `imports/mutations.ts` | Asana imports: an uploaded file and a long-running batch job, not an AI change. |
| `integrations/mutations.ts` | Webhook URLs, signing secrets, inbound tokens, delivery retries: secrets and outward delivery, never through the AI. |
| `slack/mutations.ts` | Slack connection and channels: a bot token (a secret) and outward messages. |
| `workspace/mutations.ts` | Workspace-wide admin settings (admins, invites, removal, logo, switches, verified domains, workweek): Admin console only. |
| `me/mutations.ts` | Personal settings, profile, notification and email preferences, report schedules (they send email), forwarding addresses. |
| `reviews/mutations.ts` | Review checks send an email to a reviewer immediately; the public review page is anonymous. |
| `calendar/mutations.ts` | Calendar feed links are secret URLs; calendar events are low value for the AI this round. |
| `attachments/mutations.ts` | Storage uploads (no file uploads from the model). |
| `ai-builder/mutations.ts` | The AI builder itself (round 1–2 runs), not a workspace change. |
| `ai-pilot/mutations.ts` | The pilot's seed / registration (operators only). |
| `ai-assistant/mutations.ts` | The assistant's own run log (propose / Confirm / Undo), not a workspace change. |
| `mcp/mutations.ts` | Personal access tokens are secrets made and revoked by the person in Settings → AI & MCP, never by the AI. |
| `messages/mutations.ts` | Project and team Messages notify whole projects / teams when posted; left out this round (comments on tasks are covered). |
| `numbers/mutations.ts` | Task numbering settings renumber many tasks at once (with a typed confirmation by hand); left out this round. |
| `members/invite.ts` | Inviting by email sends an email to someone outside the workspace; people of the pilot are added with add_member. |
| `approvals/mutations.ts:decideApproval` | Deciding an approval is the approver’s own act on the review page; the AI never decides for anyone. |
| `approvals/mutations.ts:completeApprovalAsApprover` | Completing an approval task is its approvers’ own act. |
| `automations/mutations.ts:testRule` | The Test panel (a dry run) is a read the builder already offers. |
| `automations/mutations.ts:installRulePreset` | Presets install several automations at once; create_automation covers each. |
| `automations/mutations.ts:runManualRuleOnTasks` | Bulk runs of an automation: run_automation covers one task at a time with a preview. |
| `automations/portfolio-rules.ts:runPortfolioRule` | Runs a portfolio automation on a project now (it can message people); left out this round. |
| `automations/portfolio-rules.ts:duplicatePortfolioRule` | Low value; create_portfolio_automation covers it. |
| `automations/portfolio-rules.ts:setPortfolioRulePausedUntil` | Low value; enable_portfolio_automation covers on / off. |
| `comments/mutations.ts:sendSubmitterResponse` | Emails a form’s submitter immediately. |
| `comments/mutations.ts:setReplyThreadClosed` | The submitter’s email thread: email settings, left out. |
| `comments/mutations.ts:registerAttachment` | Records an uploaded file (no uploads from the model). |
| `comments/mutations.ts:setEmailConversationOverride` | A workspace admin email policy override. |
| `dependencies/mutations.ts:applyDependencyShifts` | shift_with_dependents covers moving dates with dependents (one task at a time, with its plan). |
| `dependencies/mutations.ts:moveTaskDatesWith` | Timeline's drag keys; shift_with_dependents covers it. |
| `dependencies/mutations.ts:undoDependencyShift` | Undo is the run's own (each moved task put back). |
| `dependencies/mutations.ts:changeTaskDates` | set_dates / shift_with_dependents cover date changes. |
| `dependencies/mutations.ts:setDependencyShiftMode` | A project setting about future date changes; left out this round. |
| `fields/mutations.ts:addLibraryField` | Adding a shared library field links data across projects; left out this round. |
| `forms/mutations.ts:submitForm` | Submitting a form is the public’s act (anonymous), not a workspace change. |
| `goals/mutations.ts:linkGoal` | Goal links; left out this round. |
| `goals/mutations.ts:unlinkGoal` | Goal links; left out this round. |
| `goals/mutations.ts:deleteGoalStatusUpdate` | Status history; left out. |
| `members/mutations.ts:inviteProjectMember` | Invites by email (an email outside the workspace); add_member adds people of the pilot. |
| `members/mutations.ts:cancelPendingInvite` | Pending email invites; see inviteProjectMember. |
| `members/mutations.ts:resendPendingInvite` | Sends an invite email. |
| `members/mutations.ts:transferProjectOwnership` | Hands the project to someone else and demotes you; too consequential for an AI change. |
| `members/mutations.ts:loadTaskRoles` | A read (get_task covers it), not a change. |
| `members/mutations.ts:setTaskRoleLink` | Role links on a task; left out this round (assign_task covers the assignee). |
| `my-tasks/mutations.ts:placeMyTaskSection` | Drag order of My Tasks sections; left out. |
| `my-tasks/mutations.ts:quickAddTask` | Private tasks have no project (the AI works in pilot projects); create_task covers it. |
| `my-tasks/mutations.ts:setMyTasksChecked` | A display setting. |
| `my-tasks/mutations.ts:dismissDatePrompt` | A display prompt. |
| `my-tasks/mutations.ts:undoTaskCompleted` | The checklist’s own Undo; reopen_task covers it. |
| `my-tasks/mutations.ts:setTaskRowExpanded` | A display setting. |
| `portfolios/mutations.ts:addPortfolioProjects` | add_project_to_portfolio covers it (one at a time, each previewed). |
| `portfolios/mutations.ts:createProjectInPortfolio` | create_project + add_project_to_portfolio cover it. |
| `portfolios/mutations.ts:movePortfolioProject` | Card order; left out. |
| `portfolios/mutations.ts:invitePortfolioMember` | Invites by email. |
| `portfolios/mutations.ts:changePortfolioMemberRole` | Portfolio membership; left out this round. |
| `portfolios/mutations.ts:removePortfolioMember` | Portfolio membership; left out this round. |
| `portfolios/mutations.ts:transferPortfolioOwnership` | Too consequential for an AI change. |
| `portfolios/mutations.ts:addPortfolioChild` | Nested portfolios; left out this round. |
| `portfolios/mutations.ts:removePortfolioChild` | Nested portfolios; left out this round. |
| `portfolios/mutations.ts:createPortfolioField` | Portfolio fields; left out this round. |
| `portfolios/mutations.ts:updatePortfolioField` | Portfolio fields; left out this round. |
| `portfolios/mutations.ts:deletePortfolioField` | Portfolio fields; left out this round. |
| `portfolios/mutations.ts:setPortfolioFieldValue` | Portfolio fields; left out this round. |
| `projects/mutations.ts:updateProjectTeam` | Team and privacy change who can find the project; left out this round. |
| `projects/mutations.ts:joinProject` | Joining is the person’s own act from Browse. |
| `projects/mutations.ts:requestProjectAccess` | Asks a project’s owners (notifies them). |
| `projects/mutations.ts:decideAccessRequest` | Deciding someone’s access request; left out this round. |
| `projects/mutations.ts:createStatusTemplate` | Status templates; left out this round. |
| `projects/mutations.ts:updateStatusTemplate` | Status templates; left out this round. |
| `projects/mutations.ts:deleteStatusTemplate` | Status templates; left out this round. |
| `reports/mutations.ts:renamePersonalDashboard` | Low value; create_dashboard covers dashboards. |
| `reports/mutations.ts:deletePersonalDashboard` | Low value. |
| `reports/mutations.ts:createPersonalWidget` | Personal dashboard widgets take report filters; left out this round. |
| `reports/mutations.ts:updatePersonalWidget` | See createPersonalWidget. |
| `reports/mutations.ts:deletePersonalWidget` | See createPersonalWidget. |
| `reports/mutations.ts:movePersonalWidget` | Widget order. |
| `sidebar/mutations.ts:setProjectsStarred` | star_project covers it one project at a time. |
| `sidebar/mutations.ts:updateSidebarFolder` | Folder name / collapsed state; left out. |
| `tags/mutations.ts:moveTaskTag` | Board drags between tag columns; add_tag / remove_tag cover it. |
| `tasks/mutations.ts:createPrivateTask` | Private tasks have no project; create_task covers project tasks. |
| `tasks/mutations.ts:placeTask` | Drag order inside a section; move_task covers sections. |
| `tasks/mutations.ts:bulkEditTasks` | bulk_edit stages one previewed, undoable change per task instead. |
| `tasks/mutations.ts:lastProjectRefusalOf` | A helper, not a write. |
| `tasks/mutations.ts:createSubtaskFromFeedback` | create_subtask covers it. |
| `tasks/mutations.ts:updateSubtask` | Subtasks are tasks: rename_task / complete_task cover them. |
| `tasks/mutations.ts:placeSubtask` | Subtask drag order; left out. |
| `tasks/mutations.ts:deleteSubtask` | Subtasks are tasks: delete_task covers them. |
| `teams/mutations.ts:addTeamCuratedWork` | Curated work; left out this round. |
| `teams/mutations.ts:removeTeamCuratedWork` | Curated work; left out this round. |
| `teams/mutations.ts:moveTeamCuratedWork` | Curated work order. |
| `teams/mutations.ts:deleteTeam` | Deleting a team moves its projects and can’t be undone; left out. |
| `teams/mutations.ts:addTeamMember` | Invites by email. |
| `teams/mutations.ts:changeTeamMemberRole` | Team membership; left out this round. |
| `teams/mutations.ts:removeTeamMember` | Team membership; left out this round. |
| `teams/mutations.ts:requestTeamJoin` | The person’s own request (notifies the team’s leads). |
| `teams/mutations.ts:decideTeamJoinRequest` | Deciding someone’s request; left out this round. |
| `teams/mutations.ts:addTeamToProject` | Adds a whole team’s people to a project at once; add_member covers one person. |
| `templates/mutations.ts:createProjectFromTemplate` | Lands in the main workspace’s default team, outside the pilot; left out. |
| `templates/mutations.ts:updateProjectTemplate` | Workspace templates are shared beyond the pilot; left out. |
| `templates/mutations.ts:createTaskFromTemplate` | create_task covers tasks; templates left out this round. |
| `templates/mutations.ts:createTaskTemplate` | save_task_template covers task templates. |
| `templates/mutations.ts:updateTaskTemplate` | Task template editing; left out this round. |
| `views/mutations.ts:saveListColumnWidths` | A display setting. |
| `views/mutations.ts:saveListCollapsedGroups` | A display setting. |
| `views/mutations.ts:setProjectShowCompleted` | A display setting. |
| `views/mutations.ts:saveViewChanges` | View filters / sorts take the views config schema; left out this round. |
| `views/mutations.ts:saveViewForMe` | See saveViewChanges. |
| `views/mutations.ts:saveViewForEveryone` | See saveViewChanges. |
| `views/mutations.ts:duplicateView` | create_view covers views. |
| `views/mutations.ts:moveView` | Tab order. |
| `views/mutations.ts:moveViewBy` | Tab order. |
| `views/mutations.ts:setProjectTabHidden` | Tab visibility; left out this round. |
| `views/mutations.ts:setProjectViewHidden` | Tab visibility; left out this round. |
| `views/mutations.ts:installStarterWidgets` | add_widget covers widgets. |
| `views/mutations.ts:updateWidget` | Widget filters; left out this round. |
| `views/mutations.ts:moveWidget` | Widget order. |
| `workload/mutations.ts:setWorkloadCapacity` | Workload capacities; left out this round. |
