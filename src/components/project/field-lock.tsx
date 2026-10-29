import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { LOCKED_FIELD_NOTE } from "@/lib/fields";

// Oct 29 notes (batch 7): the small lock beside a locked field — its List column header, the pane's
// label, the Fields list, a value someone can't change. Hovering it says who can change the field.
export function FieldLockIcon({ className = "size-3", label = LOCKED_FIELD_NOTE }: { className?: string; label?: string }) {
  return (
    <span role="img" aria-label={label} data-tooltip={label} className="inline-flex shrink-0 items-center text-zinc-400">
      <Lock className={className} aria-hidden />
    </span>
  );
}

// A locked field's value for someone who can't change it (List cells, Board cards): the value as it
// reads, then the lock — never an editor.
export function LockedFieldValue({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1" data-locked-field>
      {children}
      <FieldLockIcon />
    </span>
  );
}
