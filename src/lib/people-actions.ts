"use server";

// A person's project access (Oct 25 notes, note 2) for the Members page and Admin console → Users:
// which projects they're in (or invited to) with their role, read with the signed-in person's own
// client, so RLS decides — only projects the viewer is a member of show (a workspace admin sees nothing
// of a private project they aren't in). Changes go through the existing actions
// (changeProjectMemberRole, inviteProjectMember), which the database checks again.

import { getViewer } from "@/lib/auth";
import { commenterRoleAllowed, hasOct25Schema, listMyProjectRoles, listProjects } from "@/lib/data";
import { isUuid } from "@/lib/ids";
import { assignableRoles, hasRole, isProjectRole, type ProjectRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";

export type PersonProjectAccessRow = {
  projectId: string;
  name: string;
  archived: boolean;
  role: ProjectRole;
  // Invited before their first sign-in (the membership starts then).
  pending: boolean;
  // The viewer may change this role (Admin+ of the project by their own role; owners for owners).
  canManage: boolean;
  // Roles the viewer may give here.
  grantable: ProjectRole[];
};

export type PersonProjectAccess = {
  rows: PersonProjectAccessRow[];
  // Projects the viewer administers that the person isn't in yet (Add to a project).
  addable: { id: string; name: string; grantable: ProjectRole[] }[];
  allowCommenter: boolean;
  // "Their default role" can be picked.
  defaultRoles: boolean;
};

export async function loadPersonProjectAccess(person: {
  email: string;
  profileId: string | null;
}): Promise<PersonProjectAccess | null> {
  const { user, allowlisted } = await getViewer();
  if (!user || !allowlisted) return null;
  const email = typeof person.email === "string" ? person.email.trim().toLowerCase() : "";
  if (!email || email.length > 320) return null;
  const profileId = person.profileId && isUuid(person.profileId) ? person.profileId : null;

  const supabase = await createClient();
  const [memberships, invites, myRoles, projects, allowCommenter, defaultRoles] = await Promise.all([
    profileId
      ? supabase
          .from("project_members")
          .select("project_id, role, project:projects!project_members_project_id_fkey!inner(name, archived_at, deleted_at)")
          .eq("profile_id", profileId)
          .is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("pending_memberships")
      .select("project_id, role, project:projects!pending_memberships_project_id_fkey!inner(name, archived_at, deleted_at)")
      .eq("email", email)
      .not("project_id", "is", null)
      .is("applied_at", null)
      .is("deleted_at", null),
    listMyProjectRoles(),
    listProjects(),
    commenterRoleAllowed(),
    hasOct25Schema(),
  ]);
  if (memberships.error || invites.error) return null;

  const manage = (projectId: string, role: ProjectRole) => {
    const mine = myRoles.get(projectId);
    const canManage = hasRole(mine, "admin") && (role !== "owner" || mine === "owner");
    return { canManage, grantable: canManage ? assignableRoles(mine, allowCommenter) : [] };
  };

  const rows: PersonProjectAccessRow[] = [];
  const seen = new Set<string>();
  for (const m of memberships.data ?? []) {
    if (!m.project || m.project.deleted_at !== null || !isProjectRole(m.role)) continue;
    seen.add(m.project_id);
    rows.push({
      projectId: m.project_id,
      name: m.project.name,
      archived: m.project.archived_at !== null,
      role: m.role,
      pending: false,
      ...manage(m.project_id, m.role),
    });
  }
  for (const i of invites.data ?? []) {
    if (!i.project_id || !i.project || i.project.deleted_at !== null || seen.has(i.project_id) || !isProjectRole(i.role)) continue;
    seen.add(i.project_id);
    rows.push({
      projectId: i.project_id,
      name: i.project.name,
      archived: i.project.archived_at !== null,
      role: i.role,
      pending: true,
      ...manage(i.project_id, i.role),
    });
  }
  rows.sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name));

  const addable = projects
    .filter((p) => !seen.has(p.id) && hasRole(myRoles.get(p.id), "admin"))
    .map((p) => ({ id: p.id, name: p.name, grantable: assignableRoles(myRoles.get(p.id), allowCommenter) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { rows, addable, allowCommenter, defaultRoles };
}
