"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { ChevronDown, FolderKanban } from "lucide-react";
import { RolePicker, RoleChangePicker, projectRoleOptions } from "@/components/role-picker";
import { SmartPicker } from "@/components/smart-picker";
import { useNotify, useServerAction } from "@/components/toast";
import { Skeleton } from "@/components/ui";
import { changeProjectMemberRole, inviteProjectMember } from "@/lib/actions";
import { loadPersonProjectAccess, type PersonProjectAccess } from "@/lib/people-actions";
import { PERSON_DEFAULT_ROLE, ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/roles";
import { projectColorClass } from "@/lib/project-colors";

// "Project access" on a person's row (Members page, Admin console → Users): a button that opens the
// list of projects they're in (or invited to) that the viewer can see, each with a role picker where the
// viewer runs the project, and "Add to a project" for projects the viewer runs. So a tester can make
// someone a Viewer, Commenter, or Editor without opening each project.
export function ProjectAccessToggle({
  open,
  onToggle,
  name,
  controls,
}: {
  open: boolean;
  onToggle: () => void;
  name: string;
  controls: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className="btn-ghost h-6 px-1.5 text-xs text-zinc-600"
    >
      <FolderKanban className="size-3.5" aria-hidden />
      Project access
      <span className="sr-only"> for {name}</span>
      <ChevronDown className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
    </button>
  );
}

export function ProjectAccessPanel({
  id,
  person,
}: {
  id: string;
  person: { email: string; profileId: string | null; name: string };
}) {
  const [data, setData] = useState<PersonProjectAccess | null | undefined>(undefined);
  const [loading, startLoading] = useTransition();
  const [pending, run] = useServerAction();
  const notify = useNotify();
  const [addProject, setAddProject] = useState("");
  const [addRole, setAddRole] = useState<string>("");

  function reload() {
    startLoading(async () => {
      setData(await loadPersonProjectAccess({ email: person.email, profileId: person.profileId }));
    });
  }

  useEffect(() => {
    let live = true;
    loadPersonProjectAccess({ email: person.email, profileId: person.profileId }).then((result) => {
      if (live) setData(result);
    });
    return () => {
      live = false;
    };
  }, [person.email, person.profileId]);

  if (data === undefined) {
    return (
      <div id={id} role="status" className="space-y-2 py-2">
        <span className="sr-only">Loading project access…</span>
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-1/3" />
      </div>
    );
  }
  if (data === null) {
    return (
      <p id={id} className="py-2 text-sm text-zinc-500">
        Couldn’t load project access. Try again.
      </p>
    );
  }

  const target = data.addable.find((p) => p.id === addProject) ?? null;
  const roleChoice = addRole || (data.defaultRoles ? PERSON_DEFAULT_ROLE : "editor");

  return (
    <div id={id} className="space-y-3 py-2" aria-busy={loading || undefined}>
      {data.rows.length === 0 ? (
        <p className="text-sm text-zinc-500">
          {person.name} isn’t in any project you’re in. Projects you aren’t a member of never show here.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200 bg-white" aria-label={`Projects ${person.name} is in`}>
          {data.rows.map((row) => (
            <li key={row.projectId} className="flex flex-wrap items-center gap-2.5 px-3 py-2">
              <span aria-hidden className={`size-3 shrink-0 rounded ${projectColorClass(row.projectId)}`} />
              <Link href={`/projects/${row.projectId}`} className="min-w-0 flex-1 truncate text-sm text-zinc-900 hover:underline">
                {row.name}
              </Link>
              {row.archived ? <span className="chip">Archived</span> : null}
              {row.pending ? <span className="chip">Invited</span> : null}
              {row.canManage && !row.archived ? (
                <RoleChangePicker
                  key={`${row.role}-${row.pending}`}
                  label={`${person.name}’s role in ${row.name}`}
                  role={row.role}
                  options={projectRoleOptions({ grantable: row.grantable, allowCommenter: data.allowCommenter, current: row.role })}
                  disabled={pending}
                  run={(action) => run(action)}
                  save={async (next) => {
                    const result = row.pending
                      ? await inviteProjectMember(row.projectId, person.email, next)
                      : await changeProjectMemberRole(row.projectId, person.profileId!, next);
                    if (!result.error) {
                      notify(`${person.name} is now ${ROLE_LABELS[next as keyof typeof ROLE_LABELS] ?? next} in ${row.name}`);
                      reload();
                    }
                    return result;
                  }}
                />
              ) : (
                <span className="w-32 shrink-0 text-xs text-zinc-600" title={ROLE_DESCRIPTIONS[row.role]}>
                  {ROLE_LABELS[row.role]}
                  <span className="sr-only">
                    {" "}
                    ({row.archived ? "archived project" : "only the project’s admins and owners change this"})
                  </span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {data.addable.length ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!target) return;
            run(async () => {
              const result = await inviteProjectMember(target.id, person.email, roleChoice);
              if (!result.error) {
                notify(
                  result.pending
                    ? `${person.name} will join ${target.name} on their first sign-in`
                    : `Added ${person.name} to ${target.name}`,
                );
                setAddProject("");
                reload();
              }
              return result;
            });
          }}
        >
          <span className="text-xs font-medium text-zinc-600">Add to a project</span>
          <SmartPicker
            label={`Project to add ${person.name} to`}
            placeholder="Choose a project…"
            value={addProject}
            onChange={setAddProject}
            searchable
            className="h-7 w-56 text-xs"
            options={data.addable.map((p) => ({
              value: p.id,
              label: p.name,
              icon: <span className={`size-3 rounded ${projectColorClass(p.id)}`} />,
            }))}
          />
          <RolePicker
            label={`Role for ${person.name}`}
            value={roleChoice}
            compact
            onChange={setAddRole}
            options={projectRoleOptions({
              grantable: target?.grantable ?? ["admin", "editor", "commenter", "viewer"],
              allowCommenter: data.allowCommenter,
              includeDefault: data.defaultRoles,
              inviting: true,
            })}
          />
          <button type="submit" disabled={pending || !target} className="btn-secondary h-7 text-xs">
            Add
          </button>
        </form>
      ) : null}
    </div>
  );
}
