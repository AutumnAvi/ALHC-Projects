"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// A button with a floating panel. The panel is position: fixed and rendered on document.body (a portal),
// so neither scrolling containers (e.g. the project tab bar) nor a transformed ancestor (the bulk bar is
// centred with a transform, which would make "fixed" relative to it) can clip or offset it. It is kept
// inside the window: once drawn it flips to the
// other side of the button when there's no room, then shifts to stay 8 px from every edge. Closes on
// outside click, Escape, scroll, and resize.
export function Popover({
  label,
  button,
  buttonClassName,
  align = "start",
  side = "bottom",
  panelClassName = "w-72",
  children,
}: {
  label: string;
  button: ReactNode;
  buttonClassName?: string;
  align?: "start" | "end";
  // "top" opens above the button (for bars docked at the bottom of the screen).
  side?: "bottom" | "top";
  panelClassName?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [position, setPosition] = useState<{
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
    // Set once the panel has been measured and moved into view (so it's adjusted only once).
    placed?: boolean;
  } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const open = position !== null;
  const close = () => setPosition(null);

  useLayoutEffect(() => {
    if (!position || position.placed) return;
    const panel = panelRef.current?.getBoundingClientRect();
    const anchor = buttonRef.current?.getBoundingClientRect();
    if (!panel || !anchor) return;
    const margin = 8;
    const width = window.innerWidth;
    const height = window.innerHeight;
    // Keep the original anchor (top or bottom, left or right) unless that side overflows, so a panel
    // that opens upward keeps its bottom on the button while its content grows or shrinks.
    const next = { ...position, placed: true };
    if (panel.bottom > height - margin || panel.top < margin) {
      const above = anchor.top - panel.height - 4;
      const below = anchor.bottom + 4;
      const top =
        panel.bottom > height - margin
          ? above >= margin
            ? above
            : height - panel.height - margin
          : below + panel.height <= height - margin
            ? below
            : margin;
      next.top = Math.max(top, margin);
      next.bottom = undefined;
    }
    if (panel.right > width - margin || panel.left < margin) {
      next.left = Math.max(Math.min(panel.left, width - panel.width - margin), margin);
      next.right = undefined;
    }
    setPosition(next);
  }, [position]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) setPosition(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPosition(null);
        buttonRef.current?.focus();
      }
    };
    const onScroll = (e: Event) => {
      if (!panelRef.current?.contains(e.target as Node)) setPosition(null);
    };
    const onResize = () => setPosition(null);
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  function toggle() {
    if (open) return close();
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const vertical = side === "top" ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 };
    setPosition(
      align === "end"
        ? { ...vertical, right: Math.max(window.innerWidth - rect.right, 8) }
        : { ...vertical, left: Math.max(Math.min(rect.left, window.innerWidth - 300), 8) },
    );
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
        className={buttonClassName}
      >
        {button}
      </button>
      {position
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-label={label}
              style={{ top: position.top, bottom: position.bottom, left: position.left, right: position.right }}
              // Above dialogs (z-50): a popover opened from a dialog must not sit under it.
              className={`fixed z-[60] max-h-[70vh] overflow-y-auto rounded-lg border border-zinc-200 bg-white p-3 text-sm shadow-lg ${panelClassName}`}
            >
              {children(close)}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function MenuItem({
  onClick,
  children,
  danger = false,
  disabled = false,
}: {
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm disabled:opacity-40 ${
        danger ? "text-red-700 hover:bg-red-50" : "text-zinc-700 hover:bg-zinc-100"
      }`}
    >
      {children}
    </button>
  );
}
