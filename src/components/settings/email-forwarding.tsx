"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, Copy, Forward, Mail, RefreshCw } from "lucide-react";
import { Timestamp } from "@/components/timestamp";
import { useNotify, useServerAction } from "@/components/toast";
import { rotateForwardingAddress, setForwardingProject } from "@/lib/actions";
import { MAX_ATTACHMENT_LABEL } from "@/lib/attachments";
import { forwardRejectionLabel, type ForwardedEmail, type ForwardingSetup } from "@/lib/shell";

const HEADING = "text-sm font-semibold text-zinc-900";
const MY_TASKS = "";

// Settings → Email forwarding (Real features 1): the person's own forwarding address. Mail they send or
// forward to it from their own address becomes a task: the subject its name, the body its description,
// the attachments its files — assigned to them, in the project they pick (while they can add tasks to it)
// or their private My tasks. A new address replaces the old one at once.
export function EmailForwardingSection({ forwarding, myEmail }: { forwarding: ForwardingSetup; myEmail: string }) {
  return (
    <section aria-labelledby="forwarding-heading">
      <div className="flex items-center gap-2">
        <Forward aria-hidden className="size-4 text-zinc-400" />
        <h3 id="forwarding-heading" className={HEADING}>
          Forward emails to create tasks
        </h3>
        {forwarding.state === "ready" ? <span className="chip bg-green-50 text-green-700">On</span> : null}
      </div>
      {forwarding.state === "not_configured" ? (
        <p className="mt-1 text-sm text-zinc-600">
          Forwarding needs inbound email, which isn’t set up on this deployment yet (it uses the same Resend inbound
          domain as replies to comment emails). Until it is, there’s no forwarding address to copy.
        </p>
      ) : forwarding.state === "needs_update" ? (
        <p className="mt-1 text-sm text-zinc-600">
          Forwarding needs this release’s database update, which isn’t applied yet.
        </p>
      ) : (
        <ReadyForwarding forwarding={forwarding} myEmail={myEmail} />
      )}
    </section>
  );
}

function ReadyForwarding({
  forwarding,
  myEmail,
}: {
  forwarding: Extract<ForwardingSetup, { state: "ready" }>;
  myEmail: string;
}) {
  const notify = useNotify();
  const [pending, run] = useServerAction();
  const [address, setAddress] = useState(forwarding.address);
  const [projectId, setProjectId] = useState(forwarding.defaultProjectId ?? MY_TASKS);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  // A project that's gone from the list (archived, or no longer editable) still shows as chosen until
  // changed; emails then go to My tasks (the database checks on every email).
  const listed = projectId === MY_TASKS || forwarding.projects.some((p) => p.id === projectId);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      notify("Couldn’t copy. Select the address and copy it instead.");
    }
  }

  return (
    <div className="mt-1 flex flex-col gap-4">
      <p className="text-sm text-zinc-600">
        Send or forward an email to this address from <span className="font-medium text-zinc-900">{myEmail}</span>. Its
        subject becomes the task name, its text the description, and its attachments are added to the task (up to 10
        files, {MAX_ATTACHMENT_LABEL} each). The task is assigned to you. Mail from any other address is
        ignored, so keep this address to yourself.
      </p>

      <div>
        <label htmlFor="forwarding-address" className="text-xs font-medium text-zinc-600">
          Your forwarding address
        </label>
        <div className="mt-1 flex items-center gap-2">
          <input
            id="forwarding-address"
            readOnly
            value={address}
            onFocus={(e) => e.currentTarget.select()}
            className="field min-w-0 flex-1 font-mono text-xs"
          />
          <button type="button" onClick={copy} className="btn-secondary h-9 shrink-0 gap-1.5">
            {copied ? <Check className="size-4 text-green-600" aria-hidden /> : <Copy className="size-4" aria-hidden />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      <div>
        <label htmlFor="forwarding-project" className="text-xs font-medium text-zinc-600">
          New tasks go to
        </label>
        <select
          id="forwarding-project"
          value={projectId}
          disabled={pending}
          onChange={(e) => {
            const next = e.currentTarget.value;
            const previous = projectId;
            // Shown right away (outside the action's transition, like Notifications), put back if refused.
            setProjectId(next);
            run(async () => {
              const result = await setForwardingProject(next === MY_TASKS ? null : next);
              if (result.error) setProjectId(previous);
              return result;
            });
          }}
          className="field mt-1 w-full"
        >
          <option value={MY_TASKS}>My tasks (private to you)</option>
          {forwarding.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {!listed ? <option value={projectId}>A project you can’t add tasks to anymore</option> : null}
        </select>
        <p className="mt-1 text-xs text-zinc-500">
          Projects you can add tasks to. If you can’t add tasks to it anymore when an email arrives, the task goes to My
          tasks instead.
        </p>
      </div>

      <div>
        {confirming ? (
          <div role="group" aria-label="Get a new address" className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-zinc-700">The current address stops working right away.</p>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const result = await rotateForwardingAddress();
                  if (!result.error && result.address) {
                    setAddress(result.address);
                    setConfirming(false);
                    notify("New forwarding address ready. The old one no longer works.");
                  }
                  return result;
                })
              }
              className="btn-primary h-8"
            >
              Get a new address
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="btn-ghost h-8">
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirming(true)} className="btn-ghost h-8 gap-1.5 px-2 text-sm">
            <RefreshCw className="size-3.5" aria-hidden />
            Get a new address
          </button>
        )}
      </div>

      <RecentForwards recent={forwarding.recent} />
    </div>
  );
}

function RecentForwards({ recent }: { recent: ForwardedEmail[] }) {
  return (
    <div>
      <h4 className="text-xs font-medium text-zinc-600">Recently forwarded</h4>
      {recent.length === 0 ? (
        <p className="mt-1 text-sm text-zinc-500">Nothing yet. Emails you forward show up here.</p>
      ) : (
        <ul className="mt-1 divide-y divide-zinc-100 rounded-lg border border-zinc-200">
          {recent.map((f) => (
            <li key={f.id} className="flex items-start gap-2.5 px-3 py-2">
              <Mail aria-hidden className={`mt-0.5 size-4 shrink-0 ${f.status === "created" ? "text-zinc-400" : "text-amber-500"}`} />
              <div className="min-w-0 flex-1 text-sm">
                {f.status === "created" ? (
                  <p className="truncate text-zinc-800">
                    {f.taskId && f.taskTitle ? (
                      <Link
                        href={f.projectId ? `/projects/${f.projectId}?task=${f.taskId}` : `/my-tasks?task=${f.taskId}`}
                        className="text-accent-700 hover:underline"
                      >
                        {f.taskTitle}
                      </Link>
                    ) : (
                      "A task you can’t open anymore"
                    )}{" "}
                    <span className="text-zinc-500">
                      in {f.projectName ?? (f.projectId ? "a project" : "My tasks")}
                      {f.attachments ? ` · ${f.attachments} ${f.attachments === 1 ? "attachment" : "attachments"}` : ""}
                      {f.reason === "project_unavailable" ? " (your project wasn’t available)" : ""}
                    </span>
                  </p>
                ) : (
                  <p className="text-zinc-700">{forwardRejectionLabel(f.reason)}</p>
                )}
              </div>
              <Timestamp iso={f.createdAt} className="shrink-0 text-xs text-zinc-500" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
