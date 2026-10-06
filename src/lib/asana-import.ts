import "server-only";
import type { Json } from "@/lib/supabase/database.types";
import { MAX_SUBTASK_DEPTH } from "@/lib/subtasks";

// Parses Asana project exports (the JSON export and/or the CSV export of a project) into the batch
// format of rpc("import_batch") (documented above that function in
// supabase/migrations/20261005090000_asana_import.sql). Pure: no network, no database — the files are
// whatever an Admin downloaded from Asana. The Asana API is never called.

export type ImportFieldType = "text" | "number" | "date" | "single_select" | "multi_select" | "people";

export type PlanSection = { key: string; name: string };
export type PlanField = { key: string; name: string; type: ImportFieldType; options: string[] };
// Real subtasks: the same details as a task (minus sections, fields, comments, and attachments), nested
// up to MAX_SUBTASK_DEPTH levels; deeper levels are flattened into the deepest one.
export type PlanSubtask = {
  gid: string;
  title: string;
  kind: "task" | "milestone" | "approval";
  notes: string | null;
  completed_at: string | null;
  due_on: string | null;
  start_on: string | null;
  assignee_email: string | null;
  assignee_name: string | null;
  subtasks: PlanSubtask[];
};

// Every subtask in a tree, depth first.
export function flattenSubtasks(list: PlanSubtask[]): PlanSubtask[] {
  return list.flatMap((s) => [s, ...flattenSubtasks(s.subtasks)]);
}
export type PlanComment = {
  gid: string;
  body: string;
  author_email: string | null;
  author_name: string | null;
  created_at: string | null;
};
export type PlanAttachment = { gid: string; name: string; url: string | null };
export type PlanTask = {
  gid: string;
  title: string;
  // Asana's resource_subtype: milestone and approval keep their type; anything else is a task.
  kind: "task" | "milestone" | "approval";
  notes: string | null;
  completed_at: string | null;
  due_on: string | null;
  start_on: string | null;
  assignee_email: string | null;
  assignee_name: string | null;
  section_key: string | null;
  projects: { gid: string; section_name: string | null }[];
  fields: { key: string; value: Json }[];
  followers: string[];
  subtasks: PlanSubtask[];
  comments: PlanComment[];
  attachments: PlanAttachment[];
};
export type PlanRule = {
  key: string;
  name: string;
  trigger_type: string;
  trigger_config: Json;
  conditions: Json;
  actions: Json;
};
export type PlanPerson = {
  name: string | null;
  email: string | null;
  references: number;
};

export type ImportPlan = {
  project: { gid: string; name: string } | null;
  sections: PlanSection[];
  fields: PlanField[];
  rules: PlanRule[];
  tasks: PlanTask[];
  dependencies: { predecessor: string; successor: string }[];
  people: PlanPerson[];
  tagCount: number;
  warnings: string[];
};

export class ImportParseError extends Error {}

export const TAGS_FIELD_KEY = "asana:tags";

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function email(value: unknown): string | null {
  const s = str(value)?.toLowerCase() ?? null;
  return s && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : null;
}

// YYYY-MM-DD from "2026-10-05", "2026-10-05T…", or "10/5/2026".
export function isoDate(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return validDate(+m[3], +m[1], +m[2]);
  return null;
}

