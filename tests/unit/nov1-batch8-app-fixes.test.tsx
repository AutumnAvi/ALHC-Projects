// Nov 1 notes, batch 8 — item 58 (scrolling the sidebar showed a white bar under the app) and Forgot
// password (note 57).
//
// 58: visually hidden text and other absolutely positioned bits inside a page's scroll area escaped it
// (their containing block, .app-main, doesn't clip), the document grew past the window, and a scroll that
// reached the end of the sidebar carried on into the document. The frame now clips (overflow: clip), the
// document is locked while a frame is mounted (screen only), and inner scroll areas contain their scroll.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { AppShell } from "@/components/shell/app-shell";
import { ShellProvider } from "@/components/shell/shell-context";
import { ADMIN_SHELL_FRAME, APP_SHELL_FRAME, SCROLL_AREA } from "@/components/shell/shell-frame";
import { ToastProvider } from "@/components/toast";
import { PasswordSignInForm } from "@/app/login/password-sign-in-form";
import { safeNextPath } from "@/lib/auth";
import {
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
  PASSWORD_UPDATED,
  RESET_COOLDOWN_SECONDS,
  RESET_LINK_EXPIRED,
  RESET_PASSWORD_PATH,
  RESET_SENT_NOTICE,
  expiredResetPath,
  isResetNext,
  normalizeResetEmail,
  passwordProblem,
  resetRedirectUrl,
  resetRequestOutcome,
  updatePasswordError,
  utf8Length,
} from "@/lib/password-reset";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const member = { id: "me", email: "me@example.com", name: "Me", avatarUrl: null };

