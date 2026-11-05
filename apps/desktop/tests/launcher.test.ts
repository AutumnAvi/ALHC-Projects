// Big move 3 (docs/design/desktop.md): the desktop launcher's rules.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appOriginOf,
  engineTooOld,
  hasLookbehind,
  launchTarget,
  probeUrl,
  readShellInfo,
  retryDelaySeconds,
} from "../src/launcher";

const APP = "https://alhc-projects.vercel.app";
const T = "7a1c2d3e-4f50-4a61-8b72-9c8d7e6f5a4b";

test("the shell's info is read only when it names an app origin", () => {
  assert.deepEqual(readShellInfo({ appOrigin: APP, platform: "macos", version: "0.1.0" }), {
    appOrigin: APP,
    platform: "macos",
    version: "0.1.0",
  });
  assert.equal(readShellInfo({ appOrigin: `${APP}/`, platform: "windows", version: "1" })?.appOrigin, APP);
  for (const value of [undefined, null, "x", {}, { appOrigin: APP }, { appOrigin: "http://evil.example", platform: "macos", version: "1" }]) {
    assert.equal(readShellInfo(value), null);
  }
});

test("app origins: https, or http on this computer, and nothing after the host", () => {
  assert.equal(appOriginOf(APP), APP);
  assert.equal(appOriginOf("http://localhost:3000"), "http://localhost:3000");
  assert.equal(appOriginOf("http://127.0.0.1:3000/"), "http://127.0.0.1:3000");
  for (const value of ["http://alhc-projects.vercel.app", `${APP}/login`, `${APP}?x=1`, "javascript:alert(1)", "tauri://localhost", "", "not a url"]) {
    assert.equal(appOriginOf(value), null, value);
  }
});

test("the window goes to the deep link's page, the reloaded page, or Home", () => {
  assert.equal(launchTarget("", APP), `${APP}/`);
  assert.equal(launchTarget(`?open=${encodeURIComponent(`alhc://task/${T}`)}`, APP), `${APP}/my-tasks?task=${T}`);
  assert.equal(launchTarget(`?open=${encodeURIComponent("alhc://inbox?tab=mentioned")}`, APP), `${APP}/inbox?tab=mentioned`);
  assert.equal(launchTarget(`?open=${encodeURIComponent("https://evil.example/")}`, APP), `${APP}/`);
  assert.equal(launchTarget(`?open=${encodeURIComponent("alhc://login")}`, APP), `${APP}/`);
  assert.equal(launchTarget(`?to=${encodeURIComponent("/login?next=%2Finbox")}`, APP), `${APP}/login?next=%2Finbox`);
  assert.equal(launchTarget(`?to=${encodeURIComponent("//evil.example/x")}`, APP), `${APP}/`);
  assert.equal(launchTarget(`?to=${encodeURIComponent("https://evil.example/x")}`, APP), `${APP}/`);
});

test("probing and retrying", () => {
  assert.equal(probeUrl(APP), `${APP}/favicon.ico`);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map(retryDelaySeconds), [2, 2, 4, 8, 15, 30, 30]);
});

test("an engine without :has(), color-mix(), or Safari 16.4's JavaScript is too old for the web app", () => {
  const modern = () => true;
  assert.equal(hasLookbehind(), true);
  assert.equal(engineTooOld(modern), false);
  assert.equal(engineTooOld(modern, () => true), false);
  assert.equal(engineTooOld((property) => property !== "selector(:has(a))"), true);
  assert.equal(engineTooOld((property) => property !== "color"), true);
  // Safari 16.2 / 16.3: :has() and color-mix(), but no lookbehind (nor the class static blocks Next.js uses).
  assert.equal(engineTooOld(modern, () => false), true);
  assert.equal(
    engineTooOld(() => {
      throw new Error("no CSS.supports");
    }),
    true,
  );
});
