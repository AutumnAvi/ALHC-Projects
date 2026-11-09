// AI builder round 5 (note 178): every tool's handler, by name (the metadata — who may, the input schema —
// is ../../ai-tools.ts), and the typed API's writes the registry leaves out ON PURPOSE, each with why. The
// coverage test (packages/core/tests/ai-registry.test.ts) fails when a typed-API mutation is neither used
// by a handler here nor listed below, so a new write is either given to the AI or excluded explicitly.
import { WRITE_TOOLS, READ_TOOLS, type ToolName } from "../../ai-tools";
import { RULE_HANDLERS } from "./tools-rules";
import { READ_HANDLERS as READS } from "./tools-read";
import { STRUCTURE_HANDLERS } from "./tools-structure";
import { bulkEditTool, TASK_HANDLERS } from "./tools-tasks";
import { OTHER_HANDLERS } from "./tools-other";
import type { Handler, ReadHandler } from "./types";

export const HANDLERS: Record<string, Handler> = {
  ...TASK_HANDLERS,
  ...STRUCTURE_HANDLERS,
  ...RULE_HANDLERS,
  ...OTHER_HANDLERS,
  bulk_edit: bulkEditTool(() => HANDLERS),
};

export const READ_HANDLERS: Record<string, ReadHandler> = READS;

// Every registry tool has a handler and every handler a registry entry (the test checks this too).
export function registryProblems(): string[] {
  const out: string[] = [];
  for (const t of WRITE_TOOLS) if (!HANDLERS[t]) out.push(`${t} has no handler`);
  for (const t of READ_TOOLS) if (t !== "find_tools" && !READ_HANDLERS[t]) out.push(`${t} has no read handler`);
  for (const t of Object.keys(HANDLERS)) if (!(WRITE_TOOLS as string[]).includes(t)) out.push(`${t} isn’t in the registry`);
  return out;
}
export const handlerFor = (t: ToolName) => HANDLERS[t];

