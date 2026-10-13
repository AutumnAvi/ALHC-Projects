"use client";

import { InviteDialog } from "@/components/shell/invite-dialog";
import { NewGoalLauncher } from "@/components/shell/new-goal-launcher";
import { NewMessageDialog } from "@/components/shell/new-message-dialog";
import { NewPortfolioDialog } from "@/components/shell/new-portfolio-dialog";
import { NewProjectDialog } from "@/components/shell/new-project-dialog";
import { NewTaskDialog } from "@/components/shell/new-task-dialog";
import { NewTeamDialog } from "@/components/shell/new-team-dialog";
import { useShell } from "@/components/shell/shell-context";
import { SettingsDialog } from "@/components/settings/settings-dialog";

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
