"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CheckCircle2, Circle, Clock, Loader2, Lock, Search, SearchX } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { readRecents, recordRecent, useShell } from "@/components/shell/shell-context";
import { isMac } from "@/components/shortcuts/keyboard";
import { projectColorClass } from "@/lib/project-colors";
import { quickSearch, resolveRecents } from "@/lib/shell-actions";
import {
  EMPTY_RESULTS,
  SEARCH_KINDS,
  quickPersonHref,
  quickProjectHref,
  type QuickPerson,
  type QuickProject,
  type QuickResults,
  type QuickTask,
  type RecentItem,
  type SearchKind,
} from "@/lib/shell";

// Other parts of the app (the "/" shortcut) open the palette with this event.
export const OPEN_SEARCH_EVENT = "alhc:open-search";

const noopSubscribe = () => () => undefined;

// Search in the top bar (Asana parity, batch 1): a centered pill ("Search ALHC", ⌘/Ctrl+K or "/") that
// opens a command palette — centered near the top of the window over a dimmed page (since batch 3; it
// no longer covers the pill) — with Tasks / Projects / People chips, Recents, and results that update
// as you type. Results come from the server with the person's own session, so they only ever include
// what that person can open.
export function SearchPalette() {
  const pathname = usePathname();
  const { workspace } = useShell();
  // Open only on the page it was opened from, so following a result closes it.
  const [openState, setOpenState] = useState<{ pathname: string } | null>(null);
  const open = openState?.pathname === pathname;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const mod = useSyncExternalStore(noopSubscribe, () => (isMac() ? "⌘" : "Ctrl"), () => "Ctrl");

  useEffect(() => {
    const openHere = () => setOpenState({ pathname: window.location.pathname });
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        // Not over a modal (a Create dialog, Settings, the drawer): the palette would open underneath it.
        if (document.querySelector("[aria-modal='true']")) return;
        e.preventDefault();
        setOpenState((current) => (current?.pathname === window.location.pathname ? null : { pathname: window.location.pathname }));
      }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_SEARCH_EVENT, openHere);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_SEARCH_EVENT, openHere);
    };
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpenState({ pathname })}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-keyshortcuts="Meta+K Control+K /"
        className="flex h-7 w-full max-w-xl items-center gap-2 rounded-full bg-white/10 px-3 text-sm text-shell-text hover:bg-white/15 max-sm:size-8 max-sm:justify-center max-sm:px-0"
      >
        <Search className="size-4 shrink-0 text-shell-muted" aria-hidden />
        <span className="truncate max-sm:sr-only">Search {workspace.name}</span>
        <kbd className="ml-auto hidden shrink-0 rounded border border-white/15 px-1.5 font-sans text-2xs text-shell-muted sm:inline">
          {mod} K
        </kbd>
      </button>
      {open && openState ? (
        <Palette
          onClose={(refocus) => {
            setOpenState(null);
            if (refocus) triggerRef.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}

type Item = {
  key: string;
  href: string;
  render: () => React.ReactNode;
  recent?: { kind: "task" | "project"; id: string };
};
type Group = { heading: string; items: Item[] };

function Palette({ onClose }: { onClose: (refocus: boolean) => void }) {
  const router = useRouter();
  const { member } = useShell();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<SearchKind | null>(null);
  const [results, setResults] = useState<{ key: string; data: QuickResults } | null>(null);
  const [recents, setRecents] = useState<RecentItem[] | null>(null);
  const [active, setActive] = useState(0);
  const requestRef = useRef(0);

  const trimmed = query.trim();
  const searchKey = `${kind ?? "all"}:${trimmed}`;
  const loading = trimmed !== "" && results?.key !== searchKey;

  useEffect(() => {
    inputRef.current?.focus();
    let live = true;
    resolveRecents(readRecents(member.id))
      .then((items) => live && setRecents(items))
      .catch(() => live && setRecents([]));
    return () => {
      live = false;
    };
  }, [member.id]);

  useEffect(() => {
    if (!trimmed) return;
    const request = ++requestRef.current;
    const timer = window.setTimeout(() => {
      quickSearch(trimmed, kind)
        .then((data) => {
          if (request === requestRef.current) setResults({ key: searchKey, data });
        })
        .catch(() => {
          if (request === requestRef.current) setResults({ key: searchKey, data: EMPTY_RESULTS });
        });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [trimmed, kind, searchKey]);

  const groups: Group[] = [];
  if (!trimmed) {
    const shown = (recents ?? []).filter(
      (r) => !kind || (kind === "tasks" && r.kind === "task") || (kind === "projects" && r.kind === "project"),
    );
    if (shown.length) {
      groups.push({
        heading: "Recents",
        items: shown.slice(0, 8).map((r) => (r.kind === "task" ? taskItem(r, true) : projectItem(r, true))),
      });
    }
  } else if (results?.key === searchKey) {
    const { tasks, projects, people } = results.data;
    if (tasks.length) groups.push({ heading: "Tasks", items: tasks.map((t) => taskItem(t, false)) });
    if (projects.length) groups.push({ heading: "Projects", items: projects.map((p) => projectItem(p, false)) });
    if (people.length) groups.push({ heading: "People", items: people.map(personItem) });
  }
  const items = groups.flatMap((g) => g.items);
  const activeIndex = items.length ? Math.min(active, items.length - 1) : -1;
  const optionId = (index: number) => `${listId}-option-${index}`;

  function go(item: Item) {
    if (item.recent) recordRecent(member.id, item.recent);
    onClose(false);
    router.push(item.href);
  }

  function seeAll() {
    onClose(false);
    router.push(`/search?${new URLSearchParams({ q: trimmed }).toString()}`);
  }

  function onInputKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next = (Math.max(activeIndex, 0) + step + items.length) % items.length;
      setActive(next);
      document.getElementById(optionId(next))?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0) go(items[activeIndex]);
      else if (trimmed && (!kind || kind === "tasks")) seeAll();
    }
  }

  let index = -1;
  return (
    <div className="fixed inset-0 z-50 bg-zinc-900/40 print:hidden" onMouseDown={() => onClose(false)}>
      <div
        role="dialog"
        aria-label="Search"
        // Focusable, so clicking inside keeps focus here and Esc reaches this handler. Esc stops here: it
        // closes only the palette, never the task pane or a dialog underneath.
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose(true);
          }
        }}
        onMouseDown={(e) => e.stopPropagation()}
        // Like a command palette: centered, below the top bar (never over the search pill).
        className="absolute left-1/2 top-[max(4.5rem,12vh)] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-zinc-200 bg-white text-sm shadow-2xl shadow-zinc-900/30 outline-none"
      >
        <div className="flex h-11 items-center gap-2 border-b border-zinc-100 px-3">
          <Search className="size-4 shrink-0 text-zinc-400" aria-hidden />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            aria-label="Search tasks, projects, and people"
            value={query}
            onChange={(e) => {
              setQuery(e.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={onInputKey}
            placeholder="Search tasks, projects, and people"
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-zinc-900 shadow-none outline-none placeholder:text-zinc-400 focus-visible:shadow-none"
          />
          {loading ? <Loader2 className="size-4 shrink-0 animate-spin text-zinc-400" aria-label="Searching" /> : null}
          <kbd className="hidden shrink-0 rounded border border-zinc-200 px-1.5 font-sans text-2xs text-zinc-500 sm:inline">Esc</kbd>
        </div>
        <div role="group" aria-label="Only show" className="flex flex-wrap gap-1.5 border-b border-zinc-100 px-3 py-2">
          {SEARCH_KINDS.map((k) => (
            <button
              key={k.key}
              type="button"
              aria-pressed={kind === k.key}
              onClick={() => {
                setKind(kind === k.key ? null : k.key);
                setActive(0);
                inputRef.current?.focus();
              }}
              className="h-6 rounded-full border border-zinc-200 px-2.5 text-xs text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 aria-pressed:border-accent-500 aria-pressed:bg-accent-50 aria-pressed:text-accent-700"
            >
              {k.label}
            </button>
          ))}
        </div>
        <div className="max-h-[min(60vh,28rem)] overflow-y-auto py-1">
          <div id={listId} role="listbox" aria-label="Results">
            {groups.map((group) => (
              <div key={group.heading} role="group" aria-label={group.heading}>
                <div aria-hidden className="px-3 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wider text-zinc-400">
                  {group.heading}
                </div>
                {group.items.map((item) => {
                  index += 1;
                  const i = index;
                  return (
                    <div
                      key={item.key}
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === activeIndex}
                      onMouseMove={() => i !== activeIndex && setActive(i)}
                      onClick={() => go(item)}
                      className="mx-1 flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 aria-selected:bg-zinc-100"
                    >
                      {item.render()}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {groups.length === 0 ? (
            <EmptyHint query={trimmed} loading={loading || (!trimmed && recents === null)} kind={kind} />
          ) : null}
        </div>
        {trimmed && (!kind || kind === "tasks") ? (
          <button
            type="button"
            onClick={seeAll}
            className="flex w-full items-center gap-2 border-t border-zinc-100 px-3 py-2 text-left text-xs text-zinc-600 hover:bg-zinc-50"
          >
            <Search className="size-3.5 text-zinc-400" aria-hidden />
            See all task results for “{trimmed}”
          </button>
        ) : null}
      </div>
    </div>
  );
}

function EmptyHint({ query, loading, kind }: { query: string; loading: boolean; kind: SearchKind | null }) {
  if (loading) return <p className="px-3 py-4 text-sm text-zinc-500">Searching…</p>;
  if (query) {
    return (
      <div className="flex items-center gap-2 px-3 py-4 text-sm text-zinc-500">
        <SearchX className="size-4 shrink-0" aria-hidden />
        No {kind ?? "results"} match “{query}”. Only projects you’re a member of and your own private tasks are searched.
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 px-3 py-4 text-sm text-zinc-500">
      <Clock className="size-4 shrink-0" aria-hidden />
      {kind === "people" ? "Type a name or email address." : "Tasks and projects you open show up here. Start typing to search."}
    </div>
  );
}

function taskItem(task: QuickTask, recent: boolean): Item {
  const Icon = task.completed ? CheckCircle2 : Circle;
  return {
    key: `task-${task.id}`,
    href: task.href,
    recent: { kind: "task", id: task.id },
    render: () => (
      <>
        <Icon
          className={`size-4 shrink-0 ${task.completed ? "text-green-600" : "text-zinc-300"}`}
          aria-label={task.completed ? "Completed" : "Open"}
        />
        <span className={`min-w-0 flex-1 truncate ${task.completed ? "text-zinc-400 line-through" : "text-zinc-900"}`}>
          {task.title}
        </span>
        <span className="flex max-w-[45%] shrink-0 items-center gap-1 truncate text-xs text-zinc-500">
          {task.projectId ? (
            <>
              <span aria-hidden className={`size-2 shrink-0 rounded-[2px] ${projectColorClass(task.projectId)}`} />
              <span className="truncate">{task.projectName}</span>
            </>
          ) : task.isPrivate ? (
            <>
              <Lock className="size-3 shrink-0" aria-hidden />
              Private
            </>
          ) : null}
          {recent ? <span className="sr-only">, recently opened</span> : null}
        </span>
      </>
    ),
  };
}

function projectItem(project: QuickProject, recent: boolean): Item {
  return {
    key: `project-${project.id}`,
    href: quickProjectHref(project),
    recent: { kind: "project", id: project.id },
    render: () => (
      <>
        <span aria-hidden className={`ml-0.5 size-3.5 shrink-0 rounded-[4px] ${projectColorClass(project.id)}`} />
        <span className="min-w-0 flex-1 truncate text-zinc-900">{project.name}</span>
        <span className="shrink-0 text-xs text-zinc-500">
          {project.archived ? "Archived project" : "Project"}
          {recent ? <span className="sr-only">, recently opened</span> : null}
        </span>
      </>
    ),
  };
}

function personItem(person: QuickPerson): Item {
  return {
    key: `person-${person.id}`,
    href: quickPersonHref(person),
    render: () => (
      <>
        <Avatar name={person.name} />
        <span className="min-w-0 flex-1 truncate text-zinc-900">{person.name}</span>
        <span className="max-w-[45%] shrink-0 truncate text-xs text-zinc-500">{person.email}</span>
      </>
    ),
  };
}
