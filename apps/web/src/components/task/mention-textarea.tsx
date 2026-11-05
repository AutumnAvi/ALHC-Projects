"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type TextareaHTMLAttributes } from "react";
import { FolderKanban, SquareCheck } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { displayName } from "@alhc/core/people";
import { knownLinkName, rememberLinkName } from "@/components/task/comment-parts";
import { extendsDeadQuery, linkSearchText, projectLinkUrl, taskLinkUrl } from "@alhc/core/app-links";
import { readRecents, useShellMemberId } from "@/components/shell/shell-context";
import { recentRefsParam } from "@alhc/core/shell";
import {
  NO_CHIP_LINKS,
  addChipLink,
  bodyToDisplay,
  caretAfterTidy,
  chipText,
  displayPieces,
  displayToBody,
  hasChips,
  removeChipAt,
  seedChipLinks,
  snapCaret,
  type ChipLinks,
} from "@/lib/link-chips";
import type { CommentRefs } from "@alhc/core/api/comments/model";
import type { Profile } from "@alhc/core/api/people/model";
import { mentionToken } from "@alhc/core/reactions";
import { formatRequestLabel } from "@alhc/core/request-numbers";
import type { QuickProject, QuickTask } from "@alhc/core/shell";

const MAX_PEOPLE = 6;

