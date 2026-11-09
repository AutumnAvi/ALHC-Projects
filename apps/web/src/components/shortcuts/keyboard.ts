"use client";

import { useEffect, useRef } from "react";

// Shortcuts never fire while someone is typing: text inputs, textareas, selects, and editable content.
export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(target.type);
  }
  return Boolean(target.closest("[contenteditable=''], [contenteditable='true']"));
}

// An open dialog (popover, help overlay, bulk summary) owns the keyboard until it closes. A non-modal
// dialog (aria-modal="false": the AI assistant's floating panel) owns it only while focus is inside it, so
// the page's shortcuts keep working beside it. `except`: dialogs matching it don't count (Tab→A may open
// the assistant over the rule canvas or the full-screen task: data-assistant-allowed).
export function dialogOpen(except?: string): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  for (const el of Array.from(document.querySelectorAll("[role='dialog'], [role='alertdialog']"))) {
    if (el.getAttribute("aria-modal") === "false" && !(active && el.contains(active))) continue;
    if (except && el.matches(except)) continue;
    return true;
  }
  return false;
}

// Dialogs Tab→A may open the AI assistant over (round 4, note 174).
export const ASSISTANT_ALLOWED = "[data-assistant-allowed]";

export const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export type ListKeyHandlers = {
  move: (delta: 1 | -1, extend: boolean) => void;
  open: () => void;
  escape: () => boolean; // true when it handled the key
  complete: () => void;
  quickAdd?: () => void;
  assignToMe: () => void;
};

// How long after Tab the second key of a chord (Tab→Q, Tab→M) still counts.
export const CHORD_MS = 1000;

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
        // Without an inline add here (My tasks), Tab→Q is left to the global Create → Task.
        if (key === "q" && !h.quickAdd) return;
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

// One Tab chord for a page without list keys (Home's My tasks widget takes Tab→Q for its inline add):
// Tab, then `key` within a second, with focus outside a text field and no dialog open. Taking the chord
// prevents the event's default, so the global Create → Task stands down (keyboard-shortcuts.tsx).
// `allowOver`: dialogs the chord still works over (a selector; e.g. ASSISTANT_ALLOWED).
export function useTabChord(key: string, handler: () => void, opts: { allowOver?: string } = {}) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  const allowOver = opts.allowOver;

  useEffect(() => {
    const onKey = tabChordHandler(key, () => ref.current(), { allowOver });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key, allowOver]);
}

type KeyLike = Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey" | "defaultPrevented" | "target" | "preventDefault">;

// The chord's key handler (exported for tests): it only ever prevents the chord's own second key, and
// never touches a key typed into a text field (paste, dictation, ⌘ / Ctrl / Fn shortcuts, Space).
export function tabChordHandler(key: string, fire: () => void, opts: { allowOver?: string; now?: () => number } = {}) {
  let tabAt = 0;
  const now = opts.now ?? Date.now;
  return function onKey(e: KeyLike) {
    if (e.defaultPrevented) return;
    if (isTypingTarget(e.target)) {
      tabAt = 0;
      return;
    }
    if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      tabAt = now();
      return;
    }
    const chord = now() - tabAt < CHORD_MS;
    tabAt = 0;
    if (!chord || e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== key || dialogOpen(opts.allowOver)) return;
    e.preventDefault();
    fire();
  };
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
