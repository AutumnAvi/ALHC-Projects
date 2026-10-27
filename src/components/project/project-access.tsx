"use client";

import { createContext, useContext, type ReactNode } from "react";
import { Eye } from "lucide-react";
import { permissionsFor, type Permissions } from "@/lib/permissions";
import { ROLE_LABELS, hasRole, type ProjectRole } from "@/lib/roles";

// The viewer's role in the current project. Only hides controls; RLS enforces the real rules.
const ProjectRoleContext = createContext<ProjectRole | null>(null);
// Oct 27 notes (batch 5): the project's Owners locked its sections (Owner settings → Lock section order).
const SectionsLockedContext = createContext(false);

export function ProjectAccessProvider({
  role,
  sectionsLocked = false,
  children,
}: {
  role: ProjectRole | null;
  sectionsLocked?: boolean;
  children: ReactNode;
}) {
  return (
    <ProjectRoleContext.Provider value={role}>
      <SectionsLockedContext.Provider value={sectionsLocked}>{children}</SectionsLockedContext.Provider>
    </ProjectRoleContext.Provider>
  );
}

// Whether the viewer may add, rename, reorder, or delete sections: Editors+, and only Owners while the
// sections are locked (the database refuses the rest anyway).
export function useSectionPermissions(): { canEditSections: boolean; locked: boolean } {
  const permissions = permissionsFor(useContext(ProjectRoleContext));
  const locked = useContext(SectionsLockedContext);
  return { canEditSections: permissions.canEdit && (!locked || permissions.isOwner), locked };
}

export const SECTIONS_LOCKED_NOTE = "The project’s owner locked the sections. Only owners can add, rename, reorder, or delete them.";

export function useProjectRole() {
  return useContext(ProjectRoleContext);
}

// What the viewer may do in this project (src/lib/permissions.ts): canView / canComment / canEdit /
// canManage / isOwner. Every project view asks this instead of comparing roles itself.
export function useProjectPermissions(): Permissions {
  return permissionsFor(useContext(ProjectRoleContext));
}

// Shown above a page whose controls need a higher role than the viewer has.
export function ReadOnlyNotice({ need, what }: { need: ProjectRole; what: string }) {
  const role = useProjectRole();
  if (hasRole(role, need)) return null;
  return (
    <p className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
      <Eye className="size-4 shrink-0 text-zinc-500" aria-hidden />
      <span>
        You’re a{role === "admin" || role === "editor" ? "n" : ""} {role ? ROLE_LABELS[role] : "visitor"} here.{" "}
        {ROLE_LABELS[need]}s and above can change {what}.
      </span>
    </p>
  );
}

// Wraps a management page: below `need`, every form control inside is disabled (links still work)
// and a notice explains why. Saves would be rejected by RLS anyway.
export function RoleGate({ need, what, children }: { need: ProjectRole; what: string; children: ReactNode }) {
  const allowed = hasRole(useProjectRole(), need);
  return (
    <>
      {allowed ? null : (
        <div className="px-gutter pt-3">
          <ReadOnlyNotice need={need} what={what} />
        </div>
      )}
      <fieldset disabled={!allowed} className="m-0 min-w-0 border-0 p-0">
        {children}
      </fieldset>
    </>
  );
}
