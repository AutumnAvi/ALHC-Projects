"use client";

import Link from "next/link";
import { useState } from "react";
import { Segmented } from "@/components/project/view-chrome";
import { NotificationSettings } from "@/components/settings/profile-settings";
import { useShell } from "@/components/shell/shell-context";
import { setPaneExpanded, usePaneExpanded } from "@/components/task/pane-size";
import { Skeleton } from "@/components/ui";
import type { MySettings } from "@/lib/data";
import { MY_TASKS_LAYOUT_COOKIE, type MyTasksLayout } from "@/lib/my-tasks";
import { SETTINGS_TABS, type SettingsTab } from "@/lib/shell";
import { WORKSPACE_ROLE_LABELS } from "@/lib/workspace";

// The Settings tabs (Asana's "My settings"): Profile, Notifications, Account, Display. Shown in the
// modal from the avatar menu and on /settings/profile (links from emails land there).
export function SettingsPanel({
  data,
  tab,
  onTabChange,
}: {
  // null while the modal is loading it.
  data: MySettings | null;
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
}) {
  return (
    <div>
      <div role="tablist" aria-label="Settings" className="tab-strip gap-1">
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`settings-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`settings-panel-${t.key}`}
            onClick={() => onTabChange(t.key)}
            className="shrink-0 border-b-2 border-transparent px-2.5 pb-2 text-sm text-zinc-500 hover:text-zinc-900 aria-selected:border-accent-500 aria-selected:font-medium aria-selected:text-zinc-900"
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`} className="pt-4">
        {!data ? (
          <div role="status" className="flex flex-col gap-3">
            <span className="sr-only">Loading your settings…</span>
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        ) : tab === "profile" ? (
          <ProfileTab data={data} />
        ) : tab === "notifications" ? (
          <NotificationSettings email={data.email} emailComments={data.emailComments} />
        ) : tab === "account" ? (
          <AccountTab data={data} />
        ) : (
          <DisplayTab data={data} />
        )}
      </div>
    </div>
  );
}

const ROW = "grid gap-x-6 gap-y-1 py-2.5 sm:grid-cols-[9rem_1fr]";
const TERM = "text-sm text-zinc-500";

function initials(name: string) {
  const parts = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

function ProfileTab({ data }: { data: MySettings }) {
  const role = data.isWorkspaceAdmin ? "admin" : "member";
  return (
    <div>
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="flex size-14 shrink-0 items-center justify-center rounded-full bg-accent-100 text-lg font-semibold text-accent-700"
        >
          {initials(data.name)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold text-zinc-900">{data.name}</p>
          <p className="truncate text-sm text-zinc-500">{data.email}</p>
        </div>
      </div>
      <dl className="mt-4 divide-y divide-zinc-100 border-y border-zinc-100">
        <div className={ROW}>
          <dt className={TERM}>Workspace</dt>
          <dd className="text-sm text-zinc-900">{data.workspaceName}</dd>
        </div>
        <div className={ROW}>
          <dt className={TERM}>Workspace role</dt>
          <dd>
            <span className={`chip ${data.isWorkspaceAdmin ? "bg-accent-50 text-accent-700" : ""}`}>
              {WORKSPACE_ROLE_LABELS[role]}
            </span>
            <p className="mt-1 text-xs text-zinc-500">
              {data.isWorkspaceAdmin
                ? "You manage members, teams, and workspace settings. Private projects still need an invite."
                : "Workspace admins manage members, teams, and workspace settings."}
            </p>
          </dd>
        </div>
        <div className={ROW}>
          <dt className={TERM}>Teams</dt>
          <dd className="flex flex-wrap gap-1">
            {data.teams.length === 0 ? (
              <span className="text-sm text-zinc-500">Not on a team yet</span>
            ) : (
              data.teams.map((team) => (
                <Link key={team.id} href={`/teams/${team.id}`} className="chip hover:bg-zinc-200">
                  {team.name}
                  {team.lead ? " · Lead" : ""}
                </Link>
              ))
            )}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-zinc-500">
        Your name comes from your sign-in account.{" "}
        <Link href="/settings/workspace" className="text-accent-700 hover:underline">
          {data.isWorkspaceAdmin ? "Open the admin console" : "View workspace settings"}
        </Link>
      </p>
    </div>
  );
}

function AccountTab({ data }: { data: MySettings }) {
  const joined = data.joinedAt
    ? new Date(data.joinedAt).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" })
    : null;
  return (
    <div>
      <dl className="-mt-3 divide-y divide-zinc-100 border-b border-zinc-100">
        <div className={ROW}>
          <dt className={TERM}>Email</dt>
          <dd className="text-sm text-zinc-900">{data.email}</dd>
        </div>
        <div className={ROW}>
          <dt className={TERM}>Signs in with</dt>
          <dd className="text-sm text-zinc-900">{data.signInMethod === "google" ? "Google" : "Email and password"}</dd>
        </div>
        <div className={ROW}>
          <dt className={TERM}>Member since</dt>
          <dd className="text-sm text-zinc-900">{joined ?? "—"}</dd>
        </div>
      </dl>
      <form action="/auth/signout" method="post" className="mt-4">
        <button type="submit" className="btn-secondary">
          Log out
        </button>
      </form>
    </div>
  );
}

const SIDEBAR_OPTIONS = [
  { value: "shown", label: "Shown" },
  { value: "hidden", label: "Hidden" },
] as const;
const PANE_OPTIONS = [
  { value: "compact", label: "Side pane" },
  { value: "expanded", label: "Full screen" },
] as const;
const MY_TASKS_OPTIONS = [
  { value: "sections", label: "Sections" },
  { value: "due", label: "Due dates" },
] as const;

// Display preferences live in this browser (the sidebar and My tasks in cookies, the pane in storage).
function DisplayTab({ data }: { data: MySettings }) {
  const { sidebar, setSidebarCollapsed } = useShell();
  const expanded = usePaneExpanded();
  const [myTasks, setMyTasks] = useState<MyTasksLayout>(data.myTasksLayout);

  return (
    <div>
      <dl className="-mt-3 divide-y divide-zinc-100 border-b border-zinc-100">
        <div className={`${ROW} items-center`}>
          <dt className={TERM}>Sidebar</dt>
          <dd>
            <Segmented
              label="Sidebar"
              options={SIDEBAR_OPTIONS}
              value={sidebar.collapsed ? "hidden" : "shown"}
              onChange={(value) => setSidebarCollapsed(value === "hidden")}
            />
            <p className="mt-1 text-xs text-zinc-500">On wide screens. The ☰ button in the top bar does the same.</p>
          </dd>
        </div>
        <div className={`${ROW} items-center`}>
          <dt className={TERM}>Task details open</dt>
          <dd>
            <Segmented
              label="Task details open"
              options={PANE_OPTIONS}
              value={expanded ? "expanded" : "compact"}
              onChange={(value) => setPaneExpanded(value === "expanded")}
            />
          </dd>
        </div>
        <div className={`${ROW} items-center`}>
          <dt className={TERM}>My tasks shows</dt>
          <dd>
            <Segmented
              label="My tasks shows"
              options={MY_TASKS_OPTIONS}
              value={myTasks}
              onChange={(value) => {
                setMyTasks(value);
                document.cookie = `${MY_TASKS_LAYOUT_COOKIE}=${value}; path=/; max-age=31536000; samesite=lax`;
              }}
            />
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-zinc-500">Display settings are saved in this browser.</p>
    </div>
  );
}
