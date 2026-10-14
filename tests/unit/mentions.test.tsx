// Part 4 — @mentions: the body splits into pills with real names, and the hover card shows the person.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { mentionSegments } from "@/lib/mentions";
import { MentionText, ProfileCard } from "@/components/task/comment-parts";

const ann = { id: "a", full_name: "Ann Lee", email: "ann.lee@example.com" };
const annie = { id: "b", full_name: "Ann", email: "annie@example.com" };

test("@Full Name and @emailname become mentions; longest name wins; other @words stay text", () => {
  const segments = mentionSegments("Hi @Ann Lee and @annie, cc @ann.lee. Not @nobody or ann@example.com", [ann, annie]);
  assert.deepEqual(
    segments.filter((s) => s.type === "mention"),
    [
      { type: "mention", profileId: "a", raw: "@Ann Lee" },
      { type: "mention", profileId: "b", raw: "@annie" },
      { type: "mention", profileId: "a", raw: "@ann.lee" },
    ],
  );
  assert.equal(segments.map((s) => (s.type === "text" ? s.text : s.raw)).join(""), "Hi @Ann Lee and @annie, cc @ann.lee. Not @nobody or ann@example.com");
});

test("a mention must end at a word boundary", () => {
  assert.equal(mentionSegments("@Annabel", [annie]).length, 1);
  assert.equal(mentionSegments("@Annabel", [annie])[0].type, "text");
});

test("the pill shows the real name, not the raw token", () => {
  const html = renderToStaticMarkup(<MentionText body="Thanks @ann.lee!" people={[ann]} describe={() => "Editor"} />);
  assert.match(html, /data-mention="a"/);
  assert.match(html, />@Ann Lee</);
  assert.doesNotMatch(html, />@ann\.lee</);
  assert.match(html, /aria-label="@Ann Lee, ann\.lee@example\.com, Editor"/);
});

test("the hover card has the avatar, name, email, and role", () => {
  const html = renderToStaticMarkup(<ProfileCard person={ann} detail="Editor in this task’s project" />);
  assert.match(html, /data-profile-card/);
  assert.match(html, /Ann Lee/);
  assert.match(html, /ann\.lee@example\.com/);
  assert.match(html, /Editor in this task’s project/);
  assert.match(html, />AL</, "initials avatar");
});
