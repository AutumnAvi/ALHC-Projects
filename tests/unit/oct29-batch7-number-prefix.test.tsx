// Oct 29 notes, batch 7, item 49 (the app's side; the database's is the T2 part of suite zz36): a number
// field's symbol ("$", "€", "#") shows before its values everywhere — one helper, formatNumberValue(),
// mirrored by public.format_number_value() — while the stored value stays a plain number (CSV cells
// stay raw, the header says "Budget ($)").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { NumberInput } from "@/components/number-input";
import { PortfolioFieldDisplay, PortfolioFieldInput } from "@/components/portfolio/portfolio-field-value";
import { PortfolioFieldsManager } from "@/components/portfolio/portfolio-fields-manager";
import { FieldValueChips } from "@/components/project/field-chips";
import { FieldEditorDialog, NumberSymbolInput } from "@/components/project/field-editor";
import { filterChips } from "@/components/project/filter-editor";
import { InlineFieldCell } from "@/components/project/inline-cells";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { fieldValueLabel } from "@/components/rules/rule-shared";
import { ShellProvider } from "@/components/shell/shell-context";
import { ToastProvider } from "@/components/toast";
import type { PortfolioField, ProjectTask } from "@/lib/data";
import {
  MAX_NUMBER_PREFIX,
  fieldChips,
  fieldNameWithSymbol,
  formatNumberValue,
  normalizeNumberPrefix,
  numberPrefixOf,
  numberPrefixProblem,
  prefixNumberText,
  type FieldDef,
} from "@/lib/fields";
import { portfolioFieldValueLabel, type PortfolioRuleContext } from "@/lib/portfolio-rules";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const member = { id: "me", email: "me@example.com", name: "Me", avatarUrl: null };

function render(node: ReactNode) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/projects/p1/fields">
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <ShellProvider member={member as never} isWorkspaceAdmin={false} workspace={{ name: "ALHC", logoUrl: null }} initialSidebar={DEFAULT_SIDEBAR_PREFS}>
            <ToastProvider>
              <ProjectAccessProvider role="editor">{node}</ProjectAccessProvider>
            </ToastProvider>
          </ShellProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

function buttonTag(html: string, label: string) {
  const end = html.indexOf(`>${label}</button>`);
  assert.ok(end > 0, `a “${label}” button`);
  return html.slice(html.lastIndexOf("<button", end), end + 1);
}
const isDisabled = (tag: string) => / disabled=""/.test(tag);
// Text without tags or React's comment markers.
const textOf = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");

function field(overrides: Partial<FieldDef> = {}): FieldDef {
  return {
    id: "f1",
    projectId: "p1",
    name: "Budget",
    fieldType: "number",
    options: [],
    boundToSections: false,
    showInViews: true,
    sortOrder: 1024,
    description: null,
    notifyOnChange: false,
    inLibrary: false,
    numberPrefix: "$",
    ...overrides,
  };
}

// The same vectors as the T2 part of suite zz36 (public.format_number_value()).
const VECTORS: [number, string | null, string][] = [
  [1250, null, "1,250"],
  [1250, "$", "$1,250"],
  [-1250.5, "$", "-$1,250.5"],
  [0.12345, "€", "€0.123"],
  [1234567.891, null, "1,234,567.891"],
  [42.1, "#", "#42.1"],
  [-0.0001, "$", "$0"],
  [0, "₪", "₪0"],
  [1000, "USD", "USD 1,000"],
  [-7, "Rs", "-Rs 7"],
  [999, "", "999"],
];

test("formatNumberValue: grouped, three decimals at most, the symbol after the sign (mirrors SQL)", () => {
  for (const [value, prefix, expected] of VECTORS) {
    assert.equal(formatNumberValue(value, prefix), expected, `${value} with ${JSON.stringify(prefix)}`);
  }
  assert.equal(formatNumberValue(1250), "1,250", "no symbol given");
  assert.equal(prefixNumberText("-40", "$"), "-$40");
  assert.equal(prefixNumberText("40", "  "), "40", "a blank symbol is none");
});

