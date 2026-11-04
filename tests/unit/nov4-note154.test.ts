// Note 154: with the workspace's Tags switch off, no tag references show (the data is kept).
import assert from "node:assert/strict";
import { test } from "node:test";
import { inboundCurlExample } from "@/lib/inbound-shared";
import { describeReportFilters } from "@/lib/reports";
import { ROLE_TABLES, roleTablesFor } from "@/lib/role-help";

test("report filter summaries leave out a saved tag filter while tags are off", () => {
  const filters = { tags: ["00000000-0000-4000-8000-000000000001"] };
  assert.ok(describeReportFilters(filters, [], [], []).some((p) => p.startsWith("Tags:")));
  assert.ok(!describeReportFilters(filters, [], [], [], false).some((p) => p.startsWith("Tags:")));
});

test("the inbound curl example names tags only while they're on", () => {
  assert.match(inboundCurlExample("https://x/api/inbound/t"), /"tags"/);
  assert.doesNotMatch(inboundCurlExample("https://x/api/inbound/t", false), /tags/);
});

test("the roles help tables don't mention tags while they're off", () => {
  assert.equal(roleTablesFor(true), ROLE_TABLES);
  const labels = roleTablesFor(false).flatMap((t) => t.rows.map((r) => r.label));
  assert.ok(labels.every((l) => !/\btags?\b/i.test(l)));
});
