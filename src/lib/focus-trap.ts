// Keeping Tab inside a modal window (Oct 29 notes, batch 7, item 48's pop-out editor): Tab from the
// last control goes back to the first, Shift+Tab from the first to the last, and Tab while the focus is
// outside the window (behind it, or nowhere) brings it in. Everything in between is the browser's own
// order. Pure, so the rule is unit-tested; the editor applies it to its window's controls.

// The controls a keyboard reaches, in document order.
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

// Which of `count` controls Tab should focus when the focus is on `index` (-1 = outside the window), or
// null to let the browser move it. With nothing to focus, null.
export function trappedTabTarget(count: number, index: number, shift: boolean): number | null {
  if (count <= 0) return null;
  if (index < 0 || index >= count) return shift ? count - 1 : 0;
  if (!shift && index === count - 1) return 0;
  if (shift && index === 0) return count - 1;
  return null;
}
