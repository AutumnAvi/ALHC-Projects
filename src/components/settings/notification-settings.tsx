"use client";

import Link from "next/link";
import { useServerAction } from "@/components/toast";
import { setEmailComments } from "@/lib/actions";

const HEADING = "text-sm font-semibold text-zinc-900";

// "Email me about comments": when on, a new comment on a task you follow is emailed to you (never your
// own, and only while you can open the task). Optimistic; the server action saves your own row only.
// The panel owns the value so Email forwarding sees a change made here.
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

// What lands in the Inbox. There are no per-kind switches yet, so this says what to expect instead of
// showing controls that wouldn't do anything.
const INBOX_KINDS = [
  "Tasks assigned to you",
  "@mentions in comments and project messages",
  "Comments on tasks you follow, and when they’re completed",
  "Approval requests for you, and decisions on approvals of tasks you follow",
  "Replies in message threads you started or replied to",
  "Rules that notify you, and changes to fields set to “Notify collaborators when changed” on tasks you follow",
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
        You can’t turn these off one by one yet. To stop getting a task’s comments, leave it (Leave task, at the
        bottom of its pane).{" "}
        <Link href="/inbox" className="text-accent-700 hover:underline">
          Open Inbox
        </Link>
      </p>
    </section>
  );
}
