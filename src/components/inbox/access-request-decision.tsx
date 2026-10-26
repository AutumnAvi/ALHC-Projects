"use client";

import { useState } from "react";
import { Check, X } from "lucide-react";
import { useServerAction } from "@/components/toast";
import { decideAccessRequest } from "@/lib/actions";
import { ROLE_LABELS, isProjectRole } from "@/lib/roles";
import type { InboxAccessRequest } from "@/lib/access-requests";

// Oct 26 notes (batch 3): an owner's Inbox card about someone asking to be added. Add them (with their
// own default project role; Share lets you pick another) or decline. The database checks the owner's role
// and keeps the card's state (approved / declined) once decided, from here or from Share.
export function AccessRequestDecision({ request, compact }: { request: InboxAccessRequest; compact: boolean }) {
  const [pending, run] = useServerAction();
  const [status, setStatus] = useState(request.status);
  const [granted, setGranted] = useState(request.grantedRole);

  function decide(decision: "approve" | "decline") {
    run(async () => {
      const result = await decideAccessRequest(request.requestId, decision);
      if (!result.error && (result.status === "approved" || result.status === "declined")) setStatus(result.status);
      if (!result.error && decision === "approve") setGranted(null);
      return result;
    });
  }

  if (status !== "pending") {
    if (compact) return null;
    const role = granted && isProjectRole(granted) ? ROLE_LABELS[granted] : null;
    return (
      <p className="mt-1 text-xs text-zinc-500">
        {status === "approved" ? (role ? `Added as ${role}` : "Added to the project") : "Request declined"}
      </p>
    );
  }
  return (
    <div className="relative z-10 mt-2 flex flex-wrap gap-1.5" role="group" aria-label={`Request from ${request.requesterName}`}>
      <button type="button" onClick={() => decide("approve")} disabled={pending} className="btn-primary h-6 px-2 text-xs">
        <Check className="size-3.5" aria-hidden />
        Add to project
      </button>
      <button
        type="button"
        onClick={() => decide("decline")}
        disabled={pending}
        className="btn-secondary h-6 px-2 text-xs hover:border-red-300 hover:text-red-700"
      >
        <X className="size-3.5" aria-hidden />
        Decline
      </button>
    </div>
  );
}
