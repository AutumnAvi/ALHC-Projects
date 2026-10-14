// In-flight writes. Realtime refreshes wait until they finish (one trailing refresh if events
// arrived during the write), and a failed write drops the optimistic rows tagged with its token.

let nextToken = 0;
let activeToken = 0;
let version = 0;
const open = new Set<number>();
const failed = new Set<number>();
const dropped = new Set<string>();
const listeners = new Set<() => void>();
let dirty = false;
let onQuiet: (() => void) | null = null;

const dropKey = (token: number, taskId: string) => `${token}:${taskId}`;

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

export function setMutationQuietHandler(handler: (() => void) | null) {
  onQuiet = handler;
}

export function beginLocalMutation(): number {
  const token = ++nextToken;
  open.add(token);
  activeToken = token;
  return token;
}

export function currentMutationToken(): number {
  return activeToken;
}

// True while a write is in flight: the caller should not refresh yet.
export function noteMutationTraffic(): boolean {
  if (open.size === 0) return false;
  dirty = true;
  return true;
}

export function endLocalMutation(token: number) {
  if (!open.delete(token)) return;
  if (activeToken === token) activeToken = 0;
  if (open.size === 0 && dirty) {
    dirty = false;
    onQuiet?.();
  }
}

export function failMutation(token: number) {
  if (token === 0 || failed.has(token)) return;
  failed.add(token);
  if (failed.size > 80) {
    const oldest = failed.values().next().value;
    if (oldest !== undefined) failed.delete(oldest);
  }
  emit();
}

// A bulk write applied some tasks and skipped others: drop only the skipped ones.
export function dropTokenTasks(token: number, taskIds: string[]) {
  if (token === 0 || taskIds.length === 0) return;
  for (const taskId of taskIds) dropped.add(dropKey(token, taskId));
  if (dropped.size > 400) {
    const oldest = dropped.values().next().value;
    if (oldest !== undefined) dropped.delete(oldest);
  }
  emit();
}

export function mutationFailed(token: number) {
  return token !== 0 && failed.has(token);
}

export function tokenTaskDropped(token: number, taskId: string) {
  return dropped.has(dropKey(token, taskId));
}

export function subscribeMutationFailures(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function mutationFailureVersion() {
  return version;
}

// A date-shift / dialog that outlives a single transition. `cancel` drops its optimistic rows.
export function holdTaskChanges(): { ok: () => void; cancel: () => void } {
  const token = beginLocalMutation();
  let settled = false;
  const settle = (failedWrite: boolean) => {
    if (settled) return;
    settled = true;
    if (failedWrite) failMutation(token);
    endLocalMutation(token);
  };
  return { ok: () => settle(false), cancel: () => settle(true) };
}
