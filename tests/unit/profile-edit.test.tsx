// Oct 25 notes, note 1 — your own name and picture: the checks the Settings → Profile tab and the server
// actions share, and the one Avatar (picture, else initials) used wherever a person shows up.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Avatar } from "@/components/avatar";
import { AvatarDirectoryProvider } from "@/components/avatar-face";
import { AVATAR_MAX_BYTES, avatarFileProblem, ownAvatarPath, profileNameProblem } from "@/lib/profile";

const me = "a1a19025-0000-4000-8000-000000000001";

test("a name is 1–100 characters once trimmed", () => {
  assert.equal(profileNameProblem("Mia Member"), null);
  assert.equal(profileNameProblem("  Mia  "), null);
  assert.equal(profileNameProblem("   "), "Enter your name");
  assert.equal(profileNameProblem("x".repeat(100)), null);
  assert.match(profileNameProblem("x".repeat(101)) ?? "", /100 characters/);
});

test("pictures: PNG / JPEG / WebP / GIF up to 2 MB", () => {
  assert.equal(avatarFileProblem({ type: "image/png", size: 1000 }), null);
  assert.equal(avatarFileProblem({ type: "image/webp", size: AVATAR_MAX_BYTES }), null);
  assert.match(avatarFileProblem({ type: "image/svg+xml", size: 1000 }) ?? "", /PNG, JPEG/);
  assert.match(avatarFileProblem({ type: "image/jpeg", size: AVATAR_MAX_BYTES + 1 }) ?? "", /2 MB/);
  assert.match(avatarFileProblem({ type: "image/gif", size: 0 }) ?? "", /empty/);
});

test("only your own uploaded file is ever removed", () => {
  const base = "https://x.supabase.co/storage/v1/object/public/avatars/";
  assert.equal(ownAvatarPath(`${base}${me}/abc.png`, me), `${me}/abc.png`);
  assert.equal(ownAvatarPath(`${base}${me}/abc.png?v=2`, me), `${me}/abc.png`);
  assert.equal(ownAvatarPath(`${base}someone-else/abc.png`, me), null, "someone else's file");
  assert.equal(ownAvatarPath(`${base}${me}/nested/abc.png`, me), null, "not a file of your folder");
  assert.equal(ownAvatarPath("https://lh3.googleusercontent.com/a/me", me), null, "a provider picture");
  assert.equal(ownAvatarPath(`${base.replace("avatars", "workspace-assets")}${me}/abc.png`, me), null, "another bucket");
  assert.equal(ownAvatarPath(null, me), null);
});

test("the Avatar shows the picture when there is one, else the initials", () => {
  const withSrc = renderToStaticMarkup(<Avatar name="Mia Member" src="https://example.com/mia.png" />);
  assert.match(withSrc, /<img[^>]+src="https:\/\/example.com\/mia.png"/);
  assert.match(withSrc, /alt=""/);
  assert.doesNotMatch(withSrc, />MM</);

  const plain = renderToStaticMarkup(<Avatar name="Mia Member" />);
  assert.doesNotMatch(plain, /<img/);
  assert.match(plain, />MM</);
  assert.match(renderToStaticMarkup(<Avatar name="o25-member@example.com" />), />OM</, "an email's local part");
});

test("an Avatar that knows whose it is finds the picture in the directory", () => {
  const html = renderToStaticMarkup(
    <AvatarDirectoryProvider avatars={{ [me]: "https://example.com/dir.png" }}>
      <Avatar name="Mia Member" profileId={me} />
      <Avatar name="Olga Other" profileId="someone-else" />
    </AvatarDirectoryProvider>,
  );
  assert.match(html, /src="https:\/\/example.com\/dir.png"/);
  assert.match(html, />OO</, "no picture → initials");
});
