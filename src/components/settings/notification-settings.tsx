"use client";

import Link from "next/link";
import { useState } from "react";
import { useServerAction } from "@/components/toast";
import { setEmailComments, setNotificationSetting } from "@/lib/actions";
import {
  NOTIFICATION_KINDS,
  type NotificationChannel,
  type NotificationKind,
  type NotificationSettings,
} from "@/lib/notifications";

const HEADING = "text-sm font-semibold text-zinc-900";

// "Email me about comments" (a database without Real features 2; NotificationMatrix below replaces it):
// when on, a new comment on a task you follow is emailed to you (never your own, and only while you can
// open the task). Optimistic; the server action saves your own row only. The panel owns the value so
// Email forwarding sees a change made here.
export function NotificationSettings({
  email,
  enabled,
  onEnabledChange,
  sending,
  replyByEmail,
}: {
  email: string;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  // Whether emails go out from this workspace at all, and whether replies to them become comments.
  sending: boolean;
  replyByEmail: boolean;
}) {
  const [pending, run] = useServerAction();

  return (
    <section aria-labelledby="notifications-heading">
      <h3 id="notifications-heading" className={HEADING}>
        Email notifications
      </h3>
      <p className="mt-1 text-sm text-zinc-600">Sent to {email}. Your Inbox keeps every notification either way.</p>
      {sending ? null : (
        <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Emails aren’t sent from this workspace yet (no email provider is set up). Your choice is saved for when
          they are.
        </p>
      )}
      <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 px-4 py-3 hover:bg-zinc-50">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-accent-600"
          checked={enabled}
          disabled={pending}
          onChange={(event) => {
            const next = event.target.checked;
            const previous = enabled;
            onEnabledChange(next);
            run(async () => {
              const result = await setEmailComments(next);
              if (result.error) onEnabledChange(previous);
              return result;
            });
          }}
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-zinc-900">Email me about comments</span>
          <span className="mt-0.5 block text-sm text-zinc-600">
            When someone comments on a task you follow, email you the comment with an Open task link.
            {replyByEmail ? " Reply to the email to comment back." : ""} Turning this off also stops emails that are
            already queued.
          </span>
        </span>
      </label>
      <p className="mt-2 text-xs text-zinc-500">
        Emails from rules and forms, such as due date reminders or updates to a request you submitted, are set up by
        each project’s admins and aren’t affected by this switch.
      </p>
    </section>
  );
}

// What lands in the Inbox, on a database without Real features 2 (no per-kind switches there), so this
// says what to expect instead of showing controls that wouldn't do anything.
const INBOX_KINDS = [
  "Tasks assigned to you",
  "@mentions in comments and project messages",
  "Comments on tasks you follow, and when they’re completed",
  "Approval requests for you, and decisions on approvals of tasks you follow",
  "Replies in message threads you started or replied to",
  "Rules that notify you, and changes to fields set to “Notify followers when changed” on tasks you follow",
];

