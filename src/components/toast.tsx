"use client";

import { createContext, useCallback, useContext, useState, useTransition, type ReactNode } from "react";
import { X } from "lucide-react";
import type { ActionResult } from "@/lib/actions";

type Toast = { id: number; message: string };

const ToastContext = createContext<(message: string) => void>(() => {});

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback(
    (message: string) => {
      const id = nextId++;
      setToasts((current) => [...current.slice(-2), { id, message }]);
      window.setTimeout(() => dismiss(id), 6000);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 left-4 z-50 flex w-full max-w-sm flex-col gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="alert"
            className="pointer-events-auto flex items-start gap-3 rounded-lg bg-zinc-900 px-4 py-3 text-sm text-white shadow-lg"
          >
            <p className="flex-1">{toast.message}</p>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss"
              className="-mr-1 rounded p-0.5 text-zinc-400 hover:text-white"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// Runs a server action inside a transition and surfaces any returned error as a toast.
export function useServerAction() {
  const notify = useContext(ToastContext);
  const [pending, startTransition] = useTransition();

  const run = useCallback(
    (action: () => Promise<ActionResult | void>, optimistic?: () => void) => {
      startTransition(async () => {
        optimistic?.();
        const result = await action();
        if (result?.error) notify(result.error);
      });
    },
    [notify],
  );

  return [pending, run] as const;
}

// Shows a toast directly (for results that aren't errors, e.g. a bulk edit summary).
export function useNotify() {
  return useContext(ToastContext);
}
