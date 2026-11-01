// Nov 1 notes, batch 8 (item 58): the app frame never lets the document scroll.
//
// What caused the white bar: visually hidden text (`sr-only`, position: absolute) and other absolutely
// positioned bits inside a page's own scroll area take .app-main (position: relative, overflow visible)
// as their containing block, so they escape that scroll area and are laid out where the content would
// be — far below the window on a long List or report. The document grew to fit them, and when the
// sidebar (or any inner scroll area) reached its end the wheel / touch scroll carried on into the
// document: the whole shell slid up and the white body showed under it.
//
// The fix has three parts:
// - the frame clips its own overflow (overflow: clip — not hidden, so nothing can scroll it, focus and
//   scrollIntoView included, and position: sticky inside keeps working), so nothing inside it can make
//   the document taller than the window;
// - while a frame is on the page the document itself doesn't scroll or bounce (globals.css:
//   html:has(.app-shell) / html:has(.admin-shell), screen only — public pages and print are untouched);
// - inner scroll areas stop scroll chaining at their ends (overscroll-behavior: contain).
//
// The print stylesheet (globals.css) lets the frames flow onto paper again.
export const APP_SHELL_FRAME = "app-shell flex h-full flex-col overflow-clip";
export const ADMIN_SHELL_FRAME = "admin-shell flex h-full flex-col overflow-clip";

// An inner scroll area of the frame (sidebar, page content, task pane, Customize, the drawer).
export const SCROLL_AREA = "overflow-y-auto overscroll-contain";
