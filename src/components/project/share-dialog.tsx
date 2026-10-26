"use client";

import Link from "next/link";
import { useEffect, useId, useState, useTransition } from "react";
import { Clock, Globe, Link2, Lock, Mail, UserMinus, Users, X } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { useConfirm } from "@/components/confirm";
import { Dialog } from "@/components/dialog";
import { ResendInviteButton } from "@/components/people/pending-invites";
import { MemberRolePicker, RolePicker, TeamRolePicker, projectRoleOptions } from "@/components/role-picker";
import { SmartPicker } from "@/components/smart-picker";
import { copyProjectLink } from "@/components/project/project-page-context";
import { useShell } from "@/components/shell/shell-context";
import { useNotify } from "@/components/toast";
import {
  addTeamToProject,
  cancelPendingInvite,
  changeProjectMemberRole,
  decideAccessRequest,
  inviteProjectMember,
  leaveProject,
  removeProjectMember,
  updateProjectTeam,
} from "@/lib/actions";
import type { ShareData, ShareMember, SharePerson, ShareTeam } from "@/lib/project-page";
import { isAccessGrantRole } from "@/lib/access-requests";
import { loadProjectShare } from "@/lib/project-page-actions";
import { PERSON_DEFAULT_ROLE, ROLE_DESCRIPTIONS, ROLE_LABELS, assignableRoles, hasRole, isProjectRole } from "@/lib/roles";
import { describeTeamInvite, isTeamProjectRole } from "@/lib/teams";
import {
  EMAIL_PATTERN,
  VISIBILITY_DESCRIPTIONS,
  describeInviteEmail,
  inviteHelp,
  type ProjectVisibility,
} from "@/lib/workspace";

type InviteTarget =
  | { kind: "person"; person: SharePerson }
  | { kind: "team"; team: ShareTeam }
  | { kind: "email"; email: string };

const keyOf = (t: InviteTarget) =>
  t.kind === "person" ? `person:${t.person.id}` : t.kind === "team" ? `team:${t.team.id}` : `email:${t.email}`;
const labelOf = (t: InviteTarget) => (t.kind === "person" ? t.person.name : t.kind === "team" ? t.team.name : t.email);
const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
// A team's line: its size only when the viewer can see inside it (its members, workspace admins).
const teamLine = (team: ShareTeam) => (team.memberCount === null ? "Team" : `Team · ${people(team.memberCount)}`);