// "@" at the start or after whitespace, then up to two words, ending at the caret: people only.
// (Nov 4 notes, batch 21: never through a link chip's invisible marks, link-chips.ts.)
const AT_TRIGGER = /(^|\s)@([^\s@\u2062\u2063]{0,40}(?: [^\s@\u2062\u2063]{0,40})?)$/;
// Nov 3 notes (batch 18, 133): "#" at the start or after whitespace finds tasks and projects. The query
// runs to the caret across spaces ("#Facility Launch Party") — never across a line break, and at most 60
// characters — so the list stays open while a multi-word name is typed and closes only on a pick, Esc,
// or once nothing matches.
const HASH_TRIGGER = /(^|\s)#((?:[^\s#\u2062\u2063][^\n#\u2062\u2063]{0,59})?)$/;

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
// Nov 4 notes (batch 21, note 153): the box shows a picked link as a chip with its name while typing, never
// the raw link (`value` / onValueChange still carry the body with the link; src/lib/link-chips.ts). The
// textarea holds the name between two invisible marks, and a layer over it (LinkChipLayer) draws that
// span as a chip; the caret skips over a chip, and Backspace / Delete next to one removes it whole.
export function MentionTextarea({
  value,
  onValueChange,
  candidates,
  onSubmit,
  onCancel,
  links = false,
  linkRefs,
  people: peopleOn = true,
  listBelow = false,
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
  // Names of the tasks and projects the text already links to (the page's lookup), so they open as chips.
  linkRefs?: CommentRefs | null;
  people?: boolean;
  // The suggestions open under the box (a box near the top of a scroll area, like the task name).
  listBelow?: boolean;
} & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "onSubmit">) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  // Links picked here (note 153): the body keeps the link, the box shows its chip.
  const [chipLinks, setChipLinks] = useState<ChipLinks>(() =>
    links ? seedChipLinks(value, (link) => knownLinkName(link, linkRefs)) : NO_CHIP_LINKS,
  );
  const display = bodyToDisplay(value, chipLinks);
  const chips = links && hasChips(display);
  const lastCaret = useRef<number | null>(null);
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

  // Nov 4 notes (batch 25, 158): "#" alone suggests at once (recent and relevant tasks and projects), like
  // "@" lists people before a letter is typed; a "#" query that matched nothing never goes dead for "".
  const memberId = useShellMemberId();
  useEffect(() => {
    if (hashQuery === null || hashDead || hashStart === null) return;
    const controller = new AbortController();
    const url =
      hashQuery === ""
        ? `/api/link-search?recent=${encodeURIComponent(recentRefsParam(memberId ? readRecents(memberId) : []))}`
        : `/api/link-search?q=${encodeURIComponent(hashQuery)}`;
    const timer = window.setTimeout(() => {
      fetch(url, { signal: controller.signal, cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { tasks?: QuickTask[]; projects?: QuickProject[] } | null) => {
          if (!body) return;
          const tasks = body.tasks ?? [];
          const projects = body.projects ?? [];
          setFound({ start: hashStart, query: hashQuery, tasks, projects });
          if (hashQuery !== "" && tasks.length + projects.length === 0) setDead({ start: hashStart, query: hashQuery });
        })
        .catch(() => {});
    }, hashQuery === "" ? 0 : 120);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [hashQuery, hashDead, hashStart, memberId]);

  const people: Suggestion[] =
    live?.kind === "@"
      ? candidates
          .filter((p) => matches(p, live.query))
          .slice(0, MAX_PEOPLE)
          .map((profile) => ({ kind: "person", key: `person-${profile.id}`, profile }))
      : [];
  // While a newer query is on its way, the last results at this "#" stay (no flicker between keys).
  const shown = hashQuery !== null && !hashDead && found && found.start === hashStart ? found : null;
  const searching = hashQuery !== null && !hashDead && (!found || found.start !== hashStart || found.query !== hashQuery);
  const suggestions: Suggestion[] = [
    ...people,
    ...(shown?.tasks ?? []).map((task) => ({ kind: "task" as const, key: `task-${task.id}`, task })),
    ...(shown?.projects ?? []).map((project) => ({ kind: "project" as const, key: `project-${project.id}`, project })),
  ];
  // "#" alone: the suggestions with a hint row under them (the hint alone while they load or when there are
  // none); "#Name" on its way with nothing yet: "Searching…".
  const hashNote =
    live?.kind === "#" && !hashDead
      ? hashQuery
        ? suggestions.length === 0 && searching
          ? "Searching…"
          : null
        : "Type a task or project name, or a task number"
      : null;
  const open = suggestions.length > 0 || hashNote !== null;
  const activeIndex = Math.min(active, Math.max(suggestions.length - 1, 0));

  function placeCaret(caret: number) {
    requestAnimationFrame(() => {
      const element = ref.current;
      if (!element) return;
      element.setSelectionRange(caret, caret);
      lastCaret.current = caret;
    });
  }

  function sync(element: HTMLTextAreaElement) {
    // The caret never rests inside a chip.
    if (hasChips(element.value) && element.selectionStart === element.selectionEnd) {
      const caret = element.selectionStart ?? 0;
      const snapped = snapCaret(element.value, caret, lastCaret.current);
      if (snapped !== caret) element.setSelectionRange(snapped, snapped);
      lastCaret.current = snapped;
    } else {
      lastCaret.current = element.selectionStart;
    }
    const next = findTrigger(element.value, element.selectionStart ?? element.value.length, peopleOn, links);
    if (next?.start !== trigger?.start || next?.query !== trigger?.query || next?.kind !== trigger?.kind) setActive(0);
    setTrigger(next);
  }

  function choose(item: Suggestion) {
    if (!trigger) return;
    let token: string;
    let nextLinks = chipLinks;
    if (item.kind === "person") {
      token = mentionToken(item.profile);
    } else {
      const url =
        item.kind === "task"
          ? taskLinkUrl(window.location.origin, item.task.id, item.task.projectId)
          : projectLinkUrl(window.location.origin, item.project.id);
      const name = item.kind === "task" ? item.task.title : item.project.name;
      rememberLinkName(item.kind === "task" ? item.task.id : item.project.id, name);
      const added = addChipLink(chipLinks, url, name);
      nextLinks = added.links;
      token = `${chipText(added.label)} `;
    }
    const next = display.slice(0, trigger.start) + token + display.slice(trigger.end);
    if (nextLinks !== chipLinks) setChipLinks(nextLinks);
    onValueChange(displayToBody(next, nextLinks));
    setTrigger(null);
    const caret = trigger.start + token.length;
    requestAnimationFrame(() => {
      const element = ref.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(caret, caret);
      lastCaret.current = caret;
    });
  }

  // A change typed into the box: report the body. A chip cut in two (a selection over part of it) is
  // plain text from then on; its marks go, and the caret stays where it was.
  function change(element: HTMLTextAreaElement) {
    const raw = element.value;
    const body = displayToBody(raw, chipLinks);
    onValueChange(body);
    const tidied = bodyToDisplay(body, chipLinks);
    if (tidied !== raw) placeCaret(caretAfterTidy(raw, tidied, element.selectionStart ?? raw.length));
  }

  return (
    <div className="relative">
      <textarea
        {...props}
        ref={ref}
        value={display}
        // While the box holds a chip its own text is drawn by LinkChipLayer (same place, same font), so
        // the textarea's glyphs are hidden; the caret and the selection stay the textarea's.
        style={chips ? { ...props.style, WebkitTextFillColor: "transparent" } : props.style}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && suggestions.length > 0 ? `${listId}-${activeIndex}` : undefined}
        onChange={(e) => {
          change(e.currentTarget);
          sync(e.currentTarget);
        }}
        onSelect={(e) => sync(e.currentTarget)}
        onBlur={(e) => {
          setTrigger(null);
          props.onBlur?.(e);
        }}
        onKeyDown={(e) => {
          const element = e.currentTarget;
          if (
            (e.key === "Backspace" || e.key === "Delete") &&
            !e.metaKey &&
            !e.ctrlKey &&
            !e.altKey &&
            element.selectionStart === element.selectionEnd &&
            hasChips(element.value)
          ) {
            const removed = removeChipAt(element.value, element.selectionStart ?? 0, e.key);
            if (removed) {
              e.preventDefault();
              onValueChange(displayToBody(removed.display, chipLinks));
              setTrigger(null);
              placeCaret(removed.caret);
              return;
            }
          }
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
            return;
          }
          // Keys the suggestions didn't take (the task name's Enter saves; Nov 4 notes, batch 27).
          props.onKeyDown?.(e);
        }}
      />
      {chips ? <LinkChipLayer display={display} textarea={ref} /> : null}
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={live?.kind === "#" ? "Tasks and projects to link" : "People to mention"}
          className={`absolute left-0 z-40 max-h-80 ${listBelow ? "top-full mt-1" : "bottom-full mb-1"} w-72 overflow-y-auto rounded-md border border-zinc-200 bg-white py-1 shadow-lg shadow-zinc-900/10`}
        >
          {suggestions.map((item, index) => {
            const heading = item.kind !== "person" && (index === 0 || suggestions[index - 1].kind !== item.kind);
            return (
              <li key={item.key} role="presentation">
                {heading ? (
                  <p role="presentation" className="px-2.5 pb-0.5 pt-1.5 text-2xs font-semibold uppercase tracking-wide text-zinc-400">
                    {shown?.query === "" ? `Suggested ${GROUP_LABELS[item.kind].toLowerCase()}` : GROUP_LABELS[item.kind]}
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

// Nov 4 notes (batch 21, note 153): draws the box's text over the (glyph-less) textarea with each link as a
// chip. It copies the textarea's font, padding, and size and follows its scrolling, and it keeps every
// character (the invisible marks too) so it lines up exactly; a chip's look never changes its width (no
// padding or bold: a background and a ring of the same color).
const MIRRORED = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "wordSpacing",
  "tabSize",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "textAlign",
  "color",
] as const;

function LinkChipLayer({ display, textarea }: { display: string; textarea: React.RefObject<HTMLTextAreaElement | null> }) {
  const layer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = textarea.current;
    const mirror = layer.current;
    if (!element || !mirror) return;
    const place = () => {
      const style = window.getComputedStyle(element);
      for (const key of MIRRORED) mirror.style[key] = style[key];
      mirror.style.top = `${element.offsetTop + element.clientTop}px`;
      mirror.style.left = `${element.offsetLeft + element.clientLeft}px`;
      mirror.style.width = `${element.clientWidth}px`;
      mirror.style.height = `${element.clientHeight}px`;
      mirror.scrollTop = element.scrollTop;
    };
    place();
    const follow = () => {
      mirror.scrollTop = element.scrollTop;
    };
    const observer = new ResizeObserver(place);
    observer.observe(element);
    element.addEventListener("scroll", follow);
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", follow);
    };
  }, [display, textarea]);

  return (
    <div
      ref={layer}
      aria-hidden
      data-link-chip-layer=""
      className="pointer-events-none absolute overflow-hidden whitespace-pre-wrap break-words [overflow-wrap:break-word]"
    >
      {displayPieces(display).map((piece, index) =>
        piece.type === "chip" ? (
          <span
            key={index}
            data-link-chip=""
            title={piece.label}
            className="rounded-[3px] bg-accent-50 text-accent-800 shadow-[0_0_0_2px_var(--color-accent-50)] [box-decoration-break:clone]"
          >
            {piece.text}
          </span>
        ) : (
          <span key={index}>{piece.text}</span>
        ),
      )}
      {/* A trailing line break needs something after it to take up its line, like the textarea's. */}
      {display.endsWith("\n") ? " " : null}
    </div>
  );
}
