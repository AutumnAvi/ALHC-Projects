"use client";

import { useState } from "react";
import { useServerAction } from "@/components/toast";
import { setEmailComments } from "@/lib/actions";

// "Email me about comments": when on, a new comment on a task you follow is emailed to you (never your
// own, and only while you can open the task). Optimistic; the server action saves your own row only.
export function ProfileSettings({ email, emailComments }: { email: string; emailComments: boolean }) {
  const [enabled, setEnabled] = useState(emailComments);
  const [pending, run] = useServerAction();

  return (
    <div className="mx-auto max-w-3xl px-gutter py-5">
      <section className="rounded-lg border border-zinc-200" aria-labelledby="notifications-heading">
        <div className="border-b border-zinc-200 px-5 py-4">
          <h2 id="notifications-heading" className="text-sm font-semibold text-zinc-900">
            Email notifications
          </h2>
          <p className="mt-1 text-sm text-zinc-600">Sent to {email}. Your Inbox keeps every notification either way.</p>
        </div>
        <label className="flex cursor-pointer items-start gap-3 px-5 py-4">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-accent-600"
            checked={enabled}
            disabled={pending}
            onChange={(event) => {
              const next = event.target.checked;
              const previous = enabled;
              setEnabled(next);
              run(async () => {
                const result = await setEmailComments(next);
                if (result.error) setEnabled(previous);
                return result;
              });
            }}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-zinc-900">Email me about comments</span>
            <span className="mt-0.5 block text-sm text-zinc-600">
              When someone comments on a task you follow, email you the comment with an Open task link. You can reply
              to the email to comment back (when reply by email is set up). Turning this off also stops emails that
              are already queued.
            </span>
          </span>
        </label>
      </section>
    </div>
  );
}
