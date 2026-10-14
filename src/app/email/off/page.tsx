import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth-card";
import { isUnsubscribeWhat, UNSUBSCRIBE_TOKEN } from "@/lib/email-schedules";
import { settingsHref } from "@/lib/shell";

export const metadata: Metadata = { title: "Turn off emails", robots: { index: false, follow: false } };

const COPY = {
  digest: {
    title: "Turn off your Inbox digest?",
    body: "You’ll stop getting the Inbox digest email. Your Inbox and your other notification emails stay as they are.",
    button: "Turn off digest",
    done: "Your Inbox digest is off.",
  },
  reports: {
    title: "Turn off scheduled report emails?",
    body: "You’ll stop getting every scheduled report email that people send you. Your Inbox and other emails stay as they are.",
    button: "Turn off report emails",
    done: "Scheduled report emails are off.",
  },
} as const;

// The "Turn off" link from a digest or report email (Real features 3). No sign-in: the token in the link
// is enough, and the button posts it to /api/email/unsubscribe. Opening this page changes nothing (link
// scanners open every link in an email); the one button does.
export default async function EmailOffPage({ searchParams }: PageProps<"/email/off">) {
  const params = await searchParams;
  const what = isUnsubscribeWhat(params.what) ? params.what : null;
  const token = typeof params.t === "string" && UNSUBSCRIBE_TOKEN.test(params.t) ? params.t : null;
  const result = typeof params.result === "string" ? params.result : null;
  const copy = what ? COPY[what] : null;
  const settings = (
    <Link href={settingsHref("notifications")} className="font-medium text-accent-700 hover:underline">
      Settings → Notifications
    </Link>
  );

  if (copy && (result === "off" || result === "already_off")) {
    return (
      <AuthCard title={copy.done}>
        <p className="text-sm text-zinc-600">
          {result === "already_off" ? "It was already off. " : ""}To turn it back on, sign in and open {settings}.
        </p>
      </AuthCard>
    );
  }
  if (result || !copy || !token) {
    return (
      <AuthCard title="This link doesn’t work">
        <p className="text-sm text-zinc-600">
          {result === "error"
            ? "Something went wrong. Try the link again in a minute."
            : "It may be incomplete. You can always change which emails you get in "}
          {result === "error" ? null : <>{settings}.</>}
        </p>
      </AuthCard>
    );
  }
  return (
    <AuthCard title={copy.title}>
      <p className="text-sm text-zinc-600">{copy.body}</p>
      <form method="post" action="/api/email/unsubscribe" className="mt-6">
        <input type="hidden" name="t" value={token} />
        <input type="hidden" name="what" value={what!} />
        <input type="hidden" name="source" value="page" />
        <button
          type="submit"
          className="inline-flex w-full items-center justify-center rounded-lg bg-accent-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-accent-600"
        >
          {copy.button}
        </button>
      </form>
      <p className="mt-4 text-xs text-zinc-500">You can also change this any time in {settings} after signing in.</p>
    </AuthCard>
  );
}
