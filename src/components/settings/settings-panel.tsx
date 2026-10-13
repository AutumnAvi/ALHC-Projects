"use client";

import Link from "next/link";
import { useState, type KeyboardEvent } from "react";
import { ArrowUpRight, Reply, Webhook } from "lucide-react";
import { Segmented } from "@/components/project/view-chrome";
import { EmailForwardingSection } from "@/components/settings/email-forwarding";
import { InboxNotifications, NotificationSettings } from "@/components/settings/notification-settings";
import { useShell } from "@/components/shell/shell-context";
import { setPaneExpanded, usePaneExpanded } from "@/components/task/pane-size";
import { Skeleton } from "@/components/ui";
import type { MySettings } from "@/lib/data";
import { MY_TASKS_LAYOUT_COOKIE, type MyTasksLayout } from "@/lib/my-tasks";
import { projectColorClass } from "@/lib/project-colors";
import { SETTINGS_TABS, type EmailSetup, type SettingsTab } from "@/lib/shell";
import { WORKSPACE_ROLE_LABELS } from "@/lib/workspace";

export type SettingsData = { me: MySettings; email: EmailSetup };

// The Settings modal's tabs (Asana's "My settings"): Profile, Notifications, Email forwarding, Account,
// Display, across the top. ←/→, Home, and End move between tabs (ARIA tabs); the modal focuses the open
// tab first (Dialog looks for data-autofocus).
export function SettingsPanel({
  data,
  tab,
  onTabChange,
}: {
  // null while the modal is loading it.
  data: SettingsData | null;
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
}) {
  const { closeDialog } = useShell();
  // "Email me about comments" once changed here (Notifications), so Email forwarding agrees with it.
  const [commentEmails, setCommentEmails] = useState<boolean | null>(null);

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    const index = SETTINGS_TABS.findIndex((t) => t.key === tab);
    const last = SETTINGS_TABS.length - 1;
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % SETTINGS_TABS.length
        : event.key === "ArrowLeft"
          ? (index + last) % SETTINGS_TABS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    onTabChange(SETTINGS_TABS[next].key);
    document.getElementById(`settings-tab-${SETTINGS_TABS[next].key}`)?.focus();
  }

  return (
    <div>
      <div role="tablist" aria-label="Settings" className="tab-strip gap-1">
        {SETTINGS_TABS.map((t) => {
          const selected = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`settings-tab-${t.key}`}
              aria-selected={selected}
              aria-controls={`settings-panel-${t.key}`}
              tabIndex={selected ? 0 : -1}
              data-autofocus={selected || undefined}
              onClick={() => onTabChange(t.key)}
              onKeyDown={onTabKey}
              className="shrink-0 border-b-2 border-transparent px-2.5 pb-2 text-sm text-zinc-500 hover:text-zinc-900 aria-selected:border-accent-500 aria-selected:font-medium aria-selected:text-zinc-900"
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {/* A steady height, so switching tabs doesn't make the modal jump. Following a link closes the modal:
          the shell only does that on a new page, and a link can lead to the page it was opened on. */}
      <div
        role="tabpanel"
        id={`settings-panel-${tab}`}
        aria-labelledby={`settings-tab-${tab}`}
        className="min-h-88 pt-4"
        onClick={(event) => {
          const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
          if (!modified && (event.target as Element).closest("a[href]")) closeDialog();
        }}
      >
        {!data ? (
          <div role="status" className="flex flex-col gap-3">
            <span className="sr-only">Loading your settings…</span>
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        ) : tab === "profile" ? (
          <ProfileTab data={data.me} />
        ) : tab === "notifications" ? (
          <div className="flex flex-col gap-6">
            <NotificationSettings
              email={data.me.email}
              enabled={commentEmails ?? data.me.emailComments}
              onEnabledChange={setCommentEmails}
              sending={data.email.sending}
              replyByEmail={data.email.replyByEmail}
            />
            <InboxNotifications />
          </div>
        ) : tab === "email_forwarding" ? (
          <EmailForwardingTab
            email={data.email}
            myEmail={data.me.email}
            commentEmails={commentEmails ?? data.me.emailComments}
            onTabChange={onTabChange}
          />
        ) : tab === "account" ? (
          <AccountTab data={data.me} />
        ) : (
          <DisplayTab data={data.me} />
        )}
      </div>
    </div>
  );
}

const ROW = "grid gap-x-6 gap-y-1 py-2.5 sm:grid-cols-[9rem_1fr]";
const TERM = "text-sm text-zinc-500";
const HEADING = "text-sm font-semibold text-zinc-900";
const CARD = "rounded-lg border border-zinc-200 px-4 py-3";

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
        {data.isWorkspaceAdmin ? (
          <Link href="/admin" className="text-accent-700 hover:underline">
            Open the admin console
          </Link>
        ) : (
          <Link href="/settings/workspace" className="text-accent-700 hover:underline">
            View workspace settings
          </Link>
        )}
      </p>
    </div>
  );
}

