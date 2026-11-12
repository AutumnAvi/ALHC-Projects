import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

// Nov 12 notes (batch 40, item 7): /pdfjs/ (pdf.js's worker, a static file) is skipped like _next/static:
// the public review page (no sign-in) opens PDFs with it.
export const config = {
  matcher: ["/((?!_next/static|_next/image|pdfjs/|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
