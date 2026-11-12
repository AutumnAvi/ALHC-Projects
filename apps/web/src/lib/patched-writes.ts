"use client";

// Nov 12 notes (batch 40, item 1): the browser side of @alhc/core/patched-writes. Screens that show the
// person's own changes by themselves say so (useScreenPatches); a save of that kind then runs without the
// action's refresh (patchedAction → the action's `screenOnly`), so the router keeps recently visited
// pages. Everything else refreshes as before.
import { useEffect } from "react";
import { screensPatch, type PatchedWriteKind } from "@alhc/core/patched-writes";
import { topicIsLive } from "@/lib/live";
import { currentMutationToken, markWriteWithoutRefresh } from "@/lib/optimistic-session";

type Declaration = { kinds: readonly PatchedWriteKind[]; topic: string | null };

const declarations = new Set<Declaration>();
const writeListeners = new Set<(at: number) => void>();

// Mounted by a screen (a project view, My tasks): `kinds` it shows correctly without the server's render,
// while `topic` (its live channel) is connected. null: it patches nothing (the page refreshes).
export function useScreenPatches(kinds: readonly PatchedWriteKind[] | null, topic: string | null) {
  const key = kinds ? kinds.join(",") : "";
  useEffect(() => {
    const declaration: Declaration = { kinds: key ? (key.split(",") as PatchedWriteKind[]) : [], topic };
    declarations.add(declaration);
    return () => {
      declarations.delete(declaration);
    };
  }, [key, topic]);
}

// Whether a save of this kind can skip the refresh right now.
export function screenPatches(kind: PatchedWriteKind): boolean {
  const list = [...declarations];
  if (!screensPatch(list.map((d) => d.kinds), kind)) return false;
  return list.every((d) => d.topic === null || topicIsLive(d.topic));
}

// Saves made without a refresh (route-freshness.ts renders a page drawn from the router's cache again
// when one happened after it was drawn).
export function onWriteWithoutRefresh(listener: (at: number) => void): () => void {
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
}

// Wraps a server action that takes a trailing `screenOnly` flag. Decided when the save starts. `refresh`:
// this save always refreshes (a subtask — its parent's x/y count is the server's —, a repeating task —
// its next occurrence is a new row).
export function patchedAction<R extends { error?: string } | void>(
  kind: PatchedWriteKind,
  call: (screenOnly: boolean) => Promise<R>,
  options: { refresh?: boolean } = {},
): () => Promise<R> {
  return async () => {
    const screenOnly = !options.refresh && screenPatches(kind);
    const token = currentMutationToken();
    if (screenOnly) markWriteWithoutRefresh(token);
    const result = await call(screenOnly);
    if (screenOnly && !(result && result.error)) {
      const at = Date.now();
      for (const listener of writeListeners) listener(at);
    }
    return result;
  };
}

export function resetPatchedWritesForTests() {
  declarations.clear();
  writeListeners.clear();
}
