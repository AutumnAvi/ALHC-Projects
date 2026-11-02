// Asana importer, "Download attachments": the plan lists each imported task's attachment download links
// (https only, kept out of the import batches), and downloads refuse private addresses and plain http.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildImportPlan, importSteps } from "@/lib/asana-import";
import { BlockedAddressError, safeDownload } from "@/lib/safe-fetch";

const exportJson = JSON.stringify({
  data: [
    {
      gid: "1",
      name: "Flyer",
      memberships: [{ project: { gid: "p1", name: "Creative" }, section: { gid: "s1", name: "To do" } }],
      attachments: [
        { gid: "a1", name: "brief.pdf", permanent_url: "https://app.asana.com/x", download_url: "https://s3.example.com/brief.pdf?sig=1", size: 1200 },
        { gid: "a2", name: "huge.mov", download_url: "https://s3.example.com/huge.mov", size: 99_000_000 },
        { gid: "a3", name: "old.txt", download_url: "http://insecure.example.com/old.txt" },
        { gid: "a4", name: "link-only.doc", view_url: "https://app.asana.com/y" },
        { gid: "a5", name: "Drive doc", host: "gdrive", view_url: "https://docs.google.com/z" },
      ],
    },
  ],
});

test("the plan lists https download links per imported task, and the batches don't carry them", () => {
  const plan = buildImportPlan([{ name: "export.json", text: exportJson }]);
  // Nov 2 notes (batch 14, 103): Asana-stored files without a usable download link are listed too (fetched
  // with an Asana token when one is given); files stored elsewhere (Google Drive) have no file to copy.
  assert.deepEqual(
    plan.attachmentFiles.map((f) => [f.taskGid, f.gid, f.name, f.size, f.downloadUrl !== null]),
    [
      ["1", "a1", "brief.pdf", 1200, true],
      ["1", "a2", "huge.mov", 99_000_000, true],
      ["1", "a3", "old.txt", null, false],
      ["1", "a4", "link-only.doc", null, false],
    ],
  );
  assert.equal(plan.tasks[0].attachments.length, 5, "every attachment still becomes a link");
  assert.ok(!JSON.stringify(importSteps(plan)).includes("sig=1"), "signed links never reach the database");
});

test("downloads refuse plain http and private addresses", async () => {
  await assert.rejects(safeDownload("http://example.com/x", { timeoutMs: 1000, maxBytes: 10 }));
  await assert.rejects(safeDownload("https://127.0.0.1/x", { timeoutMs: 1000, maxBytes: 10 }), BlockedAddressError);
  const resolver = (
    _host: string,
    _options: { all: true },
    callback: (error: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void,
  ) => callback(null, [{ address: "10.0.0.7", family: 4 }]);
  await assert.rejects(
    safeDownload("https://files.example.com/x", { timeoutMs: 1000, maxBytes: 10 }, resolver),
    BlockedAddressError,
  );
});
