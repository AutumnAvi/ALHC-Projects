"use client";

import { useActionState, useEffect, useState } from "react";
import { RESET_COOLDOWN_SECONDS } from "@/lib/password-reset";
import { requestPasswordReset, type ForgotPasswordState } from "./actions";

export function ForgotPasswordForm({ defaultEmail }: { defaultEmail?: string }) {
  const [state, formAction, pending] = useActionState<ForgotPasswordState, FormData>(requestPasswordReset, {});
  // After a request the button rests for a minute (Supabase allows one reset email a minute per address).
  const [wait, setWait] = useState(0);
  const [seen, setSeen] = useState<ForgotPasswordState>(state);
  if (seen !== state) {
    setSeen(state);
    if (state.sent) setWait(RESET_COOLDOWN_SECONDS);
  }

  useEffect(() => {
    if (wait <= 0) return;
    const timer = window.setTimeout(() => setWait((left) => Math.max(0, left - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [wait]);

  return (
    <form action={formAction} className="space-y-4">
      <label className="block text-sm font-medium text-zinc-700">
        Email
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          defaultValue={state.email ?? defaultEmail}
          className="field mt-1 block h-10 w-full font-normal"
        />
      </label>
      {state.error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}
      {state.notice ? (
        <p role="status" className="rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-700">
          {state.notice} Open it in this browser; it expires after a while. Check your spam folder too.
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending || wait > 0}
        className="w-full rounded-lg bg-accent-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-accent-600 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Sending…" : wait > 0 ? `Send again in ${wait}s` : state.sent ? "Send again" : "Send reset link"}
      </button>
    </form>
  );
}
