import { appLinkSegments, type AppLink } from "@alhc/core/app-links";

// Nov 4 notes (batch 21, note 153): a task or project picked with "#" shows in the comment box (and the
// description) as a chip with its name right away, never as its raw link. A textarea can only hold plain
// text, so the box holds the link's *name* between two invisible marks (CHIP_OPEN, CHIP_CLOSE: default-
// ignorable characters, drawn as nothing) and a layer over it draws that span as a chip. What the box
// reports to its owner — and what gets saved — is still the plain body with the link in it: the names are
// turned back into their links here (displayToBody), and links back into names (bodyToDisplay). Pure and
// unit-tested.

export const CHIP_OPEN = "⁢";
export const CHIP_CLOSE = "⁣";
const MARKS = /[⁢⁣]/g;
const CHIP = /⁢([^⁢⁣\n]*)⁣/g;

// The links picked in this box: link → its chip's name, and name → link (names are kept unique per box).
export type ChipLinks = { byUrl: ReadonlyMap<string, string>; byLabel: ReadonlyMap<string, string> };

export const NO_CHIP_LINKS: ChipLinks = { byUrl: new Map(), byLabel: new Map() };

function cleanName(name: string): string {
  const text = name.replace(MARKS, "").replace(/\s+/g, " ").trim();
  return text || "Link";
}

// Remembers a picked link and returns its chip's name: the task's or project's name, with " (2)", " (3)", …
// when another link in this box already has that name (so every name leads back to one link).
export function addChipLink(links: ChipLinks, url: string, name: string): { links: ChipLinks; label: string } {
  const known = links.byUrl.get(url);
  if (known !== undefined) return { links, label: known };
  const base = cleanName(name);
  let label = base;
  for (let n = 2; links.byLabel.has(label); n += 1) label = `${base} (${n})`;
  const byUrl = new Map(links.byUrl);
  const byLabel = new Map(links.byLabel);
  byUrl.set(url, label);
  byLabel.set(label, url);
  return { links: { byUrl, byLabel }, label };
}

// A box opened on text that already has links (editing a comment or the description): each link whose
// name the reader already has starts as a chip too. One whose name isn't known stays as written.
export function seedChipLinks(body: string, nameFor: (link: AppLink) => string | null | undefined): ChipLinks {
  let links = NO_CHIP_LINKS;
  for (const seg of appLinkSegments(body.replace(MARKS, ""))) {
    if (seg.type !== "link") continue;
    const name = nameFor(seg.link);
    if (name) links = addChipLink(links, seg.raw, name).links;
  }
  return links;
}

export function chipText(label: string): string {
  return `${CHIP_OPEN}${label}${CHIP_CLOSE}`;
}

// The saved body → what the box shows: each picked link becomes its chip. Other text (and links not picked
// here, e.g. pasted ones) stays as it is; marks typed or pasted on their own are dropped.
export function bodyToDisplay(body: string, links: ChipLinks): string {
  const clean = body.replace(MARKS, "");
  if (links.byUrl.size === 0) return clean;
  return appLinkSegments(clean)
    .map((seg) => {
      if (seg.type === "text") return seg.text;
      const label = links.byUrl.get(seg.raw);
      return label === undefined ? seg.raw : chipText(label);
    })
    .join("");
}

// What the box shows → the body: each whole chip becomes its link again. A chip that was cut in two (or
// whose name was changed) is no longer a link: its text stays, without the marks.
export function displayToBody(display: string, links: ChipLinks): string {
  return display.replace(CHIP, (whole, label: string) => links.byLabel.get(label) ?? label).replace(MARKS, "");
}

export type ChipRange = { start: number; end: number; label: string };

// Where the chips are: start = the opening mark, end = just after the closing mark.
export function chipRanges(display: string): ChipRange[] {
  const out: ChipRange[] = [];
  for (const m of display.matchAll(CHIP)) {
    const start = m.index ?? 0;
    out.push({ start, end: start + m[0].length, label: m[1] });
  }
  return out;
}

export function hasChips(display: string): boolean {
  return display.includes(CHIP_OPEN);
}

// The caret never rests inside a chip: it moves to the chip's start when it came from after the chip
// (moving left), else to its end.
export function snapCaret(display: string, caret: number, previous: number | null): number {
  for (const chip of chipRanges(display)) {
    if (caret > chip.start && caret < chip.end) return previous !== null && previous >= chip.end ? chip.start : chip.end;
  }
  return caret;
}

// Backspace right after a chip (or Delete right before one) removes the whole chip.
export function removeChipAt(display: string, caret: number, key: "Backspace" | "Delete"): { display: string; caret: number } | null {
  for (const chip of chipRanges(display)) {
    if ((key === "Backspace" && caret === chip.end) || (key === "Delete" && caret === chip.start)) {
      return { display: display.slice(0, chip.start) + display.slice(chip.end), caret: chip.start };
    }
  }
  return null;
}

// After the box's text was tidied (marks dropped), where the caret goes: the same place, less the marks
// removed before it. `tidied` is `raw` with some characters taken out.
export function caretAfterTidy(raw: string, tidied: string, caret: number): number {
  let i = 0;
  let j = 0;
  while (i < caret && i < raw.length) {
    if (j < tidied.length && raw[i] === tidied[j]) j += 1;
    i += 1;
  }
  return j;
}

// The box's text in pieces for the layer that draws the chips (the marks stay in, drawn as nothing, so
// the layer lines up with the text box character for character).
export type DisplayPiece = { type: "text"; text: string } | { type: "chip"; text: string; label: string };

export function displayPieces(display: string): DisplayPiece[] {
  const out: DisplayPiece[] = [];
  let last = 0;
  for (const chip of chipRanges(display)) {
    if (chip.start > last) out.push({ type: "text", text: display.slice(last, chip.start) });
    out.push({ type: "chip", text: display.slice(chip.start, chip.end), label: chip.label });
    last = chip.end;
  }
  if (last < display.length) out.push({ type: "text", text: display.slice(last) });
  return out;
}
