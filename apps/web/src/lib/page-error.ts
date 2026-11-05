// Nov 3 notes (batch 19): the app's error boundary tries a failed page once more on its own, but never in a
// loop — at most once per error (its digest) every AUTO_RETRY_WINDOW_MS in this tab.
export const AUTO_RETRY_WINDOW_MS = 60_000;
const KEY = "alhc.page-error.retried";

type Store = Pick<Storage, "getItem" | "setItem">;

function read(store: Store): Record<string, number> {
  try {
    const value = JSON.parse(store.getItem(KEY) ?? "{}") as unknown;
    return value && typeof value === "object" ? (value as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function canAutoRetry(digest: string | undefined, store: Store | null, now: number): boolean {
  if (!store) return false;
  const last = read(store)[digest ?? "client"];
  return !(typeof last === "number" && now - last < AUTO_RETRY_WINDOW_MS);
}

export function markAutoRetried(digest: string | undefined, store: Store | null, now: number): void {
  if (!store) return;
  const kept = Object.fromEntries(Object.entries(read(store)).filter(([, at]) => now - at < AUTO_RETRY_WINDOW_MS));
  try {
    store.setItem(KEY, JSON.stringify({ ...kept, [digest ?? "client"]: now }));
  } catch {
    // Storage full or off: the Try again button still works.
  }
}
