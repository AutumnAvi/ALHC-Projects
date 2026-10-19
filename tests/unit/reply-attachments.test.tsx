// Reply attachments (Oct 19 notes): a submitter's emailed reply with a pasted / Apple Mail image saved
// nothing and kept the mail app's "[AL_ICON MARK.jpg]" placeholder as its text. These run the planner,
// the placeholder strip, and the copier on a recorded sample in the shapes of Resend's docs
// (fixtures/resend-reply-inline-image.json), plus the reply card's previews.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EmailFiles } from "@/components/task/comment-parts";
import { copyReceivedAttachments, copyReplyAttachments, resendFileSource, type ReceivedFileSource } from "@/lib/email-forward";
import { htmlToText, keptHtml, stripQuotedReply } from "@/lib/email-reply";
import {
  attachmentsOnlyBody,
  normalizeReceivedFiles,
  planReceivedFiles,
  plannedFiles,
  stripAttachmentPlaceholders,
  type ReceivedFile,
} from "@/lib/reply-attachments";

const sample = JSON.parse(readFileSync(new URL("./fixtures/resend-reply-inline-image.json", import.meta.url), "utf8"));
const TASK = "00000000-0000-4000-8000-0000000000a1";

// What the inbound route does with a retrieved email.
function plan(message: { text: string | null; html: string | null; attachments: unknown }) {
  const files = normalizeReceivedFiles(message.attachments);
  const keptText = stripQuotedReply(message.text?.trim() ? message.text : message.html ? htmlToText(message.html) : "");
  const result = planReceivedFiles(files, {
    rawText: message.text?.trim() ? message.text : message.html ? htmlToText(message.html, { keepQuoted: true }) : "",
    keptText,
    html: message.html,
    keptHtml: message.html ? keptHtml(message.html) : null,
  });
  const saving = result.copy.length + result.skipped.length;
  const body = stripAttachmentPlaceholders(keptText, plannedFiles(files, result)) || (saving ? attachmentsOnlyBody(saving) : "");
  return { files, plan: result, body };
}

test("the reported reply: the pasted logo and the PDF are saved, the big file is noted, the quoted image left out", () => {
  const { plan: result, body } = plan(sample.retrieved);
  assert.deepEqual(result.copy.map((f) => f.filename), ["AL_ICON MARK.jpg", "brief.pdf"]);
  assert.deepEqual(result.skipped, [{ name: "walkthrough.mov", reason: "too_large" }]);
  assert.deepEqual(result.ignored.map((f) => f.filename), ["image001.png"], "Outlook's image in the quoted part");
  assert.equal(body, "Here is the logo.\n\nThanks,\nTerry", "no [AL_ICON MARK.jpg] left in the comment");
});

test("an image-only reply from an iPhone posts as a reply with its file", () => {
  const { plan: result, body } = plan(sample.iphone);
  assert.deepEqual(result.copy.map((f) => f.filename), ["AL_ICON MARK.jpg"]);
  assert.equal(body, "Sent an attachment.");
  assert.equal(attachmentsOnlyBody(3), "Sent 3 attachments.");
});

test("an HTML-only reply: its own cid images are saved, quoted ones left out", () => {
  const { plan: result } = plan({ ...sample.retrieved, text: null });
  assert.deepEqual(result.copy.map((f) => f.filename), ["AL_ICON MARK.jpg", "brief.pdf"]);
  assert.deepEqual(result.ignored.map((f) => f.filename), ["image001.png"]);
});

test("placeholders: Gmail, Apple Mail, and Outlook forms come out; other names stay", () => {
  const files = [{ filename: "AL_ICON MARK.jpg", contentId: "B7E2@x" }];
  assert.equal(stripAttachmentPlaceholders("Logo: [image: AL_ICON MARK.jpg] done", files), "Logo: done");
  assert.equal(stripAttachmentPlaceholders("<AL_ICON MARK.jpg>\nThanks", files), "Thanks");
  assert.equal(stripAttachmentPlaceholders("See [cid:B7E2@x]\n\n\n\nok", files), "See\n\nok");
  assert.equal(stripAttachmentPlaceholders("[al_icon mark.JPG] and [other.jpg]", files), "and [other.jpg]");
});

