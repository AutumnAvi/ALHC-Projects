"use client";

import dynamic from "next/dynamic";
import { useShell } from "@/components/shell/shell-context";

// Create / settings dialogs open rarely. Keep them out of the shell chunk until one is opened.
const NewTaskDialog = dynamic(() => import("@/components/shell/new-task-dialog").then((m) => m.NewTaskDialog));
const NewProjectDialog = dynamic(() => import("@/components/shell/new-project-dialog").then((m) => m.NewProjectDialog));
const NewMessageDialog = dynamic(() => import("@/components/shell/new-message-dialog").then((m) => m.NewMessageDialog));
const NewTeamDialog = dynamic(() => import("@/components/shell/new-team-dialog").then((m) => m.NewTeamDialog));
const NewPortfolioDialog = dynamic(() => import("@/components/shell/new-portfolio-dialog").then((m) => m.NewPortfolioDialog));
const NewGoalLauncher = dynamic(() => import("@/components/shell/new-goal-launcher").then((m) => m.NewGoalLauncher));
const InviteDialog = dynamic(() => import("@/components/shell/invite-dialog").then((m) => m.InviteDialog));
const SettingsDialog = dynamic(() => import("@/components/settings/settings-dialog").then((m) => m.SettingsDialog));

// Whichever dialog the Create menu, the sidebar's "+" / Invite, or the avatar menu opened. Each one is
// the existing create flow (the redirect after creating closes it).
export function ShellDialogs() {
  const { dialog, closeDialog } = useShell();
  if (!dialog) return null;
  switch (dialog.kind) {
    case "task":
      return <NewTaskDialog onClose={closeDialog} />;
    case "project":
      return <NewProjectDialog teamId={dialog.teamId} onClose={closeDialog} />;
    case "message":
      return <NewMessageDialog onClose={closeDialog} />;
    case "team":
      return <NewTeamDialog onClose={closeDialog} />;
    case "portfolio":
      return <NewPortfolioDialog onClose={closeDialog} />;
    case "goal":
      return <NewGoalLauncher teamId={dialog.teamId} onClose={closeDialog} />;
    case "invite":
      return <InviteDialog onClose={closeDialog} />;
    case "settings":
      return <SettingsDialog tab={dialog.tab} onClose={closeDialog} />;
  }
}
