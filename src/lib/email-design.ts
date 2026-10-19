// Email designs (20261019010000_email_designs.sql): two kinds of email, each with its own look —
// "internal" (no-reply notifications to workspace people) and "requester" (emails to a form's
// submitter, whose replies come back as comments). A design is a logo, an accent color, a header label,
// a heading, an intro message, a button label and color, the email's small print, and a sign-off; since
// Oct 19 notes also a subject template, and a show / hide switch for every block. Workspace admins set
// the workspace default of each kind, project admins a project override, and (requester emails only) a
// form override; every setting resolves form → project → workspace → the built-in default below
// (mirrors resolve_email_design()). Fill-in fields like {task_name} are replaced when an email is
// rendered; unknown ones render blank. Pure: the drain, the editor's preview, and the unit tests use it.

export const EMAIL_DESIGN_KINDS = ["internal", "requester"] as const;
export type EmailDesignKind = (typeof EMAIL_DESIGN_KINDS)[number];

export const EMAIL_DESIGN_KIND_LABELS: Record<EmailDesignKind, string> = {
  internal: "Internal notifications",
  requester: "Requester emails",
};

export const EMAIL_DESIGN_KIND_DESCRIPTIONS: Record<EmailDesignKind, string> = {
  internal:
    "Comments, assignments, @mentions, due dates, digests, and other notifications to people in the workspace. These are no-reply.",
  requester:
    "Form confirmations, responses sent to a form’s submitter, and rule emails to the submitter. Replies come back as comments.",
};

// Text settings: null = inherit, "" = explicitly empty (for the subject, heading, and small print: "this
// email's own").
export const TEXT_DESIGN_FIELDS = [
  "logoPath",
  "accentColor",
  "subjectTemplate",
  "headerText",
  "headingText",
  "introMessage",
  "buttonLabel",
  "buttonColor",
  "noticeText",
  "footerText",
] as const;
// Show / hide switches, one per block of the email: null = inherit.
export const BLOCK_DESIGN_FIELDS = [
  "showLogo",
  "showHeader",
  "showHeading",
  "showIntro",
  "showBody",
  "showDetails",
  "showButton",
  "showNotice",
  "showFooter",
] as const;
export const DESIGN_FIELDS = [...TEXT_DESIGN_FIELDS, ...BLOCK_DESIGN_FIELDS] as const;
export type TextDesignField = (typeof TEXT_DESIGN_FIELDS)[number];
export type BlockDesignField = (typeof BLOCK_DESIGN_FIELDS)[number];
export type DesignField = (typeof DESIGN_FIELDS)[number];

// The database column of each setting (email_designs, resolve_email_design's keys).
export const DESIGN_COLUMNS: Record<DesignField, string> = {
  logoPath: "logo_path",
  accentColor: "accent_color",
  subjectTemplate: "subject_template",
  headerText: "header_text",
  headingText: "heading_text",
  introMessage: "intro_message",
  buttonLabel: "button_label",
  buttonColor: "button_color",
  noticeText: "notice_text",
  footerText: "footer_text",
  showLogo: "show_logo",
  showHeader: "show_header",
  showHeading: "show_heading",
  showIntro: "show_intro",
  showBody: "show_body",
  showDetails: "show_details",
  showButton: "show_button",
  showNotice: "show_notice",
  showFooter: "show_footer",
};
// The settings a database without Oct 19 notes' update has.
export const LEGACY_DESIGN_FIELDS = [
  "logoPath",
  "accentColor",
  "headerText",
  "introMessage",
  "footerText",
  "buttonLabel",
  "buttonColor",
] as const satisfies readonly TextDesignField[];

export function isBlockField(field: DesignField): field is BlockDesignField {
  return (BLOCK_DESIGN_FIELDS as readonly string[]).includes(field);
}

// A scope's own settings: null = inherit from the next scope.
export type EmailDesignSettings = { [K in TextDesignField]: string | null } & { [K in BlockDesignField]: boolean | null };
export type ResolvedDesign = { [K in TextDesignField]: string } & { [K in BlockDesignField]: boolean };
export type DesignSource = "form" | "project" | "workspace" | "default";

export const DESIGN_LIMITS = {
  subjectTemplate: 300,
  headerText: 200,
  headingText: 300,
  introMessage: 2000,
  buttonLabel: 60,
  noticeText: 500,
  footerText: 1000,
} as const;

export const EMPTY_SETTINGS = Object.fromEntries(DESIGN_FIELDS.map((f) => [f, null])) as EmailDesignSettings;

