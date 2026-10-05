"use client";

import { useActionState } from "react";
import { passwordAuth, type PasswordAuthState } from "./actions";

const inputClass =
  "mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-xs focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-100";

export function PasswordSignInForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState<PasswordAuthState, FormData>(
    passwordAuth,
    {},
  );

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <label className="block text-sm font-medium text-zinc-700">
        Email
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
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
          autoComplete="current-password"
          className={inputClass}
        />
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
      <div className="flex gap-2">
        <button
          type="submit"
          name="intent"
          value="sign-in"
          disabled={pending}
          className="flex-1 rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-60"
        >
          Sign in
        </button>
        <button
          type="submit"
          name="intent"
          value="sign-up"
          disabled={pending}
          className="flex-1 rounded-lg border border-zinc-300 bg-white px-4 py-2.5 text-sm font-medium text-zinc-800 shadow-xs transition hover:bg-zinc-50 disabled:cursor-wait disabled:opacity-60"
        >
          Sign up
        </button>
      </div>
    </form>
  );
}
