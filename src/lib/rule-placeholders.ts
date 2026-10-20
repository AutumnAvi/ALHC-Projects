// {{placeholders}} in rule text (Automations V2, batch 3). The database renders them when a rule runs
// (public.render_rule_text_as / rule_placeholder_value in 20261020010000_automations_v2.sql); this
// module lists them for the builder's "Insert placeholder" picker and renders the same way for the
// live preview with sample values. Keys are case-insensitive; unknown ones render empty. The original
// single-brace tokens ({task}, {assignee}, …) keep working, in the same single pass.

export type PlaceholderDef = {
  key: string;
  label: string;
  group: string;
  description: string;
  sample: string;
  keywords?: readonly string[];
};

export const PLACEHOLDERS: readonly PlaceholderDef[] = [
  { key: "task.name", label: "Task name", group: "Task", description: "The task’s name", sample: "Spring flyer", keywords: ["title"] },
  { key: "task.url", label: "Task link", group: "Task", description: "A link to the task (people sign in to open it)", sample: "https://projects.example.com/projects/…?task=…", keywords: ["link", "url"] },
  { key: "task.section", label: "Section", group: "Task", description: "The task’s section in this project", sample: "In review", keywords: ["column", "status"] },
  { key: "task.status", label: "Status", group: "Task", description: "Open or Complete", sample: "Open", keywords: ["complete"] },
  { key: "task.type", label: "Task type", group: "Task", description: "Task, Milestone, or Approval", sample: "Task", keywords: ["kind"] },
  { key: "task.request_number", label: "Request number", group: "Task", description: "The task’s number label, when numbering is on", sample: "REQ-042", keywords: ["req", "number"] },
  { key: "task.tags", label: "Tags", group: "Task", description: "The task’s tags, comma-separated", sample: "Print, Urgent", keywords: ["labels"] },
  { key: "task.assignee", label: "Assignee", group: "People", description: "The assignee’s name", sample: "Dana Diaz", keywords: ["owner", "person"] },
  { key: "task.creator", label: "Creator", group: "People", description: "Who created the task", sample: "Avi Weinreb", keywords: ["author", "requester"] },
  { key: "submitter.email", label: "Submitter email", group: "People", description: "The form submitter’s address", sample: "sam@example.com", keywords: ["requester", "form"] },
  { key: "task.due_date", label: "Due date", group: "Dates", description: "Like Oct 24, 2026 (empty without one)", sample: "Oct 24, 2026", keywords: ["deadline"] },
  { key: "task.start_date", label: "Start date", group: "Dates", description: "Like Oct 20, 2026", sample: "Oct 20, 2026", keywords: ["begin"] },
  { key: "today", label: "Today", group: "Dates", description: "The day the rule runs", sample: "Oct 19, 2026", keywords: ["date", "now"] },
  { key: "project.name", label: "Project name", group: "Project", description: "This project", sample: "Creative Requests" },
  { key: "form.name", label: "Form name", group: "Forms", description: "The form that created the task", sample: "Design request", keywords: ["intake"] },
  { key: "approval.note", label: "Approval note", group: "Other", description: "The approver’s note (approval triggers)", sample: "Please use the new logo", keywords: ["feedback"] },
  { key: "rule.name", label: "Rule name", group: "Other", description: "This rule’s name", sample: "Route by request type" },
];

// Short forms the database also accepts (the spec's {{assignee}}, {{due_date}}, {{field:Request type}}).
const ALIASES: Record<string, string> = {
  "task.title": "task.name",
  task: "task.name",
  name: "task.name",
  title: "task.name",
  "task.link": "task.url",
  url: "task.url",
  link: "task.url",
  "task.assignee.name": "task.assignee",
  assignee: "task.assignee",
  "task.creator.name": "task.creator",
  creator: "task.creator",
  "task.due": "task.due_date",
  due_date: "task.due_date",
  due: "task.due_date",
  start_date: "task.start_date",
  section: "task.section",
  "task.req": "task.request_number",
  request_number: "task.request_number",
  req: "task.request_number",
  status: "task.status",
  type: "task.type",
  tags: "task.tags",
  project: "project.name",
  submitter: "submitter.email",
  "requester.email": "submitter.email",
  requester: "submitter.email",
  form: "form.name",
  approval_note: "approval.note",
  rule: "rule.name",
};