test("the symbol: trimmed, empty = none, 1–4 characters (code points), no line breaks or controls", () => {
  assert.equal(MAX_NUMBER_PREFIX, 4);
  assert.equal(normalizeNumberPrefix("  $ "), "$");
  assert.equal(normalizeNumberPrefix(" € "), "€");
  assert.equal(normalizeNumberPrefix("   "), null);
  assert.equal(normalizeNumberPrefix(null), null);
  for (const ok of ["$", "€", "#", "₪", "USD", "US $", "₪₪₪₪", "🇺🇸", "  $  ", ""]) {
    assert.equal(numberPrefixProblem(ok), null, JSON.stringify(ok));
  }
  assert.match(numberPrefixProblem("Euros") ?? "", /4 characters at most/);
  assert.match(numberPrefixProblem("$\n€") ?? "", /line breaks or control characters/);
  assert.match(numberPrefixProblem("$ €") ?? "", /line breaks/);
  assert.match(numberPrefixProblem("\u0007#") ?? "", /control characters/);
});

test("the SQL side checks the same rules", () => {
  const sql = readFileSync("supabase/migrations/20261029010000_oct29_batch7_a.sql", "utf8");
  assert.ok(sql.includes("create or replace function public.format_number_value(value numeric, prefix text default null)"));
  for (const table of ["custom_fields", "portfolio_fields"]) {
    const check = sql.slice(sql.indexOf(`${table}_number_prefix_check`), sql.indexOf(`${table}_number_prefix_check`) + 400);
    assert.match(check, /field_type = 'number'/, `${table}: number fields only`);
    assert.match(check, new RegExp(`char_length\\(number_prefix\\) between 1 and ${MAX_NUMBER_PREFIX}`), `${table}: the length`);
    assert.ok(check.includes("[\\x01-\\x1f\\x7f-\\x9f\\u2028\\u2029]"), `${table}: the same forbidden characters`);
  }
  assert.ok(sql.includes("prefix ~ '[A-Za-z]$'"), "a space after a symbol ending in a letter, as prefixNumberText");
});

test("numberPrefixOf / fieldNameWithSymbol: number fields only; the CSV header carries the symbol", () => {
  assert.equal(numberPrefixOf(field()), "$");
  assert.equal(numberPrefixOf(field({ numberPrefix: null })), null);
  assert.equal(numberPrefixOf(field({ numberPrefix: undefined })), null, "a database without the column");
  assert.equal(numberPrefixOf(field({ fieldType: "text" })), null, "text fields never show one");
  assert.equal(numberPrefixOf(field({ fieldType: "single_select", boundToSections: true })), null);
  assert.equal(fieldNameWithSymbol(field()), "Budget ($)");
  assert.equal(fieldNameWithSymbol(field({ numberPrefix: null })), "Budget");
  assert.equal(fieldNameWithSymbol(field({ name: "Notes", fieldType: "text" })), "Notes");
});

test("fieldChips (List cells, Board cards, the pane, activity, previews) show the symbol", () => {
  const ctx = { personName: () => null };
  assert.deepEqual(fieldChips(field(), 1250, ctx), [{ label: "$1,250", color: "zinc" }]);
  assert.deepEqual(fieldChips(field({ numberPrefix: null }), 1250.5, ctx), [{ label: "1,250.5", color: "zinc" }]);
  assert.deepEqual(fieldChips(field(), null, ctx), []);
  const task = { fieldValues: { f1: 1250 }, sectionId: null } as unknown as ProjectTask;
  const html = render(<FieldValueChips field={field()} task={task} context={{ profilesById: new Map(), sectionNames: new Map() }} />);
  assert.equal(textOf(html), "$1,250");
});

