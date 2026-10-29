"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { projectColorClass } from "@/lib/project-colors";
import {
  formatRequestLabel,
  moreTaskNumbers,
  numberChips,
  type MoreNumbers,
  type RequestLabel,
  type TaskNumber,
} from "@/lib/request-numbers";

// A task's number, the one component for it (Oct 26 notes, batch 4; Oct 29 notes, 55b).
//
// TaskNumberBadge: the number as a small muted badge next to the name — on Timeline rows, Calendar bars,
// the dependency picker, and search — with the project's name when the task comes from another project
// than the one on screen ("Task #12 · Website"). Nothing when the task has no number.
//
// Since Oct 29 notes (55b) a task in several projects has a number in each one that numbers it. Tight
// spots outside a project (My tasks, Home, search, the palette, the Inbox, the team Calendar) pass every
// number (`numbers`, in the stable order) and show the first one plus "+N"; the full list is a hover / focus
// / tap away (MoreTaskNumbers). The pane shows them all as chips (TaskNumberChips).

export function TaskNumberBadge({
  label,
  numbers = null,
  more = "inline",
  projectName = null,
  size = "xs",
  tone = "muted",
  className = "",
}: {
  // The number to show. Defaults to the first of `numbers`.
  label?: RequestLabel | null;
  // Every number the viewer can read, in the stable order: more than one adds "+N".
  numbers?: TaskNumber[] | null;
  // How "+N" opens its list (see MoreTaskNumbers): "inline" inside a link or a list option, "button" elsewhere.
  more?: MoreMode;
  // Only when the task is from a different project than the screen's.
  projectName?: string | null;
  // "2xs" = calendar bars: tiny, so the task's name keeps the room.
  size?: "xs" | "2xs";
  // "inherit" = the surrounding text color, a little lighter (inside a colored bar).
  tone?: "muted" | "inherit";
  className?: string;
}) {
  const text = formatRequestLabel(label ?? numbers?.[0]?.label ?? null);
  const rest = text ? moreTaskNumbers(numbers) : null;
  if (!text && !projectName) return null;
  return (
    <span
      className={`inline-flex min-w-0 shrink-0 items-center gap-1 whitespace-nowrap font-normal tabular-nums ${
        tone === "muted" ? "text-zinc-400" : "opacity-75"
      } ${
        size === "2xs" ? "text-[10px] leading-none" : "text-2xs"
      } ${className}`}
    >
      {text ? <span>{text}</span> : null}
      {rest ? <MoreNumbersPart more={rest} numbers={numbers ?? []} mode={more} size={size} /> : null}
      {text && projectName ? <span aria-hidden>·</span> : null}
      {projectName ? <span className="truncate">{projectName}</span> : null}
    </span>
  );
}

// "inline": inside a link or a list option, where nothing else may take focus. "+N" shows the list on
// hover; while the link has keyboard focus the other numbers are spelled out next to it; screen readers
// hear them all as part of the link. "inline-quiet": the same without spelling them out (a list option or
// a calendar bar, whose own tooltip carries the list). "button": a real button — hover, focus, or tap
// shows the list.
export type MoreMode = "inline" | "inline-quiet" | "button";

// The "+N" alone, for rows whose name already starts with the first number (My tasks, Home, the Inbox).
export function MoreTaskNumbers({
  numbers,
  mode = "button",
  size = "xs",
  className = "",
}: {
  numbers: TaskNumber[] | null | undefined;
  mode?: MoreMode;
  size?: "xs" | "2xs";
  className?: string;
}) {
  const more = moreTaskNumbers(numbers);
  if (!more) return null;
  return (
    <span className={`inline-flex shrink-0 items-center ${className}`}>
      <MoreNumbersPart more={more} numbers={numbers ?? []} mode={mode} size={size} />
    </span>
  );
}

function MoreNumbersPart({ more, numbers, mode, size }: { more: MoreNumbers; numbers: TaskNumber[]; mode: MoreMode; size: "xs" | "2xs" }) {
  if (mode === "button") return <MoreNumbersButton more={more} numbers={numbers} size={size} />;
  return (
    <>
      <span
        aria-hidden
        data-tooltip={more.list}
        data-more-numbers=""
        // Above a card's stretched-link overlay (the Inbox), so hovering it shows the list.
        className={`relative z-[1] rounded bg-zinc-100 px-1 font-medium text-zinc-500 ${size === "2xs" ? "py-px" : ""} ${
          mode === "inline" ? "in-focus-visible:hidden" : ""
        }`}
      >
        {more.text}
      </span>
      {mode === "inline" ? (
        <span aria-hidden className="hidden in-focus-visible:inline">
          · {more.others}
        </span>
      ) : null}
      <span className="sr-only">, also {more.spoken}</span>
    </>
  );
}

const CARD_WIDTH = 224;

