// CSV export (RFC 4180, UTF-8 with a BOM so Excel opens it as UTF-8, CRLF line endings). Every export
// route builds rows with the signed-in user's Supabase client, so only rows RLS lets them read get here.
//
// Since Real features 4 there is no row cap: an export is a stream. The builders in exports.ts hand over
// an async iterable that reads a page at a time (keyset pages through the same access-checked queries),
// and csvStreamResponse() writes each batch of lines as it comes, so a 50,000-row export neither holds
// every row in memory nor waits for the last page before the download starts.
//
// Formula injection: a text cell starting with =, +, -, @, a tab, or a carriage return is prefixed with an
// apostrophe so Excel, Numbers, and Google Sheets show it as text instead of running it. Numbers are
// written as numbers.

export type CsvCell = string | number | boolean | null | undefined;
export type CsvRows = Iterable<CsvCell[]> | AsyncIterable<CsvCell[]>;

const FORMULA_START = /^[=+\-@\t\r]/;
const BOM = "﻿";
// Lines are sent in batches of about this many characters.
const CHUNK_CHARS = 64 * 1024;

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  let text = value;
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(row: CsvCell[]): string {
  return `${row.map(csvCell).join(",")}\r\n`;
}

// The whole file as one string (tests and small exports).
export function toCsv(header: string[], rows: CsvCell[][]): string {
  return `${BOM}${[header, ...rows].map(csvLine).join("")}`;
}

// File name: a slug of the title plus the date, e.g. "workspace-report-2026-10-06.csv".
export function csvFileName(title: string, date: string): string {
  const slug =
    title
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-")
      .slice(0, 60) || "export";
  return `${slug}-${date}.csv`;
}

async function* csvChunks(header: string[], rows: CsvRows): AsyncGenerator<string> {
  // The header goes out at once, so the download starts while the first page is read.
  yield `${BOM}${csvLine(header)}`;
  let buffer = "";
  for await (const row of rows) {
    buffer += csvLine(row);
    if (buffer.length >= CHUNK_CHARS) {
      yield buffer;
      buffer = "";
    }
  }
  if (buffer) yield buffer;
}

// A streamed download. The headers go out with the first batch; if a later page fails, the stream errors
// so the browser reports a failed download instead of saving a file that is silently short.
export function csvStreamResponse(
  { title, header, rows }: { title: string; header: string[]; rows: CsvRows },
  date: string,
): Response {
  const encoder = new TextEncoder();
  const chunks = csvChunks(header, rows);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        console.error("CSV export failed", error instanceof Error ? error.message : "unknown error");
        controller.error(error);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
  const name = csvFileName(title, date);
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
