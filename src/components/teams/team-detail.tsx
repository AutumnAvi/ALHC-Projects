"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { FolderKanban, LogOut, Target, Trash2, UserMinus, UserPlus, Users } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { GoalStatusBadge } from "@/components/goals/goal-status-badge";
import { ProgressBar } from "@/components/portfolio/progress-bar";
import { ProjectStatusBadge } from "@/components/project-status-badge";
import { useServerAction } from "@/components/toast";
import { EmptyState, HEADER_TITLE_INPUT } from "@/components/ui";
import { addTeamMember, changeTeamMemberRole, deleteTeam, removeTeamMember, updateTeam } from "@/lib/actions";
import type { Team, TeamProject } from "@/lib/data";
import { NO_PROGRESS, type Goal, type GoalProgress } from "@/lib/goals";
import { formatProgress } from "@/lib/portfolios";
import { ROLE_LABELS, isProjectRole } from "@/lib/roles";
import { TEAM_ROLES, TEAM_ROLE_LABELS, type TeamRole } from "@/lib/teams";

const CARD = "rounded-lg border border-zinc-200";
const CARD_HEADER = "border-b border-zinc-200 px-5 py-4";

export function TeamDetail({
  team,
  viewerId,
  canManage,
  projects,
  goals,
  progress,
}: {
  team: Team;
  viewerId: string;
  canManage: boolean;
  projects: TeamProject[];
  goals: Goal[];
  progress: Record<string, GoalProgress>;
}) {
  const [pending, run] = useServerAction();
  const emailRef = useRef<HTMLInputElement>(null);
  const [inviteRole, setInviteRole] = useState<TeamRole>("member");
  const leadCount = team.members.filter((m) => m.role === "lead").length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-bar shrink-0 flex-wrap items-center gap-2 border-b border-zinc-200 px-gutter py-2">
        <Link href="/teams" className="text-sm text-zinc-500 hover:text-zinc-900 hover:underline">
          Teams
        </Link>
        <span aria-hidden className="text-zinc-300">
          /
        </span>
        <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent-600 text-white">
          <Users className="size-4" />
        </span>
        <h1 className="sr-only">{team.name}</h1>
        <label htmlFor="team-name" className="sr-only">
          Team name
        </label>
        <input
          id="team-name"
          key={team.name}
          defaultValue={team.name}
          readOnly={!canManage}
          maxLength={100}
          onBlur={(e) => {
            const value = e.currentTarget.value.trim();
            if (value && value !== team.name) run(() => updateTeam(team.id, { name: value }));
            else e.currentTarget.value = team.name;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          className={`${HEADER_TITLE_INPUT} min-w-40 flex-1`}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 px-gutter py-5">
          <section aria-labelledby="team-about-heading">
            <h2 id="team-about-heading" className="sr-only">
              About
            </h2>
            <label htmlFor="team-description" className="sr-only">
              Description
            </label>
            <textarea
              id="team-description"
              key={team.description ?? ""}
              defaultValue={team.description ?? ""}
              readOnly={!canManage}
              rows={2}
              maxLength={2000}
              placeholder={canManage ? "What this team does" : "No description"}
              onBlur={(e) => {
                const value = e.currentTarget.value;
                if (value.trim() !== (team.description ?? "")) run(() => updateTeam(team.id, { description: value }));
              }}
              className="control w-full resize-y read-only:border-transparent read-only:bg-transparent read-only:px-0"
            />
            <p className="mt-1 text-xs text-zinc-500">
              Leads and workspace admins manage this team. Being on it doesn’t open any project; a project admin can add
              the whole team from the project’s Settings → Members.
            </p>
          </section>

          <section className={CARD} aria-labelledby="team-members-heading">
            <div className={CARD_HEADER}>
              <h2 id="team-members-heading" className="text-sm font-semibold text-zinc-900">
                Members <span className="font-normal text-zinc-500">· {team.members.length}</span>
              </h2>
            </div>
            {canManage ? (
              <form
                className="flex flex-wrap items-end gap-3 border-b border-zinc-100 px-5 py-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  const input = emailRef.current;
                  const email = input?.value.trim();
                  if (!input || !email) return;
                  run(async () => {
                    const result = await addTeamMember(team.id, email, inviteRole);
                    if (!result.error) input.value = "";
                    return result;
                  });
                }}
              >
                <div className="flex min-w-56 flex-1 flex-col gap-1">
                  <label htmlFor="team-member-email" className="text-xs font-medium text-zinc-600">
                    Add someone by email
                  </label>
                  <input
                    ref={emailRef}
                    id="team-member-email"
                    type="email"
                    required
                    autoComplete="off"
                    placeholder="name@example.com"
                    className="control"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="team-member-role" className="text-xs font-medium text-zinc-600">
                    Role
                  </label>
                  <select
                    id="team-member-role"
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.currentTarget.value as TeamRole)}
                    className="control"
                  >
                    {TEAM_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {TEAM_ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                </div>
                <button type="submit" disabled={pending} className="btn-primary">
                  <UserPlus className="size-3.5" aria-hidden />
                  Add
                </button>
                <p className="basis-full text-xs text-zinc-500">
                  They must be on the workspace allowlist and have signed in at least once.
                </p>
              </form>
            ) : null}
            {team.members.length === 0 ? (
              <EmptyState icon={Users} title="No one in this team" size="inline">
                A workspace admin can add people.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {team.members.map((m) => {
                  const self = m.profileId === viewerId;
                  const lastLead = m.role === "lead" && leadCount === 1;
                  return (
                    <li key={m.profileId} className="flex flex-wrap items-center gap-3 px-5 py-3">
                      <Avatar name={m.name} size="md" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-zinc-900">
                          {m.name}
                          {self ? <span className="font-normal text-zinc-500"> (you)</span> : null}
                        </p>
                        <p className="truncate text-xs text-zinc-500">{m.email}</p>
                      </div>
                      {canManage ? (
                        <>
                          <label htmlFor={`team-role-${m.profileId}`} className="sr-only">
                            Role for {m.name}
                          </label>
                          <select
                            id={`team-role-${m.profileId}`}
                            key={m.role}
                            defaultValue={m.role}
                            disabled={pending || lastLead}
                            title={lastLead ? "A team needs at least one lead. Make someone else a lead first." : undefined}
                            onChange={(e) => {
                              const select = e.currentTarget;
                              run(async () => {
                                const result = await changeTeamMemberRole(team.id, m.profileId, select.value);
                                if (result.error) select.value = m.role;
                                return result;
                              });
                            }}
                            className="control"
                          >
                            {TEAM_ROLES.map((r) => (
                              <option key={r} value={r}>
                                {TEAM_ROLE_LABELS[r]}
                              </option>
                            ))}
                          </select>
                        </>
                      ) : (
                        <span className="chip">{TEAM_ROLE_LABELS[m.role]}</span>
                      )}
                      {self ? (
                        <button
                          type="button"
                          disabled={pending || lastLead}
                          title={lastLead ? "Make someone else a lead before leaving" : "Leave team"}
                          onClick={() => {
                            if (window.confirm(`Leave ${team.name}? Your project memberships stay as they are.`)) {
                              run(() => removeTeamMember(team.id, m.profileId));
                            }
                          }}
                          className="btn-ghost text-zinc-600"
                        >
                          <LogOut className="size-3.5" aria-hidden />
                          Leave
                        </button>
                      ) : canManage ? (
                        <button
                          type="button"
                          disabled={pending || lastLead}
                          onClick={() => {
                            if (window.confirm(`Remove ${m.name} from ${team.name}? Their project memberships stay as they are.`)) {
                              run(() => removeTeamMember(team.id, m.profileId));
                            }
                          }}
                          aria-label={`Remove ${m.name}`}
                          title="Remove from team"
                          className="btn-icon hover:bg-red-50 hover:text-red-700"
                        >
                          <UserMinus className="size-4" />
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className={CARD} aria-labelledby="team-projects-heading">
            <div className={CARD_HEADER}>
              <h2 id="team-projects-heading" className="text-sm font-semibold text-zinc-900">
                Projects
              </h2>
              <p className="mt-1 text-xs text-zinc-500">
                Projects this team was added to that you can open. Projects you aren’t a member of aren’t listed.
              </p>
            </div>
            {projects.length === 0 ? (
              <EmptyState icon={FolderKanban} title="No projects to show" size="inline">
                A project owner or admin adds the team from the project’s Settings → Members → Add a team.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {projects.map((p) => (
                  <li key={p.projectId} className="flex items-center gap-3 px-5 py-2.5">
                    <span aria-hidden className="ml-0.5 mr-0.5 size-2.5 shrink-0 rounded-sm bg-zinc-300" />
                    <Link href={`/projects/${p.projectId}`} className="min-w-0 flex-1 truncate text-sm text-zinc-900 hover:underline">
                      {p.name}
                    </Link>
                    <ProjectStatusBadge status={p.status} />
                    <span className="chip" title="The role the team was added with">
                      {isProjectRole(p.role) ? ROLE_LABELS[p.role] : p.role}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={CARD} aria-labelledby="team-goals-heading">
            <div className={CARD_HEADER}>
              <h2 id="team-goals-heading" className="text-sm font-semibold text-zinc-900">
                Goals
              </h2>
            </div>
            {goals.length === 0 ? (
              <EmptyState
                icon={Target}
                title="No team goals"
                size="inline"
                action={
                  <Link href={`/goals?team=${team.id}`} className="btn-secondary">
                    Open Goals
                  </Link>
                }
              >
                Create a goal on the Goals page and pick this team. Team leads can edit every goal of their team.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {goals.map((g) => {
                  const p = progress[g.id] ?? NO_PROGRESS;
                  return (
                    <li key={g.id} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
                      <Target className="size-4 shrink-0 text-zinc-400" aria-hidden />
                      <Link href={`/goals/${g.id}`} className="min-w-0 flex-1 truncate text-sm text-zinc-900 hover:underline">
                        {g.title}
                      </Link>
                      <GoalStatusBadge status={g.status} />
                      <span className="flex w-36 items-center gap-2">
                        <ProgressBar percent={p.progress} label={`${g.title} progress`} size="sm" />
                        <span className="w-12 shrink-0 text-right text-xs tabular-nums text-zinc-600">
                          {p.progress === null ? "—" : formatProgress(p.progress)}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {canManage ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (
                  window.confirm(
                    `Delete ${team.name}? Project memberships it created stay as they are, and its goals keep working without a team.`,
                  )
                ) {
                  run(() => deleteTeam(team.id));
                }
              }}
              className="btn-ghost text-zinc-600 hover:bg-red-50 hover:text-red-700"
            >
              <Trash2 className="size-3.5" aria-hidden />
              Delete team
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
