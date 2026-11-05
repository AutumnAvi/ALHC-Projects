"use client";

import { MailX } from "lucide-react";
import type { TaskDetail } from "@alhc/core/api/task-pane/model";
import { conversationNote } from "@alhc/core/verified-domains";

// Nov 1 notes, item 69: in a request's pane, what workers need to know about its email conversation.
// Nov 2 notes (batch 17, 130): only when it's off (a submitter outside the verified domains, or turned off
// for this request or submitter) — the "Send response to submitter" box isn't offered then, and this says
// why. No "Email conversation is on" banner, and no Change: the submitter's address is the one they
// submitted with and never changes.
export function RequestConversationNotice({ task }: { task: TaskDetail }) {
  const c = task.submitterConversation;
  if (!c || c.allowed) return null;
  const note = conversationNote(c);
  if (!note) return null;
  return (
    <div
      data-request-conversation="off"
      className="mb-2 flex items-start gap-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900"
    >
      <MailX className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">{note}</p>
    </div>
  );
}
