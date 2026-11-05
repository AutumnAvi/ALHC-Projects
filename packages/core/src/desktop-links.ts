// The desktop app's links (big move 3, docs/design/desktop.md). The desktop app (apps/desktop) is a Tauri
// shell around the hosted web app, and an alhc:// link opens one of its pages:
//
//   alhc://<path>?<query>#<hash>   → <app origin>/<path>?<query>#<hash>   for the app's own sections
//   alhc:// (or alhc://home)       → /                                    Home
//   alhc://task/<id>               → /my-tasks?task=<id>                  any task you can read, in the pane
//   alhc://settings[/<tab>]        → /?settings=<tab>                     the Settings modal
//
// e.g. alhc://projects/<id>?task=<id> opens a task in its project, alhc://inbox?tab=mentioned the Inbox's
// @Mentioned tab. A link to anything else (another section, odd characters, a path that climbs out) opens
// Home; the app itself decides what the person may see, exactly as for a typed address. Pure: the desktop
// launcher (apps/desktop/src/launcher.ts) runs it, and the web app can build links with desktopLinkFor().
import { isSettingsTab } from "./shell";

export const DESKTOP_LINK_SCHEME = "alhc";

// First path segments a link may open: the signed-in app's sections (apps/web/src/app/(app) and (admin)).
// Auth pages, the API, files, and public pages are left out on purpose.
export const DESKTOP_LINK_SECTIONS = [
  "projects",
  "my-tasks",
  "inbox",
  "search",
  "portfolios",
  "goals",
  "teams",
  "people",
  "reports",
  "templates",
  "approve",
  "admin",
  "help",
  "project-access",
  "team-access",
] as const;

const SECTIONS: ReadonlySet<string> = new Set(DESKTOP_LINK_SECTIONS);
// Sections that have no page of their own: only what's under them opens (alhc://people alone opens Home).
const NEEDS_MORE: ReadonlySet<string> = new Set(["projects", "people", "approve", "help", "project-access", "team-access"]);
const SEGMENT = /^[A-Za-z0-9_-]{1,200}$/;
const HASH = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_SEGMENTS = 8;
const MAX_LENGTH = 4000;
const HOME = "/";

function withQuery(path: string, query: string, hash: string): string {
  const params = new URLSearchParams(query);
  const search = params.toString();
  return `${path}${search ? `?${search}` : ""}${hash && HASH.test(hash) ? `#${hash}` : ""}`;
}

// The app path an alhc:// link opens, or null when the value isn't an alhc:// link at all. Every link of
// the scheme opens something: Home when it names nothing the desktop app opens.
export function desktopLinkPath(link: string): string | null {
  const value = link.trim();
  const match = /^alhc:(.*)$/is.exec(value);
  if (!match) return null;
  if (value.length > MAX_LENGTH || /[\u0000-\u001f\u007f\\]/.test(value)) return HOME;

  // alhc://projects/x, alhc:///projects/x, and alhc:projects/x all mean /projects/x (in a URL parser the
  // first one's "projects" would be a host).
  let rest = match[1].replace(/^\/+/, "");
  let hash = "";
  let query = "";
  const hashAt = rest.indexOf("#");
  if (hashAt >= 0) [rest, hash] = [rest.slice(0, hashAt), rest.slice(hashAt + 1)];
  const queryAt = rest.indexOf("?");
  if (queryAt >= 0) [rest, query] = [rest.slice(0, queryAt), rest.slice(queryAt + 1)];

  const segments = rest.split("/").filter((s) => s !== "");
  if (segments.length > MAX_SEGMENTS || !segments.every((s) => SEGMENT.test(s))) return HOME;
  const [first, second] = segments;
  if (!first || first === "home") return withQuery(HOME, query, hash);

  if (first === "task") {
    return segments.length === 2 ? withQuery("/my-tasks", `task=${encodeURIComponent(second)}`, "") : HOME;
  }
  if (first === "settings") {
    const tab = second && isSettingsTab(second) ? second : "profile";
    return segments.length <= 2 ? withQuery(HOME, `settings=${tab}`, "") : HOME;
  }
  if (!SECTIONS.has(first) || (NEEDS_MORE.has(first) && segments.length < 2)) return HOME;
  return withQuery(`/${segments.join("/")}`, query, hash);
}

// The alhc:// link for an app path ("/projects/x?task=y"), or null when the desktop app wouldn't open that
// page. The link is written the way desktopLinkPath reads it back (the query re-encoded; a fragment that
// isn't an anchor id left out), so desktopLinkPath(desktopLinkFor(p)) is that page.
export function desktopLinkFor(path: string): string | null {
  if (sameOriginPath(path) !== path) return null;
  const url = new URL(path, "https://same-origin.invalid");
  const page = withQuery(url.pathname, url.search.slice(1), url.hash.slice(1));
  const link = `${DESKTOP_LINK_SCHEME}://${page.replace(/^\/+/, "")}`;
  return desktopLinkPath(link) === page ? link : null;
}

// A relative path on the app's own origin, or "/" (the same rule as the web app's safeNextPath() in
// apps/web/src/lib/auth.ts). The desktop shell's Reload goes through the launcher with the page's path.
export function sameOriginPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\u0000-\u001f\u007f\\]/.test(value)) {
    return HOME;
  }
  try {
    const url = new URL(value, "https://same-origin.invalid");
    if (url.origin !== "https://same-origin.invalid") return HOME;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return HOME;
  }
}
