"use client";

import { useId, useRef, useState } from "react";
import { AtSign, CalendarDays, FolderClosed, Plus, Repeat, X } from "lucide-react";
import { useTabChord } from "@/components/shortcuts/keyboard";
import { useNotify, useServerAction } from "@/components/toast";
import { quickAddTask } from "@/lib/actions/my-tasks";
import { QUICK_ADD_PENDING_SCOPE, checklistDueLabel } from "@alhc/core/checklist";
import { useToday } from "@/lib/dates";
import { withPendingCreate } from "@/lib/pending-creates";
import {
  completeToken,
  describeRepeat,
  parseQuickAdd,
  personNames,
  tokenAtCaret,
  type QuickAddPart,
  type QuickAddPerson,
  type QuickAddProject,
} from "@alhc/core/quick-add";

const MAX_SUGGESTIONS = 6;

// My tasks' one-line quick add (Nov 1 notes, batch 9b, item 64): type the task like a sentence —
// "Draft flu-shot email fri #Fall Campaign @Dana every week". Typing # or @ lists projects (where you
// can add tasks) or people; the parts it understood show as chips under the box (× keeps that text in
// the name). Enter adds it; the list refreshes with the new task in its date group. Tab then Q focuses it.
// Nov 3 notes (batch 18, 134): the task is always yours; an @person is added as a follower, not the assignee.
// Nov 4 notes (batch 27, 162): and the @person stays in the name as a mention (a chip linking to them).
// Nov 3 notes (batch 19, video 34.12 / 34.13): the box never locks while an earlier add is saving (it did,
// so a second task typed straight after the first was lost while the first one's toast still showed), each
// Enter saves on its own, and the new task shows in its group at once as a pending row (with its date,
// project, and repeat mark) until the refreshed list has it.
export function QuickAddBar({
  projects,
  people,
  workWeek,
  placeholder = "Add a task — try “Send the report fri #Project @person every week”",
  compact = false,
}: {
  projects: QuickAddProject[];
  people: QuickAddPerson[];
  workWeek?: readonly number[];
  placeholder?: string;
  compact?: boolean;
}) {
  const id = useId();
  const today = useToday();
  const notify = useNotify();
  const [, run] = useServerAction();
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const [suggestionsClosed, setSuggestionsClosed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useTabChord("q", () => input.current?.focus());

  const parsed = today ? parseQuickAdd(text, { today, projects, people, workWeek, ignored }) : null;
  const token = tokenAtCaret(text, caret);
  const query = token?.query.trim().toLowerCase() ?? "";
  const suggestions: { id: string; name: string; detail?: string }[] =
    !token || suggestionsClosed
      ? []
      : token.marker === "#"
        ? projects.filter((p) => p.name.toLowerCase().includes(query)).slice(0, MAX_SUGGESTIONS)
        : people
            .filter((p) => personNames(p).some((n) => n.toLowerCase().includes(query)))
            .slice(0, MAX_SUGGESTIONS)
            .map((p) => ({ id: p.id, name: p.name, detail: p.email ?? undefined }));
  const listOpen = suggestions.length > 0;
  const listId = `${id}-suggestions`;

  function pick(name: string) {
    if (!token) return;
    const next = completeToken(text, token, name);
    setText(next.text);
    setCaret(next.caret);
    setActive(0);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(next.caret, next.caret);
    });
  }

  function submit() {
    if (!parsed) return;
    if (!parsed.title) {
      notify(text.trim() ? "Type a name for the task too" : "Type a task first");
      return;
    }
    const typed = text;
    const what = parsed;
    setText("");
    setIgnored([]);
    setCaret(0);
    run(async () => {
      const result = await withPendingCreate(
        QUICK_ADD_PENDING_SCOPE,
        what.title,
        () =>
          quickAddTask({
            title: what.title,
            projectId: what.project?.id ?? null,
            mentionId: what.person?.id ?? null,
            dueOn: what.dueOn,
            repeat: what.repeat,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        {
          dueOn: what.dueOn,
          recurring: Boolean(what.repeat),
          projectId: what.project?.id ?? null,
          projectName: what.project?.name ?? null,
        },
      );
      if (result.error) {
        setText(typed);
        return result;
      }
      const where = [
        what.project ? `to ${what.project.name}` : null,
        what.person ? `with ${what.person.name} following` : null,
        what.dueOn && today ? `due ${checklistDueLabel(what.dueOn, today)}` : null,
      ].filter(Boolean);
      notify(result.note ?? `Added “${what.title}”${where.length ? ` ${where.join(", ")}` : ""}`);
      return result;
    });
  }

  return (
    <div className="relative">
      <div
        className={`flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 shadow-xs focus-within:border-accent-400 focus-within:ring-2 focus-within:ring-accent-100 ${
          compact ? "h-10" : "h-12"
        }`}
      >
        <Plus className="size-5 shrink-0 text-accent-600" aria-hidden />
        <label htmlFor={`${id}-input`} className="sr-only">
          Add a task
        </label>
        <input
          ref={input}
          id={`${id}-input`}
          type="text"
          role="combobox"
          aria-expanded={listOpen}
          aria-controls={listOpen ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={listOpen ? `${listId}-${Math.min(active, suggestions.length - 1)}` : undefined}
          aria-describedby={`${id}-hint`}
          autoComplete="off"
          maxLength={1000}
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.currentTarget.value);
            setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
            setActive(0);
            setSuggestionsClosed(false);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={(e) => {
            if (listOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => (a + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pick(suggestions[Math.min(active, suggestions.length - 1)].name);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSuggestionsClosed(true);
                return;
              }
            }
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape" && text) {
              e.preventDefault();
              setText("");
              setIgnored([]);
            }
          }}
          className={`min-w-0 flex-1 border-0 bg-transparent p-0 text-zinc-900 shadow-none outline-none ring-0 placeholder:text-zinc-400 focus:ring-0 ${
            compact ? "text-sm" : "text-[15px]"
          }`}
        />
        {text.trim() ? (
          <button type="button" onClick={submit} className="btn-primary h-8 shrink-0">
            Add
          </button>
        ) : null}
      </div>
      <p id={`${id}-hint`} className="sr-only">
        Type a date like tomorrow or fri, # and a project, @ and a person to mention them in the name (and add them as a follower on a project task), or every week. Enter adds the task, assigned to you.
      </p>

      {listOpen ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={token?.marker === "#" ? "Projects" : "People"}
          className="absolute left-8 top-full z-30 mt-1 w-72 overflow-hidden rounded-lg border border-zinc-200 bg-white py-1 shadow-lg"
        >
          {suggestions.map((s, i) => (
            <li
              key={s.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s.name);
              }}
              onMouseEnter={() => setActive(i)}
              className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm ${i === active ? "bg-accent-50 text-accent-900" : "text-zinc-800"}`}
            >
              {token?.marker === "#" ? (
                <FolderClosed className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
              ) : (
                <AtSign className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
              )}
              <span className="min-w-0 truncate">{s.name}</span>
              {s.detail ? <span className="ml-auto truncate text-xs text-zinc-400">{s.detail}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {parsed && parsed.parts.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Understood">
          {parsed.parts.map((part) => (
            <li key={`${part.kind}-${part.start}`}>
              <PartChip
                part={part}
                label={chipLabel(part, parsed, today)}
                onIgnore={() => setIgnored((list) => [...list, part.text])}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function chipLabel(part: QuickAddPart, parsed: NonNullable<ReturnType<typeof parseQuickAdd>>, today: string | null): string {
  if (part.kind === "date") return parsed.dueOn && today ? `Due ${checklistDueLabel(parsed.dueOn, today)}` : part.text;
  if (part.kind === "project") return parsed.project?.name ?? part.text;
  if (part.kind === "person") return `Mentions ${parsed.person?.name ?? part.text}`;
  return parsed.repeat ? describeRepeat(parsed.repeat) : part.text;
}

const PART_ICON = { date: CalendarDays, project: FolderClosed, person: AtSign, repeat: Repeat } as const;

function PartChip({ part, label, onIgnore }: { part: QuickAddPart; label: string; onIgnore: () => void }) {
  const Icon = PART_ICON[part.kind];
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-full bg-accent-50 pl-2.5 pr-1 text-xs font-medium text-accent-800">
      <Icon className="size-3.5" aria-hidden />
      {label}
      <button
        type="button"
        onClick={onIgnore}
        aria-label={part.kind === "person" ? `Keep “${part.text}” as plain text, not a mention` : `Keep “${part.text}” in the task name instead`}
        data-tooltip={part.kind === "person" ? "Plain text, not a mention" : "Keep this text in the name"}
        className="inline-flex size-5 items-center justify-center rounded-full text-accent-600 hover:bg-accent-100"
      >
        <X className="size-3" aria-hidden />
      </button>
    </span>
  );
}