export function InboxNotifications() {
  return (
    <section aria-labelledby="inbox-notifications-heading">
      <h3 id="inbox-notifications-heading" className={HEADING}>
        Inbox
      </h3>
      <p className="mt-1 text-sm text-zinc-600">
        Your Inbox gets a notification for these, except for things you did yourself:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-700">
        {INBOX_KINDS.map((kind) => (
          <li key={kind}>{kind}</li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-zinc-500">
        Switches per kind need this release’s database update. To stop getting a task’s comments, leave it (Leave
        task, at the bottom of its pane).{" "}
        <Link href="/inbox" className="text-accent-700 hover:underline">
          Open Inbox
        </Link>
      </p>
    </section>
  );
}

// Settings → Notifications since Real features 2: an Inbox and an Email switch per kind. The database
// respects them (Inbox items of a kind turned off aren't stored; emails are queued only when wanted and
// checked again before they're sent). Optimistic; each switch saves on its own.
export function NotificationMatrix({
  email,
  settings,
  onCommentEmailChange,
  sending,
  replyByEmail,
}: {
  email: string;
  settings: NotificationSettings;
  // The comment email switch is also shown on Email forwarding (reply by email needs it).
  onCommentEmailChange: (enabled: boolean) => void;
  sending: boolean;
  replyByEmail: boolean;
}) {
  const [values, setValues] = useState(settings);
  const [pending, run] = useServerAction();

  function toggle(kind: NotificationKind, channel: NotificationChannel, next: boolean) {
    const previous = values;
    setValues({ ...values, [kind]: { ...values[kind], [channel]: next } });
    if (kind === "comment" && channel === "email") onCommentEmailChange(next);
    run(async () => {
      // Mention emails follow the comment email switch until they're set; pin them first so changing
      // one switch never moves the other.
      if (kind === "comment" && channel === "email") {
        const pinned = await setNotificationSetting("mention", "email", previous.mention.email);
        if (pinned.error) {
          setValues(previous);
          onCommentEmailChange(previous.comment.email);
          return pinned;
        }
      }
      const result = await setNotificationSetting(kind, channel, next);
      if (result.error) {
        setValues(previous);
        if (kind === "comment" && channel === "email") onCommentEmailChange(previous.comment.email);
      }
      return result;
    });
  }

  return (
    <section aria-labelledby="notifications-heading">
      <h3 id="notifications-heading" className={HEADING}>
        Notifications
      </h3>
      <p className="mt-1 text-sm text-zinc-600">
        Choose what reaches your Inbox and what’s also emailed to {email}. Things you do yourself never notify you.
      </p>
      {sending ? null : (
        <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Emails aren’t sent from this workspace yet (no email provider is set up). Your choices are saved for when
          they are.
        </p>
      )}
      <table className="mt-3 w-full border-separate border-spacing-0 overflow-hidden rounded-lg border border-zinc-200 text-sm">
        <caption className="sr-only">Notifications by kind: Inbox and email</caption>
        <thead>
          <tr className="bg-zinc-50 text-left text-xs text-zinc-500">
            <th scope="col" className="px-3 py-2 font-medium">
              Notify me about
            </th>
            <th scope="col" className="w-16 px-2 py-2 text-center font-medium">
              Inbox
            </th>
            <th scope="col" className="w-16 px-2 py-2 text-center font-medium">
              Email
            </th>
          </tr>
        </thead>
        <tbody>
          {NOTIFICATION_KINDS.map((kind) => (
            <tr key={kind.key} className="align-top [&>*]:border-t [&>*]:border-zinc-100">
              <th scope="row" className="px-3 py-2.5 text-left font-normal">
                <span className="block font-medium text-zinc-900">{kind.label}</span>
                <span className="mt-0.5 block text-xs text-zinc-500">
                  {kind.description}
                  {kind.key === "comment" && replyByEmail ? " Reply to a comment email to comment back." : ""}
                </span>
              </th>
              {(["inbox", "email"] as const).map((channel) => (
                <td key={channel} className="px-2 py-2.5 text-center">
                  <input
                    type="checkbox"
                    className="size-4 accent-accent-600"
                    checked={values[kind.key][channel]}
                    disabled={pending}
                    aria-label={`${kind.label}: ${channel === "inbox" ? "Inbox" : "email"}`}
                    onChange={(event) => toggle(kind.key, channel, event.target.checked)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-zinc-500">
        An email isn’t sent when you’ve already read the notification in your Inbox, and turning an email off also
        stops ones already queued. Emails from rules and forms, such as due date reminders or updates to a request
        you submitted, are set up by each project’s admins and aren’t affected by these switches. To stop hearing
        about one task, leave it (Leave task, at the bottom of its pane).{" "}
        <Link href="/inbox" className="text-accent-700 hover:underline">
          Open Inbox
        </Link>
      </p>
    </section>
  );
}
