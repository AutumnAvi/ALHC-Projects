"use client";

import { createContext, useContext, type ReactNode } from "react";

// Where a rule step's setting is edited (src/lib/rule-params.ts). A rule builder wraps each step's
// editors in <StepParams missing={…}> and each setting's editor in <ParamSlot param="kind">: the editor
// inside is highlighted while that setting is still missing, and the slot carries data-param so tests
// can find the editor of every setting. The slot draws no box of its own (display: contents).

const MissingParamsContext = createContext<ReadonlySet<string>>(new Set());
const ParamKeyContext = createContext<string | null>(null);

// Tests only: a probe that every editor inside a slot registers its setter with while rendering, so a
// test can "pick" a value on a server-rendered builder. Never provided in the app.
export type ParamProbe = { register: (param: string, set: (value: never) => void) => void };
export const ParamProbeContext = createContext<ParamProbe | null>(null);

export function StepParams({ missing, children }: { missing: readonly string[]; children: ReactNode }) {
  return <MissingParamsContext.Provider value={new Set(missing)}>{children}</MissingParamsContext.Provider>;
}

export function ParamSlot({ param, children }: { param: string; children: ReactNode }) {
  const missing = useContext(MissingParamsContext).has(param);
  return (
    <ParamKeyContext.Provider value={param}>
      <span data-param={param} data-param-missing={missing || undefined} className="contents">
        {children}
      </span>
    </ParamKeyContext.Provider>
  );
}

// Inside a slot, for a helper control that isn't the setting's editor (the "{ }" placeholder picker
// next to a text box): it neither highlights nor registers.
export function NotAParam({ children }: { children: ReactNode }) {
  return <ParamKeyContext.Provider value={null}>{children}</ParamKeyContext.Provider>;
}

// For an editor: is the setting it edits still missing (highlight it), and register its setter with a
// test probe. Outside a slot: not missing, nothing registered.
export function useParamSlot<T>(set: (value: T) => void): { param: string | null; missing: boolean } {
  const param = useContext(ParamKeyContext);
  const missing = useContext(MissingParamsContext);
  const probe = useContext(ParamProbeContext);
  if (probe && param) probe.register(param, set as (value: never) => void);
  return { param, missing: param !== null && missing.has(param) };
}

// The step's inline prompt: what it still needs, next to it.
export function StepPrompt({ problems, id }: { problems: readonly string[]; id?: string }) {
  if (problems.length === 0) return null;
  return (
    <span id={id} role="note" data-step-prompt className="inline-flex items-center gap-1 text-xs font-medium text-amber-800">
      <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
      {problems.join(" · ")}
    </span>
  );
}