// The canonical key for what's between the braces: lowercase, single spaces, aliases resolved,
// "field:Name" → "field.name", "form.answer.X" → "form.field.x".
export function placeholderKey(raw: string): string {
  const k = raw.trim().replace(/\s+/g, " ").toLowerCase();
  if (k.startsWith("field:")) return `field.${k.slice(6).trim()}`;
  if (k.startsWith("form.answer.")) return `form.field.${k.slice(12).trim()}`;
  return ALIASES[k] ?? k;
}

export function fieldPlaceholder(fieldName: string): string {
  return `{{field.${fieldName.trim()}}}`;
}

export function formAnswerPlaceholder(questionLabel: string): string {
  return `{{form.field.${questionLabel.trim()}}}`;
}

// Same pattern as render_rule_text_as: {{ up to 120 characters without braces }} or an original token.
const TOKEN = /\{\{([^{}]{1,120})\}\}|\{(task_link|assignee|creator|task|req|due|approval_note|project|section)\}/g;

export type PlaceholderValues = Record<string, string | null | undefined>;

// Renders like the database: one pass, values never re-scanned, unknown placeholders empty. `values`
// is keyed by canonical key (placeholderKey); field.<name> and form.field.<label> keys are lowercase.
// Old tokens: {assignee} / {creator} read as @Name, {due} as "Oct 24" or "no due date", {section} falls
// back to "No section" (so does {{task.section}}), {task_link} is left as typed (it is a Slack token).
export function renderPlaceholders(template: string, values: PlaceholderValues): string {
  return template
    .replace(TOKEN, (whole, key: string | undefined, token: string | undefined) => {
      if (key !== undefined) {
        const canonical = placeholderKey(key);
        return canonical === "task.section" ? values[canonical] || "No section" : (values[canonical] ?? "");
      }
      switch (token) {
        case "task_link":
          return whole;
        case "assignee":
          return values["task.assignee"] ? `@${values["task.assignee"]}` : "";
        case "creator":
          return values["task.creator"] ? `@${values["task.creator"]}` : "";
        case "task":
          return values["task.name"] ?? "";
        case "req":
          return values["task.request_number"] ?? "";
        case "due":
          return values["task.due_date"] ? values["task.due_date"]!.replace(/, \d{4}$/, "") : "no due date";
        case "approval_note":
          return values["approval.note"] ?? "";
        case "project":
          return values["project.name"] ?? "";
        case "section":
          return values["task.section"] || "No section";
        default:
          return "";
      }
    })
    .trim();
}

// Placeholder keys used in a text that the builder doesn't know (typos): shown as a warning.
export function unknownPlaceholders(template: string, known: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(TOKEN)) {
    if (m[1] === undefined) continue;
    const key = placeholderKey(m[1]);
    if (!known.has(key) && !key.startsWith("field.") && !key.startsWith("form.field.")) out.add(m[1].trim());
  }
  return [...out];
}

// Sample values for the preview: the fixed list's samples, plus one per custom field and form question.
export function samplePlaceholderValues(input: {
  projectName?: string;
  fields?: { name: string; fieldType: string; options?: { name: string }[] }[];
  questions?: { label: string }[];
}): PlaceholderValues {
  const values: PlaceholderValues = Object.fromEntries(PLACEHOLDERS.map((p) => [p.key, p.sample]));
  if (input.projectName) values["project.name"] = input.projectName;
  for (const f of input.fields ?? []) {
    values[`field.${f.name.trim().toLowerCase()}`] =
      f.options?.[0]?.name ??
      { number: "1500", date: "2026-10-24", boolean: "Yes", people: "Dana Diaz" }[f.fieldType] ??
      `Sample ${f.name}`;
  }
  for (const q of input.questions ?? []) values[`form.field.${q.label.trim().toLowerCase()}`] = `Sample answer to “${q.label}”`;
  return values;
}

// {{task.url}} is rendered as an "alhc-link:" marker in email text (the database doesn't know the app's
// origin): the email renderer turns exact task paths into absolute links, or drops them without one.
const TASK_PATH = "/projects/[0-9a-f-]{36}\\?task=[0-9a-f-]{36}";
const URL_MARKER = new RegExp(`alhc-link:(${TASK_PATH})`, "g");

export function resolveTaskLinkMarkers(text: string, origin: string | null): string {
  return text.replace(URL_MARKER, (_, path: string) => (origin ? `${origin}${path}` : ""));
}