test("tracking pixels are left out; an unreferenced real image (Apple Mail 'attached') is kept", () => {
  const files: ReceivedFile[] = [
    { id: "p", filename: "pixel.gif", contentType: "image/gif", inline: true, contentId: "px", size: 43 },
    { id: "a", filename: "photo.heic", contentType: "image/heic", inline: true, contentId: "ph", size: 5000 },
  ];
  const result = planReceivedFiles(files, { rawText: "Here you go", keptText: "Here you go" });
  assert.deepEqual(result.ignored.map((f) => f.id), ["p"]);
  assert.deepEqual(result.copy.map((f) => f.id), ["a"]);
});

test("limits: 10 files at most, then 'more than 10 files'; malformed entries are dropped", () => {
  const many = normalizeReceivedFiles(
    Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, filename: `f${i}.txt`, content_type: "text/plain", size: 10 })),
  );
  const result = planReceivedFiles(many, { rawText: "", keptText: "" });
  assert.equal(result.copy.length, 10);
  assert.deepEqual(result.skipped.map((s) => s.reason), ["too_many", "too_many"]);
  assert.deepEqual(normalizeReceivedFiles([{ filename: "no id" }, null, 3]), []);
  assert.deepEqual(normalizeReceivedFiles("nope"), []);
  assert.equal(normalizeReceivedFiles([{ id: "x", content_type: "bad type", content_id: "<cid@x>" }])[0].contentId, "cid@x");
});

// A fake admin client: Storage uploads / removes and rpc calls, recorded.
function fakeAdmin(refuse: (name: string) => boolean = () => false) {
  const calls = { uploads: [] as { path: string; contentType?: string; size: number }[], removed: [] as string[], rpc: [] as { fn: string; args: Record<string, unknown> }[] };
  const admin = {
    storage: {
      from: () => ({
        upload: async (path: string, bytes: Uint8Array, opts: { contentType?: string }) => {
          calls.uploads.push({ path, contentType: opts.contentType, size: bytes.byteLength });
          return { error: null };
        },
        remove: async (paths: string[]) => {
          calls.removed.push(...paths);
          return { error: null };
        },
      }),
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.rpc.push({ fn, args });
      return { error: fn === "attach_reply_file" && refuse(String(args.file_name)) ? { code: "P0001" } : null };
    },
  };
  return { admin: admin as unknown as Parameters<typeof copyReceivedAttachments>[0], calls };
}

function fakeSource(options: { failFirst?: string[] } = {}): ReceivedFileSource & { downloads: string[] } {
  const failed = new Set<string>();
  const downloads: string[] = [];
  return {
    downloads,
    list: async () => sample.attachmentsList.data,
    refresh: async (_email, id) => `https://inbound-cdn.resend.com/fresh/${id}`,
    download: async (url) => {
      downloads.push(url);
      const id = options.failFirst?.find((x) => url.includes(x));
      if (id && !failed.has(id)) {
        failed.add(id);
        return { ok: false, tooLarge: false };
      }
      return { ok: true, bytes: new Uint8Array(url.includes("2a0c9ce0") ? 48213 : 13264), contentType: "application/octet-stream" };
    },
  };
}

