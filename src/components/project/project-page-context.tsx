"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { ShareDialog } from "@/components/project/share-dialog";
import { StatusUpdatePanel } from "@/components/project/status-update-panel";
import type { ProjectStatus } from "@/lib/portfolios";

// The project page's two overlays (Asana parity, batch 2): the Share dialog and the status update panel.
// The header (Share button, member avatars, status menu) and the Overview tab (Add member, What's the
// status?) open the same ones.
type ProjectPage = {
  openShare: () => void;
  openStatusUpdate: (status: ProjectStatus) => void;
};

const ProjectPageContext = createContext<ProjectPage | null>(null);

export function ProjectPageProvider({
  project,
  children,
}: {
  project: { id: string; name: string };
  children: ReactNode;
}) {
  const [sharing, setSharing] = useState(false);
  const [statusUpdate, setStatusUpdate] = useState<ProjectStatus | null>(null);
  const value = useMemo<ProjectPage>(
    () => ({
      openShare: () => setSharing(true),
      openStatusUpdate: (status) => setStatusUpdate(status),
    }),
    [],
  );

  return (
    <ProjectPageContext.Provider value={value}>
      {children}
      {sharing ? <ShareDialog projectId={project.id} projectName={project.name} onClose={() => setSharing(false)} /> : null}
      {statusUpdate ? (
        <StatusUpdatePanel
          key={statusUpdate}
          projectId={project.id}
          projectName={project.name}
          initialStatus={statusUpdate}
          onClose={() => setStatusUpdate(null)}
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
