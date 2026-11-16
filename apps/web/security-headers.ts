// Security audit 2 (Nov 12, batch 41): the security headers every response carries, set in one place
// (next.config.ts → headers()). Plain TypeScript with no imports, so next.config.ts loads it at build time
// and the unit tests (tests/unit/security-headers.test.ts) check it with Next.js's own path matcher.
//
// What is enforced (Nov 16 batch 42 turned the content policy on; batch 41 had it report-only):
// - No MIME sniffing, a two-year https rule (production builds only, no preload), the referrer policy, and
//   who may frame a page (X-Frame-Options + CSP frame-ancestors).
// - The whole content policy, in one enforced Content-Security-Policy per page: where scripts, styles,
//   images, fonts, media, frames, workers and connections may come from, plus `object-src 'none'`,
//   `base-uri 'self'` and `form-action 'self'`. Whatever it blocks is still reported to /api/csp-report.
// - Scripts keep 'unsafe-inline': Next.js streams every page as inline scripts. Nonces would replace it,
//   but a nonce is per response, so every page would have to be rendered per request (no static pages, no
//   CDN cache, no prefetched copies the router can reuse) — and the policy already stops scripts, frames,
//   and connections to any other site, which is what an injected script would need to send data out.
//
// Who may frame what:
// - The public form pages (/forms/<id> and /forms/<id>/embed) may be framed by any site: the form editor
//   hands out an embed snippet meant for any page (a request hub on Notion, a website, an intranet, the
//   marketing request forms site), and the plain link may have been pasted into an iframe too. Neither page
//   has anything a stranger could be tricked into clicking beyond sending the form.
// - /attachments/<id> may be framed by this app only: the approver's review shows a file's preview in an
//   iframe (components/task/approver-review.tsx).
// - Everything else may not be framed at all (sign-in, every app page, the review page, the API).
// The desktop app loads the site as its window's top-level page, never in a frame.

export type SecurityHeaderOptions = {
  // NEXT_PUBLIC_SUPABASE_URL at build time: the one other origin the browser talks to.
  supabaseUrl?: string;
  // `next dev`: React needs eval for its error stacks, and Speed Insights loads its debug script.
  dev: boolean;
  // A Vercel preview deployment (VERCEL_ENV=preview at build time): Vercel adds its comments toolbar
  // (vercel.live) to preview pages. Never in production.
  vercelPreview?: boolean;
};

// The Vercel toolbar on preview deployments (Vercel's documented sources for it).
const VERCEL_TOOLBAR = {
  script: ["https://vercel.live"],
  connect: ["https://vercel.live", "wss://ws-us3.pusher.com"],
  frame: ["https://vercel.live"],
  style: ["https://vercel.live"],
  font: ["https://vercel.live", "https://assets.vercel.com"],
};

export type HeaderRule = { source: string; headers: { key: string; value: string }[] };

// The public form pages (frameable by any site) and the files the app frames itself.
export const PUBLIC_FORM_SOURCES = ["/forms/:formId", "/forms/:formId/embed"] as const;
export const SELF_FRAMED_SOURCE = "/attachments/:path*";
// Every path except those above. path-to-regexp (Next.js's matcher) allows a lookahead inside a
// parameter's pattern; the root "/" matches with an empty path.
export const NOT_FRAMEABLE_SOURCE = "/:path((?!(?:forms/[^/]+(?:/embed)?$)|(?:attachments(?:/|$))).*)";

// Pages whose URL is a secret (a review link's token, an email's turn-off token, a calendar link): never
// sent as a referrer, even to this site's own requests. The rest use strict-origin-when-cross-origin, which
// sends other sites only the origin (never a path or a query).
export const NO_REFERRER_SOURCES = ["/review/:path*", "/email/off", "/api/calendar/:path*"] as const;

export const CSP_REPORT_PATH = "/api/csp-report";

const TWO_YEARS = 63072000;

function supabaseOrigins(url: string | undefined): { https: string; wss: string } {
  try {
    if (url) {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        const ws = parsed.protocol === "https:" ? "wss:" : "ws:";
        return { https: parsed.origin, wss: `${ws}//${parsed.host}` };
      }
    }
  } catch {
    // Falls through to the wildcard below.
  }
  // Without the address at build time (a CI build without env): any Supabase project. Report-only either way.
  return { https: "https://*.supabase.co", wss: "wss://*.supabase.co" };
}

