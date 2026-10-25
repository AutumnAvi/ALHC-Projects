"use client";

import Link from "next/link";
import { useState } from "react";
import { useShell } from "@/components/shell/shell-context";
import { SmartPicker, type SmartOption } from "@/components/smart-picker";
import {
  COMMENTER_OFF_REASON,
  COMMENTER_SWITCH_HREF,
  PERSON_DEFAULT_ROLE,
  PORTFOLIO_ROLES,
  PORTFOLIO_ROLE_DESCRIPTIONS,
  PORTFOLIO_ROLE_LABELS,
  PROJECT_ROLES,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  TEAM_ROLE_DESCRIPTIONS,
  type PortfolioRole,
  type ProjectRole,
} from "@/lib/roles";

// Every project role, highest first, each with its one-line description. Roles the viewer can't give are
// listed greyed out with the reason (so nobody wonders where Viewer or Commenter went); the member's
// current role is always selectable. With includeDefault, "Their default role" comes first.
export function projectRoleOptions({
  grantable,
  allowCommenter,
  current,
  includeDefault = false,
  defaultDescription = "Each person’s default project role (Editor unless a workspace admin chose another)",
  inviting = false,
}: {
  grantable: readonly ProjectRole[];
  allowCommenter: boolean;
  current?: string | null;
  includeDefault?: boolean;
  defaultDescription?: string;
  // Adding people: owners are made from the member list afterwards.
  inviting?: boolean;
}): SmartOption[] {
  const roles: SmartOption[] = PROJECT_ROLES.map((role) => {
    const base = { value: role, label: ROLE_LABELS[role], description: ROLE_DESCRIPTIONS[role] };
    if (role === current) return base;
    if (role === "commenter" && !allowCommenter) return { ...base, disabled: true, disabledReason: COMMENTER_OFF_REASON };
    if (role === "owner" && inviting) {
      return { ...base, disabled: true, disabledReason: "Add them first, then make them an owner from the list" };
    }
    if (!grantable.includes(role)) {
      return {
        ...base,
        disabled: true,
        disabledReason: role === "owner" ? "Only project owners can make someone an owner" : "Your role here can’t give this role",
      };
    }
    return base;
  });
  return includeDefault
    ? [{ value: PERSON_DEFAULT_ROLE, label: "Their default role", description: defaultDescription }, ...roles]
    : roles;
}

export function portfolioRoleOptions({ grantable, current }: { grantable: readonly PortfolioRole[]; current?: string | null }): SmartOption[] {
  return PORTFOLIO_ROLES.map((role) => {
    const base = { value: role, label: PORTFOLIO_ROLE_LABELS[role], description: PORTFOLIO_ROLE_DESCRIPTIONS[role] };
    if (role === current || grantable.includes(role)) return base;
    return {
      ...base,
      disabled: true,
      disabledReason: role === "owner" ? "Only portfolio owners can make someone an owner" : "Your role here can’t give this role",
    };
  });
}

export function teamRoleOptions(): SmartOption[] {
  return [
    { value: "lead", label: "Lead", description: TEAM_ROLE_DESCRIPTIONS.lead },
    { value: "member", label: "Member", description: TEAM_ROLE_DESCRIPTIONS.member },
  ];
}

// The one role picker (Share, project / portfolio / team members, the Admin console): searchable, every
// role with what it can do. When Commenter is greyed out because the workspace turned it off, the list
// ends with where to turn it on (a link for workspace admins).
export function RolePicker({
  label,
  value,
  options,
  onChange,
  disabled = false,
  id,
  name,
  className = "",
  compact = false,
  title,
}: {
  label: string;
  value: string | null;
  options: readonly SmartOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  name?: string;
  className?: string;
  compact?: boolean;
  title?: string;
}) {
  const { isWorkspaceAdmin } = useShell();
  const commenterOff = options.some((o) => o.value === "commenter" && o.disabled && o.disabledReason === COMMENTER_OFF_REASON);
  return (
    <span title={title} className="inline-flex shrink-0">
      <SmartPicker
        id={id}
        name={name}
        label={label}
        value={value}
        options={options}
        onChange={onChange}
        disabled={disabled}
        searchable
        panelWidth={320}
        className={`${compact ? "h-7 w-32 text-xs" : "h-9 w-40"} ${className}`}
        renderValue={(chosen) => (chosen[0] ? <span className="truncate">{chosen[0].label}</span> : null)}
        footer={
          commenterOff ? (
            isWorkspaceAdmin ? (
              <Link href={COMMENTER_SWITCH_HREF} className="font-medium text-accent-700 hover:underline">
                Turn on Commenter in Admin console → Security
              </Link>
            ) : (
              "Commenter is turned off in this workspace. A workspace admin can turn it on in Admin console → Security."
            )
          ) : undefined
        }
      />
    </span>
  );
}

