// CSV export (RFC 4180, UTF-8 with a BOM so Excel opens it as UTF-8, CRLF line endings). Every export
// route builds rows with the signed-in user's Supabase client, so only rows RLS lets them read get here.
//
// Formula injection: a text cell starting with =, +, -, @, a tab, or a carriage return is prefixed with an
// apostrophe so Excel, Numbers, and Google Sheets show it as text instead of running it. Numbers are
// written as numbers.

export const MAX_EXPORT_ROWS = 10_000;
export const TRUNCATED_HEADER = "X-Export-Truncated";
export const TRUNCATED_NOTICE = `Only the first ${MAX_EXPORT_ROWS.toLocaleString("en-US")} rows were exported. Narrow the filters to export the rest.`;

export type CsvCell = string | number | boolean | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  let text = value;
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

export type CsvTable = { header: string[]; rows: CsvCell[][]; truncated: boolean };

// Caps the rows at MAX_EXPORT_ROWS; `truncated` sets the X-Export-Truncated header, which the Export CSV
// buttons (ExportLink) turn into a visible notice.
export function csvTable(header: string[], rows: CsvCell[][]): CsvTable {
  return { header, rows: rows.slice(0, MAX_EXPORT_ROWS), truncated: rows.length > MAX_EXPORT_ROWS };
}

export function toCsv(table: CsvTable): string {
  const lines = [table.header, ...table.rows].map((row) => row.map(csvCell).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
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

export function csvResponse(table: CsvTable, title: string, date: string): Response {
  const name = csvFileName(title, date);
  return new Response(toCsv(table), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ...(table.truncated ? { [TRUNCATED_HEADER]: `first ${MAX_EXPORT_ROWS} rows` } : {}),
    },
  });
}
