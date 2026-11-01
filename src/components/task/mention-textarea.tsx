"use client";

import { useEffect, useId, useRef, useState, type TextareaHTMLAttributes } from "react";
import { FolderKanban, SquareCheck } from "lucide-react";
import { Avatar, displayName } from "@/components/avatar";
import { rememberLinkName } from "@/components/task/comment-parts";
import { projectLinkUrl, taskLinkUrl } from "@/lib/app-links";
import type { Profile } from "@/lib/data";
import { mentionToken } from "@/lib/reactions";
import type { QuickProject, QuickTask } from "@/lib/shell";
import { quickSearch } from "@/lib/shell-actions";

const MAX_PEOPLE = 6;
const MAX_TASKS = 5;
const MAX_PROJECTS = 3;

// "@" at the start or after whitespace, then up to two words, ending at the caret.
const TRIGGER = /(^|\s)@([^\s@]{0,40}(?: [^\s@]{0,40})?)$/;

type Trigger = { start: number; end: number; query: string };

function findTrigger(value: string, caret: number): Trigger | null {
  const before = value.slice(0, caret);
  const match = TRIGGER.exec(before);
  if (!match) return null;
  const start = before.length - match[2].length - 1;
  return { start, end: caret, query: match[2].toLowerCase() };
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

// A textarea with @mention autocomplete. Choosing a person inserts the token the comments trigger
// parses (`@Full Name`, else `@emaillocalpart`), so the mention notifies them through the usual inbox.
// candidates: people who can read the task (its projects' members), without the viewer.
// With `links` (task comments, Nov 1 notes batch 9a / Asana test 10.3) the menu also finds tasks and
// projects the viewer can open (the search palette's own search, with their own access) and inserts a
// link to the one picked, which the comment shows as a clickable chip with its name.
export function MentionTextarea({
  value,
  onValueChange,
  candidates,
  onSubmit,
  onCancel,
  links = false,
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
} & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "onSubmit">) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  // Tasks and projects for the current query (links only); `query` says which query they answer.
  const [found, setFound] = useState<{ query: string; tasks: QuickTask[]; projects: QuickProject[] }>({
    query: "",
    tasks: [],
    projects: [],
  });

  const query = trigger && dismissed !== trigger.start ? trigger.query : null;
  useEffect(() => {
    if (!links || !query || query.trim().length < 1) return;
    let live = true;
    const timer = window.setTimeout(() => {
      quickSearch(query).then(
        (results) => {
          if (live) setFound({ query, tasks: results.tasks.slice(0, MAX_TASKS), projects: results.projects.slice(0, MAX_PROJECTS) });
        },
        () => {},
      );
    }, 150);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [links, query]);

  const people: Suggestion[] =
    query !== null
      ? candidates
          .filter((p) => matches(p, query))
          .slice(0, MAX_PEOPLE)
          .map((profile) => ({ kind: "person", key: `person-${profile.id}`, profile }))
      : [];
  const remote = links && query && found.query === query ? found : { tasks: [], projects: [] };
  const suggestions: Suggestion[] = [
    ...people,
    ...remote.tasks.map((task) => ({ kind: "task" as const, key: `task-${task.id}`, task })),
    ...remote.projects.map((project) => ({ kind: "project" as const, key: `project-${project.id}`, project })),
  ];
  const open = suggestions.length > 0;
  const activeIndex = Math.min(active, Math.max(suggestions.length - 1, 0));

  function sync(element: HTMLTextAreaElement) {
    const next = findTrigger(element.value, element.selectionStart ?? element.value.length);
    if (next?.start !== trigger?.start || next?.query !== trigger?.query) setActive(0);
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
        aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
        onChange={(e) => {
          onValueChange(e.currentTarget.value);
          sync(e.currentTarget);
        }}
        onSelect={(e) => sync(e.currentTarget)}
        onBlur={() => setTrigger(null)}
        onKeyDown={(e) => {
          if (open) {
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
          aria-label={links ? "People, tasks, and projects to mention" : "People to mention"}
          className="absolute bottom-full left-0 z-40 mb-1 max-h-80 w-72 overflow-y-auto rounded-md border border-zinc-200 bg-white py-1 shadow-lg shadow-zinc-900/10"
        >
          {suggestions.map((item, index) => {
            const heading = links && (index === 0 || suggestions[index - 1].kind !== item.kind);
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
        </ul>
      ) : null}
    </div>
  );
}
