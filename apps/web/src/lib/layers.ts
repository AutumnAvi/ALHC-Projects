// Nov 2 notes (batch 14, 99): the app's one stacking order. Every floating thing uses one of these, so
// a palette never opens under a menu and a menu opened from a dialog never hides behind it.
//
//   content     sticky headers and pinned List cells                     z-10 / z-[1]
//   pane        the task side pane                                       z-30
//   panel       right panels (Customize, status sheet), bulk bar, drawer z-40
//   modal       dialogs, full-screen task, form editor, rule canvas      z-50
//   assistant   the AI assistant's bubble and panel (round 4, note 174:  z-[55]
//               usable on top of the rule canvas and the full-screen task)
//   assistantModal  a modal opened from the assistant (Expand)           z-[57]
//   popover     menus and pickers (also when opened inside a modal)      z-[60]
//   floating    hover cards, tooltips, smart picker lists, vocab picker  z-[70]
//   palette     the ⌘K search palette (above every menu)                 z-[75]
//   alert       confirm / alert / prompt dialogs                         z-[80]
//   toast       toasts                                                   z-[90]
//
// Popovers and pickers also register with the overlay registry (components/overlay-registry.ts): one
// open at a time (a picker inside a menu keeps its menu open), and opening a modal or the palette
// closes them all first.
export const LAYER = {
  pane: "z-30",
  panel: "z-40",
  modal: "z-50",
  assistant: "z-[55]",
  assistantModal: "z-[57]",
  popover: "z-[60]",
  floating: "z-[70]",
  palette: "z-[75]",
  alert: "z-[80]",
  toast: "z-[90]",
} as const;

export type Layer = keyof typeof LAYER;

// Numeric values, for tests and inline styles.
export const LAYER_Z: Record<Layer, number> = {
  pane: 30,
  panel: 40,
  modal: 50,
  assistant: 55,
  assistantModal: 57,
  popover: 60,
  floating: 70,
  palette: 75,
  alert: 80,
  toast: 90,
};
