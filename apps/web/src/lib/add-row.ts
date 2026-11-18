// Nov 18 notes (batch 44, item 4): one inline "Add task" row open at a time on a page. The toolbar's
// "+ Add task" opens a row at the top of a section while a section's own "Add task…" row may already be
// open (it showed in two places at once); opening one closes the others. Pure and unit-tested: the rows
// subscribe, and claiming the slot tells every other open row to close.

type Row = { id: string; close: () => void };

const open = new Map<string, Row>();

// This row is open now: every other open row closes. Returns the release for when it closes or unmounts.
export function claimAddRow(id: string, close: () => void): () => void {
  for (const [otherId, other] of [...open]) {
    if (otherId === id) continue;
    open.delete(otherId);
    other.close();
  }
  open.set(id, { id, close });
  return () => {
    if (open.get(id)?.close === close) open.delete(id);
  };
}

export function openAddRowIds(): string[] {
  return [...open.keys()];
}
