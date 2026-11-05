// Nov 5 note 166: a subtask made from an approver's feedback on one file is named feedback first, then
// the file ("Make the logo bigger — logo_autumn_lake.pdf"), and the file's name is drawn as a chip that
// opens the file, like an @person chip in a name (note 162).
//
// The name stays plain text, so search, emails, exports, and notifications read it as written. The chip
// is resolved by id: the subtask's description carries one line per file, "File: <name> (<link to
// /attachments/<id>>)", written when the subtask is made. The name kept on that line (not the file's
// current name) is what the title is matched against, so the chip keeps opening the same file by id. A
// task's own files, and a parent's files in its subtask list, are matched by name too, so subtasks made
// before this ("logo.pdf: Do better") get the chip as well. Pure, so the unit tests can pin it.

export type TitleAsset = { id: string; name: string; contentType?: string | null };

export type AssetSegment = { kind: "text"; text: string } | { kind: "asset"; text: string; asset: TitleAsset };

// Between the feedback and the file's name (feedbackAssetTitle in feedback-subtask.ts).
export const ASSET_TITLE_SEPARATOR = " — ";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// The description line that ties a subtask to a file by id. `origin` makes the link work from an email or
// another app; without it the line still carries the id.
export function assetRefLine(asset: Pick<TitleAsset, "id" | "name">, origin: string | null = null): string {
  const name = asset.name.replace(/\s+/g, " ").trim();
  return `File: ${name} (${origin ?? ""}/attachments/${asset.id})`;
}

const REF_LINE = new RegExp(`^File: (.+) \\((?:[^\\s()]*?)/attachments/(${UUID})(?:[?#][^\\s()]*)?\\)\\s*$`, "gim");

// Every file a description refers to with assetRefLine, in order, each id once.
export function parseAssetRefs(notes: string | null | undefined): TitleAsset[] {
  if (!notes || !notes.includes("/attachments/")) return [];
  const out: TitleAsset[] = [];
  for (const match of notes.matchAll(REF_LINE)) {
    const id = match[2].toLowerCase();
    const name = match[1].trim();
    if (name && !out.some((a) => a.id === id)) out.push({ id, name });
  }
  return out;
}

// The file named right after the cut must end there: the end of the name, a space, or punctuation that
// can't be part of a file name's last word.
const BEFORE = /[\s([{"“‘—–:-]/;
const AFTER = /[\s)\]}"”’,;:!?—–]/;

// The title cut into text and file chips. A file's name (any case) is a chip where it starts the title or
// follows a space, a dash, a colon, or an opening bracket, and ends at the end, a space, or punctuation.
// The longest name wins; each piece of text is matched once. Names shorter than 3 characters never match.
export function titleAssetSegments(title: string, assets: readonly TitleAsset[]): AssetSegment[] {
  const candidates = assets
    .map((asset) => ({ asset, name: asset.name.trim().toLowerCase() }))
    .filter((c) => c.name.length >= 3)
    .sort((a, b) => b.name.length - a.name.length);
  if (!title || candidates.length === 0) return [{ kind: "text", text: title }];
  const lower = title.toLowerCase();
  const segments: AssetSegment[] = [];
  let from = 0;
  let at = 0;
  while (at < title.length) {
    const startsOk = at === 0 || BEFORE.test(title[at - 1]);
    const hit = startsOk
      ? candidates.find((c) => {
          if (!lower.startsWith(c.name, at)) return false;
          const next = title[at + c.name.length];
          return next === undefined || AFTER.test(next) || (next === "." && at + c.name.length === title.length - 1);
        })
      : undefined;
    if (!hit) {
      at++;
      continue;
    }
    const end = at + hit.name.length;
    if (at > from) segments.push({ kind: "text", text: title.slice(from, at) });
    segments.push({ kind: "asset", text: title.slice(at, end), asset: hit.asset });
    from = end;
    at = end;
  }
  if (from < title.length) segments.push({ kind: "text", text: title.slice(from) });
  return segments.length ? segments : [{ kind: "text", text: title }];
}

// The files a task's name can chip: those its description refers to (by id) first, then the extra ones
// given (its own files, or a parent's files in its subtask list); each id once.
export function titleAssetsFor(notes: string | null | undefined, extra: readonly TitleAsset[] = []): TitleAsset[] {
  const refs = parseAssetRefs(notes);
  const byId = new Map(extra.map((a) => [a.id, a] as const));
  // A ref takes the file's content type when it's one of the extra ones (for the chip's icon).
  const out: TitleAsset[] = refs.map((r) => ({ ...r, contentType: byId.get(r.id)?.contentType ?? null }));
  for (const a of extra) if (!out.some((o) => o.id === a.id)) out.push(a);
  return out;
}
