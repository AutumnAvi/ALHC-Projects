"use client";

import {
  Briefcase,
  CircleCheck,
  FolderKanban,
  LogOut,
  Menu,
  MessageSquare,
  Plus,
  Settings,
  ShieldCheck,
  Target,
  UserPlus,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/avatar";
import { MenuItem, Popover } from "@/components/popover";
import { SearchPalette } from "@/components/shell/search-palette";
import { useShell } from "@/components/shell/shell-context";
import type { ShellDialog } from "@/lib/shell";

// The dark bar across the top of the app (Asana parity, batch 1): ☰ and "+ Create" on the left, search
// in the middle, the avatar menu on the right.
export function TopBar() {
  const { sidebar, setSidebarCollapsed, setDrawerOpen } = useShell();

  function toggleSidebar() {
    // Wide screens hide or show the sidebar column (remembered); narrow screens open it as a drawer.
    if (window.matchMedia("(min-width: 768px)").matches) setSidebarCollapsed(!sidebar.collapsed);
    else setDrawerOpen(true);
  }

  return (
    <header className="flex h-topbar shrink-0 items-center gap-2 bg-shell px-2 text-shell-text print:hidden">
      <div className="flex shrink-0 items-center gap-1.5 md:w-58">
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label="Show or hide the sidebar"
          aria-controls="app-sidebar"
          className="inline-flex size-8 items-center justify-center rounded-md text-shell-text hover:bg-shell-hover hover:text-white"
        >
          <Menu className="size-[18px]" />
        </button>
        <CreateMenu />
      </div>
      <div className="flex min-w-0 flex-1 justify-center">
        <SearchPalette />
      </div>
      <div className="flex shrink-0 items-center justify-end md:w-58">
        <AvatarMenu />
      </div>
    </header>
  );
}

// shortcut: the keys shown at the end of the item (Tab then Q opens the task dialog anywhere but a List
// view, where it adds a task in the current section, and Home, where it opens the My tasks widget's new
// row; the menu item itself always opens the dialog).
const CREATE_ITEMS: { kind: ShellDialog["kind"]; label: string; icon: LucideIcon; shortcut?: string[] }[] = [
  { kind: "task", label: "Task", icon: CircleCheck, shortcut: ["Tab", "Q"] },
  { kind: "project", label: "Project", icon: FolderKanban },
  { kind: "message", label: "Message", icon: MessageSquare },
  { kind: "team", label: "Team", icon: Users },
  { kind: "portfolio", label: "Portfolio", icon: Briefcase },
  { kind: "goal", label: "Goal", icon: Target },
];

function CreateMenu() {
  const { openDialog } = useShell();
  return (
    <Popover
      label="Create"
      panelClassName="w-56 p-1.5"
      buttonClassName="inline-flex h-7 items-center gap-1 rounded-full bg-coral pl-1.5 pr-1.5 text-sm font-medium text-shell hover:bg-coral-hover aria-expanded:bg-coral-hover sm:pr-3"
      button={
        <>
          <Plus className="size-4" strokeWidth={2.5} aria-hidden />
          <span className="max-sm:sr-only">Create</span>
        </>
      }
    >
      {(close) => (
        <>
          {CREATE_ITEMS.map(({ kind, label, icon: Icon, shortcut }) => (
            <MenuItem
              key={kind}
              onClick={() => {
                close();
                openDialog({ kind } as ShellDialog);
              }}
            >
              <Icon className="size-4 text-zinc-700" aria-hidden /> <span className="flex-1">{label}</span>
              {shortcut ? (
                <span className="flex items-center gap-0.5" aria-label={`Shortcut: ${shortcut.join(" then ")}`}>
                  {shortcut.map((key) => (
                    <kbd key={key} className="rounded border border-zinc-200 bg-zinc-50 px-1 font-sans text-2xs text-zinc-600">
                      {key}
                    </kbd>
                  ))}
                </span>
              ) : null}
            </MenuItem>
          ))}
          <hr className="my-1.5 border-zinc-100" />
          <MenuItem
            onClick={() => {
              close();
              openDialog({ kind: "invite" });
            }}
          >
            <UserPlus className="size-4 text-zinc-700" aria-hidden /> Invite
          </MenuItem>
        </>
      )}
    </Popover>
  );
}

// The person's name for the menu: their name, or the part of their email before @ when the account has
// no name (password sign-ups fall back to the address), so the email isn't shown twice.
function shownName(name: string, email: string) {
  const trimmed = name.trim();
  return trimmed && trimmed.toLowerCase() !== email.toLowerCase() && !trimmed.includes("@") ? trimmed : email.split("@")[0];
}

function AvatarMenu() {
  const router = useRouter();
  const { member, workspace, isWorkspaceAdmin, openDialog } = useShell();
  const name = shownName(member.name, member.email);
  return (
    <Popover
      label="Your account"
      align="end"
      panelClassName="w-72 p-1.5"
      buttonClassName="inline-flex size-8 items-center justify-center rounded-full hover:ring-2 hover:ring-white/20 aria-expanded:ring-2 aria-expanded:ring-white/30"
      button={<Avatar name={name} size="md" />}
    >
      {(close) => (
        <>
          <div className="flex items-center gap-2.5 px-2 py-2">
            <Avatar name={name} size="md" />
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-medium text-zinc-900">{name}</p>
              {/* The whole address, once: it wraps after the @ (or anywhere, if still too long). */}
              <p className="text-xs text-zinc-500 [overflow-wrap:anywhere]">
                {member.email.split("@")[0]}@<wbr />
                {member.email.split("@").slice(1).join("@")}
              </p>
            </div>
          </div>
          <div className="mx-2 mb-1.5 flex items-center gap-2 rounded-md bg-zinc-50 px-2 py-1.5 text-xs text-zinc-600">
            {workspace.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- public Storage URL
              <img src={workspace.logoUrl} alt="" className="size-5 shrink-0 rounded object-contain" />
            ) : (
              <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded bg-zinc-800 text-2xs font-semibold text-white">
                {workspace.name.slice(0, 1).toUpperCase() || "A"}
              </span>
            )}
            <span className="truncate">{workspace.name}</span>
          </div>
          <hr className="my-1 border-zinc-100" />
          <MenuItem
            onClick={() => {
              close();
              openDialog({ kind: "settings", tab: "profile" });
            }}
          >
            <UserRound className="size-4 text-zinc-500" aria-hidden /> Profile
          </MenuItem>
          <MenuItem
            onClick={() => {
              close();
              openDialog({ kind: "settings", tab: "profile" });
            }}
          >
            <Settings className="size-4 text-zinc-500" aria-hidden /> Settings
          </MenuItem>
          {isWorkspaceAdmin ? (
            <MenuItem
              onClick={() => {
                close();
                router.push("/admin");
              }}
            >
              <ShieldCheck className="size-4 text-zinc-500" aria-hidden /> Admin console
            </MenuItem>
          ) : null}
          <MenuItem
            onClick={() => {
              close();
              openDialog({ kind: "invite" });
            }}
          >
            <UserPlus className="size-4 text-zinc-500" aria-hidden /> Invite
          </MenuItem>
          <hr className="my-1 border-zinc-100" />
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100"
            >
              <LogOut className="size-4 text-zinc-500" aria-hidden /> Log out
            </button>
          </form>
        </>
      )}
    </Popover>
  );
}
