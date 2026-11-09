// AI builder pilot (experimental, feat/ai-builder): turns the practice export (plain Asana API objects,
// normalized into collections: workspace, users, custom_fields, projects, tasks, stories) into what the
// existing Asana importer takes (the import_batch format, documented above that function in
// supabase/migrations/20261005090000_asana_import.sql), plus the few writes the importer can't carry.
// Pure: no network, no database, no files. The seed script (scripts/ai-builder/pilot-seed.ts) runs it.
//
// Isolation: every external id is namespaced by the pilot's marker ("pilot:<marker>:<gid>"). The importer
// multi-homes a task into "other projects where that Asana project was imported before", looked up by
// external id across the database; namespacing means it can only ever find this pilot's own projects —
// never a real project imported from the same Asana project.
//
// People: nobody is invited or created. A source person maps to the operator's explicitly selected,
// signed-in account ("account") or stays a name-only placeholder ("placeholder", the default): the importer
// then leaves the task unassigned with "Assignee in Asana: <name>" in its notes, and posts their comments as
// the operator with "<name> wrote in Asana:". Source emails of placeholders are never written anywhere.
//
// Imported text is data: it is stored as task / comment text and never interpreted.

import type { Json } from "./supabase/database.types";

export class SeedInputError extends Error {}

export type SeedPersonMode = "account" | "placeholder";

export type SeedOptions = {
  marker: string;
  accountEmail: string;
  // By Asana user gid or (lowercased) email. Anyone not listed is a placeholder.
  people: Record<string, SeedPersonMode>;
  // Appended to each project's name so practice projects never read like the real ones.
  nameSuffix: string;
};

export type SeedFieldType = "text" | "number" | "date" | "single_select" | "multi_select" | "people";

export type SeedProjectPlan = {
  sourceGid: string;
  externalGid: string;
  name: string;
  // The import_batch batches, in order: structure first, then tasks.
  batches: Json[];
  sections: { key: string; name: string }[];
  fields: { key: string; sourceGid: string; name: string; type: SeedFieldType; options: string[] }[];
  // Top-level tasks homed here (source gids) and their subtasks.
  taskGids: string[];
  subtaskGids: string[];
  // Comments the importer posts here (top-level tasks only).
  commentCount: number;
  // Top-level tasks in this project (homed here or multi-homed in from another project).
  memberships: number;
};

// A comment on a subtask (the importer carries comments of top-level tasks only).
export type SeedComment = { sourceKey: string; taskGid: string; homeProjectGid: string; isSubtask: true; body: string };

// A field value the importer can't set: on a subtask, or on a top-level task for a field of one of its
// other projects. Choice values are option NAMES; the seed script resolves them to the created field's
// option ids.
export type SeedValue = {
  sourceKey: string;
  taskGid: string;
  homeProjectGid: string;
  isSubtask: boolean;
  fieldGid: string;
  fieldProjectGid: string;
  type: SeedFieldType;
  value: string | number | string[];
};

export type SeedExpected = {
  projects: number;
  sections: number;
  fields: number;
  options: number;
  topLevelTasks: number;
  subtasks: number;
  comments: number;
};

