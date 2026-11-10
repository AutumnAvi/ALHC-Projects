"use client";

import Link from "next/link";
import { useRef, useState, type KeyboardEvent } from "react";
import { ArrowUpRight, Webhook } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { Segmented } from "@/components/project/view-chrome";
import { CalendarSyncSettings } from "@/components/settings/calendar-sync";
import { EmailDigestSettings } from "@/components/settings/email-digest-settings";
import { EmailForwardingSection } from "@/components/settings/email-forwarding";
import { MyWorkdays } from "@/components/settings/my-workdays";
import {
  InboxNotifications,
  NotificationMatrix,
  NotificationSettings,
} from "@/components/settings/notification-settings";
import { useShell } from "@/components/shell/shell-context";
import { setPaneExpanded, usePaneExpanded } from "@/components/task/pane-size";
import { useNotify, useServerAction } from "@/components/toast";
import { Skeleton } from "@/components/ui";
import { removeMyAvatar, setOpenPersonalView, updateMyProfile, uploadMyAvatar } from "@/lib/actions/me";
import { setMyTasksChecked } from "@/lib/actions/my-tasks";
import type { MySettings } from "@alhc/core/api/me/model";
import type { MyTasksLayout } from "@alhc/core/my-tasks";
import { saveMyTasksLayout } from "@/lib/my-tasks-cookie";
import { CHECKED_MODE_OPTIONS, type CheckedMode } from "@alhc/core/checklist";
import { AVATAR_ACCEPT, MAX_PROFILE_NAME, avatarFileProblem, profileNameProblem } from "@alhc/core/profile";
import { projectColorClass } from "@/lib/project-colors";
import { SETTINGS_TABS, type EmailSetup, type SettingsTab } from "@alhc/core/shell";
import { describeWorkWeek } from "@alhc/core/workdays";
import { ONLY_ADMINS_NOTE, WORKSPACE_ROLE_LABELS } from "@alhc/core/workspace";
import { useTagsEnabled } from "@/components/tags/tags-enabled";
import { BRAND_SENDER_NAME } from "@/lib/email-design";

export type SettingsData = { me: MySettings; email: EmailSetup };

// The Settings modal's tabs (Asana's "My settings"): Profile, Notifications, Email forwarding, Calendar
// sync, Account, Display, across the top. ←/→, Home, and End move between tabs (ARIA tabs); the modal focuses the open
// tab first (Dialog looks for data-autofocus).
export function SettingsPanel({
  data,
  tab,
  onTabChange,
  onRetry,
}: {
  // null while the modal is loading it.
  data: SettingsData | null;
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  // Loads the settings again (a part that didn't load says "Try again").
  onRetry?: () => void;
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
          data.me.notifications ? (
            <div className="flex flex-col gap-8">
              {/* Nov 1 notes (batch 11): the email digest first, where people look for it. */}
              {data.me.emailPreferences ? (
                <div className="rounded-lg border border-zinc-200 p-4">
                  <EmailDigestSettings
                    email={data.me.email}
                    preferences={data.me.emailPreferences}
                    sending={data.email.sending}
                    workWeek={data.me.workWeek}
                  />
                </div>
              ) : (
                <LoadFailed what="the email digest settings" onRetry={onRetry} />
              )}
              <NotificationMatrix
                email={data.me.email}
                settings={{
                  ...data.me.notifications,
                  comment: { ...data.me.notifications.comment, email: commentEmails ?? data.me.emailComments },
                }}
                onCommentEmailChange={setCommentEmails}
                sending={data.email.sending}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              <NotificationSettings
                email={data.me.email}
                enabled={commentEmails ?? data.me.emailComments}
                onEnabledChange={setCommentEmails}
                sending={data.email.sending}
              />
              <InboxNotifications />
            </div>
          )
        ) : tab === "email_forwarding" ? (
          <EmailForwardingTab email={data.email} myEmail={data.me.email} onRetry={onRetry} />
        ) : tab === "calendar" ? (
          <CalendarSyncSettings />
        ) : tab === "account" ? (
          <AccountTab data={data.me} />
        ) : tab === "workspace" ? (
          <WorkspaceTab data={data.me} />
        ) : (
          <DisplayTab data={data.me} onRetry={onRetry} />
        )}
      </div>
    </div>
  );
}

