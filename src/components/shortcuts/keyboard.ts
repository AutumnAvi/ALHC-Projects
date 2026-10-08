"use client";

import { useEffect, useRef } from "react";

// Shortcuts never fire while someone is typing: text inputs, textareas, selects, and editable content.
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(target.type);
  }
  return Boolean(target.closest("[contenteditable=''], [contenteditable='true']"));
}

// An open dialog (popover, help overlay, bulk summary) owns the keyboard until it closes.
export function dialogOpen(): boolean {
  return Boolean(document.querySelector("[role='dialog'], [role='alertdialog']"));
}

export const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export type ListKeyHandlers = {
  move: (delta: 1 | -1, extend: boolean) => void;
  open: () => void;
  escape: () => boolean; // true when it handled the key
  complete: () => void;
  quickAdd?: () => void;
  assignToMe: () => void;
};

const CHORD_MS = 1000;

// List shortcuts: ↑/↓ (moves the cursor), Enter, Esc, ⌘/Ctrl+Enter, and the Tab chords Tab→Q (quick add)
// and Tab→M (assign to me). Tab keeps its normal focus behaviour; Q or M within a second afterwards,
// with focus still outside a text field, completes the chord.
export function useListKeys(handlers: ListKeyHandlers) {
  const ref = useRef(handlers);
  const tabAt = useRef(0);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      if (isTypingTarget(e.target)) {
        tabAt.current = 0;
        return;
      }
      const h = ref.current;
      if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        tabAt.current = Date.now();
        return;
      }
      const chord = Date.now() - tabAt.current < CHORD_MS;
      tabAt.current = 0;
      if (dialogOpen()) return;
      const key = e.key.toLowerCase();
      if (chord && !e.metaKey && !e.ctrlKey && !e.altKey && (key === "q" || key === "m")) {
        e.preventDefault();
        if (key === "q") h.quickAdd?.();
        else h.assignToMe();
        return;
      }
      if (e.altKey) return;
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.metaKey && !e.ctrlKey) {
        // Arrow keys inside a focused control (e.g. a select) keep their own meaning.
        e.preventDefault();
        h.move(e.key === "ArrowDown" ? 1 : -1, e.shiftKey);
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        h.complete();
      } else if (e.key === "Enter" && !e.shiftKey && isRowOrBody(e.target)) {
        e.preventDefault();
        h.open();
      } else if (e.key === "Escape") {
        if (h.escape()) e.preventDefault();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

// Enter on a focused button or link keeps activating it; only rows and the page itself open the pane.
function isRowOrBody(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return true;
  if (target === document.body) return true;
  if (target.closest("button, a, input, select, textarea, [role='button']")) return false;
  return true;
}

export function scrollRowIntoView(taskId: string) {
  document
    .querySelector(`[data-task-row="${CSS.escape(taskId)}"]`)
    ?.scrollIntoView({ block: "nearest" });
}
