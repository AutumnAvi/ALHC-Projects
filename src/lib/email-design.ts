// Email designs (20261019010000_email_designs.sql): two kinds of email, each with its own look —
// "internal" (no-reply notifications to workspace people) and "requester" (emails to a form's
// submitter, whose replies come back as comments). A design is a logo, an accent color, header text,
// an intro message, a sign-off / footer, and a button label and color. Workspace admins set the
// workspace default of each kind, project admins a project override, and (requester emails only) a
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

export const DESIGN_FIELDS = [
  "logoPath",
  "accentColor",
  "headerText",
  "introMessage",
  "footerText",
  "buttonLabel",
  "buttonColor",
] as const;
export type DesignField = (typeof DESIGN_FIELDS)[number];

// A scope's own settings: null = inherit from the next scope, "" = explicitly empty.
export type EmailDesignSettings = Record<DesignField, string | null>;
export type ResolvedDesign = Record<DesignField, string>;
export type DesignSource = "form" | "project" | "workspace" | "default";

export const DESIGN_LIMITS = {
  headerText: 200,
  introMessage: 2000,
  footerText: 1000,
  buttonLabel: 60,
} as const;

export const EMPTY_SETTINGS: EmailDesignSettings = {
  logoPath: null,
  accentColor: null,
  headerText: null,
  introMessage: null,
  footerText: null,
  buttonLabel: null,
  buttonColor: null,
};

// The built-in look: blue accent, no logo, the app's sign-off. For internal emails an empty button
// label keeps each email's own ("Open task", "Open Inbox", …); requester emails have no button unless a
// label is set (it then links to the request's form, for another request).
export const DESIGN_DEFAULTS: Record<EmailDesignKind, ResolvedDesign> = {
  internal: {
    logoPath: "",
    accentColor: "#4573d2",
    headerText: "",
    introMessage: "",
    footerText: "Sent by ALHC Projects",
    buttonLabel: "",
    buttonColor: "#4573d2",
  },
  requester: {
    logoPath: "",
    accentColor: "#4573d2",
    headerText: "{project_name}",
    introMessage: "",
    footerText: "Sent by ALHC Projects",
    buttonLabel: "",
    buttonColor: "#4573d2",
  },
};

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

// {task_link} is a signed-in link: never put in an email to someone outside the workspace.
export function fillInFieldsFor(kind: EmailDesignKind): FillInField[] {
  return kind === "requester" ? FILL_IN_FIELDS.filter((f) => f !== "task_link") : [...FILL_IN_FIELDS];
}

// Replaces {field} with its value; unknown fields, fields this kind doesn't offer, and missing values
// render blank (never as raw braces). Lines left with only spaces are trimmed.
export function fillIn(text: string, values: FillInValues, kind: EmailDesignKind): string {
  if (!text) return "";
  const allowed = new Set<string>(fillInFieldsFor(kind));
  return text
    .replace(/\{\s*([A-Za-z_]+)\s*\}/g, (_, key: string) => {
      const name = key.toLowerCase();
      if (!allowed.has(name)) return "";
      return values[name as FillInField]?.trim() ?? "";
    })
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .trim();
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
  const design = { ...DESIGN_DEFAULTS[kind] };
  const sources = Object.fromEntries(DESIGN_FIELDS.map((f) => [f, "default"])) as Record<DesignField, DesignSource>;
  for (const field of DESIGN_FIELDS) {
    for (const [source, layer] of order) {
      const value = layer?.[field];
      if (value !== null && value !== undefined) {
        design[field] = value;
        sources[field] = source;
        break;
      }
    }
  }
  return { design, sources };
}

// The resolved design as the database returns it (resolve_email_design / email_design_context).
export function designFromJson(kind: EmailDesignKind, value: unknown): ResolvedDesign {
  const o = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : null);
  return resolveEmailDesign(kind, {
    workspace: {
      logoPath: s("logo_path"),
      accentColor: s("accent_color"),
      headerText: s("header_text"),
      introMessage: s("intro_message"),
      footerText: s("footer_text"),
      buttonLabel: s("button_label"),
      buttonColor: s("button_color"),
    },
  }).design;
}

// The design applied to one email: fill-ins replaced, colors checked, the logo as a URL.
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
  };
}

export function defaultAppliedDesign(kind: EmailDesignKind): AppliedDesign {
  return applyDesign(kind, DESIGN_DEFAULTS[kind], {});
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

// The database row → a scope's settings.
export function settingsFromRow(row: {
  logo_path: string | null;
  accent_color: string | null;
  header_text: string | null;
  intro_message: string | null;
  footer_text: string | null;
  button_label: string | null;
  button_color: string | null;
} | null | undefined): EmailDesignSettings | null {
  if (!row) return null;
  return {
    logoPath: row.logo_path,
    accentColor: row.accent_color,
    headerText: row.header_text,
    introMessage: row.intro_message,
    footerText: row.footer_text,
    buttonLabel: row.button_label,
    buttonColor: row.button_color,
  };
}

export function isEmailDesignKind(value: unknown): value is EmailDesignKind {
  return value === "internal" || value === "requester";
}