const ALL_SHOWN = Object.fromEntries(BLOCK_DESIGN_FIELDS.map((f) => [f, true])) as { [K in BlockDesignField]: boolean };

// The built-in look: blue accent, no logo, each email's own subject, heading, and small print, every
// block shown, the app's sign-off. For internal emails an empty button label keeps each email's own
// ("Open task", "Open Inbox", …); requester emails have no button unless a label is set (it then links
// to the request's form, for another request).
export const DESIGN_DEFAULTS: Record<EmailDesignKind, ResolvedDesign> = {
  internal: {
    logoPath: "",
    accentColor: "#4573d2",
    subjectTemplate: "",
    headerText: "",
    headingText: "",
    introMessage: "",
    buttonLabel: "",
    buttonColor: "#4573d2",
    noticeText: "",
    footerText: "Sent by ALHC Projects",
    ...ALL_SHOWN,
  },
  requester: {
    logoPath: "",
    accentColor: "#4573d2",
    subjectTemplate: "",
    headerText: "{project_name}",
    headingText: "",
    introMessage: "",
    buttonLabel: "",
    buttonColor: "#4573d2",
    noticeText: "",
    footerText: "Sent by ALHC Projects",
    ...ALL_SHOWN,
  },
};

// The heading of a response sent to a form's submitter: the subject stays "Re: …", so the heading
// doesn't repeat it.
export const RESPONSE_HEADING = "Update on your request";

export const FILL_IN_FIELDS = [
  "requester_name",
  "request_number",
  "task_name",
  "project_name",
  "form_name",
  "commenter_name",
  "due_date",
  "task_link",
] as const;
export type FillInField = (typeof FILL_IN_FIELDS)[number];
export type FillInValues = Partial<Record<FillInField, string | null>>;

export const FILL_IN_LABELS: Record<FillInField, string> = {
  requester_name: "Requester’s name",
  request_number: "Request number",
  task_name: "Task name",
  project_name: "Project name",
  form_name: "Form name",
  commenter_name: "Commenter’s name",
  due_date: "Due date",
  task_link: "Task link (internal only)",
};

// Only in the subject and the heading: the email's own subject / heading, for "[Creative] {email_subject}".
export const OWN_TEXT_FIELDS = ["email_subject", "email_heading"] as const;
export type OwnTextField = (typeof OWN_TEXT_FIELDS)[number];
export const OWN_TEXT_LABELS: Record<OwnTextField, string> = {
  email_subject: "This email’s own subject",
  email_heading: "This email’s own heading",
};

// {task_link} is a signed-in link: never put in an email to someone outside the workspace.
export function fillInFieldsFor(kind: EmailDesignKind): FillInField[] {
  return kind === "requester" ? FILL_IN_FIELDS.filter((f) => f !== "task_link") : [...FILL_IN_FIELDS];
}

// Whitespace as the database's email_subject_fill_in() sees it: an explicit class, so JavaScript's
// Unicode spaces and Postgres's \s can't disagree.
const WS = "[ \\t\\r\\n\\f\\v]";
const TOKEN = new RegExp(`\\{${WS}*([A-Za-z_]+)${WS}*\\}`, "g");
const EDGES = new RegExp(`^${WS}+|${WS}+$`, "g");
const RUNS = new RegExp(`${WS}+`, "g");

// One pass over the text: each {field} becomes its trimmed value when allowed, else nothing. A value
// that itself looks like {field} stays as typed (it's never filled in again).
function substitute(text: string, values: Record<string, string | null | undefined>, allowed: Set<string>): string {
  return text.replace(TOKEN, (_, key: string) => {
    const name = key.toLowerCase();
    if (!allowed.has(name)) return "";
    const value = values[name];
    return typeof value === "string" ? value.replace(EDGES, "") : "";
  });
}

function trimLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .trim();
}

// Replaces {field} with its value; unknown fields, fields this kind doesn't offer, and missing values
// render blank (never as raw braces). Lines left with only spaces are trimmed.
export function fillIn(text: string, values: FillInValues, kind: EmailDesignKind): string {
  if (!text) return "";
  return trimLines(substitute(text, values, new Set(fillInFieldsFor(kind))));
}

// One line, single spaces, at most 300 characters (mirrors email_subject_fill_in()).
export function oneLine(value: string): string {
  return Array.from(value.replace(RUNS, " ").replace(/^ | $/g, ""))
    .slice(0, 300)
    .join("");
}

