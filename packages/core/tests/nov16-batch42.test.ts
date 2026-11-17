// Nov 16 batch 42 (audit C97): the Inbox reads one more than it shows, and its "latest 100" note says so
// only when there really are older notifications.
import assert from "node:assert/strict";
import { test } from "node:test";
import { INBOX_LIMIT, inboxLimitNote, inboxPageOf } from "../src/inbox";

const rows = (n: number) => Array.from({ length: n }, (_, i) => i);

test("one more than shown tells a full page from a cut one", () => {
  assert.deepEqual(inboxPageOf(rows(99)), { items: rows(99), hasMore: false });
  assert.deepEqual(inboxPageOf(rows(100)), { items: rows(100), hasMore: false });
  const cut = inboxPageOf(rows(101));
  assert.equal(cut.items.length, INBOX_LIMIT);
  assert.equal(cut.hasMore, true);
  assert.equal(inboxPageOf(rows(150)).items.length, INBOX_LIMIT);
  assert.equal(inboxPageOf(rows(3), 2).hasMore, true);
});

test("the note: only with more, and Activity says how to see them", () => {
  assert.equal(inboxLimitNote("activity", false), null);
  assert.equal(inboxLimitNote("archive", false), null);
  assert.equal(inboxLimitNote("activity", true), "Showing the latest 100 notifications. Archive some to see older ones.");
  assert.equal(inboxLimitNote("bookmarks", true), "Showing the latest 100 notifications.");
});