// "+N" as a button: hovering or focusing it shows every number with its project; a click or tap pins the
// list open (another click, Escape, or a click elsewhere closes it). It never opens the task.
function MoreNumbersButton({ more, numbers, size }: { more: MoreNumbers; numbers: TaskNumber[]; size: "xs" | "2xs" }) {
  const ref = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const [anchor, setAnchor] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const [pinned, setPinned] = useState(false);
  const pinnedRef = useRef(false);
  useEffect(() => {
    pinnedRef.current = pinned;
  }, [pinned]);
  const cardId = useId();

  function show() {
    window.clearTimeout(hideTimer.current);
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const above = rect.bottom + 40 + numbers.length * 24 > window.innerHeight;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - CARD_WIDTH - 8));
    setAnchor({ left, top: above ? rect.top - 6 : rect.bottom + 6, above });
  }
  function hide(delay = 120) {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      setAnchor(null);
      setPinned(false);
    }, delay);
  }
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
  useEffect(() => {
    if (!anchor) return;
    const close = () => {
      setAnchor(null);
      setPinned(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Only this Escape when the list was opened on purpose (pinned, or the button has focus): a list
      // that's merely hovered closes without keeping Escape from the pane.
      if (pinnedRef.current || document.activeElement === ref.current) {
        e.preventDefault();
        e.stopPropagation();
      }
      close();
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || cardRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [anchor]);

  const open = Boolean(anchor);
  return (
    <>
      <button
        ref={ref}
        type="button"
        draggable={false}
        data-more-numbers=""
        aria-label={`${more.count} more ${more.count === 1 ? "number" : "numbers"}: ${more.spoken}`}
        aria-expanded={open}
        aria-describedby={open ? cardId : undefined}
        onPointerEnter={(e) => {
          if (e.pointerType !== "touch") show();
        }}
        onPointerLeave={(e) => {
          if (e.pointerType !== "touch" && !pinned) hide();
        }}
        onFocus={show}
        onBlur={() => hide()}
        onClick={(e) => {
          // Not the row's click: it would open the task.
          e.preventDefault();
          e.stopPropagation();
          if (open && pinned) {
            setAnchor(null);
            setPinned(false);
          } else {
            setPinned(true);
            show();
          }
        }}
        className={`shrink-0 rounded bg-zinc-100 px-1 font-medium tabular-nums text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800 focus-visible:outline-2 focus-visible:outline-accent-500 aria-expanded:bg-zinc-200 aria-expanded:text-zinc-800 ${
          size === "2xs" ? "text-[10px] leading-4" : "text-2xs leading-4"
        }`}
      >
        {more.text}
      </button>
      {anchor && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={cardRef}
              id={cardId}
              role="tooltip"
              data-numbers-card=""
              onPointerEnter={() => window.clearTimeout(hideTimer.current)}
              onPointerLeave={() => {
                if (!pinned) hide();
              }}
              style={{
                position: "fixed",
                left: anchor.left,
                top: anchor.top,
                width: CARD_WIDTH,
                transform: anchor.above ? "translateY(-100%)" : undefined,
              }}
              className="z-[70] rounded-lg border border-zinc-200 bg-white p-2 text-left shadow-lg"
            >
              <p className="px-1 pb-1 text-2xs font-semibold uppercase tracking-wider text-zinc-500">Numbers in its projects</p>
              <NumberList numbers={numbers} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

// Every number with its project's color and name, in the stable order.
function NumberList({ numbers }: { numbers: TaskNumber[] }) {
  return (
    <ul className="space-y-0.5">
      {numberChips(numbers).map((chip) => (
        <li key={chip.key} className="flex min-w-0 items-center gap-2 rounded px-1 py-0.5 text-xs">
          {chip.projectId ? (
            <span aria-hidden className={`size-2.5 shrink-0 rounded-[3px] ${projectColorClass(chip.projectId)}`} />
          ) : null}
          <span className="shrink-0 font-medium tabular-nums text-zinc-800">{chip.text}</span>
          {chip.projectName ? <span className="min-w-0 truncate text-zinc-500">{chip.projectName}</span> : null}
        </li>
      ))}
    </ul>
  );
}

// The pane's numbers (Oct 29 notes, 55b): one chip per project that numbers the task and the viewer can
// read, in the stable order, wrapping onto more lines for five or six projects ("Req #1 · Design #14"). The
// project on screen (inside a project's views) is the darker one; each chip names its project on hover.
export function TaskNumberChips({
  numbers,
  currentProjectId = null,
  className = "",
}: {
  numbers: TaskNumber[] | null | undefined;
  currentProjectId?: string | null;
  className?: string;
}) {
  const chips = numberChips(numbers, currentProjectId);
  if (chips.length === 0) return null;
  return (
    <ul aria-label={chips.length === 1 ? "Task number" : "Task numbers"} data-task-numbers="" className={`flex flex-wrap items-center gap-1 ${className}`}>
      {chips.map((chip) => (
        <li key={chip.key} className="min-w-0 max-w-full">
          <span
            data-tooltip={chip.projectName ?? undefined}
            data-current-number={chip.current ? "" : undefined}
            className={`inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded px-1.5 text-xs font-medium tabular-nums ${
              chip.current ? "bg-zinc-200 text-zinc-800" : "bg-zinc-100 text-zinc-500"
            }`}
          >
            {chip.projectId ? (
              <span aria-hidden className={`size-2 shrink-0 rounded-[2px] ${projectColorClass(chip.projectId)}`} />
            ) : null}
            <span aria-hidden className="truncate" data-task-number="">
              {chip.text}
            </span>
            <span className="sr-only">
              {chip.spoken}
              {chip.current ? " (this project)" : ""}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// Screen-reader / tooltip text for the same thing: "Task #12, in Website".
export function taskNumberText(label: RequestLabel | null | undefined, projectName: string | null = null): string {
  const text = formatRequestLabel(label);
  return [text, projectName ? `in ${projectName}` : ""].filter(Boolean).join(", ");
}