test("NumberInput: the symbol sits inside the box (decorative, described for screen readers)", () => {
  const html = render(<NumberInput symbol="€" aria-label="Budget" defaultValue={5} className="control" />);
  assert.match(html, /data-number-prefix="€"/);
  assert.match(html, /<span aria-hidden="true"[^>]*>€<\/span>/);
  assert.match(html, /<span id="([^"]+)" class="sr-only">In €<\/span>/);
  const id = html.match(/<span id="([^"]+)" class="sr-only">/)?.[1];
  assert.ok(html.includes(`aria-describedby="${id}"`), "the box points at the description");
  assert.match(html, /type="number"/);
  assert.match(html, /padding-left:calc\(0\.875rem \+ 1ch\)/);
  const plain = render(<NumberInput aria-label="Budget" defaultValue={5} className="control" />);
  assert.doesNotMatch(plain, /data-number-prefix|sr-only/, "no symbol, a plain number box");
  assert.match(plain, /^<input type="number" step="any"/);
});

test("List inline cell: the cell's label reads the value with its symbol", () => {
  const html = render(
    <InlineFieldCell
      field={field()}
      value={1250}
      sectionId={null}
      sections={[]}
      people={[]}
      taskTitle="Launch"
      canEdit
      display="$1,250"
      onChange={() => {}}
      onSectionChange={() => {}}
    />,
  );
  assert.match(html, /aria-label="Budget of “Launch”: \$1,250\. Change"/);
});

test("Edit field: a number field has a Symbol setting with a live preview", () => {
  const html = render(<FieldEditorDialog projectId="p1" field={field()} sectionNames={[]} batch4 onClose={() => {}} />);
  assert.match(html, /<input id="field-f1-symbol"[^>]*value="\$"/);
  assert.match(textOf(html), /Shown before every value: \$1,250\./);
  assert.match(html, /aria-label="Use €"/, "quick picks");
  assert.match(html, /aria-label="Use \$" aria-pressed="true"|aria-pressed="true"[^>]*aria-label="Use \$"/, "the current one is pressed");
  assert.ok(!isDisabled(buttonTag(html, "Save")));

  const text = render(<FieldEditorDialog projectId="p1" field={field({ fieldType: "text", numberPrefix: null })} sectionNames={[]} batch4 onClose={() => {}} />);
  assert.doesNotMatch(text, /Symbol/, "only number fields have one");
});

test("Symbol input: a bad symbol explains itself", () => {
  const html = render(<NumberSymbolInput id="s" value="Euros" onChange={() => {}} />);
  assert.match(html, /aria-invalid="true"/);
  assert.match(textOf(html), /A symbol is 4 characters at most\./);
  const none = render(<NumberSymbolInput id="s" value="" onChange={() => {}} />);
  assert.match(textOf(none), /Shown before every value: 1,250\./);
});

test("Filters, rules, and portfolio values read the symbol too", () => {
  const chips = filterChips(
    { fields: [{ field_id: "f1", op: "equals", value: 1250 }] },
    { sections: [], profiles: [], fields: [field()] },
  );
  assert.equal(chips[0]?.label, "Budget = $1,250");
  const ctx = { fields: [field()] } as never;
  assert.equal(fieldValueLabel(ctx, "f1", -40), "-$40");

  const pf: PortfolioField = { id: "pf1", name: "Spend", fieldType: "number", options: [], sortOrder: 1, numberPrefix: "€" };
  const pctx = { fields: [pf] } as unknown as PortfolioRuleContext;
  assert.equal(portfolioFieldValueLabel(pctx, "pf1", 2500), "€2,500");
  assert.equal(textOf(render(<PortfolioFieldDisplay field={pf} value={2500} />)), "€2,500");
  const input = render(<PortfolioFieldInput field={pf} projectId="p1" projectName="Launch" value={2500} />);
  assert.match(input, /data-number-prefix="€"/);
  const manager = render(<PortfolioFieldsManager portfolioId="pt1" fields={[pf]} canEdit />);
  assert.match(manager, /<input id="portfolio-field-symbol-pf1"[^>]*value="€"/);
  assert.match(textOf(manager), /Shown as €1,250/);
  const viewer = render(<PortfolioFieldsManager portfolioId="pt1" fields={[pf]} canEdit={false} />);
  assert.doesNotMatch(viewer, /portfolio-field-symbol-pf1"/, "viewers read it, nothing to edit");
  assert.match(textOf(viewer), /Shown as €1,250/);
});
