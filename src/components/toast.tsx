"use client";

import { createContext, useCallback, useContext, useState, useTransition, type ReactNode } from "react";
import { X } from "lucide-react";
import type { ActionResult } from "@/lib/actions";
import { invalidateTaskPanes } from "@/components/task/task-pane-store";
import { beginLocalMutation, endLocalMutation, failMutation } from "@/lib/optimistic-session";

// An optional button on the toast (e.g. Undo); clicking it runs the action and dismisses the toast.
export type ToastAction = { label: string; onClick: () => void };
type Toast = { id: number; message: string; action?: ToastAction };
type Notify = (message: string, action?: ToastAction) => void;

const ToastContext = createContext<Notify>(() => {});

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback<Notify>(
    (message, action) => {
      const id = nextId++;
      setToasts((current) => [...current.slice(-2), { id, message, action }]);
      // Toasts with an action stay a little longer, so there is time to use it.
      window.setTimeout(() => dismiss(id), action ? 12000 : 6000);
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
            {toast.action ? (
              <button
                type="button"
                onClick={() => {
                  dismiss(toast.id);
                  toast.action?.onClick();
                }}
                className="-my-0.5 rounded px-1.5 py-0.5 font-medium text-accent-200 hover:bg-white/10 hover:text-white"
              >
                {toast.action.label}
              </button>
            ) : null}
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

// What a failed action that threw (a dropped connection, an expired session) reads as.
export const ACTION_FAILED = "Couldn’t save. Check your connection and try again.";

// Runs a server action inside a transition and surfaces any returned error as a toast. The returned
// promise settles (never rejects) once the action has finished, with its result — so a caller that
// must not lose what someone typed (the long text editor) can wait for it and keep the draft on an
// error. Callers that don't need it ignore it.
export function useServerAction() {
  const notify = useContext(ToastContext);
  const [pending, startTransition] = useTransition();

  const run = useCallback(
    (action: () => Promise<ActionResult | void>, optimistic?: () => void): Promise<ActionResult | void> =>
      new Promise((resolve) => {
        const token = beginLocalMutation();
        startTransition(async () => {
          try {
            optimistic?.();
            const result = await action();
            if (result?.error) {
              notify(result.error);
              failMutation(token);
            }
            resolve(result);
          } catch (error) {
            failMutation(token);
            resolve({ error: ACTION_FAILED });
            throw error;
          } finally {
            endLocalMutation(token);
            // Cached task panes may be out of date now (the open one gets its fresh copy with the refresh).
            invalidateTaskPanes();
          }
        });
      }),
    [notify],
  );

  return [pending, run] as const;
}

// Shows a toast directly (for results that aren't errors, e.g. a bulk edit summary).
export function useNotify() {
  return useContext(ToastContext);
}