type Run = (action: () => Promise<{ error?: string } | void>) => void;

// A member's project role, changed in place: shows the new role at once and puts the old one back when
// the database refuses (the caller's run() shows why). Remount it with key={role} to follow a refresh.
export function MemberRolePicker({
  id,
  label,
  role,
  grantable,
  allowCommenter,
  disabled,
  title,
  run,
  save,
}: {
  id?: string;
  label: string;
  role: ProjectRole;
  grantable: readonly ProjectRole[];
  allowCommenter: boolean;
  disabled?: boolean;
  title?: string;
  run: Run;
  save: (role: string) => Promise<{ error?: string }>;
}) {
  const [shown, setShown] = useState<string>(role);
  return (
    <RolePicker
      id={id}
      label={label}
      value={shown}
      compact
      title={title}
      disabled={disabled}
      options={projectRoleOptions({ grantable, allowCommenter, current: role })}
      onChange={(next) => {
        if (next === shown) return;
        setShown(next);
        run(async () => {
          const result = await save(next);
          if (result.error) setShown(role);
          return result;
        });
      }}
    />
  );
}

// A team's role on a project (a group invite run again): one role for everyone on the team who isn't in
// the project yet, or each person's default. People already in keep their own role.
export function TeamRolePicker({
  team,
  grantable,
  allowCommenter,
  defaultRoles,
  disabled,
  run,
  save,
}: {
  team: { id: string; name: string; role: string; usesDefaultRoles: boolean };
  grantable: readonly ProjectRole[];
  allowCommenter: boolean;
  defaultRoles: boolean;
  disabled?: boolean;
  run: Run;
  save: (role: string) => Promise<{ error?: string }>;
}) {
  const current = team.usesDefaultRoles ? PERSON_DEFAULT_ROLE : team.role;
  const [shown, setShown] = useState<string>(current);
  const options = projectRoleOptions({
    grantable,
    allowCommenter,
    current: team.role,
    includeDefault: defaultRoles,
    defaultDescription: "Each team member joins with their own default project role",
    inviting: true,
  });
  return (
    <RolePicker
      label={`Role for people added from ${team.name}`}
      value={shown}
      compact
      disabled={disabled}
      title="Adds anyone on the team who isn’t here yet with this role. People already here keep their own role."
      options={options}
      onChange={(next) => {
        if (next === shown) return;
        setShown(next);
        run(async () => {
          const result = await save(next);
          if (result.error) setShown(current);
          return result;
        });
      }}
    />
  );
}

// The same in-place change for any role list (portfolio and team members).
export function RoleChangePicker({
  id,
  label,
  role,
  options,
  disabled,
  title,
  run,
  save,
}: {
  id?: string;
  label: string;
  role: string;
  options: readonly SmartOption[];
  disabled?: boolean;
  title?: string;
  run: Run;
  save: (role: string) => Promise<{ error?: string }>;
}) {
  const [shown, setShown] = useState(role);
  return (
    <RolePicker
      id={id}
      label={label}
      value={shown}
      compact
      title={title}
      disabled={disabled}
      options={options}
      onChange={(next) => {
        if (next === shown) return;
        setShown(next);
        run(async () => {
          const result = await save(next);
          if (result.error) setShown(role);
          return result;
        });
      }}
    />
  );
}
