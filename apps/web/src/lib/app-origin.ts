// Security audit 2 (Nov 12, batch 41): which site address a link may be built from. A request's Origin or
// Host header is only used when it is one of this app's own addresses: the configured app URL, this
// deployment's Vercel addresses, or localhost when not running on Vercel (`next dev`, a local
// `next start`). Anything else falls back to the app's own address, so a forged header can never put
// another site into an email link. Pure (no Next.js, no server-only), so the unit tests check every case;
// src/lib/origin.ts reads the headers.

export type OriginEnv = Record<string, string | undefined>;

// The production site (Vercel's production domain of this project).
export const PRODUCTION_APP_ORIGIN = "https://alhc-projects.vercel.app";
export const LOCAL_APP_ORIGIN = "http://localhost:3000";

// "https://host[:port]" (or "host[:port]" with a default scheme) → its origin; null for anything else.
export function originOf(value: string | null | undefined, defaultScheme: "https" | "http" = "https"): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `${defaultScheme}://${raw}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

// This app's own addresses: the configured app URL and the ones Vercel gives this deployment.
export function trustedOrigins(env: OriginEnv): Set<string> {
  const values = [
    originOf(env.NEXT_PUBLIC_APP_URL),
    originOf(env.VERCEL_URL),
    originOf(env.VERCEL_BRANCH_URL),
    originOf(env.VERCEL_PROJECT_PRODUCTION_URL),
  ];
  return new Set(values.filter((v): v is string => v !== null));
}

function isLocalhost(origin: string): boolean {
  const { hostname } = new URL(origin);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

// An origin a request claims, if it is one of this app's own; else null.
export function verifiedOrigin(claimed: string | null | undefined, env: OriginEnv): string | null {
  const origin = originOf(claimed);
  if (!origin) return null;
  // An Origin header is exactly "scheme://host[:port]"; anything longer isn't one.
  if (claimed && claimed.includes("://") && claimed.trim().replace(/\/+$/, "") !== origin) return null;
  if (trustedOrigins(env).has(origin)) return origin;
  if (!env.VERCEL && isLocalhost(origin)) return origin;
  return null;
}

// The app's own address when a request says nothing usable: production's domain, a preview's own URL, or
// localhost off Vercel.
export function fallbackOrigin(env: OriginEnv): string {
  if (!env.VERCEL) return LOCAL_APP_ORIGIN;
  if (env.VERCEL_ENV === "production") return PRODUCTION_APP_ORIGIN;
  return originOf(env.VERCEL_URL) ?? PRODUCTION_APP_ORIGIN;
}

// NEXT_PUBLIC_APP_URL as it has always been read (trailing slashes dropped).
export function configuredOrigin(env: OriginEnv): string | null {
  return env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") || null;
}

// Sign-up confirmation and password-reset links (Supabase Auth's emails). The browser's Origin first, when
// it is this app's own: the reset link must come back to the site that started it (its PKCE code verifier
// is a cookie there), as it always has on production, previews, and localhost. Then the configured app
// URL, then the app's own address. Never the Host header.
export function authEmailOrigin(originHeader: string | null | undefined, env: OriginEnv): string {
  return verifiedOrigin(originHeader, env) ?? configuredOrigin(env) ?? fallbackOrigin(env);
}

// Links built during a request (share links, embed snippets, calendar links, review emails): the
// configured app URL first (as before), else the request's host when it is this app's own, else the app's
// own address.
export function requestLinkOrigin(host: string | null | undefined, proto: string | null | undefined, env: OriginEnv): string {
  const configured = configuredOrigin(env);
  if (configured) return configured;
  const value = host?.trim();
  if (value) {
    const scheme = proto === "http" || proto === "https" ? proto : value.startsWith("localhost") ? "http" : "https";
    const claimed = originOf(`${scheme}://${value}`);
    const verified = claimed && verifiedOrigin(claimed, env);
    if (verified) return verified;
  }
  return fallbackOrigin(env);
}
