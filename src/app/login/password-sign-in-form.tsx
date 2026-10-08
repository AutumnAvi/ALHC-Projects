"use client";

import { useActionState } from "react";
import { passwordAuth, type PasswordAuthState } from "./actions";

const inputClass =
  "field mt-1 block h-10 w-full font-normal";

// One form for both screens: /login signs in, /signup creates an account (confirmed by email, then the
// allowlist gate in /auth/callback). Each screen links to the other.
export function PasswordSignInForm({
  next,
  mode = "sign-in",
  defaultEmail,
}: {
  next: string;
  mode?: "sign-in" | "sign-up";
  // Prefilled from an invite link (/signup?email=…).
  defaultEmail?: string;
}) {
  const signUp = mode === "sign-up";
  const [state, formAction, pending] = useActionState<PasswordAuthState, FormData>(
    passwordAuth,
    {},
  );

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="intent" value={mode} />
      <label className="block text-sm font-medium text-zinc-700">
        Email
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          defaultValue={defaultEmail}
          className={inputClass}
        />
      </label>
      <label className="block text-sm font-medium text-zinc-700">
        Password
        <input
          type="password"
          name="password"
          required
          minLength={6}
          autoComplete={signUp ? "new-password" : "current-password"}
          aria-describedby={signUp ? "password-hint" : undefined}
          className={inputClass}
        />
        {signUp ? (
          <span id="password-hint" className="mt-1 block text-xs font-normal text-zinc-500">
            At least 6 characters.
          </span>
        ) : null}
      </label>
      {state.error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}
      {state.notice ? (
        <p role="status" className="rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-700">
          {state.notice}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-60"
      >
        {pending ? (signUp ? "Creating account…" : "Signing in…") : signUp ? "Create account" : "Sign in"}
      </button>
    </form>
  );
}
