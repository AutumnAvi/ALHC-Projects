import { MAX_REPORT_BYTES, createReportLimiter, parseCspReports } from "@/lib/csp-report";

// Security audit 2 (Nov 12, batch 41): browsers send reports of the report-only content policy here
// (security-headers.ts: report-uri). Public (a signed-out page reports too; the proxy lets it through), no
// session, nothing stored: a short summary line per distinct report goes to the server log, rate-limited
// per instance (src/lib/csp-report.ts). The answer is always 204, so it tells a caller nothing.

export const dynamic = "force-dynamic";

const shouldLog = createReportLimiter();
const NO_CONTENT = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

async function readSmall(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? "0") > MAX_REPORT_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REPORT_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function POST(request: Request) {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/csp-report" && type !== "application/reports+json" && type !== "application/json") {
    return NO_CONTENT();
  }
  let raw: string | null = null;
  try {
    raw = await readSmall(request);
  } catch {
    return NO_CONTENT();
  }
  for (const summary of (raw && parseCspReports(raw)) || []) {
    if (shouldLog(summary)) {
      console.warn(`[csp] report-only violation directive=${summary.directive} blocked=${summary.blocked || "-"} page=${summary.page}`);
    }
  }
  return NO_CONTENT();
}