// A part of the modal that didn't load (Nov 10 audit, C29): plain words and a way to try again.
export function LoadFailed({ what, onRetry }: { what?: string; onRetry?: () => void }) {
  return (
    <p role="alert" className="text-xs text-zinc-500">
      Couldn’t load {what ?? "this"}.{" "}
      {onRetry ? (
        <button type="button" onClick={onRetry} className="font-medium text-accent-700 hover:underline">
          Try again
        </button>
      ) : (
        "Close Settings and try again."
      )}
    </p>
  );
}

const ROW = "grid gap-x-6 gap-y-1 py-2.5 sm:grid-cols-[9rem_1fr]";
const TERM = "text-sm text-zinc-500";
const HEADING = "text-sm font-semibold text-zinc-900";
const CARD = "rounded-lg border border-zinc-200 px-4 py-3";

function ProfileTab({ data }: { data: MySettings }) {
  const role = data.isWorkspaceAdmin ? "admin" : "member";
  // Saved here, so the tab keeps showing them (the modal's data was loaded when it opened).
  const [savedName, setSavedName] = useState(data.fullName ?? "");
  const [avatarUrl, setAvatarUrl] = useState(data.avatarUrl);
  const shownName = savedName.trim() || data.name;
  return (
    <div>
      <div className="flex items-start gap-4">
        <ProfilePicture name={shownName} url={avatarUrl} onChange={setAvatarUrl} />
        <div className="min-w-0 flex-1">
          <ProfileName initial={data.fullName ?? ""} fallback={data.name} onSaved={setSavedName} />
          <p className="mt-1 truncate text-sm text-zinc-500">{data.email}</p>
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
        {data.personalWorkWeek !== undefined ? (
          <div className={ROW}>
            <dt className={TERM}>My workdays</dt>
            <dd>
              <MyWorkdays own={data.personalWorkWeek} organization={data.workWeek} />
            </dd>
          </div>
        ) : null}
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
        Everyone in the workspace sees your name and picture.{" "}
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

// Your name: edited in place, saved with Save (or Enter); Escape puts the saved one back.
function ProfileName({
  initial,
  fallback,
  onSaved,
}: {
  initial: string;
  fallback: string;
  onSaved: (name: string) => void;
}) {
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial || fallback);
  const [pending, runAction] = useServerAction();
  const trimmed = draft.trim();
  const problem = draft === (saved || fallback) ? null : profileNameProblem(trimmed);
  const changed = trimmed !== (saved || fallback).trim();

  function save() {
    if (!changed || problem) return;
    runAction(async () => {
      const result = await updateMyProfile({ fullName: trimmed });
      if (!result.error) {
        setSaved(trimmed);
        setDraft(trimmed);
        onSaved(trimmed);
      }
      return result;
    });
  }

  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <label htmlFor="profile-name" className="text-xs font-medium text-zinc-500">
        Your name
      </label>
      <div className="flex items-center gap-2">
        <input
          id="profile-name"
          value={draft}
          maxLength={MAX_PROFILE_NAME + 20}
          autoComplete="name"
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? "profile-name-problem" : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && changed) {
              event.preventDefault();
              event.stopPropagation();
              setDraft(saved || fallback);
            }
          }}
          className="field min-w-0 flex-1 text-base font-semibold text-zinc-900"
        />
        <button type="submit" disabled={!changed || Boolean(problem) || pending} className="btn-primary">
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
      {problem ? (
        <p id="profile-name-problem" className="text-xs text-red-600">
          {problem}
        </p>
      ) : null}
    </form>
  );
}