export type SeedPlan = {
  projects: SeedProjectPlan[];
  comments: SeedComment[];
  values: SeedValue[];
  expected: SeedExpected;
  people: { gid: string; name: string; mode: SeedPersonMode }[];
  // What the practice data loses on the way in, said plainly.
  omissions: string[];
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const gidOf = (v: unknown): string | null => (isObj(v) ? str(v.gid) : null);
const ISO = /^\d{4}-\d{2}-\d{2}/;
const isoDate = (v: unknown): string | null => {
  const s = str(v);
  return s && ISO.test(s) ? s.slice(0, 10) : null;
};

export function namespaced(marker: string, gid: string): string {
  return `pilot:${marker}:${gid}`;
}

const FIELD_TYPES: Record<string, SeedFieldType> = {
  text: "text",
  number: "number",
  date: "date",
  enum: "single_select",
  multi_enum: "multi_select",
  people: "people",
};

export function buildSeedPlan(source: unknown, options: SeedOptions): SeedPlan {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.marker)) {
    throw new SeedInputError("The pilot marker must be a uuid");
  }
  const account = options.accountEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(account)) throw new SeedInputError("The selected account must be an email address");
  if (!isObj(source)) throw new SeedInputError("The export must be a JSON object");
  for (const k of ["users", "custom_fields", "projects", "tasks", "stories"]) {
    if (!Array.isArray(source[k])) throw new SeedInputError(`The export has no “${k}” list`);
  }
  const ns = (gid: string) => namespaced(options.marker, gid);
  const omissions: string[] = [];

  // People ----------------------------------------------------------------------------------------
  const users = new Map<string, { gid: string; name: string; email: string | null }>();
  for (const u of arr(source.users)) {
    const gid = str(u.gid);
    if (gid) users.set(gid, { gid, name: str(u.name) ?? "Someone", email: str(u.email)?.toLowerCase() ?? null });
  }
  const modeOf = (gid: string | null): SeedPersonMode => {
    if (!gid) return "placeholder";
    const u = users.get(gid);
    return options.people[gid] ?? (u?.email ? options.people[u.email] : undefined) ?? "placeholder";
  };
  const person = (v: unknown) => {
    const gid = gidOf(v);
    if (!gid) return null;
    const u = users.get(gid);
    const name = u?.name ?? (isObj(v) ? str(v.name) : null) ?? "Someone";
    return { gid, name, email: modeOf(gid) === "account" ? account : null };
  };

  // Field definitions -----------------------------------------------------------------------------
  const definitions = new Map<string, { gid: string; name: string; type: SeedFieldType; options: { gid: string; name: string; enabled: boolean }[] }>();
  const unsupportedTypes: string[] = [];
  for (const f of arr(source.custom_fields)) {
    const gid = str(f.gid);
    const name = str(f.name);
    if (!gid || !name) continue;
    const type = FIELD_TYPES[str(f.resource_subtype) ?? ""];
    if (!type) {
      unsupportedTypes.push(str(f.resource_subtype) ?? "unknown");
      continue;
    }
    definitions.set(gid, {
      gid,
      name: name.slice(0, 100),
      type,
      options: arr(f.enum_options)
        .map((o) => ({ gid: str(o.gid) ?? "", name: (str(o.name) ?? "").slice(0, 100), enabled: o.enabled !== false }))
        .filter((o) => o.gid && o.name),
    });
  }
  if (unsupportedTypes.length) {
    omissions.push(`${unsupportedTypes.length} custom field definition(s) of a type the importer doesn’t support were skipped (${[...new Set(unsupportedTypes)].join(", ")}).`);
  }

  // Projects ---------------------------------------------------------------------------------------
  const projects = arr(source.projects).map((p) => {
    const gid = str(p.gid);
    const name = str(p.name);
    if (!gid || !name) throw new SeedInputError("Every project needs a gid and a name");
    const fieldGids = arr(p.custom_field_settings).map((s) => gidOf(s.custom_field)).filter((g): g is string => !!g && definitions.has(g));
    return {
      gid,
      name: `${name}${options.nameSuffix}`.slice(0, 200),
      sections: arr(p.sections)
        .map((s) => ({ gid: str(s.gid) ?? "", name: (str(s.name) ?? "").slice(0, 200) }))
        .filter((s) => s.gid && s.name),
      fieldGids,
    };
  });
  if (projects.length === 0) throw new SeedInputError("The export has no projects");
  const projectIndex = new Map(projects.map((p, i) => [p.gid, i]));
  const fieldProject = new Map<string, string>();
  for (const p of projects) for (const g of p.fieldGids) if (!fieldProject.has(g)) fieldProject.set(g, p.gid);

  // Tasks ------------------------------------------------------------------------------------------
  const tasks = arr(source.tasks);
  const byGid = new Map<string, Obj>();
  for (const t of tasks) {
    const gid = str(t.gid);
    if (gid) byGid.set(gid, t);
  }
  const parentOf = (t: Obj) => gidOf(t.parent);
  const children = new Map<string, Obj[]>();
  for (const t of tasks) {
    const parent = parentOf(t);
    if (parent) {
      if (!byGid.has(parent)) throw new SeedInputError(`Subtask ${str(t.gid)} names a parent that isn’t in the export`);
      children.set(parent, [...(children.get(parent) ?? []), t]);
    }
  }
  const topLevel = tasks.filter((t) => !parentOf(t));

  const storiesByTask = new Map<string, Obj[]>();
  let otherStories = 0;
  for (const s of arr(source.stories)) {
    const target = gidOf(s.target);
    const isComment = str(s.type) === "comment" || str(s.resource_subtype) === "comment_added";
    if (!target || !isComment || !byGid.has(target)) {
      otherStories++;
      continue;
    }
    storiesByTask.set(target, [...(storiesByTask.get(target) ?? []), s]);
  }
  if (otherStories) omissions.push(`${otherStories} story item(s) that aren’t comments on exported tasks were skipped.`);

  const projectsOf = (t: Obj) =>
    arr(t.memberships)
      .map((m) => ({ project: gidOf(m.project), section: gidOf(m.section), sectionName: isObj(m.section) ? str(m.section.name) : null }))
      .filter((m): m is { project: string; section: string | null; sectionName: string | null } => !!m.project && projectIndex.has(m.project));

  const values: SeedValue[] = [];
  const comments: SeedComment[] = [];
  let peopleValuesSkipped = 0;

  const valueOf = (cf: Obj, def: NonNullable<ReturnType<typeof definitions.get>>): string | number | string[] | null => {
    const optName = (g: string | null) => def.options.find((o) => o.gid === g)?.name ?? null;
    switch (def.type) {
      case "text":
        return str(cf.text_value);
      case "number":
        return typeof cf.number_value === "number" ? cf.number_value : null;
      case "date":
        return isoDate(isObj(cf.date_value) ? cf.date_value.date : null);
      case "single_select":
        return optName(gidOf(cf.enum_value));
      case "multi_select": {
        const names = arr(cf.multi_enum_values).map((o) => optName(str(o.gid))).filter((n): n is string => !!n);
        return names.length ? names : null;
      }
      case "people": {
        const list = arr(cf.people_value);
        const emails = list.map((p) => person(p)?.email).filter((e): e is string => !!e);
        peopleValuesSkipped += list.length - emails.length;
        return emails.length ? [...new Set(emails)] : null;
      }
    }
  };

  const stamp = (t: Obj) => (t.completed === true ? (str(t.completed_at) ?? null) : null);
  const commentsFor = (taskGid: string) =>
    (storiesByTask.get(taskGid) ?? []).map((s) => {
      const author = person(s.created_by);
      return {
        gid: ns(str(s.gid) ?? `${taskGid}:${str(s.created_at)}`),
        body: (str(s.text) ?? "").slice(0, 9000),
        author_email: author?.email ?? null,
        author_name: author?.name ?? null,
        created_at: str(s.created_at),
      };
    });

  const plans: SeedProjectPlan[] = projects.map((p) => ({
    sourceGid: p.gid,
    externalGid: ns(p.gid),
    name: p.name,
    batches: [],
    sections: p.sections.map((s) => ({ key: ns(s.gid), name: s.name })),
    fields: p.fieldGids.map((g) => {
      const d = definitions.get(g)!;
      return { key: ns(g), sourceGid: g, name: d.name, type: d.type, options: d.options.map((o) => o.name) };
    }),
    taskGids: [],
    subtaskGids: [],
    commentCount: 0,
    memberships: 0,
  }));
  const taskItems = new Map<string, Json[]>(projects.map((p) => [p.gid, []]));
  let unassignedPlaceholders = 0;

  for (const t of topLevel) {
    const gid = str(t.gid)!;
    const memberships = projectsOf(t);
    if (memberships.length === 0) throw new SeedInputError(`Task ${gid} isn’t in any exported project`);
    // Homed in the LAST of its projects in import order: the others are imported first, so the importer
    // adds the task to them too ("projects" below).
    const home = memberships.reduce((a, b) => (projectIndex.get(b.project)! > projectIndex.get(a.project)! ? b : a));
    const plan = plans[projectIndex.get(home.project)!];
    for (const m of new Set(memberships.map((x) => x.project))) plans[projectIndex.get(m)!].memberships++;
    const homeFields = new Set(projects[projectIndex.get(home.project)!].fieldGids);
    const taskProjects = new Set(memberships.map((m) => m.project));

    const fields: Json[] = [];
    for (const cf of arr(t.custom_fields)) {
      const fg = str(cf.gid);
      const def = fg ? definitions.get(fg) : undefined;
      if (!fg || !def) continue;
      const v = valueOf(cf, def);
      if (v === null) continue;
      if (homeFields.has(fg)) fields.push({ key: ns(fg), value: v });
      else {
        const fp = [...taskProjects].find((pg) => projects[projectIndex.get(pg)!].fieldGids.includes(fg));
        if (fp) values.push({ sourceKey: `value:${gid}:${fg}`, taskGid: gid, homeProjectGid: home.project, isSubtask: false, fieldGid: fg, fieldProjectGid: fp, type: def.type, value: v });
      }
    }

    const assignee = person(t.assignee);
    if (assignee && !assignee.email) unassignedPlaceholders++;
    const subtasks: Json[] = [];
    for (const s of children.get(gid) ?? []) {
      const sg = str(s.gid)!;
      if (children.has(sg)) omissions.push(`Subtask ${sg}'s own subtasks were left out (the practice export has none).`);
      const sa = person(s.assignee);
      if (sa && !sa.email) unassignedPlaceholders++;
      subtasks.push({
        gid: ns(sg),
        title: (str(s.name) ?? "Untitled subtask").slice(0, 1000),
        kind: "task",
        notes: str(s.notes),
        completed_at: stamp(s),
        due_on: isoDate(s.due_on),
        start_on: isoDate(s.start_on),
        assignee_email: sa?.email ?? null,
        assignee_name: sa?.name ?? null,
        subtasks: [],
      });
      plan.subtaskGids.push(sg);
      for (const cf of arr(s.custom_fields)) {
        const fg = str(cf.gid);
        const def = fg ? definitions.get(fg) : undefined;
        if (!fg || !def) continue;
        const v = valueOf(cf, def);
        if (v === null) continue;
        const fp = [...taskProjects].find((pg) => projects[projectIndex.get(pg)!].fieldGids.includes(fg));
        if (fp) values.push({ sourceKey: `value:${sg}:${fg}`, taskGid: sg, homeProjectGid: home.project, isSubtask: true, fieldGid: fg, fieldProjectGid: fp, type: def.type, value: v });
      }
      for (const c of storiesByTask.get(sg) ?? []) {
        const author = person(c.created_by);
        const when = isoDate(c.created_at);
        const body = (str(c.text) ?? "").slice(0, 9000);
        if (!body) continue;
        comments.push({
          sourceKey: `comment:${str(c.gid) ?? `${sg}:${str(c.created_at)}`}`,
          taskGid: sg,
          homeProjectGid: home.project,
          isSubtask: true,
          body: `Originally posted in Asana${when ? ` on ${when}` : ""} by ${author?.name ?? "someone"}:\n\n${body}`,
        });
      }
    }

    const topComments = commentsFor(gid).filter((c) => c.body);
    plan.commentCount += topComments.length;
    plan.taskGids.push(gid);
    taskItems.get(home.project)!.push({
      gid: ns(gid),
      title: (str(t.name) ?? "Untitled task").slice(0, 1000),
      kind: "task",
      notes: str(t.notes),
      completed_at: stamp(t),
      due_on: isoDate(t.due_on),
      start_on: isoDate(t.start_on),
      assignee_email: assignee?.email ?? null,
      assignee_name: assignee?.name ?? null,
      section_key: home.section ? ns(home.section) : null,
      projects: memberships
        .filter((m) => m.project !== home.project)
        .map((m) => ({ gid: ns(m.project), section_name: m.sectionName })),
      fields,
      tags: arr(t.tags).map((g) => str(g.name)).filter((n): n is string => !!n),
      followers: [...new Set(arr(t.followers).map((f) => person(f)?.email).filter((e): e is string => !!e))],
      subtasks,
      comments: topComments,
      attachments: [],
    });
  }

  for (const plan of plans) {
    plan.batches = [
      { project: { gid: plan.externalGid, name: plan.name }, sections: plan.sections, fields: plan.fields.map(({ key, name, type, options }) => ({ key, name, type, options })), rules: [] },
    ];
    const items = taskItems.get(plan.sourceGid)!;
    for (let i = 0; i < items.length; i += 50) plan.batches.push({ tasks: items.slice(i, i + 50) });
  }

  const disabledOptions = [...definitions.values()].reduce((n, d) => n + d.options.filter((o) => !o.enabled).length, 0);
  if (disabledOptions) omissions.push(`${disabledOptions} disabled Asana option(s) are imported as ordinary options (ALHC has no disabled options).`);
  omissions.push("Option colors aren’t carried (the importer assigns its own palette).");
  if (unassignedPlaceholders) omissions.push(`${unassignedPlaceholders} assignment(s) to placeholder people are left unassigned with “Assignee in Asana: <name>” in the notes.`);
  if (peopleValuesSkipped) omissions.push(`${peopleValuesSkipped} People-field value(s) naming placeholder people were left empty.`);
  if (comments.length) omissions.push(`${comments.length} subtask comment(s) are posted by the selected account with an “Originally posted in Asana on <date> by <name>” line (the importer carries top-level comments only).`);
  if (values.length) omissions.push(`${values.length} field value(s) on subtasks, or for a multi-homed task’s other project, are set after the import by the seed (the importer sets top-level values of the home project only); People-field values are left empty.`);
  omissions.push(
    "Not in the export, so not created: rules/automations, forms, attachments, views, portfolios, project colors, owners, and members (the selected account owns every practice project).",
    "Task creation times aren’t kept (the importer stamps the import time); completion times and top-level comment times are.",
  );

  return {
    projects: plans,
    comments,
    values,
    expected: {
      projects: plans.length,
      sections: plans.reduce((n, p) => n + p.sections.length, 0),
      fields: plans.reduce((n, p) => n + p.fields.length, 0),
      options: plans.reduce((n, p) => n + p.fields.reduce((m, f) => m + f.options.length, 0), 0),
      topLevelTasks: plans.reduce((n, p) => n + p.taskGids.length, 0),
      subtasks: plans.reduce((n, p) => n + p.subtaskGids.length, 0),
      comments: plans.reduce((n, p) => n + p.commentCount, 0) + comments.length,
    },
    people: [...users.values()].map((u) => ({ gid: u.gid, name: u.name, mode: modeOf(u.gid) })),
    omissions,
  };
}

// Compares the plan with the export's manifest counts ("counts" in manifest.json). Problems, if any.
export function checkManifest(plan: SeedPlan, manifest: unknown): string[] {
  const counts = isObj(manifest) && isObj(manifest.counts) ? manifest.counts : null;
  if (!counts) return ["The manifest has no counts"];
  const pairs: [keyof SeedExpected, string][] = [
    ["projects", "projects"],
    ["sections", "sections"],
    ["fields", "custom_field_definitions"],
    ["options", "enum_options"],
    ["topLevelTasks", "top_level_tasks"],
    ["subtasks", "subtasks"],
    ["comments", "comments"],
  ];
  return pairs
    .filter(([k, m]) => typeof counts[m] === "number" && counts[m] !== plan.expected[k])
    .map(([k, m]) => `${m}: the manifest says ${counts[m]}, the plan has ${plan.expected[k]}`);
}
