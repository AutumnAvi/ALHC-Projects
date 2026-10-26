"use client";

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";

// Oct 26 notes, batch 4: the in-app replacement for the browser's confirm() / alert(), which ESLint
// refuses in src. `const confirm = useConfirm(); if (await confirm({ title, message })) …` opens a small
// modal (role="alertdialog") and resolves true on the confirm button, false on Cancel, Escape, or a click
// outside. `useAlert()` is the one-button version for a message that only needs an OK, and `usePrompt()`
// asks for a line of text (resolves the text, or null when cancelled).
export type ConfirmOptions = {
  // A short question: "Delete this comment?"
  title: string;
  // What happens next, in plain words (optional).
  message?: ReactNode;
  // The confirm button's label ("Delete", "Remove", "Leave"); defaults to "OK".
  confirmLabel?: string;
  cancelLabel?: string;
  // "danger" = a red confirm button, for anything that removes or can't be undone.
  tone?: "default" | "danger";
};

export type PromptOptions = ConfirmOptions & { label?: string; placeholder?: string; initialValue?: string };

type Kind = "confirm" | "alert" | "prompt";
type Request = PromptOptions & { id: number; kind: Kind; resolve: (answer: string | null) => void };
type Ask = (options: PromptOptions | string, kind: Kind) => Promise<string | null>;

// Without a provider (unit tests that render a component on its own) nothing is ever confirmed.
const ConfirmContext = createContext<Ask>(async () => null);

let nextId = 1;

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Request[]>([]);

  const ask = useCallback<Ask>(
    (options, kind) =>
      new Promise<string | null>((resolve) => {
        const opts = typeof options === "string" ? { title: options } : options;
        setQueue((current) => [...current, { ...opts, id: nextId++, kind, resolve }]);
      }),
    [],
  );

  const settle = useCallback((id: number, answer: string | null) => {
    setQueue((current) => {
      const request = current.find((r) => r.id === id);
      request?.resolve(answer);
      return current.filter((r) => r.id !== id);
    });
  }, []);

  const current = queue[0];
  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {current ? <ConfirmModal key={current.id} request={current} onSettle={(answer) => settle(current.id, answer)} /> : null}
    </ConfirmContext.Provider>
  );
}

// Asks a yes / no question in the in-app modal.
export function useConfirm() {
  const ask = useContext(ConfirmContext);
  return useCallback(async (options: ConfirmOptions | string) => (await ask(options, "confirm")) !== null, [ask]);
}

// Shows a message with a single OK button; resolves once it's dismissed.
export function useAlert() {
  const ask = useContext(ConfirmContext);
  return useCallback(
    async (options: ConfirmOptions | string) => {
      await ask(options, "alert");
    },
    [ask],
  );
}

// Asks for a line of text: the trimmed-or-not text on OK (possibly ""), null on Cancel.
export function usePrompt() {
  const ask = useContext(ConfirmContext);
  return useCallback((options: PromptOptions | string) => ask(options, "prompt"), [ask]);
}

function ConfirmModal({ request, onSettle }: { request: Request; onSettle: (answer: string | null) => void }) {
  const titleId = useId();
  const messageId = useId();
  const inputId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(request.initialValue ?? "");
  const settleRef = useRef(onSettle);

  useEffect(() => {
    settleRef.current = onSettle;
  }, [onSettle]);

  useEffect(() => {
    const returnFocus = document.activeElement as HTMLElement | null;
    (inputRef.current ?? confirmRef.current)?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // Escape closes this modal only, not a popover or pane underneath it.
        e.preventDefault();
        e.stopImmediatePropagation();
        settleRef.current(null);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      returnFocus?.focus?.();
    };
  }, []);

  const danger = request.tone === "danger";
  const ok = () => onSettle(request.kind === "prompt" ? value : "");
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-zinc-900/30 p-4"
      onMouseDown={(e) => {
        e.stopPropagation();
        onSettle(null);
      }}
      // A click inside the modal must never reach a popover's "click outside" handler underneath.
      onClick={(e) => e.stopPropagation()}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={request.message ? messageId : undefined}
        data-confirm-dialog=""
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-5 text-sm shadow-xl"
      >
        <h2 id={titleId} className="text-base font-semibold text-zinc-900">
          {request.title}
        </h2>
        {request.message ? (
          <div id={messageId} className="mt-1.5 text-sm text-zinc-600">
            {request.message}
          </div>
        ) : null}
        {request.kind === "prompt" ? (
          <div className="mt-3">
            {request.label ? (
              <label htmlFor={inputId} className="block text-xs font-medium text-zinc-700">
                {request.label}
              </label>
            ) : null}
            <input
              ref={inputRef}
              id={inputId}
              value={value}
              placeholder={request.placeholder}
              aria-label={request.label ? undefined : request.title}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  ok();
                }
              }}
              className="field mt-1 w-full"
            />
          </div>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          {request.kind === "alert" ? null : (
            <button type="button" onClick={() => onSettle(null)} className="btn-secondary">
              {request.cancelLabel ?? "Cancel"}
            </button>
          )}
          <button
            ref={confirmRef}
            type="button"
            onClick={ok}
            className={danger ? "btn-primary bg-red-600 hover:bg-red-700 focus-visible:ring-red-300" : "btn-primary"}
          >
            {request.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
