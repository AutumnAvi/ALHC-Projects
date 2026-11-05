"use client";

import { useEffect, type RefObject } from "react";

// Nov 2 notes (batch 14, 99): one popover or menu open at a time. Every popover / picker registers here
// while it's open; opening another closes the rest — except the ones it was opened from (a picker inside
// a menu, a menu inside a dialog's popover), found by whether their panel contains the new one's button.
// Opening a modal, a right panel, or the ⌘K palette closes every popover first (closeAllPopovers).
export type OpenPopover = {
  close: () => void;
  // The popover's own panel (and button): an anchor inside it means "opened from this one".
  contains: (node: Node) => boolean;
};

const open = new Set<OpenPopover>();

export function registerPopover(entry: OpenPopover, anchor: Node | null): () => void {
  for (const other of [...open]) {
    if (other === entry) continue;
    if (anchor && other.contains(anchor)) continue;
    other.close();
    open.delete(other);
  }
  open.add(entry);
  return () => {
    open.delete(entry);
  };
}

// `inside`: a modal drawn inside a popover's panel (a dialog opened from a menu that renders it in
// place) keeps that popover open — closing it would take the modal with it.
export function closeAllPopovers(inside: Node | null = null) {
  for (const entry of [...open]) {
    if (inside && entry.contains(inside)) continue;
    open.delete(entry);
    entry.close();
  }
}

export function openPopoverCount() {
  return open.size;
}

// For modals, right panels, and the palette: closes every open popover when it opens (but not one the
// modal itself is drawn inside; pass its element).
export function useClosesPopovers(active = true, element?: RefObject<Element | null>) {
  useEffect(() => {
    if (active) closeAllPopovers(element?.current ?? null);
  }, [active, element]);
}
