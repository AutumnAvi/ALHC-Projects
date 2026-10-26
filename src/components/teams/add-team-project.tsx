"use client";

import { FolderKanban, FolderPlus } from "lucide-react";
import { useConfirm } from "@/components/confirm";
import { SmartPicker, type SmartOption } from "@/components/smart-picker";
import { useNotify, useServerAction } from "@/components/toast";
import { updateProjectTeam } from "@/lib/actions";

export type MovableProject = {
  id: string;
  name: string;
  // The team it's in now (null when the viewer can't tell).
  teamName: string | null;
  visibility: string;
};

// A team's All work → Add existing project (Oct 26 notes, batch 4): move a project the viewer runs (Admin+
// by their own role) from another team into this one. It's the project's Team setting (updateProjectTeam,
// RLS: Admin+ of the project, and a member of the team it goes to), so the project keeps its members and
// its privacy; a public-to-team project becomes findable by this team's members instead.
export function AddTeamProject({
  teamId,
  teamName,
  projects,
}: {
  teamId: string;
  teamName: string;
  projects: MovableProject[];
}) {
  const [pending, run] = useServerAction();
  const confirm = useConfirm();
  const notify = useNotify();
  const options: SmartOption[] = projects.map((p) => ({
    value: p.id,
    label: p.name,
    description: p.teamName ? `In ${p.teamName}` : undefined,
    icon: <FolderKanban className="size-3.5" aria-hidden />,
  }));

  async function add(projectId: string) {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;
    const from = project.teamName ? `It leaves ${project.teamName}. ` : "";
    const findable =
      project.visibility === "team"
        ? ` It’s public to its team, so ${teamName}’s members can find and join it.`
        : " It stays private to its members.";
    const ok = await confirm({
      title: `Move ${project.name} to ${teamName}?`,
      message: `${from}Its members and their roles stay as they are.${findable}`,
      confirmLabel: "Move project",
    });
    if (!ok) return;
    run(async () => {
      const result = await updateProjectTeam(projectId, { teamId });
      if (!result.error) notify(`${project.name} is now in ${teamName}`);
      return result;
    });
  }

  return (
    <SmartPicker
      label="Add existing project"
      value={null}
      options={options}
      onChange={(value) => void add(value)}
      variant="ghost"
      searchable
      disabled={pending}
      panelWidth={320}
      className="h-8 border border-zinc-200 bg-white px-3 text-zinc-700 hover:border-zinc-300"
      emptyText="No projects to add. Projects in other teams where you’re an owner or admin show up here."
      renderValue={() => (
        <>
          <FolderPlus className="size-4" aria-hidden />
          Add existing project
        </>
      )}
      footer="Projects in other teams where you’re an owner or admin. A project you add keeps its members and privacy."
    />
  );
}
