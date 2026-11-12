// Security audit 2 (Nov 12, batch 41): the security headers every response carries, set in one place
// (next.config.ts → headers()). Plain TypeScript with no imports, so next.config.ts loads it at build time
// and the unit tests (tests/unit/security-headers.test.ts) check it with Next.js's own path matcher.
//
// What is enforced and what only reports:
// - Enforced: no MIME sniffing, a two-year https rule (production builds only, no preload), the referrer
//   policy, and who may frame a page (X-Frame-Options + CSP frame-ancestors), plus `object-src 'none'` and
//   `base-uri 'self'` in an enforced Content-Security-Policy.
// - Report-only: the rest of the content policy (where scripts, styles, images, fonts, media, frames,
//   workers and connections may come from). Enforcing it without nonces would still need 'unsafe-inline'
//   for Next.js's inline scripts, and nonces make every page dynamic (no static pages, no CDN cache), so for
//   now browsers report what it would block (to /api/csp-report) and block nothing.
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

// The report-only policy: what the app loads today, so a violation means something unexpected.
export function reportOnlyPolicy({ supabaseUrl, dev }: SecurityHeaderOptions): string {
  const supabase = supabaseOrigins(supabaseUrl);
  return policy({
    "default-src": ["'self'"],
    // Next.js streams the page as inline scripts (no nonces); pdf.js's worker compiles its JPEG 2000
    // decoder (WebAssembly). Dev: React's eval-based error stacks and Speed Insights' debug script.
    "script-src": [
      "'self'",
      "'unsafe-inline'",
      "'wasm-unsafe-eval'",
      ...(dev ? ["'unsafe-eval'", "https://va.vercel-scripts.com"] : []),
    ],
    // Tailwind's stylesheet plus React style attributes; pdf.js adds @font-face rules for PDF fonts.
    "style-src": ["'self'", "'unsafe-inline'"],
    // Avatars and logos (public Supabase buckets, or a picture URL a person set), signed thumbnails, upload
    // previews (blob:), small inline images (data:).
    "img-src": ["'self'", "data:", "blob:", "https:"],
    // next/font is served from this site; pdf.js may load a PDF's own fonts as data: URLs.
    "font-src": ["'self'", "data:"],
    // Videos and audio play from signed Supabase links (/attachments and /review/<token>/file redirect there).
    "media-src": ["'self'", "blob:", supabase.https],
    // Supabase's API, Storage uploads, and Realtime (live updates); PDFs are fetched for pdf.js through a
    // redirect to Supabase.
    "connect-src": ["'self'", supabase.https, supabase.wss],
    // The approver's review frames /attachments/<id>?preview=1, which redirects to a signed Supabase link.
    "frame-src": ["'self'", supabase.https],
    // pdf.js's worker (/pdfjs/…, a static file of this site).
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "form-action": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "report-uri": [CSP_REPORT_PATH],
  });
}

// The enforced policy: framing, plugins, and <base>. Nothing here can break how a page loads.
export function enforcedPolicy(frameAncestors: "'none'" | "'self'" | "*"): string {
  return policy({
    "frame-ancestors": [frameAncestors],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
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
      { key: "Content-Security-Policy-Report-Only", value: reportOnlyPolicy(options) },
    ],
  };
  const notFrameable: HeaderRule = {
    source: NOT_FRAMEABLE_SOURCE,
    headers: [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Content-Security-Policy", value: enforcedPolicy("'none'") },
    ],
  };
  const selfFramed: HeaderRule = {
    source: SELF_FRAMED_SOURCE,
    headers: [
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "Content-Security-Policy", value: enforcedPolicy("'self'") },
    ],
  };
  // No X-Frame-Options here: it can't allow other sites (ALLOW-FROM is gone from browsers).
  const publicForms: HeaderRule[] = PUBLIC_FORM_SOURCES.map((source) => ({
    source,
    headers: [{ key: "Content-Security-Policy", value: enforcedPolicy("*") }],
  }));
  // Later rules win for the same header, so these come after the site-wide referrer policy.
  const noReferrer: HeaderRule[] = NO_REFERRER_SOURCES.map((source) => ({
    source,
    headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
  }));
  return [everywhere, notFrameable, selfFramed, ...publicForms, ...noReferrer];
}
