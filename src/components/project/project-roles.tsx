"use client";

import { useState, useTransition } from "react";
import { Plus, Trash2, UserRound } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { useConfirm } from "@/components/confirm";
import { Dialog } from "@/components/dialog";
import { useProjectPermissions } from "@/components/project/project-access";
import { SmartPicker } from "@/components/smart-picker";
import { useNotify, useServerAction } from "@/components/toast";
import {
  createProjectRole,
  loadRoleOpenTaskCount,
  removeProjectRole,
  renameProjectRole,
  setProjectRolePerson,
} from "@/lib/actions";
import { describeRoleUpdate } from "@/lib/project-roles";

export type RoleRow = { id: string; name: string; profileId: string | null };
export type RoleMember = { profileId: string; name: string };

// Nov 2 notes (batch 14, 95): a project's roles (like Asana's project roles: Approver, Designer, Lead) and
// who fills each. Tasks can take their assignee, approver, or followers from a role (the task pane's Roles
// row); automations can name "the person in role X"; and a template carries the roles so whoever creates
// a project from it picks the people. Changing who fills a role offers to update its open tasks.
export function ProjectRolesSection({
  projectId,
  roles,
  members,
  titleClass,
}: {
  projectId: string;
  roles: RoleRow[];
  members: RoleMember[];
  titleClass: string;
}) {
  const { canEdit } = useProjectPermissions();
  const [pending, run] = useServerAction();
  const [adding, setAdding] = useState(false);
  const nameOf = (id: string | null) => members.find((m) => m.profileId === id)?.name ?? null;

  if (roles.length === 0 && !canEdit) return null;
  return (
    <section aria-labelledby="overview-project-roles">
      <h2 id="overview-project-roles" className={titleClass}>
        Project roles
      </h2>
      <p className="mt-1 text-xs text-zinc-500">
        Name the jobs on this project — Approver, Designer, Lead — and who does each. Tasks and automations can say
        “the Designer” instead of a name, so changing who fills a role can update its open tasks in one step.
      </p>
      {roles.length === 0 ? null : (
        <ul className="mt-3 divide-y divide-zinc-100 rounded-lg border border-zinc-200">
          {roles.map((role) => (
            <RoleItem key={role.id} role={role} members={members} personName={nameOf(role.profileId)} />
          ))}
        </ul>
      )}
      {canEdit ? (
        adding ? (
          <form
            className="mt-2 flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              const name = String(data.get("name") ?? "").trim();
              if (!name) return;
              setAdding(false);
              run(() => createProjectRole(projectId, name));
            }}
          >
            <label htmlFor="new-project-role" className="sr-only">
              Role name
            </label>
            <input
              id="new-project-role"
              name="name"
              autoFocus
              maxLength={60}
              placeholder="Role name, e.g. Approver"
              className="control w-60"
              onKeyDown={(e) => {
                if (e.key === "Escape") setAdding(false);
              }}
            />
            <button type="submit" disabled={pending} className="btn-primary">
              Add role
            </button>
            <button type="button" onClick={() => setAdding(false)} className="btn-ghost">
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="btn-ghost mt-2">
            <Plus className="size-3.5" aria-hidden /> Add role
          </button>
        )
      ) : null}
    </section>
  );
}

