"use client";

import dynamic from "next/dynamic";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { StatusUpdatePanel } from "@/components/project/status-update-panel";
import { useRightPanel } from "@/components/shell/right-panel";

// Share is a large dialog opened from the header. Leave it out of the project page chunk until then.
const ShareDialog = dynamic(() => import("@/components/project/share-dialog").then((m) => m.ShareDialog));
import type { ProjectStatus } from "@/lib/portfolios";
import type { StatusTemplate } from "@/lib/status-templates";

// The project page's two overlays (Asana parity, batch 2): the Share dialog and the status update panel.
// The header (Share button, member avatars, status menu) and the Overview tab (Add member, What's the
// status?) open the same ones.
type ProjectPage = {
  openShare: () => void;
  openStatusUpdate: (status: ProjectStatus) => void;
  // Asana parity, batch 4's database features (field descriptions, the field library, field
  // notifications, rule branches, Heading / Email form questions): false on a preview deployed before
  // 20261011040000_asana_parity_4.sql is applied, so those controls stay hidden there.
  batch4: boolean;
};

const ProjectPageContext = createContext<ProjectPage | null>(null);

export function ProjectPageProvider({
  project,
  batch4,
  statusTemplates = [],
  children,
}: {
  project: { id: string; name: string };
  batch4: boolean;
  // Real features 4: Customize → Status templates, offered in the status update panel.
  statusTemplates?: StatusTemplate[];
  children: ReactNode;
}) {
  const [sharing, setSharing] = useState(false);
  const [statusUpdate, setStatusUpdate] = useState<ProjectStatus | null>(null);
  // The status update sheet is a right-side panel: it takes the app's one slot (closing the task pane
  // and Customize), and opening a task closes it. Share is a centered dialog and stays over the page.
  const { open: statusOpen, setOpen: setStatusOpen } = useRightPanel(`status:${project.id}`);
  const value = useMemo<ProjectPage>(
    () => ({
      openShare: () => setSharing(true),
      openStatusUpdate: (status) => {
        setStatusUpdate(status);
        setStatusOpen(true);
      },
      batch4,
    }),
    [batch4, setStatusOpen],
  );

  return (
    <ProjectPageContext.Provider value={value}>
      {children}
      {sharing ? <ShareDialog projectId={project.id} projectName={project.name} onClose={() => setSharing(false)} /> : null}
      {statusOpen && statusUpdate ? (
        <StatusUpdatePanel
          key={statusUpdate}
          projectId={project.id}
          projectName={project.name}
          initialStatus={statusUpdate}
          templates={statusTemplates}
          onClose={() => setStatusOpen(false)}
        />
      ) : null}
    </ProjectPageContext.Provider>
  );
}

export function useProjectPage(): ProjectPage {
  const page = useContext(ProjectPageContext);
  if (!page) throw new Error("useProjectPage() needs the project layout (ProjectPageProvider)");
  return page;
}

// Copies the signed-in link to the project (people still need access to open it).
export async function copyProjectLink(projectId: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(`${window.location.origin}/projects/${projectId}`);
    return true;
  } catch {
    return false;
  }
}
