// Nov 1 notes, batch 9a (Asana test 10.3): links to this app's tasks and projects in comment text. The
// @ menu inserts them (a task's or project's URL), and links people paste are recognised the same way;
// the comment shows the task's or project's name as a chip (looked up with the reader's own access, so
// something they can't open shows as "Private link"). Pure and server-safe (unit-tested).
//
// Recognised: an http(s) URL whose path is /projects/<uuid>[/...] (a project), and any of them — or
// /my-tasks, /inbox, /search, a team or person page — with ?task=<uuid> (a task). Only the ids matter:
// a chip always opens the task in the pane or the project in this app, never the URL's host.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const PROJECT_PATH = new RegExp(`^/projects/(${UUID})(?:/[^?#]*)?$`, "i");
const TASK_PARAM = new RegExp(`(?:^|&)task=(${UUID})(?:&|$)`, "i");

export type AppLink = { kind: "task"; taskId: string; projectId: string | null } | { kind: "project"; projectId: string };

export type AppLinkSegment = { type: "text"; text: string } | { type: "link"; link: AppLink; raw: string };

// Trailing punctuation a sentence puts after a URL ("see https://…/projects/x."), kept as text.
function trimTrailing(url: string): { url: string; rest: string } {
  const m = /[.,;:!?)\]}]+$/.exec(url);
  return m ? { url: url.slice(0, m.index), rest: m[0] } : { url, rest: "" };
}

export function parseAppLink(url: string): AppLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const project = PROJECT_PATH.exec(parsed.pathname);
  const task = TASK_PARAM.exec(parsed.search.replace(/^\?/, ""));
  if (task) return { kind: "task", taskId: task[1].toLowerCase(), projectId: project ? project[1].toLowerCase() : null };
  if (project) return { kind: "project", projectId: project[1].toLowerCase() };
  return null;
}

// The text split into plain text and app links (other URLs stay text).
export function appLinkSegments(body: string): AppLinkSegment[] {
  const out: AppLinkSegment[] = [];
  let last = 0;
  for (const match of body.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    const { url, rest } = trimTrailing(match[0]);
    const link = parseAppLink(url);
    if (!link) continue;
    if (start > last) out.push({ type: "text", text: body.slice(last, start) });
    out.push({ type: "link", link, raw: url });
    last = start + url.length;
    if (rest) {
      out.push({ type: "text", text: rest });
      last += rest.length;
    }
  }
  if (last < body.length) out.push({ type: "text", text: body.slice(last) });
  // Merge neighbouring text parts.
  return out.reduce<AppLinkSegment[]>((acc, seg) => {
    const prev = acc[acc.length - 1];
    if (seg.type === "text" && prev?.type === "text") prev.text += seg.text;
    else acc.push(seg.type === "text" ? { ...seg } : seg);
    return acc;
  }, []);
}

// Every task and project id linked from these bodies (for one lookup).
export function appLinkIds(bodies: readonly string[]): { taskIds: string[]; projectIds: string[] } {
  const tasks = new Set<string>();
  const projects = new Set<string>();
  for (const body of bodies) {
    for (const seg of appLinkSegments(body)) {
      if (seg.type !== "link") continue;
      if (seg.link.kind === "task") tasks.add(seg.link.taskId);
      else projects.add(seg.link.projectId);
    }
  }
  return { taskIds: [...tasks], projectIds: [...projects] };
}

// The URL the @ menu inserts for a task (in its project when it has one) or a project.
export function taskLinkUrl(origin: string, taskId: string, projectId: string | null): string {
  return projectId ? `${origin}/projects/${projectId}?task=${taskId}` : `${origin}/my-tasks?task=${taskId}`;
}

export function projectLinkUrl(origin: string, projectId: string): string {
  return `${origin}/projects/${projectId}`;
}

// Nov 3 notes (batch 18, 133): the "#" link picker. The search text of a "#" query: trimmed, single spaces.
export function linkSearchText(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

// A query that already came back empty: a longer one can't match more (names are matched as substrings),
// except a number, which matches exactly ("1" finds nothing, "12" finds Task #12).
export function extendsDeadQuery(query: string, dead: string | null): boolean {
  if (!dead || /\d/.test(query)) return false;
  return query.startsWith(dead);
}
