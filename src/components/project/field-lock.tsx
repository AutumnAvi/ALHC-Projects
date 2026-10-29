import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { Popover } from "@/components/popover";
import { LOCKED_FIELD_NOTE } from "@/lib/fields";

// Oct 29 notes (batch 7): the small lock beside a locked field — its List column header, the pane's
// label, the Fields list, a value someone can't change. Hovering it says who can change the field.
// `focusable` (once per field: a column header, the pane's label, a Fields list row that isn't itself a
// button) makes it a button for keyboard and touch: focus shows the tooltip, Enter / a tap opens the note.
// Per-row locks (List cells, Board cards) stay plain, so they add no tab stops.
export function FieldLockIcon({
  className = "size-3",
  label = LOCKED_FIELD_NOTE,
  focusable = false,
}: {
  className?: string;
  label?: string;
  focusable?: boolean;
}) {
  if (focusable) {
    return (
      <Popover
        label={label}
        tooltip={label}
        button={<Lock className={className} aria-hidden />}
        buttonClassName="inline-flex shrink-0 items-center rounded text-zinc-400 hover:text-zinc-600 focus-visible:outline-2 focus-visible:outline-accent-500"
        panelClassName="w-64"
      >
        {() => (
          <p className="flex items-start gap-2 text-xs text-zinc-700" data-field-lock-note>
            <Lock className="mt-px size-3.5 shrink-0 text-zinc-500" aria-hidden />
            <span>{/[.!?]$/.test(label) ? label : `${label}.`}</span>
          </p>
        )}
      </Popover>
    );
  }
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