// Email forwarding (Real features 1): the person's forwarding address, then the other email-ish ways in
// (replying to a comment email, and a project's inbound webhooks).
function EmailForwardingTab({
  email,
  myEmail,
  commentEmails,
  onTabChange,
}: {
  email: EmailSetup;
  myEmail: string;
  commentEmails: boolean;
  onTabChange: (tab: SettingsTab) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <EmailForwardingSection forwarding={email.forwarding} myEmail={myEmail} />

      <section aria-labelledby="works-today-heading">
        <h3 id="works-today-heading" className={HEADING}>
          More ways in by email
        </h3>
        <div className="mt-2 flex flex-col gap-3">
          <div className={`${CARD} flex items-start gap-3`}>
            <Reply aria-hidden className="mt-0.5 size-4 shrink-0 text-zinc-400" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-medium text-zinc-900">Reply to comment emails</h4>
                <span className={`chip ${email.replyByEmail ? "bg-green-50 text-green-700" : ""}`}>
                  {email.replyByEmail ? "On" : "Off"}
                </span>
              </div>
              <p className="mt-0.5 text-sm text-zinc-600">
                {email.replyByEmail
                  ? "Reply to an email about a comment on a task you follow, and your reply is posted on the task as a comment from you. Only the text above the quoted message is posted, and only while you can still comment on the task."
                  : email.sending
                    ? "Replies to comment emails aren’t set up for this workspace, so open the task from the email to comment."
                    : "Emails aren’t sent from this workspace yet (no email provider is set up), so there are no comment emails to reply to."}
              </p>
              {email.replyByEmail && !commentEmails ? (
                <p className="mt-1.5 text-sm text-zinc-600">
                  Your comment emails are off, so there’s nothing to reply to.{" "}
                  <button
                    type="button"
                    onClick={() => onTabChange("notifications")}
                    className="text-accent-700 hover:underline"
                  >
                    Turn them on in Notifications
                  </button>
                </p>
              ) : null}
            </div>
          </div>

          <div className={`${CARD} flex items-start gap-3`}>
            <Webhook aria-hidden className="mt-0.5 size-4 shrink-0 text-zinc-400" />
            <div className="min-w-0 flex-1">
              <h4 className="text-sm font-medium text-zinc-900">Create tasks from other tools</h4>
              <p className="mt-0.5 text-sm text-zinc-600">
                Forms, scripts, and automation services that can send an HTTPS request can add tasks to a project
                through an inbound webhook. A project’s admins set them up under Customize → Apps → Inbound webhooks.
              </p>
              {email.inboundProjects.length === 0 ? (
                <p className="mt-1.5 text-sm text-zinc-500">
                  You don’t administer any project, so ask a project’s admin to set one up.
                </p>
              ) : (
                <>
                  <p className="mt-2 text-xs font-medium text-zinc-500">Projects you administer</p>
                  <ul className="mt-1 max-h-44 overflow-y-auto">
                    {email.inboundProjects.map((project) => (
                      <li key={project.id}>
                        <Link
                          href={`/projects/${project.id}/settings/inbound`}
                          className="group flex items-center gap-2 rounded-md px-1.5 py-1 text-sm text-zinc-800 hover:bg-zinc-50"
                        >
                          <span aria-hidden className={`size-3 shrink-0 rounded-[3px] ${projectColorClass(project.id)}`} />
                          <span className="min-w-0 flex-1 truncate">{project.name}</span>
                          <span className="shrink-0 text-xs text-zinc-500 group-hover:text-accent-700">
                            Inbound webhooks
                          </span>
                          <ArrowUpRight aria-hidden className="size-3.5 shrink-0 text-zinc-400" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function AccountTab({ data }: { data: MySettings }) {
  // The modal only ever renders in the browser, so the day is the viewer's own.
  const joined = data.joinedAt ? new Date(data.joinedAt).toLocaleDateString("en-US", { dateStyle: "medium" }) : null;
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
  // The modal only ever renders in the browser, so this is the zone the tz cookie carries.
  const [timeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);

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
        <div className={ROW}>
          <dt className={TERM}>Time zone</dt>
          <dd>
            <p className="text-sm text-zinc-900">{timeZone.replaceAll("_", " ")}</p>
            <p className="mt-1 text-xs text-zinc-500">
              From this browser. “Today”, “Overdue”, and times on tasks follow it.
            </p>
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-zinc-500">Display settings are saved in this browser.</p>
    </div>
  );
}
