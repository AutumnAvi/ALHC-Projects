// Nov 4 notes (batch 27, 161): an approval round's feedback as small pills next to the task's files —
// one per file the approver reviewed ("✗ logo.pdf: Do better", "✓ flyer.png: approved"; the lines
// approverDecisionNote() writes), plus the approver's overall note. Pure, so the unit tests can pin it.
import type { ApprovalRound } from "@/lib/data";

export type FeedbackTone = "approved" | "changes_requested" | "rejected";

export type FeedbackItem = {
  key: string;
  // A file's own feedback, or the approver's note for the whole round.
  kind: "file" | "note";
  fileId: string | null;
  fileName: string | null;
  text: string;
  tone: FeedbackTone;
  approverId: string;
  decidedAt: string | null;
};

const MARKS = "✓✔✗✘✕×";
const MARK_LINE = new RegExp(`^\\s*([${MARKS}])\\s+`);

export type ParsedDecisionNote = { files: { name: string; approved: boolean; text: string }[]; overall: string };

// Splits a decision note into its per-file lines and the overall note. `fileNames` (the round's files)
// lets a name holding ": " be read whole; without a match the name runs to the first ": ".
export function parseDecisionNote(note: string, fileNames: readonly string[] = []): ParsedDecisionNote {
  const lines = note.replace(/\r\n?/g, "\n").split("\n");
  const files: ParsedDecisionNote["files"] = [];
  const names = [...fileNames].sort((a, b) => b.length - a.length);
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const mark = MARK_LINE.exec(line);
    if (!mark) {
      // A file's note that ran over several lines; a blank line (or a line before any file) ends the list.
      if (files.length && line.trim()) {
        files[files.length - 1].text += `\n${line}`;
        continue;
      }
      break;
    }
    const rest = line.slice(mark[0].length);
    const known = names.find((n) => rest.startsWith(`${n}:`));
    const cut = known ? known.length : rest.indexOf(":");
    if (cut <= 0) break;
    const approved = "✓✔".includes(mark[1]);
    files.push({ name: rest.slice(0, cut).trim(), approved, text: rest.slice(cut + 1).trim() });
  }
  const overall = (files.length ? lines.slice(i) : lines).join("\n").trim();
  return { files, overall };
}

// The latest decided round's feedback: each approver's per-file lines and overall note. An approved file
// whose line only says "approved" is a green pill without more text.
export function roundFeedback(round: ApprovalRound | null, attachments: readonly { id: string; fileName: string }[]): FeedbackItem[] {
  if (!round || (round.status !== "changes_requested" && round.status !== "rejected" && round.status !== "approved")) return [];
  const roundFiles = round.attachmentIds.flatMap((id) => {
    const a = attachments.find((f) => f.id === id);
    return a ? [a] : [];
  });
  const items: FeedbackItem[] = [];
  for (const request of round.requests) {
    if (request.status !== "approved" && request.status !== "changes_requested" && request.status !== "rejected") continue;
    if (!request.decisionNote?.trim()) continue;
    const parsed = parseDecisionNote(request.decisionNote, roundFiles.map((f) => f.fileName));
    parsed.files.forEach((file, index) => {
      const match = roundFiles.find((f) => f.fileName === file.name) ?? null;
      items.push({
        key: `${request.id}:file:${index}`,
        kind: "file",
        fileId: match?.id ?? null,
        fileName: file.name,
        text: file.approved && /^approved\.?$/i.test(file.text) ? "" : file.text,
        tone: file.approved ? "approved" : request.status === "rejected" ? "rejected" : "changes_requested",
        approverId: request.approverId,
        decidedAt: request.decidedAt,
      });
    });
    if (parsed.overall) {
      items.push({
        key: `${request.id}:note`,
        kind: "note",
        fileId: null,
        fileName: null,
        text: parsed.overall,
        tone: request.status,
        approverId: request.approverId,
        decidedAt: request.decidedAt,
      });
    }
  }
  // Feedback first, then approved files.
  return items.sort((a, b) => Number(a.tone === "approved") - Number(b.tone === "approved"));
}

// "logo_autumn_lake_healthcare_at_arcola.pdf" → "logo_autumn_la…arcola.pdf": the start and the end
// (extension included) of a long file name.
export function shortFileName(name: string, max = 24): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : "";
  const tail = Math.min(8, Math.floor((max - 1) / 3)) + ext.length;
  const head = max - 1 - tail;
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

export function feedbackSnippet(text: string, max = 40): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

// What a pill's feedback becomes when it's turned into a subtask.
export function feedbackSubtaskText(item: Pick<FeedbackItem, "fileName" | "text">): string {
  return item.fileName ? `${item.fileName}: ${item.text}` : item.text;
}