// Typed-API writes left out of the registry, with why. "area/file.ts" excludes a whole file;
// "area/file.ts:fn" one function.
export const TYPED_API_EXCLUSIONS: Record<string, string> = {
  // Whole areas.
  "auth/mutations.ts": "Signing in and out, passwords, and the allowlist: never through the AI.",
  "system/mutations.ts": "Background work (outbox drains, cron, inbound email): system functions with the service role, never a person’s request.",
  "public/mutations.ts": "Public token-checked endpoints (calendar feeds, unsubscribe, inbound webhooks): anonymous, not a person.",
  "imports/mutations.ts": "Asana imports: an uploaded file and a long-running batch job, not an AI change.",
  "integrations/mutations.ts": "Webhook URLs, signing secrets, inbound tokens, delivery retries: secrets and outward delivery, never through the AI.",
  "slack/mutations.ts": "Slack connection and channels: a bot token (a secret) and outward messages.",
  "workspace/mutations.ts": "Workspace-wide admin settings (admins, invites, removal, logo, switches, verified domains, workweek): Admin console only.",
  "me/mutations.ts": "Personal settings, profile, notification and email preferences, report schedules (they send email), forwarding addresses.",
  "reviews/mutations.ts": "Review checks send an email to a reviewer immediately; the public review page is anonymous.",
  "calendar/mutations.ts": "Calendar feed links are secret URLs; calendar events are low value for the AI this round.",
  "attachments/mutations.ts": "Storage uploads (no file uploads from the model).",
  "ai-builder/mutations.ts": "The AI builder itself (round 1–2 runs), not a workspace change.",
  "ai-pilot/mutations.ts": "The pilot's seed / registration (operators only).",
  "ai-assistant/mutations.ts": "The assistant's own run log (propose / Confirm / Undo), not a workspace change.",
  "mcp/mutations.ts": "Personal access tokens are secrets made and revoked by the person in Settings → AI & MCP, never by the AI.",
  "messages/mutations.ts": "Project and team Messages notify whole projects / teams when posted; left out this round (comments on tasks are covered).",
  "numbers/mutations.ts": "Task numbering settings renumber many tasks at once (with a typed confirmation by hand); left out this round.",
  "members/invite.ts": "Inviting by email sends an email to someone outside the workspace; people of the pilot are added with add_member.",
  // Single functions.
  "approvals/mutations.ts:decideApproval": "Deciding an approval is the approver’s own act on the review page; the AI never decides for anyone.",
  "approvals/mutations.ts:completeApprovalAsApprover": "Completing an approval task is its approvers’ own act.",
  "automations/mutations.ts:testRule": "The Test panel (a dry run) is a read the builder already offers.",
  "automations/mutations.ts:installRulePreset": "Presets install several automations at once; create_automation covers each.",
  "automations/mutations.ts:runManualRuleOnTasks": "Bulk runs of an automation: run_automation covers one task at a time with a preview.",
  "automations/portfolio-rules.ts:runPortfolioRule": "Runs a portfolio automation on a project now (it can message people); left out this round.",
  "automations/portfolio-rules.ts:duplicatePortfolioRule": "Low value; create_portfolio_automation covers it.",
  "automations/portfolio-rules.ts:setPortfolioRulePausedUntil": "Low value; enable_portfolio_automation covers on / off.",
  "comments/mutations.ts:sendSubmitterResponse": "Emails a form’s submitter immediately.",
  "comments/mutations.ts:setReplyThreadClosed": "The submitter’s email thread: email settings, left out.",
  "comments/mutations.ts:registerAttachment": "Records an uploaded file (no uploads from the model).",
  "comments/mutations.ts:setEmailConversationOverride": "A workspace admin email policy override.",
  "dependencies/mutations.ts:applyDependencyShifts": "shift_with_dependents covers moving dates with dependents (one task at a time, with its plan).",
  "dependencies/mutations.ts:moveTaskDatesWith": "Timeline's drag keys; shift_with_dependents covers it.",
  "dependencies/mutations.ts:undoDependencyShift": "Undo is the run's own (each moved task put back).",
  "dependencies/mutations.ts:changeTaskDates": "set_dates / shift_with_dependents cover date changes.",
  "dependencies/mutations.ts:setDependencyShiftMode": "A project setting about future date changes; left out this round.",
  "fields/mutations.ts:addLibraryField": "Adding a shared library field links data across projects; left out this round.",
  "forms/mutations.ts:submitForm": "Submitting a form is the public’s act (anonymous), not a workspace change.",
  "goals/mutations.ts:linkGoal": "Goal links; left out this round.",
  "goals/mutations.ts:unlinkGoal": "Goal links; left out this round.",
  "goals/mutations.ts:deleteGoalStatusUpdate": "Status history; left out.",
  "members/mutations.ts:inviteProjectMember": "Invites by email (an email outside the workspace); add_member adds people of the pilot.",
  "members/mutations.ts:cancelPendingInvite": "Pending email invites; see inviteProjectMember.",
  "members/mutations.ts:resendPendingInvite": "Sends an invite email.",
  "members/mutations.ts:transferProjectOwnership": "Hands the project to someone else and demotes you; too consequential for an AI change.",
  "members/mutations.ts:loadTaskRoles": "A read (get_task covers it), not a change.",
  "members/mutations.ts:setTaskRoleLink": "Role links on a task; left out this round (assign_task covers the assignee).",
  "my-tasks/mutations.ts:placeMyTaskSection": "Drag order of My Tasks sections; left out.",
  "my-tasks/mutations.ts:quickAddTask": "Private tasks have no project (the AI works in pilot projects); create_task covers it.",
  "my-tasks/mutations.ts:setMyTasksChecked": "A display setting.",
  "my-tasks/mutations.ts:dismissDatePrompt": "A display prompt.",
  "my-tasks/mutations.ts:undoTaskCompleted": "The checklist’s own Undo; reopen_task covers it.",
  "my-tasks/mutations.ts:setTaskRowExpanded": "A display setting.",
  "portfolios/mutations.ts:addPortfolioProjects": "add_project_to_portfolio covers it (one at a time, each previewed).",
  "portfolios/mutations.ts:createProjectInPortfolio": "create_project + add_project_to_portfolio cover it.",
  "portfolios/mutations.ts:movePortfolioProject": "Card order; left out.",
  "portfolios/mutations.ts:invitePortfolioMember": "Invites by email.",
  "portfolios/mutations.ts:changePortfolioMemberRole": "Portfolio membership; left out this round.",
  "portfolios/mutations.ts:removePortfolioMember": "Portfolio membership; left out this round.",
  "portfolios/mutations.ts:transferPortfolioOwnership": "Too consequential for an AI change.",
  "portfolios/mutations.ts:addPortfolioChild": "Nested portfolios; left out this round.",
  "portfolios/mutations.ts:removePortfolioChild": "Nested portfolios; left out this round.",
  "portfolios/mutations.ts:createPortfolioField": "Portfolio fields; left out this round.",
  "portfolios/mutations.ts:updatePortfolioField": "Portfolio fields; left out this round.",
  "portfolios/mutations.ts:deletePortfolioField": "Portfolio fields; left out this round.",
  "portfolios/mutations.ts:setPortfolioFieldValue": "Portfolio fields; left out this round.",
  "projects/mutations.ts:updateProjectTeam": "Team and privacy change who can find the project; left out this round.",
  "projects/mutations.ts:joinProject": "Joining is the person’s own act from Browse.",
  "projects/mutations.ts:requestProjectAccess": "Asks a project’s owners (notifies them).",
  "projects/mutations.ts:decideAccessRequest": "Deciding someone’s access request; left out this round.",
  "projects/mutations.ts:createStatusTemplate": "Status templates; left out this round.",
  "projects/mutations.ts:updateStatusTemplate": "Status templates; left out this round.",
  "projects/mutations.ts:deleteStatusTemplate": "Status templates; left out this round.",
  "reports/mutations.ts:renamePersonalDashboard": "Low value; create_dashboard covers dashboards.",
  "reports/mutations.ts:deletePersonalDashboard": "Low value.",
  "reports/mutations.ts:createPersonalWidget": "Personal dashboard widgets take report filters; left out this round.",
  "reports/mutations.ts:updatePersonalWidget": "See createPersonalWidget.",
  "reports/mutations.ts:deletePersonalWidget": "See createPersonalWidget.",
  "reports/mutations.ts:movePersonalWidget": "Widget order.",
  "sidebar/mutations.ts:setProjectsStarred": "star_project covers it one project at a time.",
  "sidebar/mutations.ts:updateSidebarFolder": "Folder name / collapsed state; left out.",
  "tags/mutations.ts:moveTaskTag": "Board drags between tag columns; add_tag / remove_tag cover it.",
  "tasks/mutations.ts:createPrivateTask": "Private tasks have no project; create_task covers project tasks.",
  "tasks/mutations.ts:placeTask": "Drag order inside a section; move_task covers sections.",
  "tasks/mutations.ts:bulkEditTasks": "bulk_edit stages one previewed, undoable change per task instead.",
  "tasks/mutations.ts:lastProjectRefusalOf": "A helper, not a write.",
  "tasks/mutations.ts:createSubtaskFromFeedback": "create_subtask covers it.",
  "tasks/mutations.ts:updateSubtask": "Subtasks are tasks: rename_task / complete_task cover them.",
  "tasks/mutations.ts:placeSubtask": "Subtask drag order; left out.",
  "tasks/mutations.ts:deleteSubtask": "Subtasks are tasks: delete_task covers them.",
  "teams/mutations.ts:addTeamCuratedWork": "Curated work; left out this round.",
  "teams/mutations.ts:removeTeamCuratedWork": "Curated work; left out this round.",
  "teams/mutations.ts:moveTeamCuratedWork": "Curated work order.",
  "teams/mutations.ts:deleteTeam": "Deleting a team moves its projects and can’t be undone; left out.",
  "teams/mutations.ts:addTeamMember": "Invites by email.",
  "teams/mutations.ts:changeTeamMemberRole": "Team membership; left out this round.",
  "teams/mutations.ts:removeTeamMember": "Team membership; left out this round.",
  "teams/mutations.ts:requestTeamJoin": "The person’s own request (notifies the team’s leads).",
  "teams/mutations.ts:decideTeamJoinRequest": "Deciding someone’s request; left out this round.",
  "teams/mutations.ts:addTeamToProject": "Adds a whole team’s people to a project at once; add_member covers one person.",
  "templates/mutations.ts:createProjectFromTemplate": "Lands in the main workspace’s default team, outside the pilot; left out.",
  "templates/mutations.ts:updateProjectTemplate": "Workspace templates are shared beyond the pilot; left out.",
  "templates/mutations.ts:createTaskFromTemplate": "create_task covers tasks; templates left out this round.",
  "templates/mutations.ts:createTaskTemplate": "save_task_template covers task templates.",
  "templates/mutations.ts:updateTaskTemplate": "Task template editing; left out this round.",
  "views/mutations.ts:saveListColumnWidths": "A display setting.",
  "views/mutations.ts:saveListCollapsedGroups": "A display setting.",
  "views/mutations.ts:setProjectShowCompleted": "A display setting.",
  "views/mutations.ts:saveViewChanges": "View filters / sorts take the views config schema; left out this round.",
  "views/mutations.ts:saveViewForMe": "See saveViewChanges.",
  "views/mutations.ts:saveViewForEveryone": "See saveViewChanges.",
  "views/mutations.ts:duplicateView": "create_view covers views.",
  "views/mutations.ts:moveView": "Tab order.",
  "views/mutations.ts:moveViewBy": "Tab order.",
  "views/mutations.ts:setProjectTabHidden": "Tab visibility; left out this round.",
  "views/mutations.ts:setProjectViewHidden": "Tab visibility; left out this round.",
  "views/mutations.ts:installStarterWidgets": "add_widget covers widgets.",
  "views/mutations.ts:updateWidget": "Widget filters; left out this round.",
  "views/mutations.ts:moveWidget": "Widget order.",
  "workload/mutations.ts:setWorkloadCapacity": "Workload capacities; left out this round.",
};
