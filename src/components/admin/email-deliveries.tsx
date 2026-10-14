"use client";

import { useState } from "react";
import { MailCheck, ShieldOff } from "lucide-react";
import { Dialog } from "@/components/dialog";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { clearEmailSuppression } from "@/lib/actions";
import type { EmailSuppression, WorkspaceEmailDelivery } from "@/lib/data";
import { EMAIL_KIND_LABELS, SUPPRESSION_REASONS, emailStatusBadge } from "@/lib/email-schedules";

const TH = "px-3 py-2 font-medium";

function isProblem(d: WorkspaceEmailDelivery) {
  return (
    d.status === "failed" ||
    d.deliveryStatus === "bounced" ||
    d.deliveryStatus === "complained" ||
    d.deliveryStatus === "suppressed" ||
    d.deliveryStatus === "delayed"
  );
}

// Admin console → Email → Recent emails (Real features 3): every kind of email the workspace sent, with
// what Resend reported (Sent / Delivered / Bounced / Complained). Recipients outside the workspace are
// masked, and nothing says what an email was about.
export function RecentEmails({ deliveries }: { deliveries: WorkspaceEmailDelivery[] }) {
  const [problemsOnly, setProblemsOnly] = useState(false);
  const shown = problemsOnly ? deliveries.filter(isProblem) : deliveries;
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-zinc-100 px-5 py-2 text-sm">
        <div role="group" aria-label="Show" className="inline-flex h-7 items-center rounded-md bg-zinc-100 p-0.5">
          {[
            { value: false, label: "All" },
            { value: true, label: "Problems only" },
          ].map((option) => (
            <button
              key={option.label}
              type="button"
              aria-pressed={problemsOnly === option.value}
              onClick={() => setProblemsOnly(option.value)}
              className="h-6 rounded px-2 text-sm text-zinc-600 hover:text-zinc-900 aria-pressed:bg-white aria-pressed:font-medium aria-pressed:text-zinc-900 aria-pressed:shadow-xs"
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-zinc-500">
          {shown.length} of the latest {deliveries.length}
        </span>
      </div>
      {shown.length === 0 ? (
        <EmptyState icon={MailCheck} title={problemsOnly ? "No problems" : "No emails yet"} size="inline">
          {problemsOnly
            ? "Nothing failed, bounced, or was marked as spam among the latest emails."
            : "Invites, notifications, digests, and reports show up here once they’re queued."}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] border-collapse text-sm">
            <caption className="sr-only">Recent emails and their delivery status</caption>
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs text-zinc-500">
                <th scope="col" className={`${TH} w-64 pl-5`}>
                  To
                </th>
                <th scope="col" className={`${TH} w-36`}>
                  Kind
                </th>
                <th scope="col" className={`${TH} w-44`}>
                  Status
                </th>
                <th scope="col" className={TH}>
                  Details
                </th>
                <th scope="col" className={`${TH} w-24`}>
                  Time
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => {
                const badge = emailStatusBadge(d.status, d.deliveryStatus, d.attempts);
                const detail =
                  d.deliveryStatus && d.status === "sent"
                    ? d.deliveryDetail
                    : d.status !== "sent" && d.status !== "mocked"
                      ? d.lastError
                      : null;
                return (
                  <tr key={d.id} className="border-b border-zinc-100 last:border-b-0 [&>td]:align-top">
                    <td className="py-2 pr-3 pl-5">
                      <span className="block break-all text-zinc-900">{d.recipient}</span>
                      {!d.inWorkspace ? <span className="text-xs text-zinc-500">Outside the workspace</span> : null}
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-600">{EMAIL_KIND_LABELS[d.kind] ?? d.kind}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${badge.className}`}>{badge.label}</span>
                      {d.suppressed ? <span className="ml-1 text-xs text-red-700">· suppressed</span> : null}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {detail ? (
                        <span className={`break-words ${d.status === "failed" ? "text-red-700" : "text-zinc-600"}`}>{detail}</span>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-600">
                      <Timestamp iso={d.deliveryEventAt ?? d.sentAt ?? d.createdAt} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// "Permanent · NoEmail" → "NoEmail": the reason already says it was permanent.
function detailWithoutType(detail: string | null): string {
  return (detail ?? "")
    .split(" · ")
    .filter((part) => part && !/^permanent$/i.test(part))
    .join(" · ");
}

// Admin console → Email → Suppression list: addresses no email goes to after a permanent bounce, a spam
// complaint, or Resend's own suppression. Clearing lets email go to them again (the Inbox never stopped).
export function SuppressionList({ suppressions }: { suppressions: EmailSuppression[] }) {
  const [confirming, setConfirming] = useState<EmailSuppression | null>(null);
  const [pending, run] = useServerAction();
  if (suppressions.length === 0) {
    return (
      <EmptyState icon={ShieldOff} title="No suppressed addresses" size="inline">
        When an email bounces for good or someone marks one as spam, their address shows up here and no more email goes
        to it until you clear it.
      </EmptyState>
    );
  }
  return (
    <>
      <ul className="divide-y divide-zinc-100">
        {suppressions.map((s) => (
          <li key={s.id} className="flex flex-col gap-2 px-5 py-3 text-sm sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-zinc-900">
                {s.email}
                {!s.inWorkspace ? <span className="ml-2 text-xs font-normal text-zinc-500">Outside the workspace</span> : null}
              </p>
              <p className="text-xs text-zinc-500">
                {SUPPRESSION_REASONS[s.reason] ?? s.reason}
                {detailWithoutType(s.detail) ? ` · ${detailWithoutType(s.detail)}` : ""}
                {s.emailKind ? ` · email: ${EMAIL_KIND_LABELS[s.emailKind] ?? s.emailKind}` : ""} · <Timestamp iso={s.createdAt} />
              </p>
            </div>
            <button
              type="button"
              className="btn-secondary shrink-0"
              disabled={pending}
              onClick={() => setConfirming(s)}
              aria-label={`Clear ${s.email} from the suppression list`}
            >
              Clear
            </button>
          </li>
        ))}
      </ul>
      {confirming ? (
        <Dialog title={`Send email to ${confirming.email} again?`} onClose={() => setConfirming(null)}>
          <p className="text-sm text-zinc-600">
            {confirming.reason === "complained"
              ? "This person marked an email as spam. Only clear it if they asked to get emails again."
              : "Only clear it once the address works again (for example, a mailbox that was full or a typo that was fixed)."}{" "}
            {confirming.reason === "suppressed"
              ? "Resend keeps its own suppression list too: remove the address there as well (Resend → Suppressions), or emails still won’t arrive."
              : "If it bounces again, it comes back on the list."}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setConfirming(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const result = await clearEmailSuppression(confirming.id);
                  if (!result.error) setConfirming(null);
                  return result;
                })
              }
            >
              Clear address
            </button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
