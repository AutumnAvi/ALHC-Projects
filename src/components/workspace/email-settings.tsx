"use client";

import { useState } from "react";
import { useServerAction } from "@/components/toast";
import { SettingsCard } from "@/components/workspace/settings-chrome";
import { updateWorkspaceSettings } from "@/lib/actions";
import { SENDER_NAME_MAX, senderNameProblem, senderPreview } from "@/lib/workspace";

// Admin console → Email → Sender name (read-only on Settings → Workspace → Email for members). Shown in
// front of the configured from-address on every email the app sends.
export function SenderNameSettings({
  senderName,
  fromAddress,
  noReplyAddress = null,
  isAdmin,
}: {
  senderName: string | null;
  // EMAIL_FROM: the sender of replyable emails (responses to a form's submitter).
  fromAddress: string | null;
  // Nov 1 notes (batch 8): EMAIL_FROM_NOREPLY (else EMAIL_FROM), the sender of every other email.
  noReplyAddress?: string | null;
  isAdmin: boolean;
}) {
  const [pending, run] = useServerAction();
  const [value, setValue] = useState(senderName ?? "");
  const problem = value.trim() ? senderNameProblem(value.trim()) : null;
  const preview = fromAddress ? senderPreview(value, fromAddress, noReplyAddress) : null;

  return (
    <SettingsCard
      id="workspace-sender"
      title="Sender name"
      description="The name people see in their inbox on invites, comment emails, and automation emails. Leave it empty to use the address as configured."
      adminOnly
      isAdmin={isAdmin}
    >
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (problem) return;
          run(() => updateWorkspaceSettings({ emailSenderName: value.trim() || null }));
        }}
      >
        <div className="flex min-w-56 flex-1 flex-col gap-1">
          <label htmlFor="workspace-sender-name" className="text-xs font-medium text-zinc-600">
            Name
          </label>
          <input
            id="workspace-sender-name"
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            maxLength={SENDER_NAME_MAX}
            placeholder="e.g. Autumn Lake Marketing"
            aria-invalid={problem ? true : undefined}
            aria-describedby="workspace-sender-hint"
            className="field"
          />
        </div>
        <button type="submit" disabled={pending || Boolean(problem) || value.trim() === (senderName ?? "")} className="btn-secondary h-9">
          Save
        </button>
        <p id="workspace-sender-hint" className={`basis-full text-xs ${problem ? "text-red-600" : "text-zinc-500"}`}>
          {problem ?? (preview ? `Emails come from: ${preview}` : "No sending address is configured yet, so emails aren’t sent.")}
        </p>
      </form>
    </SettingsCard>
  );
}
