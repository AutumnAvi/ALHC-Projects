// Nov 2 notes (batch 17, 131): turning a piece of feedback (an approver's requested changes, a submitter's
// emailed reply, a review's outcome) into a subtask. Pure (unit-tested).

export const FEEDBACK_TITLE_MAX = 120;

// The subtask's name: the feedback's first line, spaces collapsed, cut at a word near the limit with "…".
export function feedbackSubtaskTitle(feedback: string, fallback = "Follow up on feedback"): string {
  const firstLine = feedback
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find((line) => line.length > 0);
  if (!firstLine) return fallback;
  if (firstLine.length <= FEEDBACK_TITLE_MAX) return firstLine;
  const cut = firstLine.slice(0, FEEDBACK_TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > FEEDBACK_TITLE_MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, "")}…`;
}

// The subtask's description: who the feedback came from and a link back to the task it's on, then the
// whole feedback when the name doesn't already say all of it.
export function feedbackSubtaskNotes(input: { feedback: string; from: string; link: string | null }): string {
  const text = input.feedback.trim();
  const title = feedbackSubtaskTitle(text, "");
  const full = text && (title !== text.replace(/\s+/g, " ").trim() || /\n/.test(text));
  return [
    `Feedback from ${input.from}${input.link ? ` on ${input.link}` : ""}`,
    full ? `\n${text}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join("\n");
}
