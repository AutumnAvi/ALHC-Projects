"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { Ban, CheckCircle2, Clock, Loader2, Mail, RotateCcw, Send, ShieldCheck, XCircle } from "lucide-react";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { cancelIntegrationDelivery, retryEmailDelivery, retryIntegrationDelivery } from "@/lib/actions";
import {
  DELIVERY_STATUS_LABELS,
  MAX_AUTO_ATTEMPTS,
  MAX_TOTAL_ATTEMPTS,
  canCancelDelivery,
  canRetryDelivery,
  emailKindLabel,
  type DeliveryStatus,
  type EmailDelivery,
  type IntegrationDelivery,
} from "@/lib/integrations-shared";

const FILTERS = [
  { value: "all", label: "All" },
  { value: "failed", label: "Failed" },
  { value: "pending", label: "Waiting" },
] as const;

type Filter = (typeof FILTERS)[number]["value"];

const STATUS_STYLE: Record<DeliveryStatus, { icon: typeof Clock; className: string }> = {
  pending: { icon: Clock, className: "bg-amber-50 text-amber-800" },
  sending: { icon: Loader2, className: "bg-accent-50 text-accent-700" },
  sent: { icon: CheckCircle2, className: "bg-green-50 text-green-800" },
  mocked: { icon: CheckCircle2, className: "bg-zinc-100 text-zinc-600" },
  failed: { icon: XCircle, className: "bg-red-50 text-red-700" },
  cancelled: { icon: Ban, className: "bg-zinc-100 text-zinc-600" },
};

const buttonClass =
  "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-300 px-2.5 py-1 text-sm text-zinc-700 hover:border-accent-500 hover:text-accent-700 disabled:opacity-50";

function subscribe(callback: () => void) {
  const timer = window.setInterval(callback, 30_000);
  return () => window.clearInterval(timer);
}

// "in 12m" / "any moment", rendered only on the client (like Timestamp).
function NextAttempt({ iso }: { iso: string }) {
  const now = useSyncExternalStore(subscribe, () => Math.floor(Date.now() / 30_000) * 30_000, () => null);
  if (now === null) return null;
  const minutes = Math.ceil((new Date(iso).getTime() - now) / 60_000);
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {minutes <= 1 ? "any moment" : minutes < 60 ? `in ${minutes}m` : `in ${Math.round(minutes / 60)}h`}
    </time>
  );
}

