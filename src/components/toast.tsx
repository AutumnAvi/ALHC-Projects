"use client";

import { createContext, useCallback, useContext, useState, useTransition, type ReactNode } from "react";
import { X } from "lucide-react";
import type { ActionResult } from "@/lib/actions";
import { invalidateTaskPanes } from "@/components/task/task-pane-store";
import { beginLocalMutation, endLocalMutation, failMutation } from "@/lib/optimistic-session";

// An optional button on the toast (e.g. Undo); clicking it runs the action and dismisses the toast.
export type ToastAction = { label: string; onClick: () => void };
// Nov 1 notes, batch 10: "quiet" = a small, semi-transparent note (an automation ran); "warning" = an
// amber card that stays longer (loop protection stopped an automation). `body` replaces the message's
// text when given (links); `message` stays the accessible text.
export type ToastVariant = "default" | "quiet" | "warning";
export type RichToast = { message: string; body?: ReactNode; variant?: ToastVariant; action?: ToastAction; durationMs?: number };
type Toast = RichToast & { id: number };
type Notify = (message: string, action?: ToastAction) => void;

const ToastContext = createContext<Notify>(() => {});
const RichToastContext = createContext<(toast: RichToast) => void>(() => {});
// Nov 3 notes (batch 19, 141): a spot at the bottom of the toast column for something that stays while
// it matters (the running-automations indicator), so toasts stack above it instead of over it.
const ToastDockContext = createContext<HTMLElement | null>(null);

export function useToastDock(): HTMLElement | null {
  return useContext(ToastDockContext);
}

let nextId = 1;

const TOAST_CLASS: Record<ToastVariant, string> = {
  default: "pointer-events-auto flex items-start gap-3 rounded-lg bg-zinc-900 px-4 py-3 text-sm text-white shadow-lg",
  quiet:
    "pointer-events-auto flex w-fit max-w-full items-start gap-2 rounded-md bg-zinc-900/70 px-3 py-1.5 text-xs text-white shadow-md backdrop-blur-sm",
  warning:
    "pointer-events-auto flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 shadow-lg",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dock, setDock] = useState<HTMLElement | null>(null);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (toast: RichToast) => {
      const id = nextId++;
      setToasts((current) => [...current.slice(-3), { ...toast, id }]);
      // Toasts with an action stay a little longer, so there is time to use it.
      window.setTimeout(() => dismiss(id), toast.durationMs ?? (toast.action ? 12000 : 6000));
    },
    [dismiss],
  );
  const notify = useCallback<Notify>((message, action) => show({ message, action }), [show]);

  return (
    <ToastContext.Provider value={notify}>
      <RichToastContext.Provider value={show}>
      <ToastDockContext.Provider value={dock}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 left-4 z-[90] flex w-full max-w-sm flex-col gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.variant === "quiet" ? "status" : "alert"}
            data-toast-variant={toast.variant ?? "default"}
            aria-label={toast.body ? toast.message : undefined}
            className={TOAST_CLASS[toast.variant ?? "default"]}
          >
            <div className="min-w-0 flex-1">{toast.body ?? <p>{toast.message}</p>}</div>
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
              className={
                toast.variant === "warning"
                  ? "-mr-1 rounded p-0.5 text-amber-700 hover:text-amber-950"
                  : "-mr-1 rounded p-0.5 text-zinc-400 hover:text-white"
              }
            >
              <X className={toast.variant === "quiet" ? "size-3.5" : "size-4"} />
            </button>
          </div>
        ))}
        <div ref={setDock} data-toast-dock className="contents" />
      </div>
      </ToastDockContext.Provider>
      </RichToastContext.Provider>
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
            // Batch 10 / 18: ending the mutation tells the person what automations their change ran
            // (optimistic-session.ts → rule-feedback.tsx).
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

// Shows a toast with a variant and links (automation feedback).
export function useRichToast() {
  return useContext(RichToastContext);
}

// Shows a toast directly (for results that aren't errors, e.g. a bulk edit summary).
export function useNotify() {
  return useContext(ToastContext);
}
