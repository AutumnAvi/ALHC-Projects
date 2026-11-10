import "server-only";
import Link from "next/link";
import { SettingsCard } from "@/components/workspace/settings-chrome";
import { configuredSender, isEmailConfigured, senderAddress } from "@/lib/email";
import { isInboundEmailConfigured } from "@/lib/email-reply";

// The address part of EMAIL_FROM ("Name <a@b>" or "a@b"): the sender of replyable emails (responses to a
// form's submitter). Shown in the sender preview, never a secret.
export function fromAddress(): string | null {
  return senderAddress(configuredSender(true));
}

// Nov 1 notes (batch 8): the address every email that can't be replied to comes from — EMAIL_FROM_NOREPLY,
// else EMAIL_FROM.
export function noReplyFromAddress(): string | null {
  return senderAddress(configuredSender(false));
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
            ? isAdmin
              ? "On — emails go out through Resend within about a minute"
              : "On — emails go out within about a minute"
            : isAdmin
              ? "Off — no email provider is configured, so emails are logged, not sent"
              : "Off — email isn’t set up yet, so nothing is sent"}
        </dd>
        <dt className="text-zinc-500">Senders</dt>
        <dd className="text-zinc-900">
          <SenderLines
            replyable={fromAddress()}
            noReply={noReplyFromAddress()}
            separate={Boolean(process.env.EMAIL_FROM_NOREPLY?.trim())}
            isAdmin={isAdmin}
          />
        </dd>
        <dt className="text-zinc-500">Reply by email</dt>
        <dd className="text-zinc-900">
          {isInboundEmailConfigured()
            ? "On — replies to responses sent to a form’s submitter become comments on the request. Every other email says “Do not reply to this email.”"
            : "Off — every email says “Do not reply to this email.”"}
        </dd>
        <dt className="text-zinc-500">Bounces and complaints</dt>
        <dd className="text-zinc-900">
          {isInboundEmailConfigured()
            ? isAdmin
              ? "Tracked from the Resend webhook’s delivery events; bounced and spam-reporting addresses stop getting email"
              : "Tracked: addresses that bounce or report spam stop getting email"
            : isAdmin
              ? "Off — needs the Resend webhook (the same one reply by email uses)"
              : "Not tracked yet"}
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

// The two senders (Nov 1 notes, batch 8): replyable emails from EMAIL_FROM, everything else from
// EMAIL_FROM_NOREPLY (or EMAIL_FROM when it isn't set).
// Nov 10 audit (C87): the environment hint (EMAIL_FROM_NOREPLY) is for workspace admins only.
export function SenderLines({
  replyable,
  noReply,
  separate,
  isAdmin = false,
}: {
  replyable: string | null;
  noReply: string | null;
  separate: boolean;
  isAdmin?: boolean;
}) {
  if (!replyable) return <>No sending address is set up yet</>;
  return (
    <ul className="space-y-0.5">
      <li>
        <span className="font-mono text-xs">{noReply ?? replyable}</span>
        <span className="text-zinc-500"> — every email that can’t be replied to{separate || !isAdmin ? "" : " (set EMAIL_FROM_NOREPLY for a separate no-reply address)"}</span>
      </li>
      <li>
        <span className="font-mono text-xs">{replyable}</span>
        <span className="text-zinc-500"> — responses to a form’s submitter, which they can answer by email</span>
      </li>
    </ul>
  );
}
