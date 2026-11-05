"use client";

import { useActionState } from "react";
import { MIN_PASSWORD_LENGTH } from "@alhc/core/password-reset";
import { updatePassword, type ResetPasswordState } from "./actions";

const inputClass = "field mt-1 block h-10 w-full font-normal";

export function ResetPasswordForm({ email }: { email: string | null }) {
  const [state, formAction, pending] = useActionState<ResetPasswordState, FormData>(updatePassword, {});

  return (
    <form action={formAction} className="space-y-4">
      {/* Lets password managers save the new password under the right account. */}
      {email ? <input type="email" name="username" value={email} autoComplete="username" readOnly hidden /> : null}
      <label className="block text-sm font-medium text-zinc-700">
        New password
        <input
          type="password"
          name="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          aria-describedby="new-password-hint"
          className={inputClass}
        />
        <span id="new-password-hint" className="mt-1 block text-xs font-normal text-zinc-500">
          At least {MIN_PASSWORD_LENGTH} characters.
        </span>
      </label>
      <label className="block text-sm font-medium text-zinc-700">
        Confirm new password
        <input
          type="password"
          name="confirm"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          className={inputClass}
        />
      </label>
      {state.error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-accent-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-accent-600 disabled:cursor-wait disabled:opacity-60"
      >
        {pending ? "Saving…" : "Save new password"}
      </button>
    </form>
  );
}
