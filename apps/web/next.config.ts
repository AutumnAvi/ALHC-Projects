import path from "node:path";
import type { NextConfig } from "next";
import { securityHeaderRules } from "./security-headers";

// Big move 2 (docs/design/monorepo.md): this app is apps/web of an npm workspace; the shared core package
// (@alhc/core, packages/core) is TypeScript source, and npm installs every package into the repo root's
// node_modules. Builds trace from the repo root so a function ships the files it needs from both.
const MONOREPO_ROOT = path.join(__dirname, "../..");
// Where npm put pdf.js (hoisted to the root's node_modules), as a path from this folder: tracing globs are
// resolved from here.
const PDFJS = path.relative(__dirname, path.dirname(require.resolve("pdfjs-dist/package.json"))).split(path.sep).join("/");

const nextConfig: NextConfig = {
  // Security audit 2 (Nov 12, batch 41): no "X-Powered-By: Next.js", and the security headers of
  // security-headers.ts on every response (framing, nosniff, https, referrer, content policy).
  poweredByHeader: false,
  async headers() {
    return securityHeaderRules({
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      dev: process.env.NODE_ENV === "development",
    });
  },
  // Turbopack compiles workspace packages on its own; listed so the intent is plain (and webpack agrees).
  transpilePackages: ["@alhc/core"],
  outputFileTracingRoot: MONOREPO_ROOT,
  turbopack: { root: MONOREPO_ROOT },
  experimental: {
    // Nov 4 notes, batch 28 (M4): going back to a screen within 30 seconds draws the router's copy at once,
    // and a screen rendered ahead on hover is kept 60 seconds; either way the screen is rendered again in
    // the background (src/lib/route-freshness.ts: keep these in step with ROUTER_CACHE_SECONDS /
    // HOVER_PREFETCH_SECONDS). Every write's refresh() / revalidatePath() still empties the router's cache.
    staleTimes: { dynamic: 30, static: 60 },
    serverActions: {
      // Profile pictures are uploaded through a Server Action (uploadMyAvatar): 2 MB plus room for the
      // multipart overhead. Everything else stays well under the 1 MB default.
      bodySizeLimit: "3mb",
    },
  },
  // Oct 27 notes (batch 5): review check emails draw thumbnails on the server (src/lib/review-thumbnails.ts)
  // with @napi-rs/canvas (a native module) and pdf.js's Node build. Both are loaded with Node's own require /
  // import instead of being bundled.
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist"],
  // Nov 4 notes (batch 21, QW3): only POST /api/review-thumbnails imports that module (the review Server
  // Actions ask it over HTTP), so only its function ships the libraries and pdf.js's built-in font data
  // (PDFs that don't embed Helvetica and friends). pdf.js's browser build (build/, for the review page's
  // PDF viewer, components/review/review-viewer.tsx) is only ever loaded in the browser, but as an external
  // package the server render of that client component would trace it into 17 pages: leave it out (the
  // thumbnail route uses legacy/build, which stays).
  outputFileTracingIncludes: {
    "/api/review-thumbnails": [`${PDFJS}/standard_fonts/**/*`],
  },
  outputFileTracingExcludes: {
    "/*": [`${PDFJS}/build/**/*`],
  },
};

export default nextConfig;
