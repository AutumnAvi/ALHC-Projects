"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectTask, ProjectTaskGroupPage } from "@alhc/core/api/tasks/model";
import { encodeConfig, parsePageLimits, ROW_PAGE, type ViewConfig } from "@alhc/core/views";
import { useNotify } from "@/components/toast";

// Nov 12 notes (batch 40, item 4): List and Board's "Show more" asks for that group's next page only
// (GET /api/projects/<id>/task-page) and adds it under the rows already drawn — the rows already there keep
// their place and their DOM — instead of re-rendering the whole view with a bigger page. The count still
// goes into ?n= (history.replaceState: no server render), so a reload or Back shows the same depth, and a
// later server render with that ?n= simply holds those rows (they're never drawn twice).

type Appended = { total: number; nextId: string | null; nextSortOrder: number | null; tasks: ProjectTask[] };

export function mergePagedGroups(
  tasks: ProjectTask[],
  taskPage: ProjectTaskGroupPage[] | null,
  appended: ReadonlyMap<string, Appended>,
): { tasks: ProjectTask[]; taskPage: ProjectTaskGroupPage[] | null } {
  if (!taskPage || appended.size === 0) return { tasks, taskPage };
  const known = new Set(tasks.map((t) => t.id));
  const added: ProjectTask[] = [];
  const pages = taskPage.map((page) => {
    const more = appended.get(page.key);
    if (!more) return page;
    const inPage = new Set(page.tasks.map((t) => t.id));
    const extra = more.tasks.filter((t) => !inPage.has(t.id));
    if (extra.length === 0) return page;
    for (const task of extra) {
      if (known.has(task.id)) continue;
      known.add(task.id);
      added.push(task);
    }
    return { ...page, tasks: [...page.tasks, ...extra], total: more.total, nextId: more.nextId, nextSortOrder: more.nextSortOrder };
  });
  return { tasks: added.length ? [...tasks, ...added] : tasks, taskPage: pages };
}

export function usePagedGroups(
  projectId: string,
  config: ViewConfig,
  tasks: ProjectTask[],
  taskPage: ProjectTaskGroupPage[] | null,
) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const notify = useNotify();
  const [appended, setAppended] = useState<ReadonlyMap<string, Appended>>(new Map());
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const configKey = encodeConfig(config);
  // A new server copy of the page (a refresh, another filter): rows it already holds aren't added again
  // (mergePagedGroups), and a different view starts over.
  const seenConfig = useRef(configKey);
  useEffect(() => {
    if (seenConfig.current === configKey) return;
    seenConfig.current = configKey;
    setAppended(new Map());
  }, [configKey]);

  const merged = useMemo(() => mergePagedGroups(tasks, taskPage, appended), [tasks, taskPage, appended]);

  const show = (key: string, shown: number) => {
    if (loadingKey) return;
    setLoadingKey(key);
    const params = new URLSearchParams({ c: configKey, key, after: String(shown) });
    void fetch(`/api/projects/${projectId}/task-page?${params.toString()}`, { headers: { Accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as { group: ProjectTaskGroupPage | null };
        const group = body.group;
        if (!group || seenConfig.current !== configKey) return;
        setAppended((current) => {
          const next = new Map(current);
          const before = current.get(key);
          const have = new Set(before?.tasks.map((t) => t.id) ?? []);
          next.set(key, {
            total: group.total,
            nextId: group.nextId,
            nextSortOrder: group.nextSortOrder,
            tasks: [...(before?.tasks ?? []), ...group.tasks.filter((t) => !have.has(t.id))],
          });
          return next;
        });
        // The depth in the address (as before), without a server render.
        const limits = parsePageLimits(searchParams.get("n"));
        limits[key] = shown + ROW_PAGE;
        const query = new URLSearchParams(searchParams.toString());
        query.set("n", JSON.stringify(limits));
        window.history.replaceState(window.history.state, "", `${pathname}?${query.toString()}`);
      })
      .catch(() => notify("Couldn’t load more tasks. Check your connection and try again."))
      .finally(() => setLoadingKey(null));
  };

  return { tasks: merged.tasks, taskPage: merged.taskPage, show, loadingKey };
}
