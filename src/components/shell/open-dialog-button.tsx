"use client";

import type { ReactNode } from "react";
import { useShell } from "@/components/shell/shell-context";
import type { ShellDialog } from "@/lib/shell";

// A button on a server-rendered page that opens one of the shell's create flows (the New project
// gallery, New portfolio, New goal, …), the same ones the top bar's Create menu opens.
export function OpenDialogButton({
  dialog,
  className = "btn-primary",
  children,
  label,
}: {
  dialog: ShellDialog;
  className?: string;
  children: ReactNode;
  // An accessible name when the content is only an icon.
  label?: string;
}) {
  const { openDialog } = useShell();
  return (
    <button type="button" aria-haspopup="dialog" aria-label={label} onClick={() => openDialog(dialog)} className={className}>
      {children}
    </button>
  );
}
