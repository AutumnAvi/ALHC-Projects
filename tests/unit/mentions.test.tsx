// Part 4 — @mentions: the body splits into pills with real names, and the hover card shows the person.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { mentionSegments } from "@/lib/mentions";
import { MentionText, ProfileCard, TeamCard } from "@/components/task/comment-parts";

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

const design = {
  id: "t1",
  name: "Design Team",
  members: [
    { id: "a", name: "Ann Lee", email: "ann.lee@example.com" },
    { id: "c", name: "Cy Ho", email: "cy@example.com" },
  ],
};

test("@Team Name becomes a team mention; a person with the same name wins", () => {
  const segments = mentionSegments("Ping @Design Team and @Ann Lee", [ann], [design]);
  assert.deepEqual(
    segments.filter((s) => s.type !== "text"),
    [
      { type: "team", teamId: "t1", raw: "@Design Team" },
      { type: "mention", profileId: "a", raw: "@Ann Lee" },
    ],
  );
  const clash = mentionSegments("@Ann Lee", [ann], [{ id: "t2", name: "Ann Lee" }]);
  assert.deepEqual(clash, [{ type: "mention", profileId: "a", raw: "@Ann Lee" }]);
});

test("a team pill shows the name; its card lists the members, with nothing to click", () => {
  const html = renderToStaticMarkup(<MentionText body="cc @design team" people={[]} teams={[design]} />);
  assert.match(html, /data-team-mention="t1"/);
  assert.match(html, />@Design Team</);
  assert.match(html, /aria-label="@Design Team, team of 2"/);
  assert.doesNotMatch(html, /<a /);
  const card = renderToStaticMarkup(<TeamCard team={design} />);
  assert.match(card, /data-team-card/);
  assert.match(card, /Design Team/);
  assert.match(card, /2 members/);
  assert.match(card, /Ann Lee/);
  assert.match(card, /Cy Ho/);
  assert.doesNotMatch(card, /<a |<button/);
});
