"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarDays,
  ClipboardList,
  FolderKanban,
  Link2,
  MoreHorizontal,
  Trash2,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Avatar } from "@/components/avatar";
import { useConfirm } from "@/components/confirm";
import { MenuItem, Popover } from "@/components/popover";
import { useNotify, useServerAction } from "@/components/toast";
import { HEADER_TAB, HEADER_TITLE_INPUT, HeaderGlyph } from "@/components/ui";
import { deleteTeam, updateTeam } from "@/lib/actions";
import { ADD_TEAM_MEMBER_ID, TEAM_TABS, teamTabHref, type TeamTab } from "@/lib/teams";

const TAB_ICONS: Record<TeamTab, LucideIcon> = {
  overview: ClipboardList,
  members: Users,
  work: FolderKanban,
  calendar: CalendarDays,
};

type HeaderMember = { profileId: string; name: string };

// Asana's team header: "Teams /", the team's icon and name (editable by leads and workspace admins),
// a "…" menu, and on the right up to three member avatars; then the tabs Overview, Members, All work,
// and Calendar. Only the team's members and workspace admins get here (the layout checks first).
export function TeamHeader({
  teamId,
  name,
  members,
  canManage,
  isDefault,
  requestCount = 0,
}: {
  teamId: string;
  name: string;
  members: HeaderMember[];
  // A lead of the team or a workspace admin (can_manage_team).
  canManage: boolean;
  // The workspace's default team: new members join it automatically; it can't be deleted.
  isDefault: boolean;
  // Oct 26 notes (batch 4): open requests to join, for the people who decide (0 for everyone else).
  requestCount?: number;
}) {
  const pathname = usePathname();
  const [, run] = useServerAction();
  const membersHref = teamTabHref(teamId, "members");

  // A blank name, or one the database refused, goes back to the saved one.
  function saveName(input: HTMLInputElement) {
    const next = input.value.trim();
    if (!next) input.value = name;
    else if (next !== name) {
      run(async () => {
        const result = await updateTeam(teamId, { name: next });
        if (result.error) input.value = name;
        return result;
      });
    }
  }

  return (
    <header className="px-gutter pt-2.5">
      <div className="flex items-center gap-2">
        <Link href="/teams" className="shrink-0 text-sm text-zinc-500 hover:text-zinc-900 hover:underline">
          Teams
        </Link>
        <span aria-hidden className="text-zinc-300">
          /
        </span>
        <HeaderGlyph icon={Users} />
        <div className="flex min-w-0 flex-1 items-center gap-0.5">
          {canManage ? (
            <>
              <h1 className="sr-only">{name}</h1>
              <label htmlFor="team-name" className="sr-only">
                Team name
              </label>
              <input
                id="team-name"
                key={`name-${name}`}
                defaultValue={name}
                maxLength={100}
                onBlur={(e) => saveName(e.currentTarget)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    e.currentTarget.value = name;
                    e.currentTarget.blur();
                  }
                }}
                className={`${HEADER_TITLE_INPUT} field-sizing-content min-w-24 max-w-full`}
              />
            </>
          ) : (
            <h1 className="min-w-0 truncate px-1.5 text-xl font-semibold tracking-tight text-zinc-900">{name}</h1>
          )}
          <TeamMenu teamId={teamId} name={name} canManage={canManage} isDefault={isDefault} />
          {isDefault ? (
            <span
              className="chip ml-1.5 hidden bg-accent-50 text-accent-700 sm:inline-flex"
              data-tooltip="New members of the workspace join this team automatically"
            >
              Default team
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2 print:hidden">
          <MemberStack members={members} href={membersHref} />
          {canManage ? (
            <Link
              href={`${membersHref}#add-member`}
              onClick={(e) => {
                // Already on Members: just move to the person picker.
                const picker = document.getElementById(ADD_TEAM_MEMBER_ID);
                if (pathname === membersHref && picker) {
                  e.preventDefault();
                  picker.focus();
                }
              }}
              className="btn-primary h-7 px-3"
            >
              <UserPlus className="size-3.5" aria-hidden />
              Add members
            </Link>
          ) : null}
        </div>
      </div>

      <nav aria-label="Team" className="tab-strip -mx-gutter mt-1 items-center gap-0.5 px-gutter print:hidden">
        {TEAM_TABS.map(({ key, label }) => {
          const href = teamTabHref(teamId, key);
          const Icon = TAB_ICONS[key];
          const active = key === "overview" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
          const requests = key === "members" ? requestCount : 0;
          return (
            <Link key={key} href={href} aria-current={active ? "page" : undefined} className={HEADER_TAB}>
              <Icon className="size-3.5" aria-hidden />
              {label}
              {requests > 0 ? (
                <span
                  className="ml-0.5 rounded-full bg-amber-100 px-1.5 text-2xs font-semibold tabular-nums text-amber-800"
                  data-tooltip={requests === 1 ? "1 person asked to join" : `${requests} people asked to join`}
                >
                  {requests}
                  <span className="sr-only">{requests === 1 ? " person asked to join" : " people asked to join"}</span>
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

// Up to three avatars and a "+N" count; opens the Members tab.
function MemberStack({ members, href }: { members: HeaderMember[]; href: string }) {
  if (members.length === 0) return null;
  const shown = members.slice(0, 3);
  const more = members.length - shown.length;
  const names = shown.map((m) => m.name).join(", ");
  return (
    <Link
      href={href}
      aria-label={`${members.length} ${members.length === 1 ? "member" : "members"}: ${names}${more ? ` and ${more} more` : ""}. View members`}
      data-tooltip="View members"
      className="hidden items-center rounded-full p-0.5 hover:bg-zinc-100 md:inline-flex"
    >
      <span className="flex -space-x-1">
        {shown.map((m) => (
          <span key={m.profileId} className="rounded-full ring-2 ring-white">
            <Avatar name={m.name} profileId={m.profileId} size="md" />
          </span>
        ))}
      </span>
      {more > 0 ? <span className="ml-1 pr-1.5 text-xs font-medium tabular-nums text-zinc-600">+{more}</span> : null}
    </Link>
  );
}

function TeamMenu({
  teamId,
  name,
  canManage,
  isDefault,
}: {
  teamId: string;
  name: string;
  canManage: boolean;
  isDefault: boolean;
}) {
  const notify = useNotify();
  const [pending, run] = useServerAction();
  const confirm = useConfirm();

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/teams/${teamId}`);
      notify("Team link copied");
    } catch {
      notify("Couldn’t copy the link");
    }
  }

  return (
    <Popover
      label="Team actions"
      tooltip="Team actions"
      panelClassName="w-60 p-1.5"
      buttonClassName="btn-icon size-7 shrink-0 print:hidden"
      button={<MoreHorizontal className="size-4" aria-hidden />}
    >
      {(close) => (
        <>
          <MenuItem
            onClick={() => {
              close();
              void copyLink();
            }}
          >
            <Link2 className="size-4 text-zinc-500" /> Copy team link
          </MenuItem>
          {canManage ? (
            <>
              <div role="separator" className="my-1 border-t border-zinc-100" />
              <MenuItem
                danger
                disabled={pending || isDefault}
                onClick={async () => {
                  close();
                  if (
                    await confirm({
                      title: `Delete ${name}?`,
                      message:
                        "Its projects move to the default team and become private, project memberships stay as they are, and its goals keep working without a team.",
                      confirmLabel: "Delete team",
                      tone: "danger",
                    })
                  ) {
                    run(() => deleteTeam(teamId));
                  }
                }}
              >
                <Trash2 className="size-4" /> Delete team
              </MenuItem>
              {isDefault ? (
                <p className="px-2 pb-1 text-xs text-zinc-500">
                  The workspace’s default team can’t be deleted. A workspace admin can pick another default team first.
                </p>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </Popover>
  );
}