// Your picture: Upload (or Change) a PNG / JPEG / WebP / GIF up to 2 MB, or Remove it.
function ProfilePicture({
  name,
  url,
  onChange,
}: {
  name: string;
  url: string | null;
  onChange: (url: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const notify = useNotify();
  const [pending, runAction] = useServerAction();

  function upload(file: File) {
    const problem = avatarFileProblem(file);
    if (problem) {
      notify(problem);
      return;
    }
    const form = new FormData();
    form.set("file", file);
    runAction(async () => {
      const result = await uploadMyAvatar(form);
      if (!result.error && result.avatarUrl) onChange(result.avatarUrl);
      return result;
    });
  }

  return (
    <div className="flex shrink-0 flex-col items-center gap-1.5">
      <Avatar name={name} src={url} size="xl" />
      <input
        ref={inputRef}
        type="file"
        accept={AVATAR_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) upload(file);
        }}
      />
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={pending}
          onClick={() => inputRef.current?.click()}
          className="btn-ghost h-6 px-1.5 text-xs"
        >
          {pending ? "Saving…" : url ? "Change" : "Upload"}
          <span className="sr-only"> profile picture</span>
        </button>
        {url ? (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              runAction(async () => {
                const result = await removeMyAvatar();
                if (!result.error) onChange(null);
                return result;
              })
            }
            className="btn-ghost h-6 px-1.5 text-xs text-zinc-500 hover:text-red-600"
          >
            Remove
            <span className="sr-only"> profile picture</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

// Email forwarding (Real features 1): the person's forwarding address, then the other way in from outside
// (a project's inbound webhooks). Replies to comment emails aren't read (only a form's submitter can reply
// by email), so nothing here promises them (Nov 10 audit, C3).
function EmailForwardingTab({ email, myEmail, onRetry }: { email: EmailSetup; myEmail: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col gap-6">
      <EmailForwardingSection forwarding={email.forwarding} myEmail={myEmail} onRetry={onRetry} />

      <section aria-labelledby="works-today-heading">
        <h3 id="works-today-heading" className={HEADING}>
          More ways in
        </h3>
        <div className="mt-2 flex flex-col gap-3">
          <div className={`${CARD} flex items-start gap-3`}>
            <Webhook aria-hidden className="mt-0.5 size-4 shrink-0 text-zinc-400" />
            <div className="min-w-0 flex-1">
              <h4 className="text-sm font-medium text-zinc-900">Create tasks from other tools</h4>
              <p className="mt-0.5 text-sm text-zinc-600">
                Forms, scripts, and automation services that can send an HTTPS request can add tasks to a project
                through an inbound webhook. A project’s Owner sets them up under Customize → Apps → Inbound webhooks.
              </p>
              {email.inboundProjects.length === 0 ? (
                <p className="mt-1.5 text-sm text-zinc-500">You don’t own a project, so ask a project’s Owner to set one up.</p>
              ) : (
                <>
                  <p className="mt-2 text-xs font-medium text-zinc-500">Projects you own</p>
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
          <dd className="text-sm text-zinc-900">
            {data.signInMethod === "google" ? (
              "Google"
            ) : (
              <>
                Email and password{" · "}
                <Link href="/reset-password" className="text-accent-700 hover:underline">
                  Change password
                </Link>
              </>
            )}
          </dd>
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

// Settings → Workspace (Nov 3 notes, batch 19): what the workspace's admins set, read-only for everyone
// else, with the full read-only pages (members, teams, tags) one click away; admins change it all in the
// Admin console.
function WorkspaceTab({ data }: { data: MySettings }) {
  const tagsOn = useTagsEnabled();
  return (
    <div>
      <dl className="-mt-3 divide-y divide-zinc-100 border-b border-zinc-100">
        <div className={ROW}>
          <dt className={TERM}>Workspace name</dt>
          <dd className="flex items-center gap-2 text-sm text-zinc-900">
            {data.workspaceLogoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- public Storage URL
              <img src={data.workspaceLogoUrl} alt="" className="size-6 rounded object-contain" />
            ) : null}
            {data.workspaceName}
          </dd>
        </div>
        <div className={ROW}>
          <dt className={TERM}>Default team</dt>
          <dd className="text-sm text-zinc-900">{data.defaultTeamName ?? "—"}</dd>
        </div>
        <div className={ROW}>
          <dt className={TERM}>Email sender name</dt>
          <dd className="text-sm text-zinc-900">
            {data.emailSenderName ?? (
              <>
                Not set <span className="text-zinc-500">(requester emails come from “{BRAND_SENDER_NAME}”)</span>
              </>
            )}
          </dd>
        </div>
        <div className={ROW}>
          <dt className={TERM}>Workweek</dt>
          <dd className="text-sm text-zinc-900">{describeWorkWeek(data.workWeek)}</dd>
        </div>
        <div className={ROW}>
          <dt className={TERM}>Your role</dt>
          <dd className="text-sm text-zinc-900">{data.isWorkspaceAdmin ? "Workspace admin" : "Member"}</dd>
        </div>
      </dl>
      {data.isWorkspaceAdmin ? (
        <p className="mt-3 text-xs text-zinc-500">
          You’re a workspace admin. Change these in the Admin console:{" "}
          <Link href="/admin/organization" className="text-accent-700 hover:underline">
            Organization
          </Link>{" "}
          (name, team, workweek) and{" "}
          <Link href="/admin/email" className="text-accent-700 hover:underline">
            Email delivery
          </Link>{" "}
          (sender name).
        </p>
      ) : (
        <p className="mt-3 text-xs text-zinc-500">
          {ONLY_ADMINS_NOTE}{" "}
          <Link href="/settings/workspace" className="text-accent-700 hover:underline">
            {tagsOn ? "See members, teams, and tags" : "See members and teams"}
          </Link>
        </p>
      )}
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
  { value: "checklist", label: "Checklist" },
  { value: "sections", label: "Sections" },
  { value: "due", label: "Due dates" },
] as const;

// Display preferences live in this browser (the sidebar and My tasks in cookies, the pane in storage).
function DisplayTab({ data, onRetry }: { data: MySettings; onRetry?: () => void }) {
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
                saveMyTasksLayout(value);
              }}
            />
          </dd>
        </div>
        <CheckedItemsRow saved={data.myTasksChecked} />
        <OpenPersonalViewRow saved={data.openPersonalView} onRetry={onRetry} />
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
      <p className="mt-3 text-xs text-zinc-500">
        Display settings are saved in this browser, except “Checked tasks” and “Open my saved view by default”, which follow you everywhere.
      </p>
    </div>
  );
}

// Nov 1 notes (batch 9b): what checking off a task on My tasks (and Home's Today) does. Saved on your
// account; the checklist's own options menu changes the same setting.
function CheckedItemsRow({ saved }: { saved: CheckedMode }) {
  const [pending, run] = useServerAction();
  const [mode, setMode] = useState<CheckedMode>(saved);
  return (
    <div className={`${ROW} items-center`}>
      <dt className={TERM}>Checked tasks</dt>
      <dd>
        <Segmented
          label="Checked tasks"
          options={CHECKED_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          value={mode}
          onChange={(value) => {
            if (pending || value === mode) return;
            const previous = mode;
            setMode(value);
            run(async () => {
              const result = await setMyTasksChecked(value);
              if (result.error) setMode(previous);
              return result;
            });
          }}
        />
        <p className="mt-1 text-xs text-zinc-500">
          {CHECKED_MODE_OPTIONS.find((o) => o.value === mode)?.description} Clears overnight. Saved on your account.
        </p>
      </dd>
    </div>
  );
}

// Oct 26 notes (batch 4): open a project on your own saved view (when you have one there) instead of the
// project's default view. Saved on your account.
function OpenPersonalViewRow({ saved, onRetry }: { saved: boolean | null; onRetry?: () => void }) {
  const [pending, run] = useServerAction();
  const [on, setOn] = useState(Boolean(saved));
  return (
    <div className={`${ROW} items-center`}>
      <dt className={TERM}>Projects open on</dt>
      <dd>
        <label className="flex items-center gap-2 text-sm text-zinc-900">
          <input
            type="checkbox"
            className="size-3.5 accent-accent-600"
            checked={on}
            disabled={saved === null || pending}
            onChange={(e) => {
              const next = e.currentTarget.checked;
              setOn(next);
              run(async () => {
                const result = await setOpenPersonalView(next);
                if (result.error) setOn(!next);
                return result;
              });
            }}
          />
          Open my saved view by default
        </label>
        {saved === null ? (
          <div className="mt-1">
            <LoadFailed what="this setting" onRetry={onRetry} />
          </div>
        ) : (
          <p className="mt-1 text-xs text-zinc-500">
            When you’ve saved a view of your own in a project, it opens first. Otherwise the project’s default view does.
          </p>
        )}
      </dd>
    </div>
  );
}
