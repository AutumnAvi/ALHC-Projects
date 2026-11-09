// A stand-in Supabase client for layer tests (the same shape as api-layer.test.ts's): every builder method
// chains, and awaiting the chain answers with what `answer` returns for the recorded call.
import type { Db } from "@alhc/core/api/core/context";

export type Call = { target: string; steps: Array<[string, unknown[]]> };
export type Answer = { data: unknown; error: { code?: string; message: string; hint?: string | null } | null; count?: number };

export function fakeDb(answer: (call: Call) => Answer): { db: Db; calls: Call[] } {
  const calls: Call[] = [];
  const chain = (call: Call): unknown =>
    new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "then") {
            const result = answer(call);
            return (resolve: (value: Answer) => unknown) => resolve(result);
          }
          return (...args: unknown[]) => {
            call.steps.push([String(prop), args]);
            return chain(call);
          };
        },
      },
    );
  const start = (target: string) => {
    const call: Call = { target, steps: [] };
    calls.push(call);
    return call;
  };
  const db = {
    from: (table: string) => chain(start(`table:${table}`)),
    rpc: (fn: string, args?: unknown) => {
      const call = start(`rpc:${fn}`);
      call.steps.push(["args", [args]]);
      return chain(call);
    },
  };
  return { db: db as unknown as Db, calls };
}

export const step = (call: Call, name: string) => call.steps.find(([s]) => s === name)?.[1];
export const hasStep = (call: Call, name: string) => call.steps.some(([s]) => s === name);
