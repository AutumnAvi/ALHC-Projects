"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

// A small modal: overlay, focus moves into the panel, Escape or the overlay closes it, and focus
// returns to whatever opened it. Keyboard shortcuts stand down while a role="dialog" is open.
export function Dialog({
  title,
  description,
  onClose,
  children,
  width = "max-w-md",
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: string;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const returnFocus = document.activeElement as HTMLElement | null;
    const focusable = "input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])";
    const first =
      bodyRef.current?.querySelector<HTMLElement>("[data-autofocus]") ??
      bodyRef.current?.querySelector<HTMLElement>(focusable) ??
      panelRef.current?.querySelector<HTMLElement>("button");
    first?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      returnFocus?.focus?.();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/30 p-4" onMouseDown={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
        className={`max-h-[90vh] w-full ${width} overflow-y-auto rounded-xl border border-zinc-200 bg-white p-5 text-sm shadow-xl`}
      >
        <div className="flex items-start gap-2">
          <h2 id={titleId} className="flex-1 font-semibold text-zinc-900">
            {title}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="btn-icon -mr-1 -mt-1">
            <X className="size-4" />
          </button>
        </div>
        {description ? <div className="mt-1 text-xs text-zinc-500">{description}</div> : null}
        <div ref={bodyRef} className="mt-4">
          {children}
        </div>
      </div>
    </div>
  );
}

export const DIALOG_LABEL = "block text-xs font-medium text-zinc-700";
export const DIALOG_HINT = "mt-1 text-xs text-zinc-500";
