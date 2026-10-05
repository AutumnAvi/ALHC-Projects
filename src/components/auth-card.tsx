import type { ReactNode } from "react";

export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-full items-center justify-center bg-zinc-50 px-4 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex size-8 items-center justify-center rounded-lg bg-zinc-900 text-sm font-semibold text-white"
          >
            A
          </span>
          <span className="text-sm font-semibold tracking-tight text-zinc-900">ALHC Projects</span>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold tracking-tight text-zinc-900">{title}</h1>
          <div className="mt-2">{children}</div>
        </div>
      </div>
    </main>
  );
}
