"use client";

import { MailX, MailCheck } from "lucide-react";
import { Popover } from "@/components/popover";
import { useServerAction } from "@/components/toast";
import { setEmailConversationOverride } from "@/lib/actions";
import type { TaskDetail } from "@/lib/data";
import { conversationNote } from "@/lib/verified-domains";

// Nov 1 notes, item 69: in a request's pane, what workers need to know about its email conversation —
// off for a submitter outside the verified domains (they submitted, but get no email back-and-forth), or
// turned on / off by a workspace admin — and, for workspace admins, the switches for this request or for
// every request from this submitter.
export function RequestConversationNotice({ task }: { task: TaskDetail }) {
  const [pending, run] = useServerAction();
  const c = task.submitterConversation;
  if (!c) return null;
  const note = conversationNote(c);
  if (!note && !c.canOverride) return null;
  const overridden = c.reason === "override_request" || c.reason === "override_submitter";
  const Icon = c.allowed ? MailCheck : MailX;
  return (
    <div
      data-request-conversation={c.allowed ? "on" : "off"}
      className={`mb-2 flex flex-wrap items-start gap-2 rounded-md px-2.5 py-1.5 text-xs ${
        c.allowed ? "bg-zinc-50 text-zinc-600" : "bg-amber-50 text-amber-900"
      }`}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">{note ?? `Email conversation is on: ${c.email} is on a verified domain.`}</p>
      {c.canOverride ? (
        <Popover
          label="Email conversation for this request"
          align="end"
          panelClassName="w-72 p-1.5"
          buttonClassName="shrink-0 rounded px-1.5 py-0.5 font-medium text-accent-700 hover:bg-accent-50"
          button="Change"
        >
          {(close) => (
            <div className="flex flex-col text-sm">
              <p className="px-2 pb-1 pt-1 text-2xs text-zinc-500">Workspace admins only</p>
              {[
                c.allowed
                  ? { label: "Turn off for this request", scope: "request" as const, allow: false }
                  : { label: "Turn on for this request", scope: "request" as const, allow: true },
                c.allowed
                  ? { label: `Turn off for every request from ${c.email}`, scope: "submitter" as const, allow: false }
                  : { label: `Turn on for every request from ${c.email}`, scope: "submitter" as const, allow: true },
                ...(overridden
                  ? [{ label: "Go back to the workspace rule", scope: c.reason === "override_request" ? ("request" as const) : ("submitter" as const), allow: null }]
                  : []),
              ].map((item) => (
                <button
                  key={item.label}
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    close();
                    run(() => setEmailConversationOverride(task.id, item.scope, item.allow));
                  }}
                  className="rounded-md px-2 py-1.5 text-left text-zinc-700 hover:bg-zinc-100"
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </Popover>
      ) : null}
    </div>
  );
}
