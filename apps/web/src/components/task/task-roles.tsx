"use client";

import { useEffect, useState, useTransition } from "react";
import { Plus, UsersRound, X } from "lucide-react";
import { MenuItem, Popover } from "@/components/popover";
import { useServerAction } from "@/components/toast";
import { loadTaskRoles, setTaskRoleLink } from "@/lib/actions/members";
import { type TaskRolesInfo } from "@alhc/core/api/members/model";
import { ROLE_SLOTS, type RoleSlot } from "@alhc/core/project-roles";
import { PANE_LABEL } from "./pane-styles";

// Nov 2 notes (batch 14, 95): the task pane's Roles row — this task's assignee, approvers, or followers
// given by a project role ("Assignee: Designer"). Linking applies the role's person now; changing who
// fills the role later (Overview → Project roles) can update every open task linked to it. Drawn only
// when the task's projects have roles.
export function TaskRolesRow({ taskId, canEdit, kind }: { taskId: string; canEdit: boolean; kind: string }) {
  const [info, setInfo] = useState<TaskRolesInfo | null>(null);
  const [, startLoad] = useTransition();
  const [pending, run] = useServerAction();
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    startLoad(async () => {
      const next = await loadTaskRoles(taskId).catch(() => null);
      if (live) setInfo(next);
    });
    return () => {
      live = false;
    };
  }, [taskId, version]);

  if (!info || info.roles.length === 0) return null;
  const linkedRoles = info.links
    .map((l) => ({ ...l, role: info.roles.find((r) => r.id === l.roleId) }))
    .filter((l): l is typeof l & { role: NonNullable<typeof l.role> } => Boolean(l.role));
  if (!canEdit && linkedRoles.length === 0) return null;
  const several = new Set(info.roles.map((r) => r.projectName)).size > 1;
  const slots = ROLE_SLOTS.filter((s) => s.value !== "approver" || kind === "approval");

  const toggle = (roleId: string, slot: RoleSlot, linked: boolean) =>
    run(async () => {
      const result = await setTaskRoleLink(taskId, roleId, slot, linked);
      if (!result.error) setVersion((v) => v + 1);
      return result;
    });

  return (
    <>
      <dt className={`${PANE_LABEL} self-start`}>Who does what</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5 py-1">
        {linkedRoles.map((l) => (
          <span
            key={`${l.roleId}-${l.slot}`}
            className="inline-flex max-w-full items-center gap-1 rounded-full bg-violet-50 py-0.5 pl-2 pr-1 text-xs text-violet-800"
            title={l.role.personName ? `Now ${l.role.personName}` : "Nobody fills this role yet"}
          >
            <UsersRound className="size-3 shrink-0" aria-hidden />
            <span className="truncate">
              {ROLE_SLOTS.find((s) => s.value === l.slot)?.label}: {l.role.name}
              {several ? ` (${l.role.projectName})` : ""}
              {l.role.personName ? ` · ${l.role.personName}` : ""}
            </span>
            {canEdit ? (
              <button
                type="button"
                disabled={pending}
                aria-label={`Stop following the ${l.role.name} role as ${l.slot}`}
                onClick={() => toggle(l.roleId, l.slot, false)}
                className="rounded-full p-0.5 hover:bg-violet-100"
              >
                <X className="size-3" />
              </button>
            ) : null}
          </span>
        ))}
        {canEdit ? (
          <Popover
            label="Take people from Who does what"
            tooltip="Take the assignee, approvers, or followers from the project’s Who does what"
            panelClassName="w-72 p-1.5"
            buttonClassName="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-zinc-300 px-2 text-xs text-zinc-600 hover:border-zinc-400 hover:bg-zinc-50"
            button={
              <>
                <Plus className="size-3" aria-hidden /> Role
              </>
            }
          >
            {(close) => (
              <div role="group" aria-label="Who does what">
                {slots.map((slot) => (
                  <div key={slot.value}>
                    <p className="px-2 pb-0.5 pt-1.5 text-2xs font-medium uppercase tracking-wide text-zinc-400">{slot.label}</p>
                    {info.roles.map((role) => {
                      const linked = info.links.some((l) => l.roleId === role.id && l.slot === slot.value);
                      return (
                        <MenuItem
                          key={`${slot.value}-${role.id}`}
                          disabled={linked}
                          onClick={() => {
                            close();
                            toggle(role.id, slot.value, true);
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {role.name}
                            {several ? <span className="text-zinc-400"> · {role.projectName}</span> : null}
                          </span>
                          <span className="shrink-0 text-xs text-zinc-500">{role.personName ?? "nobody yet"}</span>
                        </MenuItem>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </Popover>
        ) : null}
      </dd>
    </>
  );
}