function validDate(y: number, mo: number, d: number): string | null {
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function timestamp(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T12:00:00Z`;
  const t = Date.parse(s);
  if (Number.isNaN(t)) {
    const d = isoDate(s);
    return d ? `${d}T12:00:00Z` : null;
  }
  return new Date(t).toISOString();
}

function sectionKey(gid: string | null, name: string): string {
  return gid ?? `name:${name.toLowerCase()}`;
}

function splitList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// CSV (RFC 4180: quoted fields, doubled quotes, embedded newlines, CRLF, optional BOM)
// ---------------------------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

// Columns of Asana's CSV export that are not custom fields.
const CSV_STANDARD = new Set(
  [
    "task id",
    "created at",
    "completed at",
    "last modified",
    "name",
    "section/column",
    "section",
    "column",
    "assignee",
    "assignee email",
    "start date",
    "due date",
    "due time",
    "start time",
    "tags",
    "notes",
    "projects",
    "parent task",
    "parent task id",
    "blocked by (dependencies)",
    "blocking (dependencies)",
    "type",
    "created by",
    "completed",
    "approval status",
  ].map((s) => s.toLowerCase()),
);

type CsvTask = {
  gid: string;
  title: string;
  notes: string | null;
  completedAt: string | null;
  dueOn: string | null;
  startOn: string | null;
  assigneeName: string | null;
  assigneeEmail: string | null;
  section: string | null;
  tags: string[];
  parent: string | null;
  blockedBy: string[];
  blocking: string[];
  custom: Map<string, string>;
};

function readCsv(text: string, fileName: string): { tasks: CsvTask[]; customColumns: string[] } {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new ImportParseError(`${fileName} is empty`);
  const header = rows[0].map((h) => h.trim());
  const index = new Map(header.map((h, i) => [h.toLowerCase(), i]));
  const col = (row: string[], name: string) => {
    const i = index.get(name);
    return i === undefined ? null : str(row[i]);
  };
  if (!index.has("task id") || !index.has("name")) {
    throw new ImportParseError(
      `${fileName} doesn’t look like an Asana CSV export (it needs “Task ID” and “Name” columns)`,
    );
  }
  const customColumns = header.filter((h) => h && !CSV_STANDARD.has(h.toLowerCase()));
  const tasks: CsvTask[] = [];
  for (const row of rows.slice(1)) {
    const gid = col(row, "task id");
    if (!gid) continue;
    const custom = new Map<string, string>();
    for (const name of customColumns) {
      const value = col(row, name.toLowerCase());
      if (value) custom.set(name, value);
    }
    tasks.push({
      gid,
      title: col(row, "name") ?? "",
      notes: col(row, "notes"),
      completedAt: col(row, "completed at"),
      dueOn: isoDate(col(row, "due date")),
      startOn: isoDate(col(row, "start date")),
      assigneeName: col(row, "assignee"),
      assigneeEmail: email(col(row, "assignee email")),
      section: col(row, "section/column") ?? col(row, "section") ?? col(row, "column"),
      tags: splitList(col(row, "tags")),
      parent: col(row, "parent task id") ?? col(row, "parent task"),
      blockedBy: splitList(col(row, "blocked by (dependencies)")),
      blocking: splitList(col(row, "blocking (dependencies)")),
      custom,
    });
  }
  return { tasks, customColumns };
}

function inferCsvType(values: string[]): ImportFieldType {
  if (values.length === 0) return "text";
  if (values.every((v) => /^-?\$?[\d,]*\.?\d+%?$/.test(v))) return "number";
  if (values.every((v) => isoDate(v) !== null)) return "date";
  const distinct = new Set(values.map((v) => v.toLowerCase()));
  if (distinct.size <= 20 && distinct.size < values.length && values.every((v) => v.length <= 60)) {
    return "single_select";
  }
  return "text";
}

function csvNumber(value: string): number | null {
  const n = Number(value.replace(/[$,%]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------------------------
// JSON (the project JSON export: { "data": [task, …] }, tasks with nested subtasks)
// ---------------------------------------------------------------------------------------------

type User = { gid: string | null; name: string | null; email: string | null };

function user(value: unknown): User | null {
  if (!isObj(value)) return null;
  const u = { gid: str(value.gid), name: str(value.name), email: email(value.email) };
  return u.gid || u.name || u.email ? u : null;
}

function jsonTasks(root: unknown, fileName: string): { tasks: Obj[]; rules: unknown[] } {
  if (Array.isArray(root)) return { tasks: root.filter(isObj), rules: [] };
  if (isObj(root)) {
    const tasks = Array.isArray(root.data) ? root.data : Array.isArray(root.tasks) ? root.tasks : null;
    if (tasks) return { tasks: tasks.filter(isObj), rules: arr(root.rules) };
  }
  throw new ImportParseError(`${fileName} doesn’t look like an Asana JSON export (expected a "data" list of tasks)`);
}

// Asana custom field types → ours. Formula / custom ID / unknown types come in as text.
function asanaFieldType(field: Obj): ImportFieldType {
  const type = str(field.type) ?? str(field.resource_subtype);
  switch (type) {
    case "text":
      return "text";
    case "number":
    case "percent":
    case "currency":
      return "number";
    case "enum":
      return "single_select";
    case "multi_enum":
      return "multi_select";
    case "date":
      return "date";
    case "people":
      return "people";
    default:
      return "text";
  }
}

// ---------------------------------------------------------------------------------------------
// Build the plan
// ---------------------------------------------------------------------------------------------

export function buildImportPlan(files: { name: string; text: string }[]): ImportPlan {
  const warnings: string[] = [];
  const jsonRoots: { name: string; tasks: Obj[]; rules: unknown[] }[] = [];
  const csvFiles: { name: string; tasks: CsvTask[]; customColumns: string[] }[] = [];

  for (const file of files) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".json")) {
      let root: unknown;
      try {
        root = JSON.parse(file.text.charCodeAt(0) === 0xfeff ? file.text.slice(1) : file.text);
      } catch {
        throw new ImportParseError(`${file.name} isn’t valid JSON`);
      }
      jsonRoots.push({ name: file.name, ...jsonTasks(root, file.name) });
    } else if (lower.endsWith(".csv")) {
      csvFiles.push({ name: file.name, ...readCsv(file.text, file.name) });
    } else {
      throw new ImportParseError(`${file.name}: only .json and .csv Asana exports can be imported`);
    }
  }

  // People: Asana's JSON export often has no emails, so learn them from the CSV export (same task →
  // the assignee's email) and from any user object that has one.
  const emailByGid = new Map<string, string>();
  const emailByName = new Map<string, string>();
  const learn = (u: User | null) => {
    if (!u?.email) return;
    if (u.gid) emailByGid.set(u.gid, u.email);
    if (u.name) emailByName.set(u.name.toLowerCase(), u.email);
  };
  const csvByGid = new Map<string, CsvTask>();
  for (const file of csvFiles) {
    for (const t of file.tasks) {
      if (!csvByGid.has(t.gid)) csvByGid.set(t.gid, t);
      if (t.assigneeEmail && t.assigneeName) emailByName.set(t.assigneeName.toLowerCase(), t.assigneeEmail);
    }
  }

  // Flatten JSON: top-level tasks, plus top-level rows that are really subtasks of another row.
  const topLevel: Obj[] = [];
  const seenTop = new Set<string>();
  const allJson = jsonRoots.flatMap((r) => r.tasks);
  const jsonGids = new Set(allJson.map((t) => str(t.gid)).filter((g): g is string => !!g));
  const childrenOf = new Map<string, Obj[]>();
  const walkUsers = (t: Obj) => {
    learn(user(t.assignee));
    for (const f of arr(t.followers)) learn(user(f));
    for (const s of arr(t.stories)) if (isObj(s)) learn(user(s.created_by));
    for (const s of arr(t.subtasks)) if (isObj(s)) walkUsers(s);
  };
  for (const t of allJson) {
    walkUsers(t);
    const gid = str(t.gid);
    if (!gid || seenTop.has(gid)) continue;
    seenTop.add(gid);
    const parent = isObj(t.parent) ? str(t.parent.gid) : null;
    if (parent && jsonGids.has(parent)) {
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), t]);
    } else {
      topLevel.push(t);
    }
    const csv = csvByGid.get(gid);
    const assignee = user(t.assignee);
    if (csv?.assigneeEmail && assignee?.gid && !emailByGid.has(assignee.gid)) {
      emailByGid.set(assignee.gid, csv.assigneeEmail);
    }
  }
  const resolveEmail = (u: User | null) =>
    u ? (u.email ?? (u.gid ? emailByGid.get(u.gid) : undefined) ?? (u.name ? emailByName.get(u.name.toLowerCase()) : undefined) ?? null) : null;

  // People referenced anywhere (for the dry-run preview).
  const people = new Map<string, PlanPerson>();
  const reference = (name: string | null, mail: string | null) => {
    if (!name && !mail) return;
    const key = mail ?? `name:${name!.toLowerCase()}`;
    const existing = people.get(key);
    if (existing) {
      existing.references++;
      if (!existing.name && name) existing.name = name;
    } else {
      people.set(key, { name, email: mail, references: 1 });
    }
  };

  // Source project = the project most top-level JSON tasks belong to.
  const projectVotes = new Map<string, { name: string; votes: number }>();
  for (const t of topLevel) {
    for (const m of arr(t.memberships)) {
      if (!isObj(m) || !isObj(m.project)) continue;
      const gid = str(m.project.gid);
      if (!gid) continue;
      const entry = projectVotes.get(gid) ?? { name: str(m.project.name) ?? "Asana project", votes: 0 };
      entry.votes++;
      projectVotes.set(gid, entry);
    }
  }
  const [projectGid, projectEntry] = [...projectVotes.entries()].sort((a, b) => b[1].votes - a[1].votes)[0] ?? [];
  const project = projectGid && projectEntry ? { gid: projectGid, name: projectEntry.name } : null;

  const sections = new Map<string, PlanSection>();
  const addSection = (gid: string | null, name: string | null) => {
    if (!name) return null;
    const key = sectionKey(gid, name);
    if (!sections.has(key)) sections.set(key, { key, name: name.slice(0, 200) });
    return key;
  };

  const fields = new Map<string, PlanField>();
  const fieldByName = new Map<string, PlanField>();
  const addField = (key: string, name: string, type: ImportFieldType) => {
    let field = fields.get(key);
    if (!field) {
      field = { key, name: name.slice(0, 100), type, options: [] };
      fields.set(key, field);
      if (!fieldByName.has(name.toLowerCase())) fieldByName.set(name.toLowerCase(), field);
    }
    return field;
  };
  const addOption = (field: PlanField, name: string | null) => {
    if (!name) return;
    if (!field.options.some((o) => o.toLowerCase() === name.toLowerCase())) field.options.push(name.slice(0, 100));
  };
  const tagNames = new Set<string>();
  const tagsValue = (names: string[]) => {
    if (names.length === 0) return null;
    const field = addField(TAGS_FIELD_KEY, "Tags", "multi_select");
    for (const n of names) {
      addOption(field, n);
      tagNames.add(n.toLowerCase());
    }
    return { key: TAGS_FIELD_KEY, value: names as Json };
  };

  let nestedFlattened = 0;
  let unresolvedPeopleValues = 0;
  let commentsWithoutAuthorEmail = 0;

  const dependencies = new Map<string, { predecessor: string; successor: string }>();
  const addDependency = (predecessor: string | null, successor: string | null) => {
    if (!predecessor || !successor || predecessor === successor) return;
    dependencies.set(`${predecessor}>${successor}`, { predecessor, successor });
  };

  const tasks: PlanTask[] = [];
  const taskGids = new Set<string>();

  // JSON tasks -------------------------------------------------------------------------------------
  for (const t of topLevel) {
    const gid = str(t.gid)!;
    const assignee = user(t.assignee);
    const assigneeEmail = resolveEmail(assignee);
    if (assignee) reference(assignee.name, assigneeEmail);

    let section: string | null = null;
    const projects: PlanTask["projects"] = [];
    for (const m of arr(t.memberships)) {
      if (!isObj(m) || !isObj(m.project)) continue;
      const pg = str(m.project.gid);
      const sectionObj = isObj(m.section) ? m.section : null;
      if (pg && pg === project?.gid) {
        section = sectionObj ? addSection(str(sectionObj.gid), str(sectionObj.name)) : null;
      } else if (pg) {
        projects.push({ gid: pg, section_name: sectionObj ? str(sectionObj.name) : null });
      }
    }

    const values: PlanTask["fields"] = [];
    for (const cf of arr(t.custom_fields)) {
      if (!isObj(cf)) continue;
      const fgid = str(cf.gid);
      const name = str(cf.name);
      if (!fgid || !name) continue;
      const type = asanaFieldType(cf);
      const field = addField(fgid, name, type);
      for (const o of arr(cf.enum_options)) if (isObj(o) && o.enabled !== false) addOption(field, str(o.name));
      let value: Json | null = null;
      switch (field.type) {
        case "text":
          value = str(cf.text_value) ?? str(cf.display_value);
          break;
        case "number":
          value = typeof cf.number_value === "number" ? cf.number_value : null;
          break;
        case "single_select": {
          const name = isObj(cf.enum_value) ? str(cf.enum_value.name) : null;
          addOption(field, name);
          value = name;
          break;
        }
        case "multi_select": {
          const names = arr(cf.multi_enum_values)
            .map((o) => (isObj(o) ? str(o.name) : null))
            .filter((n): n is string => !!n);
          names.forEach((n) => addOption(field, n));
          value = names.length ? names : null;
          break;
        }
        case "date":
          value = (isObj(cf.date_value) ? isoDate(cf.date_value.date) : null) ?? isoDate(cf.display_value);
          break;
        case "people": {
          const emails: string[] = [];
          for (const p of arr(cf.people_value)) {
            const u = user(p);
            const mail = resolveEmail(u);
            if (u) reference(u.name, mail);
            if (mail) emails.push(mail);
            else unresolvedPeopleValues++;
          }
          value = emails.length ? emails : null;
          break;
        }
      }
      if (value !== null) values.push({ key: field.key, value });
    }
    const tags = tagsValue(
      arr(t.tags)
        .map((tag) => (isObj(tag) ? str(tag.name) : null))
        .filter((n): n is string => !!n),
    );
    if (tags) values.push(tags);

    const followers: string[] = [];
    for (const f of arr(t.followers)) {
      const u = user(f);
      const mail = resolveEmail(u);
      if (mail) followers.push(mail);
    }

    const subtasks: PlanSubtask[] = [];
    const seenSub = new Set<string>();
    // depth = the level the items land on (1 = direct subtasks); past the limit they stay on the last one.
    const walk = (list: unknown[], depth: number, out: PlanSubtask[]) => {
      for (const s of list) {
        if (!isObj(s)) continue;
        const sg = str(s.gid);
        if (!sg || seenSub.has(sg)) continue;
        seenSub.add(sg);
        const subAssignee = user(s.assignee);
        const subEmail = resolveEmail(subAssignee);
        if (subAssignee) reference(subAssignee.name, subEmail);
        const subtype = str(s.resource_subtype);
        const item: PlanSubtask = {
          gid: sg,
          title: str(s.name) ?? "Untitled subtask",
          kind: subtype === "milestone" || subtype === "approval" ? subtype : "task",
          notes: typeof s.notes === "string" && s.notes.trim() ? s.notes : null,
          completed_at: s.completed === true ? (timestamp(s.completed_at) ?? new Date().toISOString()) : null,
          due_on: isoDate(s.due_on) ?? isoDate(s.due_at),
          start_on: isoDate(s.start_on),
          assignee_email: subEmail,
          assignee_name: subAssignee?.name ?? null,
          subtasks: [],
        };
        out.push(item);
        const children = [...arr(s.subtasks), ...(childrenOf.get(sg) ?? [])];
        if (depth < MAX_SUBTASK_DEPTH) walk(children, depth + 1, item.subtasks);
        else {
          nestedFlattened += children.filter(isObj).length;
          walk(children, depth, out);
        }
      }
    };
    walk([...arr(t.subtasks), ...(childrenOf.get(gid) ?? [])], 1, subtasks);

    const comments: PlanComment[] = [];
    for (const s of [...arr(t.stories), ...arr(t.comments)]) {
      if (!isObj(s)) continue;
      const isComment = str(s.type) === "comment" || str(s.resource_subtype) === "comment_added";
      const body = str(s.text);
      const sg = str(s.gid);
      if (!isComment || !body || !sg) continue;
      const author = user(s.created_by);
      const mail = resolveEmail(author);
      if (author) reference(author.name, mail);
      if (!mail) commentsWithoutAuthorEmail++;
      comments.push({
        gid: sg,
        body: body.slice(0, 9000),
        author_email: mail,
        author_name: author?.name ?? null,
        created_at: timestamp(s.created_at),
      });
    }

    const attachments: PlanAttachment[] = [];
    for (const a of arr(t.attachments)) {
      if (!isObj(a)) continue;
      const ag = str(a.gid);
      const name = str(a.name);
      if (!ag || !name) continue;
      const url = str(a.permanent_url) ?? str(a.view_url);
      attachments.push({ gid: ag, name: name.slice(0, 255), url: url && url.startsWith("https://") ? url : null });
    }

    for (const d of arr(t.dependencies)) if (isObj(d)) addDependency(str(d.gid), gid);
    for (const d of arr(t.dependents)) if (isObj(d)) addDependency(gid, str(d.gid));

    taskGids.add(gid);
    const subtype = str(t.resource_subtype);
    tasks.push({
      gid,
      title: str(t.name) ?? "Untitled task",
      kind: subtype === "milestone" || subtype === "approval" ? subtype : "task",
      notes: typeof t.notes === "string" && t.notes.trim() ? t.notes : null,
      completed_at: t.completed === true ? (timestamp(t.completed_at) ?? new Date().toISOString()) : null,
      due_on: isoDate(t.due_on) ?? isoDate(t.due_at),
      start_on: isoDate(t.start_on),
      assignee_email: assigneeEmail,
      assignee_name: assignee?.name ?? null,
      section_key: section,
      projects,
      fields: values,
      followers,
      subtasks,
      comments,
      attachments,
    });
  }

  // CSV rows ---------------------------------------------------------------------------------------
  const csvTasks = [...csvByGid.values()];
  if (csvTasks.length > 0) {
    // Custom columns: reuse a JSON field with the same name, else infer a type from the values.
    const csvFieldFor = new Map<string, PlanField>();
    for (const column of new Set(csvFiles.flatMap((f) => f.customColumns))) {
      const existing = fieldByName.get(column.toLowerCase());
      if (existing) {
        csvFieldFor.set(column, existing);
        continue;
      }
      const values = csvTasks.map((t) => t.custom.get(column)).filter((v): v is string => !!v);
      if (values.length === 0) continue;
      csvFieldFor.set(column, addField(`name:${column.toLowerCase()}`, column, inferCsvType(values)));
    }

    const byGid = new Map(csvTasks.map((t) => [t.gid, t]));
    const byName = new Map<string, CsvTask>();
    for (const t of csvTasks) if (t.title && !byName.has(t.title.toLowerCase())) byName.set(t.title.toLowerCase(), t);
    const resolveRef = (ref: string) =>
      byGid.has(ref) || taskGids.has(ref) ? ref : (byName.get(ref.toLowerCase())?.gid ?? null);

    const parents = new Map<string, CsvTask[]>();
    const csvTop: CsvTask[] = [];
    for (const t of csvTasks) {
      const parent = t.parent ? resolveRef(t.parent) : null;
      if (parent && parent !== t.gid) parents.set(parent, [...(parents.get(parent) ?? []), t]);
      else {
        if (t.parent) warnings.push(`“${t.title}” names a parent task that isn’t in the export, so it’s imported as a task.`);
        csvTop.push(t);
      }
    }

    // Nested like the JSON (depth = the level the rows land on), deeper levels flattened into the last.
    const subtasksFromCsv = (parentGid: string, seen: Set<string>, depth: number, out: PlanSubtask[] = []): PlanSubtask[] => {
      for (const s of parents.get(parentGid) ?? []) {
        if (seen.has(s.gid)) continue;
        seen.add(s.gid);
        reference(s.assigneeName, s.assigneeEmail);
        const item: PlanSubtask = {
          gid: s.gid,
          title: s.title || "Untitled subtask",
          kind: "task",
          notes: s.notes,
          completed_at: s.completedAt ? (timestamp(s.completedAt) ?? new Date().toISOString()) : null,
          due_on: s.dueOn,
          start_on: s.startOn,
          assignee_email: s.assigneeEmail ?? (s.assigneeName ? (emailByName.get(s.assigneeName.toLowerCase()) ?? null) : null),
          assignee_name: s.assigneeName,
          subtasks: [],
        };
        out.push(item);
        if (depth < MAX_SUBTASK_DEPTH) subtasksFromCsv(s.gid, seen, depth + 1, item.subtasks);
        else {
          nestedFlattened += (parents.get(s.gid) ?? []).length;
          subtasksFromCsv(s.gid, seen, depth, out);
        }
      }
      return out;
    };

    for (const t of csvTasks) {
      for (const ref of t.blockedBy) addDependency(resolveRef(ref), t.gid);
      for (const ref of t.blocking) addDependency(t.gid, resolveRef(ref));
    }

    const jsonTaskByGid = new Map(tasks.map((x) => [x.gid, x]));
    for (const t of csvTop) {
      if (jsonTaskByGid.has(t.gid)) {
        // Already in the JSON export: JSON is richer; the CSV only contributed emails and dependencies.
        // Subtasks the CSV knows about but the JSON lacked are still added.
        const existing = jsonTaskByGid.get(t.gid)!;
        const seen = new Set(flattenSubtasks(existing.subtasks).map((s) => s.gid));
        existing.subtasks.push(...subtasksFromCsv(t.gid, seen, 1));
        continue;
      }
      taskGids.add(t.gid);
      reference(t.assigneeName, t.assigneeEmail);
      const values: PlanTask["fields"] = [];
      for (const [column, raw] of t.custom) {
        const field = csvFieldFor.get(column);
        if (!field) continue;
        let value: Json | null = null;
        switch (field.type) {
          case "text":
            value = raw;
            break;
          case "number":
            value = csvNumber(raw);
            break;
          case "date":
            value = isoDate(raw);
            break;
          case "single_select":
            addOption(field, raw);
            value = raw;
            break;
          case "multi_select": {
            const names = splitList(raw);
            names.forEach((n) => addOption(field, n));
            value = names.length ? names : null;
            break;
          }
          case "people": {
            const emails = splitList(raw)
              .map((n) => email(n) ?? emailByName.get(n.toLowerCase()) ?? null)
              .filter((e): e is string => !!e);
            if (emails.length === 0) unresolvedPeopleValues++;
            value = emails.length ? emails : null;
            break;
          }
        }
        if (value !== null) values.push({ key: field.key, value });
      }
      const tags = tagsValue(t.tags);
      if (tags) values.push(tags);
      tasks.push({
        gid: t.gid,
        title: t.title || "Untitled task",
        kind: "task",
        notes: t.notes,
        completed_at: t.completedAt ? (timestamp(t.completedAt) ?? new Date().toISOString()) : null,
        due_on: t.dueOn,
        start_on: t.startOn,
        assignee_email: t.assigneeEmail ?? (t.assigneeName ? emailByName.get(t.assigneeName.toLowerCase()) ?? null : null),
        assignee_name: t.assigneeName,
        section_key: addSection(null, t.section),
        projects: [],
        fields: values,
        followers: [],
        subtasks: subtasksFromCsv(t.gid, new Set(), 1),
        comments: [],
        attachments: [],
      });
    }
    if (jsonRoots.length === 0) {
      warnings.push(
        "The CSV export has no comments, attachments, or other-project memberships. Add the JSON export of the same project to bring those too.",
      );
    }
  }

  // Rules: Asana's exports contain none. A JSON file may carry ALHC rule JSON under "rules"; those are
  // passed through and always land disabled.
  const rules: PlanRule[] = [];
  for (const root of jsonRoots) {
    for (const r of root.rules) {
      if (!isObj(r)) continue;
      const name = str(r.name);
      const triggerType = str(r.trigger_type);
      if (!name || !triggerType) continue;
      rules.push({
        key: str(r.key) ?? str(r.gid) ?? `name:${name.toLowerCase()}`,
        name: name.slice(0, 200),
        trigger_type: triggerType,
        trigger_config: (isObj(r.trigger_config) ? r.trigger_config : {}) as Json,
        conditions: (Array.isArray(r.conditions) ? r.conditions : []) as Json,
        actions: (Array.isArray(r.actions) ? r.actions : []) as Json,
      });
    }
  }

  if (tasks.length === 0) throw new ImportParseError("No tasks found in the uploaded files");

  // Dependencies on tasks that aren't in the export can't be linked.
  const linkable = [...dependencies.values()].filter((d) => taskGids.has(d.predecessor) && taskGids.has(d.successor));
  if (linkable.length < dependencies.size) {
    warnings.push(`${dependencies.size - linkable.length} dependencies point at tasks outside this export and are skipped.`);
  }
  if (nestedFlattened > 0) {
    warnings.push(
      `${nestedFlattened} subtasks are nested more than ${MAX_SUBTASK_DEPTH} levels deep in Asana; they’re imported on the ${MAX_SUBTASK_DEPTH}th level.`,
    );
  }
  if (unresolvedPeopleValues > 0) {
    warnings.push(`${unresolvedPeopleValues} people-field values have no email in the export and are skipped.`);
  }
  if (commentsWithoutAuthorEmail > 0) {
    warnings.push(
      `${commentsWithoutAuthorEmail} comments have no author email; they’ll be posted by you with the author’s name.`,
    );
  }
  const approvalTasks = tasks.filter((t) => t.kind === "approval").length;
  if (approvalTasks > 0) {
    warnings.push(
      `${approvalTasks} approval task${approvalTasks === 1 ? "" : "s"} keep their type, but importing asks nobody to approve. Open one and use “Ask … to approve” to send the request.`,
    );
  }
  const otherProjects = new Set(tasks.flatMap((t) => t.projects.map((p) => p.gid)));
  if (otherProjects.size > 0) {
    warnings.push(
      `Tasks also belong to ${otherProjects.size} other Asana project${otherProjects.size === 1 ? "" : "s"}. They’re added to those projects only where that project was imported here before and you’re an Editor there.`,
    );
  }

  return {
    project,
    sections: [...sections.values()],
    fields: [...fields.values()],
    rules,
    tasks,
    dependencies: linkable,
    people: [...people.values()].sort((a, b) => b.references - a.references),
    tagCount: tagNames.size,
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// Batches: structure first, then tasks in chunks (≤ 100 tasks or ~1 MB), then dependencies.
// Deterministic for the same files, so an interrupted import resumes at the same step.
// ---------------------------------------------------------------------------------------------

const TASKS_PER_BATCH = 100;
const MAX_BATCH_CHARS = 1_000_000;
const DEPENDENCIES_PER_BATCH = 1000;

export function importSteps(plan: ImportPlan): Json[] {
  const steps: Json[] = [
    {
      project: plan.project,
      sections: plan.sections,
      fields: plan.fields,
      rules: plan.rules,
    } as unknown as Json,
  ];
  let chunk: PlanTask[] = [];
  let size = 0;
  for (const task of plan.tasks) {
    const length = JSON.stringify(task).length;
    if (chunk.length > 0 && (chunk.length >= TASKS_PER_BATCH || size + length > MAX_BATCH_CHARS)) {
      steps.push({ tasks: chunk } as unknown as Json);
      chunk = [];
      size = 0;
    }
    chunk.push(task);
    size += length;
  }
  if (chunk.length > 0) steps.push({ tasks: chunk } as unknown as Json);
  for (let i = 0; i < plan.dependencies.length; i += DEPENDENCIES_PER_BATCH) {
    steps.push({ dependencies: plan.dependencies.slice(i, i + DEPENDENCIES_PER_BATCH) } as unknown as Json);
  }
  return steps;
}

// Every external id the plan would create, by kind (for the dry-run "already imported" counts).
export function planExternalIds(plan: ImportPlan) {
  return {
    project: plan.project ? [plan.project.gid] : [],
    section: plan.sections.map((s) => s.key),
    field: plan.fields.map((f) => f.key),
    task: plan.tasks.map((t) => t.gid),
    subtask: plan.tasks.flatMap((t) => flattenSubtasks(t.subtasks).map((s) => s.gid)),
    comment: plan.tasks.flatMap((t) => t.comments.map((c) => c.gid)),
    attachment: plan.tasks.flatMap((t) => t.attachments.map((a) => a.gid)),
  };
}
