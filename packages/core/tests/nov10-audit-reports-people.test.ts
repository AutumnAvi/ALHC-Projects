// Nov 10 audit (reports, people, search, roles, sign-in): the pure rules behind C4, C56, C59, C78, C88.
import assert from "node:assert/strict";
import { test } from "node:test";
import { personReportsHref } from "@alhc/core/people";
import { describeDateRange, describeReportFilters, withoutDateRange } from "@alhc/core/reports";
import { assignablePortfolioRoles } from "@alhc/core/roles";
import { matchesSearchFilters, searchFiltersFromParams, searchLimitFor, searchParamsFor } from "@alhc/core/search-filters";
import { signInErrorMessage, SIGN_IN_ERRORS } from "@alhc/core/sign-in-errors";

test("C4: counts drop the date range; the summary names it in plain words", () => {
  assert.deepEqual(withoutDateRange({ from: "2026-10-27", to: "2026-11-24", status: "open" }), { status: "open" });
  assert.equal(describeDateRange("2026-10-27", "2026-11-24", 2026), "Oct 27 – Nov 24");
  assert.equal(describeDateRange("2025-12-01", undefined, 2026), "Dec 1, 2025 – …");
  assert.ok(!describeReportFilters({ from: "2026-10-27", to: "2026-11-24" }, [], []).some((p) => /\d{4}-\d{2}/.test(p)));
});

test("C56: a profile's Reports links cover every date", () => {
  assert.equal(personReportsHref("p1"), "/reports?a=p1&range=all");
  assert.equal(personReportsHref("p1", { open: true }), "/reports?a=p1&range=all&status=open");
});

test("C59: the Search page's filters round-trip and reach the export", () => {
  const filters = searchFiltersFromParams(new URLSearchParams("q=x&status=open&project=private"));
  assert.deepEqual(filters, { status: "open", project: "private" });
  assert.equal(searchLimitFor(filters), 100);
  assert.equal(searchLimitFor({ status: "all", project: null }), 50);
  assert.equal(searchParamsFor("x", filters).toString(), "q=x&status=open&project=private");
  assert.ok(matchesSearchFilters({ completed_at: null, home_project_id: null }, filters));
  assert.ok(!matchesSearchFilters({ completed_at: "2026-11-01", home_project_id: null }, filters));
});

test("C78: portfolios offer Owner, Editor, Viewer (never Admin)", () => {
  assert.deepEqual(assignablePortfolioRoles("owner"), ["owner", "editor", "viewer"]);
  assert.deepEqual(assignablePortfolioRoles("admin"), ["editor", "viewer"]);
  assert.deepEqual(assignablePortfolioRoles("editor"), []);
});

test("C88: the sign-in page shows only fixed messages", () => {
  assert.equal(signInErrorMessage(null), null);
  assert.equal(signInErrorMessage("interrupted"), SIGN_IN_ERRORS.interrupted);
  assert.equal(signInErrorMessage("Click here: evil.example"), SIGN_IN_ERRORS.failed);
  assert.equal(signInErrorMessage("toString"), SIGN_IN_ERRORS.failed);
});