function render(node: ReactNode, pathname = "/") {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value={pathname}>
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <ShellProvider member={member as never} isWorkspaceAdmin={false} workspace={{ name: "ALHC", logoUrl: null }} initialSidebar={DEFAULT_SIDEBAR_PREFS}>
            <ToastProvider>{node}</ToastProvider>
          </ShellProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

const css = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");
const printBlock = css.slice(css.indexOf("@media print"));

function classOf(html: string, marker: string): string[] {
  const at = html.indexOf(marker);
  assert.ok(at >= 0, `missing ${marker}`);
  const tagStart = html.lastIndexOf("<", at);
  const tag = html.slice(tagStart, html.indexOf(">", at));
  return (/class="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/);
}

// ---- 58: the frame never lets the document scroll ----

test("58: the app frame clips its overflow and the sidebar contains its own scroll", () => {
  const projects = Array.from({ length: 40 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, name: `Project ${i}` }));
  const html = render(
    <AppShell projects={projects} starredIds={[]} unreadCount={0}>
      <main>
        <div className={`min-h-0 flex-1 ${SCROLL_AREA}`}>page</div>
      </main>
    </AppShell>,
  );
  const frame = classOf(html, 'class="app-shell');
  for (const cls of ["app-shell", "flex", "h-full", "flex-col", "overflow-clip"]) assert.ok(frame.includes(cls), cls);
  // Not overflow-hidden: a hidden box can still be scrolled by focus / scrollIntoView.
  assert.ok(!frame.includes("overflow-hidden"));
  const nav = classOf(html, 'aria-label="Primary"');
  assert.ok(nav.includes("overflow-y-auto") && nav.includes("overscroll-contain"), nav.join(" "));
});

test("58: the shared classes", () => {
  assert.match(APP_SHELL_FRAME, /(^| )app-shell( |$)/);
  assert.match(ADMIN_SHELL_FRAME, /(^| )admin-shell( |$)/);
  for (const frame of [APP_SHELL_FRAME, ADMIN_SHELL_FRAME]) assert.match(frame, /(^| )overflow-clip( |$)/);
  assert.equal(SCROLL_AREA, "overflow-y-auto overscroll-contain");
});

test("58: the document is locked on screen only while a frame is mounted", () => {
  const screen = /@media screen\s*\{\s*html:has\(body \.app-shell\),\s*html:has\(body \.admin-shell\)\s*\{\s*overflow: hidden;\s*overscroll-behavior: none;/;
  assert.match(css, screen);
  // Never a plain html / body lock: public pages (sign in, forms, review links) scroll as usual.
  assert.doesNotMatch(css.slice(0, css.indexOf("@media print")), /(^|\n)\s*(html|body)\s*\{[^}]*overflow:\s*hidden/);
});

test("58: print lets the frame flow onto paper", () => {
  assert.match(printBlock, /html,\s*body,\s*\.app-shell,\s*\.admin-shell\s*\{\s*height: auto !important;\s*overflow: visible !important;/);
  assert.match(printBlock, /\.app-shell,\s*\.admin-shell\s*\{\s*display: block !important;/);
  assert.match(printBlock, /\.app-main,\s*\.app-main \*,\s*\.admin-shell main,\s*\.admin-shell main \*\s*\{\s*overflow: visible !important;/);
  // The task pane print (printTask) is unchanged.
  assert.match(printBlock, /html\[data-print-task\] \[data-task-pane\]/);
});

test("58: the inner scroll areas use the shared class", () => {
  const files = {
    "src/components/shell/sidebar.tsx": /<nav aria-label="Primary" className=\{`[^`]*\$\{SCROLL_AREA\}`\}/,
    "src/components/task/task-detail-panel.tsx": /className=\{`min-h-0 flex-1 \$\{SCROLL_AREA\}`\}/,
    "src/components/task/task-pane-preview.tsx": /\$\{SCROLL_AREA\}/,
    "src/components/project/customize-panel.tsx": /\$\{SCROLL_AREA\}/,
    "src/app/(admin)/admin/layout.tsx": /<div className=\{ADMIN_SHELL_FRAME\}>[\s\S]*<main className=\{`[^`]*\$\{SCROLL_AREA\}`\}/,
  };
  for (const [file, pattern] of Object.entries(files)) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.match(source, pattern, file);
  }
});

// ---- Forgot password ----

test("forgot password: the sign-in form links to it, the sign-up form doesn't", () => {
  const signIn = render(<PasswordSignInForm next="/" mode="sign-in" />, "/login");
  assert.match(signIn, /href="\/forgot-password"[^>]*>Forgot password\?<\/a>/);
  const signUp = render(<PasswordSignInForm next="/" mode="sign-up" />, "/signup");
  assert.doesNotMatch(signUp, /Forgot password/);
  assert.match(signUp, new RegExp(`minLength="${MIN_PASSWORD_LENGTH}"`));
  assert.match(signUp, new RegExp(`At least ${MIN_PASSWORD_LENGTH} characters`));
});

test("forgot password: one notice for every address", () => {
  assert.equal(RESET_SENT_NOTICE, "If that address has an account, we’ve sent a link to reset your password.");
  // No error, an unknown address, the per-address frequency limit and the email quota (both only ever
  // hit an address that exists), an SMTP failure, anything else: the same answer.
  for (const error of [
    null,
    undefined,
    { code: "user_not_found", status: 400 },
    { code: "over_email_send_rate_limit", status: 429 },
    { code: "unexpected_failure", status: 500 },
    { code: "email_address_invalid", status: 400 },
    { status: 429 },
    {},
  ]) {
    assert.equal(resetRequestOutcome(error), "sent", JSON.stringify(error));
  }
  // Only the request-rate limit (counts requests, not accounts) says try again.
  assert.equal(resetRequestOutcome({ code: "over_request_rate_limit", status: 429 }), "rate_limited");
});

test("forgot password: the email is checked loosely and lowercased", () => {
  assert.equal(normalizeResetEmail("  Avi@Example.COM "), "avi@example.com");
  for (const bad of ["", "   ", "no-at-sign", "a@b", "a b@c.de", null, undefined, `${"a".repeat(320)}@x.io`]) {
    assert.equal(normalizeResetEmail(bad), null, String(bad));
  }
});

test("forgot password: the link returns through the callback to the reset page", () => {
  const url = new URL(resetRedirectUrl("https://projects.example.com"));
  assert.equal(url.origin, "https://projects.example.com");
  assert.equal(url.pathname, "/auth/callback");
  assert.equal(url.searchParams.get("next"), RESET_PASSWORD_PATH);
  // The callback's own next-path check keeps it.
  assert.equal(safeNextPath(url.searchParams.get("next")), "/reset-password");
  assert.ok(isResetNext(safeNextPath(url.searchParams.get("next"))));
  assert.ok(isResetNext("/reset-password?x=1"));
  for (const other of ["/", "/login", "/reset-passwords", "/projects/reset-password"]) assert.equal(isResetNext(other), false, other);
  assert.equal(expiredResetPath(), "/forgot-password?expired=1");
  assert.match(RESET_LINK_EXPIRED, /expired/);
});

test("forgot password: the form rests as long as Supabase's per-address limit", () => {
  assert.equal(RESET_COOLDOWN_SECONDS, 60);
});

test("reset password: new password checks", () => {
  assert.equal(passwordProblem("", ""), "Enter a new password.");
  assert.equal(passwordProblem("short", "short"), `Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  assert.equal(passwordProblem("      ", "      "), "Use letters, numbers, or symbols, not only spaces.");
  assert.equal(passwordProblem("longenough", "longenougH"), "The two passwords don’t match.");
  assert.equal(passwordProblem("longenough", "longenough"), null);
  // Spaces inside or around a real password are kept as typed.
  assert.equal(passwordProblem(" pass word ", " pass word "), null);
  // Characters, not UTF-16 units, count toward the minimum; bytes toward bcrypt's 72.
  assert.equal(passwordProblem("😀😀😀", "😀😀😀"), `Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  const max = "a".repeat(MAX_PASSWORD_BYTES);
  assert.equal(passwordProblem(max, max), null);
  const over = "é".repeat(37); // 74 bytes
  assert.equal(utf8Length(over), 74);
  assert.match(passwordProblem(over, over) ?? "", /too long/);
});

test("reset password: Supabase's refusals in plain words", () => {
  assert.match(updatePasswordError({ code: "same_password" }), /different from your current one/);
  assert.equal(updatePasswordError({ code: "weak_password", message: "Password should contain a digit." }), "Password should contain a digit.");
  assert.match(updatePasswordError({ code: "weak_password", message: "" }), /too weak/);
  assert.equal(updatePasswordError({ code: "session_not_found" }), RESET_LINK_EXPIRED);
  const generic = updatePasswordError({ code: "unexpected_failure", message: "db timeout at 10.0.0.3" });
  assert.doesNotMatch(generic, /10\.0\.0\.3/);
  assert.match(generic, /Try again/);
  assert.equal(PASSWORD_UPDATED, "Password updated. Sign in with your new password.");
});