test("copying: the planned files land in the task's folder with their names and types", async () => {
  const { plan: result } = plan(sample.retrieved);
  const { admin, calls } = fakeAdmin();
  const source = fakeSource();
  const recorded: { name: string; type: string | null; path: string }[] = [];
  const copied = await copyReceivedAttachments(admin, source, {
    emailId: sample.retrieved.id,
    taskId: TASK,
    plan: result,
    record: async (file) => {
      recorded.push(file);
      return true;
    },
  });
  assert.equal(copied.added, 2);
  assert.deepEqual(copied.skipped, [{ name: "walkthrough.mov", reason: "too_large" }]);
  const logo = calls.uploads.find((u) => u.path.endsWith("-AL_ICON_MARK.jpg"));
  assert.ok(logo && logo.path.startsWith(`${TASK}/`) && logo.contentType === "image/jpeg", "uploaded into the task's folder as image/jpeg");
  assert.ok(recorded.some((r) => r.name === "AL_ICON MARK.jpg" && r.type === "image/jpeg"), "recorded under its real name");
  assert.ok(!source.downloads.some((u) => u.includes("5d3f2f13") || u.includes("4c2e1e02")), "nothing left out is downloaded");
});

test("copying: an expired link is fetched again once; a refused record removes the file and is noted", async () => {
  const { plan: result } = plan(sample.retrieved);
  const { admin, calls } = fakeAdmin((name) => name === "brief.pdf");
  const source = fakeSource({ failFirst: ["2a0c9ce0"] });
  const copied = await copyReplyAttachments(admin, source, {
    emailId: sample.retrieved.id,
    commentId: "00000000-0000-4000-8000-0000000000c1",
    taskId: TASK,
    plan: result,
  });
  assert.ok(source.downloads.includes("https://inbound-cdn.resend.com/fresh/2a0c9ce0-3112-4728-976e-47ddcd16a318"), "a fresh link after the first failed");
  assert.equal(copied.added, 1);
  assert.equal(calls.removed.length, 1, "the refused file doesn't stay in the folder");
  const notes = calls.rpc.filter((c) => c.fn === "note_reply_skipped_files");
  assert.equal(notes.length, 2, "the plan's skips right away, then the failures too");
  assert.deepEqual(notes[0].args.files, [{ name: "walkthrough.mov", reason: "too_large" }]);
  assert.deepEqual(notes[1].args.files, [
    { name: "walkthrough.mov", reason: "too_large" },
    { name: "brief.pdf", reason: "failed" },
  ]);
});

test("the Resend source: the key goes to the API, never to a download link", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify(url.includes("/attachments/") ? { download_url: "https://inbound-cdn.resend.com/x?signature=y" } : sample.attachmentsList), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const source = resendFileSource("re_test_key");
    const listed = await source.list(sample.retrieved.id);
    assert.equal(listed.length, 4);
    assert.equal(await source.refresh(sample.retrieved.id, "2a0c9ce0-3112-4728-976e-47ddcd16a318"), "https://inbound-cdn.resend.com/x?signature=y");
    assert.ok(seen.every((s) => s.url.startsWith("https://api.resend.com/emails/receiving/") && s.auth === "Bearer re_test_key"));
    // Downloads use the guarded fetch with no credentials: a private address is refused before any request.
    const before = seen.length;
    const refused = await source.download("https://127.0.0.1/attachments/x?signature=y");
    assert.equal(refused.ok, false);
    assert.equal(seen.length, before, "no fetch (and no key) for the download");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the reply card: images as thumbnails, PDFs in the viewer, other files as downloads, and what wasn't saved", () => {
  const html = renderToStaticMarkup(
    <EmailFiles
      files={[
        { id: "a1", name: "AL_ICON MARK.jpg", sizeBytes: 48213, contentType: "image/jpeg" },
        { id: "a2", name: "brief.pdf", sizeBytes: 13264, contentType: "application/pdf" },
        { id: "a3", name: "notes.docx", sizeBytes: 2048, contentType: null },
      ]}
      skipped={[{ name: "walkthrough.mov", reason: "too_large" }]}
    />,
  );
  assert.ok(html.includes('aria-label="View AL_ICON MARK.jpg"') && html.includes('src="/attachments/a1?preview=1"'), "image thumbnail");
  assert.ok(html.includes('href="/attachments/a2?preview=1"') && html.includes('target="_blank"'), "PDF opens in the viewer");
  assert.ok(html.includes('href="/attachments/a3"'), "other files download");
  assert.ok(html.includes("Not saved: walkthrough.mov (over 25 MB)"));
});
