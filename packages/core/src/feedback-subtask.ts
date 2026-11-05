// Nov 2 notes (batch 17, 131): turning a piece of feedback (an approver's requested changes, a submitter's
// emailed reply, a review's outcome) into a subtask. Pure (unit-tested).
import { ASSET_TITLE_SEPARATOR, assetRefLine } from "./title-assets";

export const FEEDBACK_TITLE_MAX = 120;

// The subtask's name: the feedback's first line, spaces collapsed, cut at a word near the limit with "…".
export function feedbackSubtaskTitle(feedback: string, fallback = "Follow up on feedback"): string {
  const firstLine = feedback
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find((line) => line.length > 0);
  if (!firstLine) return fallback;
  return cutAtWord(firstLine, FEEDBACK_TITLE_MAX);
}

// One line cut at a word near `max` characters with "…" (unchanged when it fits).
export function cutAtWord(line: string, max: number): string {
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, "")}…`;
}

// Nov 5 note 166: feedback on one file names the subtask feedback first, then the file's name in full
// ("Make the logo bigger — logo.pdf"; the feedback is cut so the file's name fits, since its chip needs
// all of it). No file → the feedback alone (feedbackSubtaskTitle).
export function feedbackAssetTitle(feedback: string, fileName: string | null): string {
  const name = fileName?.replace(/\s+/g, " ").trim() ?? "";
  if (!name) return feedbackSubtaskTitle(feedback);
  const text = feedbackSubtaskTitle(feedback, "");
  if (!text) return `Follow up on ${name}`;
  const room = Math.max(40, FEEDBACK_TITLE_MAX - name.length - ASSET_TITLE_SEPARATOR.length);
  const head = text.length <= room ? text : cutAtWord(text.replace(/…$/, ""), room);
  return `${head}${ASSET_TITLE_SEPARATOR}${name}`;
}

// The subtask's description: who the feedback came from and a link back to the task it's on, then the
// whole feedback when the name doesn't already say all of it. Nov 5 note 166: feedback on one file adds a
// "File: <name> (<link>)" line — the id the name's file chip opens (title-assets.ts).
export function feedbackSubtaskNotes(input: {
  feedback: string;
  from: string;
  link: string | null;
  asset?: { id: string; name: string } | null;
  origin?: string | null;
}): string {
  const text = input.feedback.trim();
  const title = feedbackSubtaskTitle(text, "");
  const full = text && (title !== text.replace(/\s+/g, " ").trim() || /\n/.test(text));
  return [
    `Feedback from ${input.from}${input.link ? ` on ${input.link}` : ""}`,
    input.asset ? assetRefLine(input.asset, input.origin ?? null) : null,
    full ? `\n${text}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join("\n");
}
