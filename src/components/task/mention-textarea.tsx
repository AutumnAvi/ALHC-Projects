"use client";

import { useEffect, useId, useRef, useState, type TextareaHTMLAttributes } from "react";
import { FolderKanban, SquareCheck } from "lucide-react";
import { Avatar, displayName } from "@/components/avatar";
import { rememberLinkName } from "@/components/task/comment-parts";
import { extendsDeadQuery, linkSearchText, projectLinkUrl, taskLinkUrl } from "@/lib/app-links";
import type { Profile } from "@/lib/data";
import { mentionToken } from "@/lib/reactions";
import { formatRequestLabel } from "@/lib/request-numbers";
import type { QuickProject, QuickTask } from "@/lib/shell";

const MAX_PEOPLE = 6;

// "@" at the start or after whitespace, then up to two words, ending at the caret: people only.
const AT_TRIGGER = /(^|\s)@([^\s@]{0,40}(?: [^\s@]{0,40})?)$/;
// Nov 3 notes (batch 18, 133): "#" at the start or after whitespace finds tasks and projects. The query
// runs to the caret across spaces ("#Facility Launch Party") — never across a line break, and at most 60
// characters — so the list stays open while a multi-word name is typed and closes only on a pick, Esc,
// or once nothing matches.
const HASH_TRIGGER = /(^|\s)#((?:[^\s#][^\n#]{0,59})?)$/;

type Trigger = { kind: "@" | "#"; start: number; end: number; query: string };

function findTrigger(value: string, caret: number, people: boolean, links: boolean): Trigger | null {
  const before = value.slice(0, caret);
  const hash = links ? HASH_TRIGGER.exec(before) : null;
  const at = people ? AT_TRIGGER.exec(before) : null;
  // The marker nearest the caret wins ("#Launch with @ann" is a person search).
  const pick =
    hash && at
      ? before.length - at[2].length > before.length - hash[2].length
        ? { kind: "@" as const, m: at }
        : { kind: "#" as const, m: hash }
      : hash
        ? { kind: "#" as const, m: hash }
        : at
          ? { kind: "@" as const, m: at }
          : null;
  if (!pick) return null;
  const start = before.length - pick.m[2].length - 1;
  return { kind: pick.kind, start, end: caret, query: pick.m[2].toLowerCase() };
}

function matches(profile: Profile, query: string) {
  if (!query) return true;
  const name = (profile.full_name ?? "").toLowerCase();
  const email = profile.email.toLowerCase();
  return name.startsWith(query) || name.split(/\s+/).some((part) => part.startsWith(query)) || email.startsWith(query);
}

type Suggestion =
  | { kind: "person"; key: string; profile: Profile }
  | { kind: "task"; key: string; task: QuickTask }
  | { kind: "project"; key: string; project: QuickProject };

const GROUP_LABELS = { person: "People", task: "Tasks", project: "Projects" } as const;

type Found = { start: number; query: string; tasks: QuickTask[]; projects: QuickProject[] };

