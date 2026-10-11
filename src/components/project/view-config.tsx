"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useContext, useMemo, useOptimistic, useTransition, type ReactNode } from "react";
import { encodeConfig, sameConfig, type ViewConfig } from "@/lib/views";

// The view's config as the page shows it, shared by the toolbar and the List's column header menus
// (sort, hide, move): one optimistic draft that lives in ?f= until it's saved to the view or reset.
type ViewConfigState = {
  // What the page shows (optimistic while the URL changes).
  current: ViewConfig;
  // The saved view's config (or the layout's default).
  base: ViewConfig;
  isDraft: boolean;
  apply: (next: ViewConfig) => void;
  // The page URL for a config (null = the saved view, ?f= dropped).
  urlFor: (next: ViewConfig | null) => string;
};

const ViewConfigContext = createContext<ViewConfigState | null>(null);

export function ViewConfigProvider({
  baseConfig,
  config,
  children,
}: {
  baseConfig: ViewConfig;
  config: ViewConfig;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const [current, setCurrent] = useOptimistic(config);

  const value = useMemo<ViewConfigState>(() => {
    const urlFor = (next: ViewConfig | null) => {
      const params = new URLSearchParams(searchParams.toString());
      // ?sub=1 (older links) is folded into the config as show_subtasks.
      params.delete("sub");
      if (next === null || sameConfig(next, baseConfig)) params.delete("f");
      else params.set("f", encodeConfig(next));
      const query = params.toString();
      return query ? `${pathname}?${query}` : pathname;
    };
    return {
      current,
      base: baseConfig,
      isDraft: !sameConfig(current, baseConfig),
      urlFor,
      apply: (next) =>
        startTransition(() => {
          setCurrent(next);
          router.replace(urlFor(next), { scroll: false });
        }),
    };
  }, [current, baseConfig, searchParams, pathname, router, setCurrent]);

  return <ViewConfigContext.Provider value={value}>{children}</ViewConfigContext.Provider>;
}

// Null outside a project view page (components fall back to their own config prop).
export function useViewConfig(): ViewConfigState | null {
  return useContext(ViewConfigContext);
}