function policy(directives: Record<string, string[]>): string {
  return Object.entries(directives)
    .map(([name, values]) => [name, ...values].join(" "))
    .join("; ");
}

// The content policy: what the app loads today, so anything else is blocked (and reported).
export function contentDirectives({ supabaseUrl, dev, vercelPreview }: SecurityHeaderOptions): Record<string, string[]> {
  const supabase = supabaseOrigins(supabaseUrl);
  const toolbar = vercelPreview && !dev ? VERCEL_TOOLBAR : { script: [], connect: [], frame: [], style: [], font: [] };
  return {
    "default-src": ["'self'"],
    // Next.js streams the page as inline scripts (no nonces); pdf.js's worker compiles its JPEG 2000
    // decoder (WebAssembly). Dev: React's eval-based error stacks and Speed Insights' debug script.
    "script-src": [
      "'self'",
      "'unsafe-inline'",
      "'wasm-unsafe-eval'",
      ...(dev ? ["'unsafe-eval'", "https://va.vercel-scripts.com"] : []),
      ...toolbar.script,
    ],
    // Tailwind's stylesheet plus React style attributes; pdf.js adds @font-face rules for PDF fonts.
    "style-src": ["'self'", "'unsafe-inline'", ...toolbar.style],
    // Avatars and logos (public Supabase buckets, or a picture URL a person set), signed thumbnails, upload
    // previews (blob:), small inline images (data:). The Supabase origin is named too for an http one
    // (a local stack).
    "img-src": ["'self'", "data:", "blob:", "https:", ...(supabase.https.startsWith("http:") ? [supabase.https] : [])],
    // next/font is served from this site; pdf.js may load a PDF's own fonts as data: URLs.
    "font-src": ["'self'", "data:", ...toolbar.font],
    // Videos and audio play from signed Supabase links (/attachments and /review/<token>/file redirect there).
    "media-src": ["'self'", "blob:", supabase.https],
    // Supabase's API, Storage uploads, and Realtime (live updates); PDFs are fetched for pdf.js through a
    // redirect to Supabase.
    "connect-src": ["'self'", supabase.https, supabase.wss, ...toolbar.connect],
    // The approver's review frames /attachments/<id>?preview=1, which redirects to a signed Supabase link.
    "frame-src": ["'self'", supabase.https, ...toolbar.frame],
    // pdf.js's worker (/pdfjs/…, a static file of this site).
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    // Every form posts to this site (sign-in, sign-out, the public forms' Server Actions, Turn off links).
    "form-action": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
  };
}

// The enforced policy of a page: who may frame it, the content policy, and where violations are reported.
export function enforcedPolicy(frameAncestors: "'none'" | "'self'" | "*", options: SecurityHeaderOptions): string {
  return policy({
    "frame-ancestors": [frameAncestors],
    ...contentDirectives(options),
    "report-uri": [CSP_REPORT_PATH],
  });
}

export function securityHeaderRules(options: SecurityHeaderOptions): HeaderRule[] {
  const everywhere: HeaderRule = {
    source: "/:path*",
    headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      // Ignored by browsers over plain http (localhost); not sent by `next dev` at all.
      ...(options.dev ? [] : [{ key: "Strict-Transport-Security", value: `max-age=${TWO_YEARS}; includeSubDomains` }]),
    ],
  };
  const notFrameable: HeaderRule = {
    source: NOT_FRAMEABLE_SOURCE,
    headers: [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Content-Security-Policy", value: enforcedPolicy("'none'", options) },
    ],
  };
  const selfFramed: HeaderRule = {
    source: SELF_FRAMED_SOURCE,
    headers: [
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "Content-Security-Policy", value: enforcedPolicy("'self'", options) },
    ],
  };
  // No X-Frame-Options here: it can't allow other sites (ALLOW-FROM is gone from browsers).
  const publicForms: HeaderRule[] = PUBLIC_FORM_SOURCES.map((source) => ({
    source,
    headers: [{ key: "Content-Security-Policy", value: enforcedPolicy("*", options) }],
  }));
  // Later rules win for the same header, so these come after the site-wide referrer policy.
  const noReferrer: HeaderRule[] = NO_REFERRER_SOURCES.map((source) => ({
    source,
    headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
  }));
  return [everywhere, notFrameable, selfFramed, ...publicForms, ...noReferrer];
}
