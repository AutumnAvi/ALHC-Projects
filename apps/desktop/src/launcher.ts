// The desktop app's launcher (big move 3, docs/design/desktop.md): the one page the app ships. Every window
// opens it first; it checks the hosted app answers, then replaces itself with the page to show. Pure rules
// here (unit-tested); main.ts does the DOM.
import { desktopLinkPath, sameOriginPath } from "@alhc/core/desktop-links";

// What the Rust shell puts on every page of its windows (src-tauri/src/shell.rs, initialization script):
// window.__ALHC_DESKTOP__. The shell is the only place the app's address is configured.
export type ShellInfo = { appOrigin: string; platform: string; version: string };

export function readShellInfo(value: unknown): ShellInfo | null {
  if (!value || typeof value !== "object") return null;
  const { appOrigin, platform, version } = value as Record<string, unknown>;
  if (typeof appOrigin !== "string" || typeof platform !== "string" || typeof version !== "string") return null;
  const origin = appOriginOf(appOrigin);
  return origin ? { appOrigin: origin, platform, version } : null;
}

// An origin the launcher may send a window to: https, or http on this computer (a local web app in
// development, ALHC_APP_URL=http://localhost:3000). Nothing after the host.
export function appOriginOf(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  return value === url.origin || value === `${url.origin}/` ? url.origin : null;
}

// Where the window goes: ?open=<alhc:// link> (a deep link the shell received), ?to=<path> (Reload: the
// path the window was on), else Home. Only ever a page of the app's own origin.
export function launchTarget(search: string, appOrigin: string): string {
  const params = new URLSearchParams(search);
  const open = params.get("open");
  const to = params.get("to");
  const path = open !== null ? (desktopLinkPath(open) ?? "/") : to !== null ? sameOriginPath(to) : "/";
  return `${appOrigin}${path}`;
}

// A small request that answers when the app is reachable (any HTTP status counts: it's only a reachability
// check, the launcher can't read a cross-origin answer anyway).
export function probeUrl(appOrigin: string): string {
  return `${appOrigin}/favicon.ico`;
}

const RETRY_SECONDS = [2, 4, 8, 15, 30];

// Seconds before the next automatic try after `failures` failed ones (the button and coming back online
// try at once).
export function retryDelaySeconds(failures: number): number {
  return RETRY_SECONDS[Math.min(Math.max(failures, 1), RETRY_SECONDS.length) - 1];
}

// The web app needs a current web engine (Next.js 16 targets Safari 16.4; Tailwind 4 needs color-mix and
// :has). WebView2 is always current; on a Mac it's the system's Safari, which can be years old. Rather than
// a broken page, the launcher says so. `supports` is CSS.supports.
export function engineTooOld(supports: (property: string, value?: string) => boolean): boolean {
  try {
    return !(supports("selector(:has(a))") && supports("color", "color-mix(in srgb, red, blue)"));
  } catch {
    return true;
  }
}
