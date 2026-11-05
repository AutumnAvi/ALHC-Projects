"use client";

import { useState } from "react";
import { effectiveRuleName } from "@alhc/core/rule-autoname";

// Nov 1 notes, batch 10 (76): the rule name box. Until someone types a name it shows the automatic one
// (muted); typing over it makes the name theirs; emptying the box goes back to the automatic name.
export function useAutoName(initial: string | null | undefined, auto: string) {
  const [typed, setTyped] = useState(initial ?? "");
  const [edited, setEdited] = useState(Boolean(initial?.trim()));
  return {
    // The box's value.
    value: edited ? typed : auto,
    // True while the box shows the automatic name.
    isAuto: !edited,
    onChange(next: string) {
      setTyped(next);
      setEdited(next.trim() !== "");
    },
    // What saving sends.
    name: effectiveRuleName(typed, edited, auto),
  };
}