// A subject template filled in (mirrors email_subject_fill_in(): the same tokens, whitespace, and cut),
// with {email_subject} = the email's own subject. An empty template or result = the email's own.
export function renderSubjectTemplate(template: string, values: FillInValues, kind: EmailDesignKind, own: string): string {
  if (!oneLine(template ?? "")) return own;
  const allowed = new Set<string>([...fillInFieldsFor(kind), "email_subject"]);
  return oneLine(substitute(template, { ...values, email_subject: own }, allowed)) || own;
}

const HEX = /^#[0-9a-f]{6}$/i;
export function isHexColor(value: string | null | undefined): value is string {
  return typeof value === "string" && HEX.test(value);
}

// Black or white text, whichever reads better on a background color.
export function textColorOn(background: string): "#ffffff" | "#18181b" {
  if (!isHexColor(background)) return "#ffffff";
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(background.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.45 ? "#18181b" : "#ffffff";
}

// What's wrong with a scope's settings (mirrors the table's CHECKs), or null.
export function designProblem(settings: EmailDesignSettings): string | null {
  if (settings.accentColor && !isHexColor(settings.accentColor)) return "The accent color must look like #4573d2";
  if (settings.buttonColor && !isHexColor(settings.buttonColor)) return "The button color must look like #4573d2";
  for (const [field, max] of Object.entries(DESIGN_LIMITS) as [keyof typeof DESIGN_LIMITS, number][]) {
    const value = settings[field];
    if (value && value.length > max) return `Keep it under ${max} characters`;
  }
  if (settings.subjectTemplate && /[\r\n]/.test(settings.subjectTemplate)) return "Keep the subject on one line";
  return null;
}

// Each setting from the first layer that sets it (form, project, workspace), else the default.
export function resolveEmailDesign(
  kind: EmailDesignKind,
  layers: { form?: Partial<EmailDesignSettings> | null; project?: Partial<EmailDesignSettings> | null; workspace?: Partial<EmailDesignSettings> | null },
): { design: ResolvedDesign; sources: Record<DesignField, DesignSource> } {
  const order: [DesignSource, Partial<EmailDesignSettings> | null | undefined][] = [
    ["form", kind === "requester" ? layers.form : null],
    ["project", layers.project],
    ["workspace", layers.workspace],
  ];
  const design: Record<DesignField, string | boolean> = { ...DESIGN_DEFAULTS[kind] };
  const sources = Object.fromEntries(DESIGN_FIELDS.map((f) => [f, "default"])) as Record<DesignField, DesignSource>;
  for (const field of DESIGN_FIELDS) {
    for (const [source, layer] of order) {
      const value = layer?.[field];
      // A switch must be a boolean and a text a string (a layer from an older database has neither).
      if (isBlockField(field) ? typeof value === "boolean" : typeof value === "string") {
        design[field] = value as string | boolean;
        sources[field] = source;
        break;
      }
    }
  }
  return { design: design as ResolvedDesign, sources };
}

// The resolved design as the database returns it (resolve_email_design / email_design_context).
export function designFromJson(kind: EmailDesignKind, value: unknown): ResolvedDesign {
  const o = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return resolveEmailDesign(kind, { workspace: settingsFromRow(o) }).design;
}

// The design applied to one email: fill-ins replaced, colors checked, the logo as a URL. The subject
// and heading templates stay raw (each email brings its own subject and heading for {email_subject} /
// {email_heading}); designedSubject / designedHeading fill them in.
export type DesignBlock = "logo" | "header" | "heading" | "intro" | "body" | "details" | "button" | "notice" | "footer";
export type AppliedDesign = {
  kind: EmailDesignKind;
  logoUrl: string | null;
  accentColor: string;
  headerText: string;
  introMessage: string;
  footerText: string;
  buttonLabel: string;
  buttonColor: string;
  buttonTextColor: string;
  // Requester emails: where a button with a label goes (the request's public form), if anywhere.
  buttonHref: string | null;
  // "" = each email's own small print.
  noticeText: string;
  subjectTemplate: string;
  headingTemplate: string;
  values: FillInValues;
  show: Record<DesignBlock, boolean>;
};

export function applyDesign(
  kind: EmailDesignKind,
  design: ResolvedDesign,
  values: FillInValues,
  options: { logoUrl?: (path: string) => string | null; buttonHref?: string | null } = {},
): AppliedDesign {
  const defaults = DESIGN_DEFAULTS[kind];
  const accent = isHexColor(design.accentColor) ? design.accentColor.toLowerCase() : defaults.accentColor;
  const button = isHexColor(design.buttonColor) ? design.buttonColor.toLowerCase() : accent;
  const shown = (value: boolean | undefined) => value !== false;
  return {
    kind,
    logoUrl: design.logoPath && options.logoUrl ? options.logoUrl(design.logoPath) : null,
    accentColor: accent,
    headerText: fillIn(design.headerText, values, kind),
    introMessage: fillIn(design.introMessage, values, kind),
    footerText: fillIn(design.footerText, values, kind),
    buttonLabel: fillIn(design.buttonLabel, values, kind).slice(0, 60),
    buttonColor: button,
    buttonTextColor: textColorOn(button),
    buttonHref: options.buttonHref ?? null,
    noticeText: fillIn(design.noticeText ?? "", values, kind),
    subjectTemplate: design.subjectTemplate ?? "",
    headingTemplate: design.headingText ?? "",
    values,
    show: {
      logo: shown(design.showLogo),
      header: shown(design.showHeader),
      heading: shown(design.showHeading),
      intro: shown(design.showIntro),
      body: shown(design.showBody),
      details: shown(design.showDetails),
      button: shown(design.showButton),
      notice: shown(design.showNotice),
      footer: shown(design.showFooter),
    },
  };
}

export function defaultAppliedDesign(kind: EmailDesignKind): AppliedDesign {
  return applyDesign(kind, DESIGN_DEFAULTS[kind], {});
}

// The subject an email goes out with: the design's template filled in, else the email's own.
export function designedSubject(design: AppliedDesign, own: string): string {
  return renderSubjectTemplate(design.subjectTemplate, design.values, design.kind, own);
}

// The heading an email shows: the design's heading filled in ({email_heading} = the email's own), else
// the email's own. Hidden with the heading switch, never by an empty text.
export function designedHeading(design: AppliedDesign, own: string, ownSubject: string): string {
  if (!design.headingTemplate.trim()) return own;
  const allowed = new Set<string>([...fillInFieldsFor(design.kind), ...OWN_TEXT_FIELDS]);
  const values = { ...design.values, email_heading: own, email_subject: ownSubject };
  return trimLines(substitute(design.headingTemplate, values, allowed)) || own;
}

// "Oct 21, 2026" for a YYYY-MM-DD date.
export function formatDesignDate(value: string | null | undefined): string | null {
  const m = typeof value === "string" ? value.match(/^(\d{4})-(\d{2})-(\d{2})/) : null;
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// Example values for the editor's preview and "Send me a test".
export const SAMPLE_VALUES: Required<Record<FillInField, string>> = {
  requester_name: "Jordan Lee",
  request_number: "Req #042",
  task_name: "Spring flyer",
  project_name: "Creative Requests",
  form_name: "Design request form",
  commenter_name: "Avery Kim",
  due_date: "Oct 21, 2026",
  task_link: "https://example.com/projects/…?task=…",
};

// The emails the editor can preview a design with ("Preview as").
export type DesignSample = "response" | "confirmation" | "update" | "comment" | "assigned" | "invite";
export const DESIGN_SAMPLES: Record<EmailDesignKind, { key: DesignSample; label: string }[]> = {
  requester: [
    { key: "response", label: "Response to submitter" },
    { key: "confirmation", label: "Form confirmation" },
    { key: "update", label: "Rule email" },
  ],
  internal: [
    { key: "comment", label: "Comment" },
    { key: "assigned", label: "Assignment" },
    { key: "invite", label: "Invite" },
  ],
};

export function isDesignSample(value: unknown): value is DesignSample {
  return typeof value === "string" && ["response", "confirmation", "update", "comment", "assigned", "invite"].includes(value);
}

// The database row (or resolve_email_design's object) → a scope's settings. Columns a database without
// Oct 19 notes' update doesn't have read as null (inherit).
export function settingsFromRow(row: Record<string, unknown> | null | undefined): EmailDesignSettings | null {
  if (!row) return null;
  const out: Record<DesignField, string | boolean | null> = { ...EMPTY_SETTINGS };
  for (const field of DESIGN_FIELDS) {
    const value = row[DESIGN_COLUMNS[field]];
    out[field] = isBlockField(field) ? (typeof value === "boolean" ? value : null) : typeof value === "string" ? value : null;
  }
  return out as EmailDesignSettings;
}

export function isEmailDesignKind(value: unknown): value is EmailDesignKind {
  return value === "internal" || value === "requester";
}
