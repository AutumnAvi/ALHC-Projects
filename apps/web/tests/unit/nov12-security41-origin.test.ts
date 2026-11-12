// Security audit 2 (Nov 12, batch 41, Low): sign-up and password-reset links (and the other links built
// during a request) never take their site from a forged Origin or Host header (src/lib/app-origin.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  LOCAL_APP_ORIGIN,
  PRODUCTION_APP_ORIGIN,
  authEmailOrigin,
  requestLinkOrigin,
  verifiedOrigin,
} from "@/lib/app-origin";

// What Vercel gives each kind of deployment (VERCEL_* are its system environment variables).
const PRODUCTION = {
  VERCEL: "1",
  VERCEL_ENV: "production",
  VERCEL_URL: "alhc-projects-abc123-autumn.vercel.app",
  VERCEL_BRANCH_URL: "alhc-projects-git-main-autumn.vercel.app",
  VERCEL_PROJECT_PRODUCTION_URL: "alhc-projects.vercel.app",
};
const PRODUCTION_CONFIGURED = { ...PRODUCTION, NEXT_PUBLIC_APP_URL: "https://alhc-projects.vercel.app" };
const PREVIEW = {
  VERCEL: "1",
  VERCEL_ENV: "preview",
  VERCEL_URL: "alhc-projects-def456-autumn.vercel.app",
  VERCEL_BRANCH_URL: "alhc-projects-git-security-autumn.vercel.app",
  VERCEL_PROJECT_PRODUCTION_URL: "alhc-projects.vercel.app",
};
const LOCAL = {};

test("production: the real site, its deployment and branch URLs; a forged Origin gets the production site", () => {
  assert.equal(authEmailOrigin("https://alhc-projects.vercel.app", PRODUCTION), "https://alhc-projects.vercel.app");
  assert.equal(authEmailOrigin("https://alhc-projects-abc123-autumn.vercel.app", PRODUCTION), "https://alhc-projects-abc123-autumn.vercel.app");
  assert.equal(authEmailOrigin("https://alhc-projects-git-main-autumn.vercel.app", PRODUCTION), "https://alhc-projects-git-main-autumn.vercel.app");
  for (const forged of ["https://evil.example", "http://alhc-projects.vercel.app", "https://alhc-projects.vercel.app.evil.example", "http://localhost:3000", "null", "", null]) {
    assert.equal(authEmailOrigin(forged, PRODUCTION), PRODUCTION_APP_ORIGIN, String(forged));
    assert.equal(authEmailOrigin(forged, PRODUCTION_CONFIGURED), "https://alhc-projects.vercel.app", String(forged));
  }
  // Not an origin at all (a path, credentials): refused.
  assert.equal(verifiedOrigin("https://alhc-projects.vercel.app/evil", PRODUCTION), null);
  assert.equal(verifiedOrigin("https://user:pw@alhc-projects.vercel.app", PRODUCTION), null);
});

test("previews: the preview's own URLs work as today; a forged Origin gets the preview itself", () => {
  assert.equal(authEmailOrigin("https://alhc-projects-def456-autumn.vercel.app", PREVIEW), "https://alhc-projects-def456-autumn.vercel.app");
  assert.equal(authEmailOrigin("https://alhc-projects-git-security-autumn.vercel.app", PREVIEW), "https://alhc-projects-git-security-autumn.vercel.app");
  assert.equal(authEmailOrigin("https://evil.example", PREVIEW), "https://alhc-projects-def456-autumn.vercel.app");
  assert.equal(authEmailOrigin(null, PREVIEW), "https://alhc-projects-def456-autumn.vercel.app");
  // A reset started on a preview returns to that preview (its PKCE cookie is there), even when the app URL
  // is configured for previews too.
  const configured = { ...PREVIEW, NEXT_PUBLIC_APP_URL: "https://alhc-projects.vercel.app" };
  assert.equal(authEmailOrigin("https://alhc-projects-git-security-autumn.vercel.app", configured), "https://alhc-projects-git-security-autumn.vercel.app");
  assert.equal(authEmailOrigin("https://evil.example", configured), "https://alhc-projects.vercel.app");
});

test("local dev: localhost on any port; anything else gets http://localhost:3000", () => {
  assert.equal(authEmailOrigin("http://localhost:3000", LOCAL), "http://localhost:3000");
  assert.equal(authEmailOrigin("http://localhost:3001", LOCAL), "http://localhost:3001");
  assert.equal(authEmailOrigin("http://127.0.0.1:3000", LOCAL), "http://127.0.0.1:3000");
  assert.equal(authEmailOrigin("https://evil.example", LOCAL), LOCAL_APP_ORIGIN);
  assert.equal(authEmailOrigin(null, LOCAL), LOCAL_APP_ORIGIN);
  // localhost is only trusted off Vercel.
  assert.equal(authEmailOrigin("http://localhost:3000", PREVIEW), "https://alhc-projects-def456-autumn.vercel.app");
});

test("links built from the Host header: the configured app URL first, then only this app's own hosts", () => {
  assert.equal(requestLinkOrigin("evil.example", "https", PRODUCTION_CONFIGURED), "https://alhc-projects.vercel.app");
  assert.equal(requestLinkOrigin("alhc-projects.vercel.app", "https", PRODUCTION), "https://alhc-projects.vercel.app");
  assert.equal(requestLinkOrigin("evil.example", "https", PRODUCTION), PRODUCTION_APP_ORIGIN, "a forged Host");
  assert.equal(requestLinkOrigin("alhc-projects-git-security-autumn.vercel.app", "https", PREVIEW), "https://alhc-projects-git-security-autumn.vercel.app");
  assert.equal(requestLinkOrigin("evil.example", "https", PREVIEW), "https://alhc-projects-def456-autumn.vercel.app");
  assert.equal(requestLinkOrigin("localhost:3000", null, LOCAL), "http://localhost:3000");
  assert.equal(requestLinkOrigin("evil.example", null, LOCAL), LOCAL_APP_ORIGIN);
  assert.equal(requestLinkOrigin(null, null, PRODUCTION), PRODUCTION_APP_ORIGIN);
  // As before, a trailing slash on the configured URL is dropped.
  assert.equal(requestLinkOrigin("x", "https", { NEXT_PUBLIC_APP_URL: "https://alhc-projects.vercel.app/" }), "https://alhc-projects.vercel.app");
});

test("sign-up and password reset read the verified origin, never the Host header", () => {
  const src = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
  for (const file of ["app/login/actions.ts", "app/forgot-password/actions.ts"]) {
    const source = src(file);
    assert.match(source, /const origin = await authLinkOrigin\(\);/, file);
    assert.doesNotMatch(source, /headers\(\)|requestOrigin/, file);
  }
  const origin = src("lib/origin.ts");
  assert.match(origin, /authEmailOrigin\(\(await headers\(\)\)\.get\("origin"\), process\.env\)/);
  assert.doesNotMatch(origin, /return `\$\{proto\}:\/\/\$\{host\}`/);
});
