import { hashKey, isServer, QueryObserver, type QueryKey, type QueryObserverOptions } from "@tanstack/query-core";
import { useCallback, useSyncExternalStore } from "react";
import { getQueryClient } from "@alhc/core/query/browser-client";

// Nov 4 notes, batch 28 (M4): read one entry of the client data cache and re-render when it changes. The
// component counts as showing it (an observer), so the size limits and the garbage collector leave it
// alone while it's on screen. It never fetches: the stores decide when to load (hover, open, a write
// ending). Works without the React provider (the tab's one cache), and reads nothing during the server
// render, like the stores it replaced.

// The entry's key, and optionally the rest of its query options (its queryFn, gcTime, …) so a refetch of
// the entry elsewhere has them.
export type EntryOptions = { queryKey: QueryKey } & Partial<Omit<QueryObserverOptions, "queryKey" | "enabled">>;

export function useCacheEntry<T>(options: EntryOptions | null): T | undefined {
  const hash = options ? hashKey(options.queryKey) : null;
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!options || isServer) return () => {};
      const observer = new QueryObserver(getQueryClient(), {
        ...(options as QueryObserverOptions),
        enabled: false,
        notifyOnChangeProps: ["data"],
      });
      return observer.subscribe(() => onChange());
    },
    // The key's hash is the identity; the rest of the options belong to it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hash],
  );
  const read = () => (options && !isServer ? getQueryClient().getQueryData<T>(options.queryKey) : undefined);
  return useSyncExternalStore(subscribe, read, () => undefined);
}
