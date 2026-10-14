import "server-only";
import Link from "next/link";
import { SettingsCard } from "@/components/workspace/settings-chrome";
import { isEmailConfigured } from "@/lib/email";
import { isInboundEmailConfigured } from "@/lib/email-reply";

// The address part of EMAIL_FROM ("Name <a@b>" or "a@b"); shown in the sender preview, never a secret.
export function fromAddress(): string | null {
  const configured = process.env.EMAIL_FROM?.trim();
  if (!configured) return null;
  return configured.match(/<([^<>]+)>\s*$/)?.[1]?.trim() ?? configured;
}

// Whether the app sends email at all, whether replies come back as comments, and where invite statuses
// show. Admin console → Email and Settings → Workspace → Email (members). Server only: it reads the
// deployment's configuration, never a key.
export function EmailDeliveryCard({ isAdmin, invitesHref }: { isAdmin: boolean; invitesHref: string }) {
  const configured = isEmailConfigured();
  return (
    <SettingsCard id="workspace-email-status" title="Delivery" isAdmin={isAdmin}>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
        <dt className="text-zinc-500">Sending</dt>
        <dd className="text-zinc-900">
          {configured
            ? "On — emails go out through Resend within about a minute"
            : "Off — no email provider is configured, so emails are logged, not sent"}
        </dd>
        <dt className="text-zinc-500">Reply by email</dt>
        <dd className="text-zinc-900">{isInboundEmailConfigured() ? "On — replies to comment emails become comments" : "Off"}</dd>
        <dt className="text-zinc-500">Bounces and complaints</dt>
        <dd className="text-zinc-900">
          {isInboundEmailConfigured()
            ? "Tracked from the Resend webhook’s delivery events; bounced and spam-reporting addresses stop getting email"
            : "Off — needs the Resend webhook (the same one reply by email uses)"}
        </dd>
        <dt className="text-zinc-500">Invites</dt>
        <dd className="text-zinc-900">
          {isAdmin ? (
            <>
              Sent when you invite someone on{" "}
              <Link href={invitesHref} className="text-accent-700 hover:underline">
                Users
              </Link>
              ; each invite’s status shows there and under Invite emails below.
            </>
          ) : (
            <>
              Sent when a workspace admin invites someone. People who haven’t signed in yet show as Invited on{" "}
              <Link href={invitesHref} className="text-accent-700 hover:underline">
                Members
              </Link>
              .
            </>
          )}
        </dd>
      </dl>
    </SettingsCard>
  );
}
