"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Lock } from "lucide-react";
import { loadTaskBlockers, type TaskBlocker } from "@/lib/actions";
import { bareTaskTitle } from "@/lib/request-numbers";
import { TaskLink } from "./task-link";
import { TaskNumberBadge } from "./task-number";

// Oct 27 notes (batch 6, item 43): a blocked task can't be completed, so its completion control is
// disabled and wears a lock; hovering, focusing, or tapping it lists the tasks it waits on — each a link
// that opens it — plus how many more the viewer can't open. The list loads the first time it opens.

type Loaded = { total: number; blockers: TaskBlocker[] };

const cache = new Map<string, Loaded>();

export function BlockersHover({
  taskId,
  count,
  children,
  className = "",
}: {
  taskId: string;
  // The count the row already knows (for the label before the list loads).
  count: number;
  children: ReactNode;
  className?: string;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(() => cache.get(taskId) ?? null);
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();

  const clearTimers = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (openTimer.current) clearTimeout(openTimer.current);
    closeTimer.current = null;
    openTimer.current = null;
  };

  const show = useCallback(() => {
    clearTimers();
    setOpen(true);
  }, []);

  const hide = useCallback(() => {
    clearTimers();
    setOpen(false);
    setPinned(false);
  }, []);

  // Load once per task (and again after a refresh of the page drops the cache entry's age).
  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    loadTaskBlockers(taskId).then((result) => {
      if (cancelled) return;
      if (result.error || !result.data) {
        setError(result.error ?? "Couldn’t load the blocking tasks");
        return;
      }
      cache.set(taskId, result.data);
      setLoaded(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [open, loaded, taskId]);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const width = 288;
    const left = Math.min(Math.max(8, rect.left - 8), window.innerWidth - width - 8);
    const below = rect.bottom + 6;
    setPosition({ top: below, left });
  }, [open]);

  // Keep it on screen once drawn (flip above when it would run off the bottom).
  useLayoutEffect(() => {
    if (!open || !position || !panelRef.current || !anchorRef.current) return;
    const panel = panelRef.current.getBoundingClientRect();
    if (panel.bottom > window.innerHeight - 8) {
      const rect = anchorRef.current.getBoundingClientRect();
      const top = Math.max(8, rect.top - panel.height - 6);
      if (top !== position.top) setPosition({ ...position, top });
    }
  }, [open, position, loaded]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        hide();
        anchorRef.current?.querySelector<HTMLElement>("button, [tabindex]")?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (anchorRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      hide();
    };
    const onScroll = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      hide();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", hide);
    };
  }, [open, hide]);

  useEffect(() => clearTimers, []);

  const leave = () => {
    if (pinned) return;
    if (openTimer.current) clearTimeout(openTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 180);
  };

  const total = loaded?.total ?? count;
  const hidden = loaded ? Math.max(0, loaded.total - loaded.blockers.length) : 0;

  return (
    <span
      ref={anchorRef}
      className={`inline-flex shrink-0 ${className}`}
      aria-describedby={open ? panelId : undefined}
      onPointerEnter={(e) => {
        if (e.pointerType === "touch") return;
        if (closeTimer.current) clearTimeout(closeTimer.current);
        openTimer.current = setTimeout(show, 120);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "touch") return;
        leave();
      }}
      onFocus={show}
      onBlur={(e) => {
        if (panelRef.current?.contains(e.relatedTarget as Node)) return;
        leave();
      }}
      onClick={(e) => {
        // A tap (or click) pins it open; links inside still work.
        e.stopPropagation();
        if (open && pinned) hide();
        else {
          setPinned(true);
          show();
        }
      }}
    >
      {children}
      {open && position && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              role="dialog"
              aria-label={`Blocked by ${total} ${total === 1 ? "task" : "tasks"}`}
              data-blockers-popover=""
              onPointerEnter={() => {
                if (closeTimer.current) clearTimeout(closeTimer.current);
              }}
              onPointerLeave={leave}
              onClick={(e) => e.stopPropagation()}
              style={{ position: "fixed", top: position.top, left: position.left }}
              className="z-[70] w-72 rounded-lg border border-zinc-200 bg-white p-2 text-left shadow-lg"
            >
              <p className="flex items-center gap-1.5 px-1.5 pb-1 text-xs font-semibold text-zinc-700">
                <Lock className="size-3.5 text-amber-600" aria-hidden />
                Blocked by {total} {total === 1 ? "task" : "tasks"}
              </p>
              <p className="px-1.5 pb-1.5 text-2xs text-zinc-500">It can be completed once {total === 1 ? "it is" : "they are"} done.</p>
              {error ? <p className="px-1.5 py-1 text-xs text-red-600">{error}</p> : null}
              {!loaded && !error ? (
                <ul aria-busy="true" className="space-y-1 px-1.5 py-1">
                  {Array.from({ length: Math.min(Math.max(count, 1), 3) }).map((_, i) => (
                    <li key={i} className="skeleton h-4 w-full" />
                  ))}
                </ul>
              ) : null}
              {loaded ? (
                <ul className="max-h-64 overflow-y-auto">
                  {loaded.blockers.map((b) => (
                    <li key={b.id}>
                      <TaskLink
                        taskId={b.id}
                        onClick={() => hide()}
                        className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-sm text-zinc-800 hover:bg-zinc-100 focus-visible:bg-zinc-100"
                      >
                        <span className="min-w-0 flex-1 truncate">{bareTaskTitle(b.title, b.label)}</span>
                        <TaskNumberBadge label={b.label} projectName={b.projectName} />
                      </TaskLink>
                    </li>
                  ))}
                  {hidden > 0 ? (
                    <li className="px-1.5 py-1 text-xs text-zinc-500">
                      and {hidden} {hidden === 1 ? "task" : "tasks"} you can’t open
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

// The locked completion control of a List / Board / My tasks / subtask row: disabled, with a lock, and the
// blocker list on hover, focus, or tap.
export function BlockedToggle({
  taskId,
  title,
  count,
  size = "md",
}: {
  taskId: string;
  title: string;
  count: number;
  size?: "sm" | "md";
}) {
  const dimensions = size === "sm" ? "size-4" : "size-[18px]";
  return (
    <BlockersHover taskId={taskId} count={count}>
      <button
        type="button"
        aria-disabled="true"
        data-blocked-toggle=""
        aria-label={`“${title}” is blocked by ${count} ${count === 1 ? "task" : "tasks"} and can’t be completed yet. Show ${count === 1 ? "it" : "them"}`}
        className={`${dimensions} inline-flex shrink-0 cursor-help items-center justify-center rounded-full border border-amber-300 bg-amber-50 text-amber-700`}
      >
        <Lock className="size-[60%]" strokeWidth={2.5} aria-hidden />
      </button>
    </BlockersHover>
  );
}
