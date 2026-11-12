// Batch 39 (speed and feel): a short exit for overlays that close by unmounting (dialogs, popovers, the
// phone sidebar drawer). React removes the element at once, so focus, Escape, and every listener behave
// exactly as before; this only leaves an inert copy of what was on screen for a moment and fades it out.
// The copy can't be clicked, focused, or read by a screen reader, carries no ids or roles (nothing finds
// it by id, and "a dialog is open" checks don't see it), and is skipped when reduced motion is asked for.

export const EXIT_MS = 140;

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function strip(node: Element) {
  node.removeAttribute("id");
  node.removeAttribute("role");
  node.removeAttribute("aria-modal");
  node.removeAttribute("data-popover-panel");
  node.removeAttribute("data-task-pane");
  // An entrance animation would replay on the copy.
  for (const name of Array.from(node.classList)) if (/^ui-anim-.*-in$/.test(name)) node.classList.remove(name);
  for (const child of Array.from(node.children)) strip(child);
}

// Call with the element that is about to leave (a ref callback's cleanup, or an effect cleanup).
// `exitClass` is one of the ui-anim-*-out classes in globals.css.
export function leaveGhost(node: HTMLElement | null, exitClass: string, ms = EXIT_MS) {
  if (!node || typeof document === "undefined" || reducedMotion()) return;
  // Only something that was on screen: a node already out of the document (or never laid out) has nothing to fade.
  if (!node.isConnected) return;
  const rect = node.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  const ghost = node.cloneNode(true) as HTMLElement;
  strip(ghost);
  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("inert", "");
  ghost.setAttribute("data-exit-ghost", "");
  ghost.style.pointerEvents = "none";
  // Keep it where it was drawn: fixed overlays already are; anything else is pinned to its last box.
  if (getComputedStyle(node).position !== "fixed") {
    Object.assign(ghost.style, {
      position: "fixed",
      top: `${rect.top}px`,
      left: `${rect.left}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      margin: "0",
    });
  }
  ghost.classList.add(exitClass);
  // Before the next paint: only if the element really left (React's development double-run of effects
  // calls the cleanup without removing anything).
  queueMicrotask(() => {
    if (node.isConnected) return;
    document.body.appendChild(ghost);
    window.setTimeout(() => ghost.remove(), ms);
  });
}