// A textarea with @mention autocomplete. Choosing a person inserts the token the comments trigger
// parses (`@Full Name`, else `@emaillocalpart`), so the mention notifies them through the usual inbox.
// candidates: people who can read the task (its projects' members), without the viewer.
// With `links` (task comments and descriptions; Nov 3 notes batch 18, 133 — Asana test 10.3) "#" finds
// tasks (by name or number) and projects the viewer can open (GET /api/link-search, their own access)
// and inserts a link to the one picked, which the text shows as a clickable chip with its name. "@" is
// for people only; `people={false}` (descriptions, which notify nobody) turns it off.
export function MentionTextarea({
  value,
  onValueChange,
  candidates,
  onSubmit,
  onCancel,
  links = false,
  people: peopleOn = true,
  ...props
}: {
  value: string;
  onValueChange: (value: string) => void;
  candidates: Profile[];
  // ⌘/Ctrl+Enter.
  onSubmit?: () => void;
  // Escape while no suggestions are open.
  onCancel?: () => void;
  links?: boolean;
  people?: boolean;
} & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "onSubmit">) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  // The newest "#" results that came back (kept on screen while the next query is on its way).
  const [found, setFound] = useState<Found | null>(null);
  // The "#" query (at this trigger) that matched nothing.
  const [dead, setDead] = useState<{ start: number; query: string } | null>(null);

  const live = trigger && dismissed !== trigger.start ? trigger : null;
  const hashQuery = live?.kind === "#" ? linkSearchText(live.query) : null;
  const deadHere = live && dead?.start === live.start ? dead.query : null;
  const hashDead = hashQuery !== null && hashQuery !== "" && extendsDeadQuery(hashQuery, deadHere);
  const hashStart = live?.kind === "#" ? live.start : null;

  useEffect(() => {
    if (hashQuery === null || hashQuery === "" || hashDead || hashStart === null) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(`/api/link-search?q=${encodeURIComponent(hashQuery)}`, { signal: controller.signal, cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { tasks?: QuickTask[]; projects?: QuickProject[] } | null) => {
          if (!body) return;
          const tasks = body.tasks ?? [];
          const projects = body.projects ?? [];
          setFound({ start: hashStart, query: hashQuery, tasks, projects });
          if (tasks.length + projects.length === 0) setDead({ start: hashStart, query: hashQuery });
        })
        .catch(() => {});
    }, 120);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [hashQuery, hashDead, hashStart]);

  const people: Suggestion[] =
    live?.kind === "@"
      ? candidates
          .filter((p) => matches(p, live.query))
          .slice(0, MAX_PEOPLE)
          .map((profile) => ({ kind: "person", key: `person-${profile.id}`, profile }))
      : [];
  // While a newer query is on its way, the last results at this "#" stay (no flicker between keys).
  const shown = hashQuery && !hashDead && found && found.start === hashStart ? found : null;
  const searching = Boolean(hashQuery) && !hashDead && (!found || found.start !== hashStart || found.query !== hashQuery);
  const suggestions: Suggestion[] = [
    ...people,
    ...(shown?.tasks ?? []).map((task) => ({ kind: "task" as const, key: `task-${task.id}`, task })),
    ...(shown?.projects ?? []).map((project) => ({ kind: "project" as const, key: `project-${project.id}`, project })),
  ];
  // "#" alone: a hint row; "#Name" on its way with nothing yet: "Searching…".
  const hashNote =
    live?.kind === "#" && suggestions.length === 0 && !hashDead
      ? hashQuery
        ? searching
          ? "Searching…"
          : null
        : "Type a task or project name, or a task number"
      : null;
  const open = suggestions.length > 0 || hashNote !== null;
  const activeIndex = Math.min(active, Math.max(suggestions.length - 1, 0));

  function sync(element: HTMLTextAreaElement) {
    const next = findTrigger(element.value, element.selectionStart ?? element.value.length, peopleOn, links);
    if (next?.start !== trigger?.start || next?.query !== trigger?.query || next?.kind !== trigger?.kind) setActive(0);
    setTrigger(next);
  }

  function choose(item: Suggestion) {
    if (!trigger) return;
    let token: string;
    if (item.kind === "person") {
      token = mentionToken(item.profile);
    } else if (item.kind === "task") {
      rememberLinkName(item.task.id, item.task.title);
      token = `${taskLinkUrl(window.location.origin, item.task.id, item.task.projectId)} `;
    } else {
      rememberLinkName(item.project.id, item.project.name);
      token = `${projectLinkUrl(window.location.origin, item.project.id)} `;
    }
    const next = value.slice(0, trigger.start) + token + value.slice(trigger.end);
    onValueChange(next);
    setTrigger(null);
    const caret = trigger.start + token.length;
    requestAnimationFrame(() => {
      const element = ref.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(caret, caret);
    });
  }

  return (
    <div className="relative">
      <textarea
        {...props}
        ref={ref}
        value={value}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && suggestions.length > 0 ? `${listId}-${activeIndex}` : undefined}
        onChange={(e) => {
          onValueChange(e.currentTarget.value);
          sync(e.currentTarget);
        }}
        onSelect={(e) => sync(e.currentTarget)}
        onBlur={(e) => {
          setTrigger(null);
          props.onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (open && suggestions.length === 0 && e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setDismissed(trigger?.start ?? null);
            return;
          }
          if (open && suggestions.length > 0) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setActive((activeIndex + step + suggestions.length) % suggestions.length);
              return;
            }
            if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
              e.preventDefault();
              choose(suggestions[activeIndex]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setDismissed(trigger?.start ?? null);
              return;
            }
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && onSubmit) {
            e.preventDefault();
            onSubmit();
            return;
          }
          if (e.key === "Escape" && onCancel) {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={live?.kind === "#" ? "Tasks and projects to link" : "People to mention"}
          className="absolute bottom-full left-0 z-40 mb-1 max-h-80 w-72 overflow-y-auto rounded-md border border-zinc-200 bg-white py-1 shadow-lg shadow-zinc-900/10"
        >
          {suggestions.map((item, index) => {
            const heading = item.kind !== "person" && (index === 0 || suggestions[index - 1].kind !== item.kind);
            return (
              <li key={item.key} role="presentation">
                {heading ? (
                  <p role="presentation" className="px-2.5 pb-0.5 pt-1.5 text-2xs font-semibold uppercase tracking-wide text-zinc-400">
                    {GROUP_LABELS[item.kind]}
                  </p>
                ) : null}
                <div
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  data-mention-kind={item.kind}
                  // mousedown, not click: keep focus (and the caret) in the textarea.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(item);
                  }}
                  onMouseEnter={() => setActive(index)}
                  className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm text-zinc-800 aria-selected:bg-accent-50 aria-selected:text-accent-900"
                >
                  {item.kind === "person" ? (
                    <>
                      <Avatar name={displayName(item.profile)} src={item.profile.avatar_url} profileId={item.profile.id} />
                      <span className="min-w-0 flex-1 truncate">{displayName(item.profile)}</span>
                      {item.profile.full_name ? <span className="truncate text-xs text-zinc-500">{item.profile.email}</span> : null}
                    </>
                  ) : item.kind === "task" ? (
                    <>
                      <SquareCheck className="size-4 shrink-0 text-zinc-400" aria-hidden />
                      <span className={`min-w-0 flex-1 truncate ${item.task.completed ? "text-zinc-500 line-through" : ""}`}>{item.task.title}</span>
                      {item.task.label ? (
                        <span className="shrink-0 text-2xs tabular-nums text-zinc-400">{formatRequestLabel(item.task.label)}</span>
                      ) : null}
                      <span className="max-w-24 truncate text-xs text-zinc-500">{item.task.isPrivate ? "Private" : item.task.projectName}</span>
                    </>
                  ) : (
                    <>
                      <FolderKanban className="size-4 shrink-0 text-zinc-400" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{item.project.name}</span>
                      {item.project.archived ? <span className="text-xs text-zinc-500">Archived</span> : null}
                    </>
                  )}
                </div>
              </li>
            );
          })}
          {hashNote ? (
            <li role="presentation" className="px-2.5 py-1.5 text-xs text-zinc-500" aria-live="polite">
              {hashNote}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
