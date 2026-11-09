"use client";

// AI builder round 4 (note 175): the assistant panel's key handling, on its own so tests run it cheaply.
import { isTypingTarget } from "@/components/shortcuts/keyboard";

type KeyLike = Pick<KeyboardEvent, "key" | "defaultPrevented" | "target" | "preventDefault" | "stopPropagation"> & { isComposing?: boolean };

// The panel's Escape (exported for tests): closes it — but never while a text box in it has text (a
// dictation tool's Escape cancels its own insertion; the words stay, and the page behind doesn't see the
// key either), and never during an IME composition. Every other key passes through untouched.
export function assistantKeyHandler(close: () => void) {
  return (e: KeyLike) => {
    if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
    const value = (e.target as { value?: unknown } | null)?.value;
    if (isTypingTarget(e.target) && typeof value === "string" && value.trim()) {
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    close();
  };
}