function RoleItem({ role, members, personName }: { role: RoleRow; members: RoleMember[]; personName: string | null }) {
  const { canEdit } = useProjectPermissions();
  const [pending, run] = useServerAction();
  const [checking, startCheck] = useTransition();
  const notify = useNotify();
  const confirm = useConfirm();
  const [renaming, setRenaming] = useState(false);
  // The person picked, waiting for "update open tasks too?" when tasks follow the role.
  const [asking, setAsking] = useState<{ profileId: string | null; count: number } | null>(null);

  const change = (profileId: string | null, updateOpenTasks: boolean) =>
    run(async () => {
      const result = await setProjectRolePerson(role.id, profileId, updateOpenTasks);
      if (!result.error && updateOpenTasks) notify(describeRoleUpdate(role.name, result.updated ?? 0, result.skipped ?? 0));
      return result;
    });

  const pick = (value: string) => {
    const profileId = value || null;
    if (profileId === role.profileId) return;
    startCheck(async () => {
      const count = await loadRoleOpenTaskCount(role.id);
      if (count > 0) setAsking({ profileId, count });
      else change(profileId, false);
    });
  };

  const newName = asking ? (members.find((m) => m.profileId === asking.profileId)?.name ?? "nobody") : "";

  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2">
      {renaming ? (
        <form
          className="flex min-w-0 flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
            setRenaming(false);
            if (name && name !== role.name) run(() => renameProjectRole(role.id, name));
          }}
        >
          <label htmlFor={`role-name-${role.id}`} className="sr-only">
            Role name
          </label>
          <input id={`role-name-${role.id}`} name="name" defaultValue={role.name} autoFocus maxLength={60} className="control min-w-0 flex-1" />
          <button type="submit" className="btn-secondary">
            Save
          </button>
        </form>
      ) : canEdit ? (
        <button
          type="button"
          onClick={() => setRenaming(true)}
          data-tooltip="Rename role"
          className="min-w-0 flex-1 truncate rounded px-1 text-left text-sm font-medium text-zinc-900 hover:bg-zinc-50"
        >
          {role.name}
        </button>
      ) : (
        <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium text-zinc-900">{role.name}</span>
      )}
      {canEdit ? (
        <SmartPicker
          id={`role-person-${role.id}`}
          label={`Who fills ${role.name}`}
          value={role.profileId ?? ""}
          searchable
          disabled={pending || checking}
          placeholder="Nobody yet"
          className="w-56"
          options={[
            { value: "", label: "Nobody yet", icon: <UserRound className="size-4 text-zinc-400" /> },
            ...members.map((m) => ({ value: m.profileId, label: m.name, icon: <Avatar name={m.name} profileId={m.profileId} /> })),
          ]}
          onChange={pick}
        />
      ) : (
        <span className="flex items-center gap-2 text-sm text-zinc-700">
          {role.profileId && personName ? <Avatar name={personName} profileId={role.profileId} /> : null}
          {personName ?? "Nobody yet"}
        </span>
      )}
      {canEdit ? (
        <button
          type="button"
          aria-label={`Remove role ${role.name}`}
          data-tooltip="Remove role"
          onClick={async () => {
            const ok = await confirm({
              title: `Remove the ${role.name} role?`,
              message: "Tasks keep whoever they have now; automations that name this role skip it.",
              confirmLabel: "Remove",
              tone: "danger",
            });
            if (ok) run(() => removeProjectRole(role.id));
          }}
          className="btn-icon hover:bg-red-50 hover:text-red-700"
        >
          <Trash2 className="size-4" />
        </button>
      ) : null}
      {asking ? (
        <Dialog title={`Update open tasks for ${role.name}?`} onClose={() => setAsking(null)}>
          <p className="text-sm text-zinc-700">
            {asking.count} open task{asking.count === 1 ? " follows" : "s follow"} the {role.name} role. Give{" "}
            {asking.count === 1 ? "it" : "them"} to {newName} too?
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Assignees change only on tasks that still have {personName ?? "nobody"} (or nobody); approvers and followers are
            swapped. Completed tasks stay as they are.
          </p>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button type="button" onClick={() => setAsking(null)} className="btn-ghost">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                const target = asking.profileId;
                setAsking(null);
                change(target, false);
              }}
              className="btn-secondary"
            >
              Only change the role
            </button>
            <button
              type="button"
              data-autofocus
              onClick={() => {
                const target = asking.profileId;
                setAsking(null);
                change(target, true);
              }}
              className="btn-primary"
            >
              Update {asking.count} task{asking.count === 1 ? "" : "s"}
            </button>
          </div>
        </Dialog>
      ) : null}
    </li>
  );
}