// Settings → Deliveries (Admin+): the project's emails (form confirmations, requester updates, rule
// emails, comment emails to followers) and what its Slack and webhook rule actions sent, with retry and
// cancel. Emails show the recipient and status, never the body. Slack / webhook destinations show as
// hints (host + last 4 characters) only; URLs, secrets, payloads, and signatures never reach the browser.
export function DeliveryLog({
  projectId,
  deliveries,
  emails,
}: {
  projectId: string;
  deliveries: IntegrationDelivery[];
  emails: EmailDelivery[];
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const matches = (status: DeliveryStatus) => filter === "all" || status === filter;
  const shownEmails = emails.filter((e) => matches(e.status));
  const shown = deliveries.filter((d) => matches(d.status));
  const failedCount =
    deliveries.filter((d) => d.status === "failed").length + emails.filter((e) => e.status === "failed").length;
  const any = deliveries.length + emails.length > 0;

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-gutter py-5">
      <section className="rounded-lg border border-zinc-200" aria-labelledby="deliveries-heading">
        <div className="px-5 py-4">
          <h2 id="deliveries-heading" className="text-sm font-semibold text-zinc-900">
            Deliveries
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            Emails about this project’s tasks, and Slack messages and webhook calls queued by its rules, newest first
            (the latest 200 of each). Queued items normally go out within a minute. A failed send is retried
            automatically after 5, 10, 20, then 30 minutes; after {MAX_AUTO_ATTEMPTS} attempts it is marked failed with
            the reason. Retry gives it one more attempt with the same content (up to {MAX_TOTAL_ATTEMPTS} in all).
          </p>
          {any ? (
            <div role="group" aria-label="Show deliveries" className="mt-3 flex gap-1">
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={filter === f.value}
                  onClick={() => setFilter(f.value)}
                  className="inline-flex h-7 items-center rounded-md px-2.5 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 aria-pressed:bg-zinc-100 aria-pressed:font-medium aria-pressed:text-zinc-900"
                >
                  {f.label}
                  {f.value === "failed" && failedCount > 0 ? (
                    <span className="ml-1.5 rounded-full bg-red-50 px-1.5 text-xs tabular-nums text-red-700">
                      {failedCount}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      <section className="rounded-lg border border-zinc-200" aria-labelledby="email-deliveries-heading">
        <div className="border-b border-zinc-200 px-5 py-3">
          <h3 id="email-deliveries-heading" className="text-sm font-semibold text-zinc-900">
            Emails
          </h3>
          <p className="mt-0.5 text-xs text-zinc-500">
            Comment emails are checked again just before sending: someone who can no longer open the task, or who
            turned comment emails off, gets nothing, and the row says why.
          </p>
        </div>
        {emails.length === 0 ? (
          <EmptyState icon={Mail} title="No emails yet" size="inline">
            Form confirmations, requester updates, rule emails, and comment emails to followers of this project’s tasks
            show up here with their status.
          </EmptyState>
        ) : shownEmails.length === 0 ? (
          <EmptyState title={filter === "failed" ? "No failed emails" : "No emails waiting"} size="inline">
            Choose All to see every email.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {shownEmails.map((e) => (
              <EmailRow key={e.id} projectId={projectId} email={e} />
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200" aria-labelledby="integration-deliveries-heading">
        <div className="border-b border-zinc-200 px-5 py-3">
          <h3 id="integration-deliveries-heading" className="text-sm font-semibold text-zinc-900">
            Slack and webhooks
          </h3>
          <p className="mt-0.5 text-xs text-zinc-500">Destinations show as host + last 4 characters only.</p>
        </div>
        {deliveries.length === 0 ? (
          <EmptyState icon={Send} title="Nothing delivered yet" size="inline">
            When a rule with a <span className="font-medium text-zinc-700">Send Slack message</span> or{" "}
            <span className="font-medium text-zinc-700">Call webhook</span> action runs, each delivery shows up here
            with its status. Set up destinations in{" "}
            <Link href={`/projects/${projectId}/settings/integrations`} className="text-accent-700 hover:underline">
              Integrations
            </Link>
            .
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState title={filter === "failed" ? "No failed deliveries" : "Nothing waiting to be sent"} size="inline">
            Choose All to see every delivery.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {shown.map((d) => (
              <DeliveryRow key={d.id} projectId={projectId} delivery={d} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: DeliveryStatus }) {
  const style = STATUS_STYLE[status];
  const StatusIcon = style.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${style.className}`}>
      <StatusIcon className="size-3.5" aria-hidden />
      {status === "mocked" ? "Not sent (mocked)" : DELIVERY_STATUS_LABELS[status]}
    </span>
  );
}

function EmailRow({ projectId, email: e }: { projectId: string; email: EmailDelivery }) {
  const [pending, run] = useServerAction();
  const kind = emailKindLabel(e.kind);
  const retryLabel = e.status === "pending" ? "Send now" : "Retry";
  return (
    <li className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge status={e.status} />
          <span className="font-medium text-zinc-900">{kind}</span>
          <span className="text-zinc-500">to</span>
          <span className="min-w-0 break-all text-zinc-700">{e.recipient}</span>
        </div>
        <p className="text-xs text-zinc-500">
          {e.taskTitle ? (
            <Link href={`/projects/${projectId}?task=${e.taskId}`} className="text-accent-700 hover:underline">
              {e.taskTitle}
            </Link>
          ) : (
            "A task you can’t open"
          )}
          {e.ruleName ? ` · rule “${e.ruleName}”` : ""} · queued <Timestamp iso={e.createdAt} />
        </p>
        <p className="text-xs text-zinc-500">
          Attempt {e.attempts} of {e.maxAttempts}
          {e.status === "pending" && e.nextAttemptAt ? (
            <>
              {" "}
              · next attempt <NextAttempt iso={e.nextAttemptAt} />
            </>
          ) : null}
          {(e.status === "sent" || e.status === "mocked") && e.sentAt ? (
            <>
              {" "}
              · {e.status === "sent" ? "sent" : "processed"} <Timestamp iso={e.sentAt} />
            </>
          ) : null}
          {e.status === "failed" ? (
            <>
              {" "}
              · gave up <Timestamp iso={e.updatedAt} />
            </>
          ) : null}
        </p>
        {e.lastError && e.status !== "sent" && e.status !== "mocked" ? (
          <p className="break-words text-xs text-red-700">{e.lastError}</p>
        ) : null}
      </div>
      {canRetryDelivery(e) ? (
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={pending}
            aria-label={`${retryLabel}: ${kind} to ${e.recipient}`}
            onClick={() => run(() => retryEmailDelivery(e.id))}
            className={buttonClass}
          >
            <RotateCcw className="size-3.5" aria-hidden />
            {retryLabel}
          </button>
        </div>
      ) : null}
    </li>
  );
}

function DeliveryRow({ projectId, delivery: d }: { projectId: string; delivery: IntegrationDelivery }) {
  const [pending, run] = useServerAction();
  const channel = d.channel === "slack" ? "Slack message" : "Webhook call";
  const retryLabel = d.status === "pending" ? "Send now" : "Retry";

  return (
    <li className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge status={d.status} />
          <span className="font-medium text-zinc-900">{channel}</span>
          <span className="text-zinc-500">to</span>
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-700">{d.targetHint}</span>
          {d.signed ? (
            <span className="inline-flex items-center gap-1 text-xs text-zinc-600">
              <ShieldCheck className="size-3.5" aria-hidden />
              Signed
            </span>
          ) : null}
        </div>
        <p className="text-xs text-zinc-500">
          {d.taskId && d.taskTitle ? (
            <Link href={`/projects/${projectId}?task=${d.taskId}`} className="text-accent-700 hover:underline">
              {d.taskTitle}
            </Link>
          ) : d.taskId ? (
            "A task you can’t open"
          ) : (
            "No task"
          )}
          {d.ruleName ? ` · rule “${d.ruleName}”` : ""} · queued <Timestamp iso={d.createdAt} />
        </p>
        <p className="text-xs text-zinc-500">
          Attempt {d.attempts} of {d.maxAttempts}
          {d.responseStatus !== null ? ` · last response HTTP ${d.responseStatus}` : ""}
          {d.status === "pending" && d.nextAttemptAt ? (
            <>
              {" "}
              · next attempt <NextAttempt iso={d.nextAttemptAt} />
            </>
          ) : null}
          {(d.status === "sent" || d.status === "mocked") && d.sentAt ? (
            <>
              {" "}
              · sent <Timestamp iso={d.sentAt} />
            </>
          ) : null}
          {d.status === "failed" || d.status === "cancelled" ? (
            <>
              {" "}
              · {d.status === "failed" ? "gave up" : "cancelled"} <Timestamp iso={d.updatedAt} />
            </>
          ) : null}
        </p>
        {d.lastError && d.status !== "sent" && d.status !== "mocked" ? (
          <p className="break-words text-xs text-red-700">{d.lastError}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 gap-2">
        {canRetryDelivery(d) ? (
          <button
            type="button"
            disabled={pending}
            aria-label={`${retryLabel}: ${channel} to ${d.targetHint}`}
            onClick={() => run(() => retryIntegrationDelivery(d.id))}
            className={buttonClass}
          >
            <RotateCcw className="size-3.5" aria-hidden />
            {retryLabel}
          </button>
        ) : null}
        {canCancelDelivery(d) ? (
          <button
            type="button"
            disabled={pending}
            aria-label={`Cancel: ${channel} to ${d.targetHint}`}
            onClick={() => {
              if (window.confirm(`Cancel this ${channel.toLowerCase()}? It won’t be sent.`)) {
                run(() => cancelIntegrationDelivery(d.id));
              }
            }}
            className={buttonClass}
          >
            <Ban className="size-3.5" aria-hidden />
            Cancel
          </button>
        ) : null}
      </div>
    </li>
  );
}