// Asana's Share dialog: invite people, emails, or whole teams with one role; who can find the project
// (private, or public to its team); and who has access, with a role per person and per team. Everything
// goes through the existing actions and database checks (add_project_member and add_team_to_project are
// Admin+, owners alone hand out Owner, a project keeps an owner), so below Admin it's read-only. The data
// is read with the viewer's own session when the dialog opens and again after each change.
export function ShareDialog({
  projectId,
  projectName,
  onClose,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
}) {
  const notify = useNotify();
  const [data, setData] = useState<ShareData | null>(null);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadProjectShare(projectId)
      .then((loaded) => {
        if (!live) return;
        if (loaded) setData(loaded);
        else setFailed(true);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [projectId, version]);

  // Runs one change, shows its error in the dialog, and reloads the lists afterwards.
  function change(action: () => Promise<{ error?: string } | void>, done?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result?.error) setError(result.error);
      else done?.();
      setVersion((v) => v + 1);
    });
  }

  async function copyLink() {
    notify((await copyProjectLink(projectId)) ? "Project link copied" : "Couldn’t copy the link. Copy it from the address bar.");
  }

  const canManage = data ? hasRole(data.viewerRole, "admin") : false;

  return (
    <Dialog title={`Share “${projectName}”`} onClose={onClose} width="max-w-xl">
      {failed ? (
        <p className="text-sm text-red-600">Couldn’t load who has access. Close this and try again.</p>
      ) : data === null ? (
        <p role="status" className="text-sm text-zinc-500">
          Loading who has access…
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          {canManage ? (
            <InviteForm data={data} pending={pending} projectId={projectId} change={change} notify={notify} />
          ) : (
            <p className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
              Only project admins and owners can invite people or change access. You’re{" "}
              {data.viewerRole === "admin" || data.viewerRole === "editor" ? "an" : "a"} {ROLE_LABELS[data.viewerRole]}{" "}
              here.
            </p>
          )}

          {error ? (
            <p role="alert" className="-mt-2 text-xs text-red-600">
              {error}
            </p>
          ) : null}

          <ProjectAccess data={data} canManage={canManage} pending={pending} projectId={projectId} change={change} />

          {canManage && data.accessRequests.length ? (
            <AccessRequests data={data} pending={pending} change={change} />
          ) : null}

          <WhoHasAccess data={data} canManage={canManage} pending={pending} projectId={projectId} change={change} notify={notify} />

          <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-4">
            <button type="button" onClick={copyLink} className="btn-secondary">
              <Link2 className="size-3.5" aria-hidden />
              Copy project link
            </button>
            <Link
              href={`/projects/${projectId}/settings/members`}
              onClick={onClose}
              className="text-xs text-accent-700 hover:underline"
            >
              Manage members
            </Link>
            <button type="button" onClick={onClose} className="btn-primary ml-auto">
              Done
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

type Change = (action: () => Promise<{ error?: string } | void>, done?: () => void) => void;

function InviteForm({
  data,
  pending,
  projectId,
  change,
  notify,
}: {
  data: ShareData;
  pending: boolean;
  projectId: string;
  change: Change;
  notify: (message: string) => void;
}) {
  const listId = useId();
  const { isWorkspaceAdmin } = useShell();
  const [query, setQuery] = useState("");
  const [targets, setTargets] = useState<InviteTarget[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  // Inviting as Owner isn't offered (owners promote someone from the list below instead).
  const roles = assignableRoles(data.viewerRole, data.allowCommenter).filter((r) => r !== "owner");
  const [role, setRole] = useState<string>(
    data.defaultRoles ? PERSON_DEFAULT_ROLE : roles.includes("editor") ? "editor" : (roles[0] ?? "viewer"),
  );

  const memberIds = new Set(data.members.map((m) => m.profileId));
  const knownEmails = new Set([...data.members, ...data.invites].map((m) => m.email.toLowerCase()));
  const chosen = new Set(targets.map(keyOf));
  const needle = query.trim().toLowerCase();
  const options: InviteTarget[] = needle
    ? [
        ...data.people
          .filter(
            (p) =>
              !memberIds.has(p.id) &&
              !chosen.has(`person:${p.id}`) &&
              (p.name.toLowerCase().includes(needle) || p.email.toLowerCase().includes(needle)),
          )
          .slice(0, 6)
          .map((person): InviteTarget => ({ kind: "person", person })),
        ...data.teams
          .filter((t) => !chosen.has(`team:${t.id}`) && t.name.toLowerCase().includes(needle))
          .slice(0, 4)
          .map((team): InviteTarget => ({ kind: "team", team })),
        ...(EMAIL_PATTERN.test(needle) &&
        !knownEmails.has(needle) &&
        !chosen.has(`email:${needle}`) &&
        !data.people.some((p) => p.email.toLowerCase() === needle)
          ? [{ kind: "email" as const, email: needle }]
          : []),
      ]
    : [];
  const showList = open && options.length > 0;
  const highlighted = Math.min(active, options.length - 1);
  // A typed address that wasn't picked from the list counts too, unless it's someone already here (an
  // invite would quietly change their role) or already chosen.
  const typedEmail = EMAIL_PATTERN.test(needle) ? needle : null;
  const typedKnown = typedEmail !== null && knownEmails.has(typedEmail);
  const typedTarget: InviteTarget | null =
    typedEmail && !typedKnown && !chosen.has(`email:${typedEmail}`) && !targets.some((t) => t.kind === "person" && t.person.email.toLowerCase() === typedEmail)
      ? { kind: "email", email: typedEmail }
      : null;

  function pick(target: InviteTarget) {
    setTargets((current) => [...current, target]);
    setQuery("");
    setActive(0);
  }

  function invite() {
    const typed = typedTarget ? [typedTarget] : [];
    const all = [...targets, ...typed];
    if (all.length === 0) return;
    change(async () => {
      const problems: string[] = [];
      const notes: string[] = [];
      const done = new Set<string>();
      let added = 0;
      let waiting = 0;
      let emailed = 0;
      let joinedWorkspace = 0;
      for (const target of all) {
        if (target.kind === "team") {
          if (!isTeamProjectRole(role) && role !== PERSON_DEFAULT_ROLE) continue;
          const outcome = await addTeamToProject(projectId, target.team.id, role);
          if (outcome.error) problems.push(`${target.team.name}: ${outcome.error}`);
          else {
            done.add(keyOf(target));
            if (outcome.result) notes.push(describeTeamInvite(target.team.name, outcome.result));
          }
          continue;
        }
        const email = target.kind === "person" ? target.person.email : target.email;
        const result = await inviteProjectMember(projectId, email, role);
        if (result.error) {
          problems.push(`${labelOf(target)}: ${result.error}`);
          continue;
        }
        done.add(keyOf(target));
        if (result.pending) waiting += 1;
        else added += 1;
        if (result.pending && result.emailed) emailed += 1;
        if (result.joinedWorkspace) joinedWorkspace += 1;
      }
      // Whatever went through leaves the box; what failed stays so it can be fixed and sent again.
      setTargets((current) => current.filter((t) => !done.has(keyOf(t))));
      if (typed.length && done.has(keyOf(typed[0]))) setQuery("");
      if (added) notes.unshift(`Added ${people(added)}`);
      if (waiting) {
        notes.push(
          emailed === waiting
            ? `Emailed ${people(waiting)} an invite; they’ll join when they sign up`
            : `${people(waiting)} will join on their first sign-in (no invite email could be sent from here, so let them know)`,
        );
      }
      if (joinedWorkspace) notes.push(`${people(joinedWorkspace)} added to the workspace`);
      if (notes.length) notify(notes.join(" · "));
      return problems.length ? { error: problems.join(" ") } : {};
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        invite();
      }}
    >
      <label htmlFor={`${listId}-input`} className="block text-xs font-medium text-zinc-700">
        Invite with email
      </label>
      <div className="mt-1 flex items-start gap-2">
        <div className="relative min-w-0 flex-1">
          <div className="field flex h-auto min-h-9 flex-wrap items-center gap-1 py-1 pl-1.5 focus-within:border-accent-500/60 focus-within:shadow-[0_0_0_3px_var(--focus-ring)]">
            {targets.map((target) => (
              <span key={keyOf(target)} className="inline-flex max-w-full items-center gap-1 rounded-full bg-zinc-100 py-0.5 pl-1 pr-1.5 text-xs text-zinc-800">
                {target.kind === "team" ? (
                  <Users className="size-3.5 text-zinc-500" aria-hidden />
                ) : target.kind === "email" ? (
                  <Mail className="size-3.5 text-zinc-500" aria-hidden />
                ) : (
                  <Avatar name={target.person.name} profileId={target.person.id} />
                )}
                <span className="truncate">{labelOf(target)}</span>
                <button
                  type="button"
                  onClick={() => setTargets((current) => current.filter((t) => keyOf(t) !== keyOf(target)))}
                  aria-label={`Don’t invite ${labelOf(target)}`}
                  className="rounded-full p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            <input
              id={`${listId}-input`}
              autoFocus
              role="combobox"
              aria-expanded={showList}
              aria-controls={`${listId}-list`}
              aria-autocomplete="list"
              aria-activedescendant={showList ? `${listId}-option-${highlighted}` : undefined}
              value={query}
              autoComplete="off"
              placeholder={targets.length ? "" : "Add people, emails, or teams"}
              onChange={(e) => {
                setQuery(e.currentTarget.value);
                setActive(0);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onBlur={() => setOpen(false)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" && options.length) {
                  e.preventDefault();
                  setOpen(true);
                  setActive((highlighted + 1) % options.length);
                } else if (e.key === "ArrowUp" && options.length) {
                  e.preventDefault();
                  setActive((highlighted - 1 + options.length) % options.length);
                } else if (e.key === "Enter" && showList) {
                  e.preventDefault();
                  pick(options[highlighted]);
                } else if (e.key === "Backspace" && !query && targets.length) {
                  setTargets((current) => current.slice(0, -1));
                } else if (e.key === "Escape" && showList) {
                  // Close the list, not the dialog.
                  e.preventDefault();
                  e.stopPropagation();
                  setOpen(false);
                }
              }}
              className="h-7 min-w-32 flex-1 border-0 bg-transparent px-1 text-sm shadow-none outline-none focus:shadow-none focus-visible:shadow-none"
            />
          </div>
          {showList ? (
            <ul
              id={`${listId}-list`}
              role="listbox"
              aria-label="Matching people and teams"
              className="absolute inset-x-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-1 shadow-lg"
            >
              {options.map((option, index) => (
                <li
                  key={keyOf(option)}
                  id={`${listId}-option-${index}`}
                  role="option"
                  aria-selected={index === highlighted}
                  // mousedown, so the input doesn't blur (and close the list) first.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(option);
                  }}
                  onMouseEnter={() => setActive(index)}
                  className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
                    index === highlighted ? "bg-zinc-100" : ""
                  }`}
                >
                  {option.kind === "person" ? (
                    <>
                      <Avatar name={option.person.name} profileId={option.person.id} size="md" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-zinc-900">{option.person.name}</span>
                        <span className="block truncate text-xs text-zinc-500">{option.person.email}</span>
                      </span>
                    </>
                  ) : option.kind === "team" ? (
                    <>
                      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-500">
                        <Users className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-zinc-900">{option.team.name}</span>
                        <span className="block truncate text-xs text-zinc-500">{teamLine(option.team)}</span>
                      </span>
                    </>
                  ) : (
                    <>
                      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-500">
                        <Mail className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-zinc-900">Invite {option.email}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <RolePicker
          id={`${listId}-role`}
          label="Role for the people you invite"
          value={role}
          onChange={setRole}
          options={projectRoleOptions({
            grantable: roles,
            allowCommenter: data.allowCommenter,
            includeDefault: data.defaultRoles,
            inviting: true,
          })}
        />
        <button
          type="submit"
          disabled={pending || (targets.length === 0 && !typedTarget)}
          className="btn-primary h-9 shrink-0 px-3"
        >
          {pending ? "Inviting…" : "Invite"}
        </button>
      </div>
      {typedKnown ? (
        <p role="status" className="mt-1 text-xs text-amber-700">
          {typedEmail} already has access or an invite. Change their role under Who has access.
        </p>
      ) : (
        <p className="mt-1 text-xs text-zinc-500">
          {inviteHelp(isWorkspaceAdmin, data.resendable)} A team adds everyone on it who isn’t here yet.
        </p>
      )}
    </form>
  );
}

function ProjectAccess({
  data,
  canManage,
  pending,
  projectId,
  change,
}: {
  data: ShareData;
  canManage: boolean;
  pending: boolean;
  projectId: string;
  change: Change;
}) {
  const teamName = data.team?.name ?? "the team";
  const label = (v: ProjectVisibility) => (v === "team" ? `Public to ${teamName}` : "Private to members");
  const Icon = data.visibility === "team" ? Globe : Lock;
  return (
    <section aria-labelledby="share-access-heading">
      <h3 id="share-access-heading" className="text-xs font-medium text-zinc-700">
        Project access
      </h3>
      <div className="mt-1.5 flex items-center gap-2.5">
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          {canManage ? (
            <>
              <VisibilityPicker
                key={data.visibility}
                saved={data.visibility}
                label={label}
                disabled={pending}
                onPick={(next, revert) =>
                  change(async () => {
                    const result = await updateProjectTeam(projectId, { visibility: next });
                    // Refused: show the saved value again (the reload doesn't change it).
                    if (result.error) revert();
                    return result;
                  })
                }
              />
            </>
          ) : (
            <p className="text-sm font-medium text-zinc-900">{label(data.visibility)}</p>
          )}
          <p className="mt-0.5 text-xs text-zinc-500">{VISIBILITY_DESCRIPTIONS[data.visibility]}</p>
        </div>
      </div>
    </section>
  );
}

function VisibilityPicker({
  saved,
  label,
  disabled,
  onPick,
}: {
  saved: ProjectVisibility;
  label: (v: ProjectVisibility) => string;
  disabled: boolean;
  onPick: (next: ProjectVisibility, revert: () => void) => void;
}) {
  const [shown, setShown] = useState<ProjectVisibility>(saved);
  return (
    <SmartPicker
      id="share-visibility"
      label="Who can find this project"
      value={shown}
      disabled={disabled}
      panelWidth={260}
      className="h-8 w-auto max-w-full font-medium"
      options={(["private", "team"] as const).map((v) => ({ value: v, label: label(v), description: VISIBILITY_DESCRIPTIONS[v] }))}
      onChange={(value) => {
        const next: ProjectVisibility = value === "team" ? "team" : "private";
        if (next === shown) return;
        setShown(next);
        onPick(next, () => setShown(saved));
      }}
    />
  );
}

function WhoHasAccess({
  data,
  canManage,
  pending,
  projectId,
  change,
  notify,
}: {
  data: ShareData;
  canManage: boolean;
  pending: boolean;
  projectId: string;
  change: Change;
  notify: (message: string) => void;
}) {
  const isOwner = data.viewerRole === "owner";
  const grantable = assignableRoles(data.viewerRole, data.allowCommenter);
  const ownerCount = data.members.filter((m) => m.role === "owner").length;
  // Already in Asana's order (owners first; loadProjectShare sorts with compareMembers).
  const members = data.members;
  const count = data.members.length + data.invites.length;

  return (
    <section aria-labelledby="share-who-heading">
      <h3 id="share-who-heading" className="text-xs font-medium text-zinc-700">
        Who has access <span className="font-normal tabular-nums text-zinc-400">· {people(count)}</span>
      </h3>
      <ul className="mt-1.5 flex max-h-80 flex-col overflow-y-auto">
        {data.visibility === "team" && data.team ? (
          <li className="flex items-center gap-2.5 py-1.5">
            <TeamGlyph />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-zinc-900">Members of {data.team.name}</p>
              <p className="truncate text-xs text-zinc-500">
                {data.team.memberCount === null ? "Can find it and join" : `${people(data.team.memberCount)} · can find it and join`}
              </p>
            </div>
            <span className="shrink-0 text-xs text-zinc-600">Can join as Editor</span>
            <span aria-hidden className="w-12 shrink-0" />
          </li>
        ) : null}
        {data.addedTeams.map((team) => (
          <li key={team.id} className="flex items-center gap-2.5 py-1.5">
            <TeamGlyph />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-zinc-900">{team.name}</p>
              <p className="truncate text-xs text-zinc-500">{teamLine(team)}</p>
            </div>
            {/* Re-running the group invite needs a team the viewer can see inside (add_team_to_project). */}
            {canManage && isTeamProjectRole(team.role) && team.memberCount !== null ? (
              <>
                <TeamRolePicker
                  key={`${team.role}-${team.usesDefaultRoles}`}
                  team={team}
                  grantable={grantable.filter((r) => r !== "owner")}
                  allowCommenter={data.allowCommenter}
                  defaultRoles={data.defaultRoles}
                  disabled={pending}
                  run={change}
                  save={async (next) => {
                    const outcome = await addTeamToProject(projectId, team.id, next);
                    if (outcome.result) notify(describeTeamInvite(team.name, outcome.result));
                    return outcome;
                  }}
                />
              </>
            ) : (
              <span className="w-32 shrink-0 text-xs text-zinc-600">
                {team.usesDefaultRoles ? "Their default role" : isProjectRole(team.role) ? ROLE_LABELS[team.role] : team.role}
              </span>
            )}
            <span aria-hidden className="w-12 shrink-0" />
          </li>
        ))}
        {members.map((member) => (
          <MemberRow
            key={member.profileId}
            member={member}
            self={member.profileId === data.viewerId}
            manageable={canManage && (member.role !== "owner" || isOwner)}
            lastOwner={member.role === "owner" && ownerCount === 1}
            grantable={grantable}
            allowCommenter={data.allowCommenter}
            pending={pending}
            projectId={projectId}
            change={change}
          />
        ))}
        {data.invites.map((invite) => (
          <li key={invite.id} className="flex items-center gap-2.5 py-1.5">
            <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-400">
              <Clock className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-zinc-900">{invite.email}</p>
              <p className="truncate text-xs text-zinc-500">
                Invited · joins when they sign up
                {canManage && invite.inviteEmail ? ` · ${describeInviteEmail(invite.inviteEmail)}` : ""}
              </p>
            </div>
            <span className="w-28 shrink-0 text-xs text-zinc-600">{isProjectRole(invite.role) ? ROLE_LABELS[invite.role] : invite.role}</span>
            {canManage && data.resendable ? (
              <ResendInviteButton invite={invite} compact disabled={pending} onResend={(action) => change(action)} />
            ) : null}
            {canManage ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => change(() => cancelPendingInvite(invite.id))}
                aria-label={`Cancel the invite for ${invite.email}`}
                title="Cancel invite"
                className="btn-icon h-6 w-12 hover:bg-red-50 hover:text-red-700"
              >
                <X className="size-3.5" />
              </button>
            ) : (
              <span aria-hidden className="w-12 shrink-0" />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// Oct 26 notes (batch 3): people who opened a link to the project and asked to be added. Pick a role
// (their own default unless you choose) and Add, or Decline.
function AccessRequests({ data, pending, change }: { data: ShareData; pending: boolean; change: Change }) {
  const [roles, setRoles] = useState<Record<string, string>>({});
  const grantable = assignableRoles(data.viewerRole, data.allowCommenter).filter((r) => r !== "owner");
  const options = projectRoleOptions({
    grantable,
    allowCommenter: data.allowCommenter,
    includeDefault: data.defaultRoles,
    inviting: true,
  });
  return (
    <section aria-labelledby="share-requests-heading" className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2">
      <h3 id="share-requests-heading" className="text-xs font-medium text-zinc-800">
        Asked to be added <span className="font-normal tabular-nums text-zinc-500">· {people(data.accessRequests.length)}</span>
      </h3>
      <ul className="mt-1 flex flex-col">
        {data.accessRequests.map((request) => {
          const role = roles[request.id] ?? (data.defaultRoles ? PERSON_DEFAULT_ROLE : "editor");
          return (
            <li key={request.id} className="flex items-center gap-2.5 py-1.5">
              <Avatar name={request.name} profileId={request.profileId} size="md" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-zinc-900">{request.name}</p>
                <p className="truncate text-xs text-zinc-500">{request.email}</p>
              </div>
              <RolePicker
                compact
                label={`Role for ${request.name}`}
                value={role}
                options={options}
                disabled={pending}
                onChange={(next) => setRoles((current) => ({ ...current, [request.id]: next }))}
              />
              <button
                type="button"
                disabled={pending}
                onClick={() => change(() => decideAccessRequest(request.id, "approve", isAccessGrantRole(role) ? role : "default"))}
                className="btn-primary h-7 px-2 text-xs"
              >
                Add
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => change(() => decideAccessRequest(request.id, "decline"))}
                aria-label={`Decline ${request.name}'s request`}
                data-tooltip="Decline"
                className="btn-icon size-7 hover:bg-red-50 hover:text-red-700"
              >
                <X className="size-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TeamGlyph() {
  return (
    <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-500">
      <Users className="size-4" />
    </span>
  );
}

function MemberRow({
  member,
  self,
  manageable,
  lastOwner,
  grantable,
  allowCommenter,
  pending,
  projectId,
  change,
}: {
  member: ShareMember;
  self: boolean;
  manageable: boolean;
  lastOwner: boolean;
  grantable: ReturnType<typeof assignableRoles>;
  allowCommenter: boolean;
  pending: boolean;
  projectId: string;
  change: Change;
}) {
  const confirm = useConfirm();
  return (
    <li className="flex items-center gap-2.5 py-1.5">
      <Avatar name={member.name} profileId={member.profileId} size="md" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-zinc-900">
          {member.name}
          {self ? <span className="ml-1 text-xs text-zinc-500">(you)</span> : null}
        </p>
        {member.name !== member.email ? <p className="truncate text-xs text-zinc-500">{member.email}</p> : null}
      </div>
      {manageable ? (
        <MemberRolePicker
          key={member.role}
          id={`share-role-${member.profileId}`}
          label={`Role for ${member.name}`}
          role={member.role}
          grantable={grantable}
          allowCommenter={allowCommenter}
          disabled={pending || lastOwner}
          title={lastOwner ? "A project needs at least one owner" : undefined}
          run={change}
          save={(next) => changeProjectMemberRole(projectId, member.profileId, next)}
        />
      ) : (
        <span className="w-32 shrink-0 text-xs text-zinc-600" title={ROLE_DESCRIPTIONS[member.role]}>
          {ROLE_LABELS[member.role]}
        </span>
      )}
      {self ? (
        <button
          type="button"
          disabled={pending || lastOwner}
          title={lastOwner ? "Make someone else an owner before leaving" : "Leave project"}
          onClick={async () => {
            if (
              await confirm({
                title: "Leave this project?",
                message: "You’ll lose access until someone invites you again.",
                confirmLabel: "Leave",
                tone: "danger",
              })
            ) {
              change(() => leaveProject(projectId, member.profileId));
            }
          }}
          className="btn-ghost h-6 w-12 shrink-0 px-1.5 text-xs"
        >
          Leave
        </button>
      ) : manageable ? (
        <button
          type="button"
          disabled={pending || lastOwner}
          onClick={async () => {
            if (await confirm({ title: `Remove ${member.name} from this project?`, confirmLabel: "Remove", tone: "danger" })) {
              change(() => removeProjectMember(projectId, member.profileId));
            }
          }}
          aria-label={`Remove ${member.name}`}
          title="Remove from project"
          className="btn-icon h-6 w-12 shrink-0 hover:bg-red-50 hover:text-red-700"
        >
          <UserMinus className="size-3.5" />
        </button>
      ) : (
        <span aria-hidden className="w-12 shrink-0" />
      )}
    </li>
  );
}
