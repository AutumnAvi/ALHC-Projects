"use client";

import { createContext, useContext, type ReactNode } from "react";
import { Eye } from "lucide-react";
import { ROLE_LABELS, hasRole, type ProjectRole } from "@/lib/roles";

// The viewer's role in the current project. Only hides controls; RLS enforces the real rules.
const ProjectRoleContext = createContext<ProjectRole | null>(null);

export function ProjectAccessProvider({ role, children }: { role: ProjectRole | null; children: ReactNode }) {
  return <ProjectRoleContext.Provider value={role}>{children}</ProjectRoleContext.Provider>;
}

export function useProjectRole() {
  return useContext(ProjectRoleContext);
}

export function useCan(min: ProjectRole) {
  return hasRole(useContext(ProjectRoleContext), min);
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
  const allowed = useCan(need);
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
