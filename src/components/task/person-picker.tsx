"use client";

import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, Search, UserRound, X } from "lucide-react";
import { Avatar, displayName } from "@/components/avatar";
import { Popover } from "@/components/popover";
import type { Profile } from "@/lib/data";

// Asana's people picker (Asana parity, batch 3): a search box over a list of people, the current one
// ticked, and a way to clear. Used for the task's assignee (field row and header avatar) and for adding
// collaborators. Who appears is decided by the caller (people who can read the task).
export function PersonPicker({
  label,
  people,
  value,
  onPick,
  onClear,
  clearLabel = "Remove assignee",
  button,
  buttonClassName,
  tooltip,
  align = "start",
  emptyNote = "Nobody else can be picked here.",
}: {
  label: string;
  people: Profile[];
  value: string | null;
  onPick: (profileId: string) => void;
  onClear?: () => void;
  clearLabel?: string;
  button: ReactNode;
  buttonClassName: string;
  tooltip?: string;
  align?: "start" | "end";
  emptyNote?: string;
}) {
  return (
    <Popover
      label={label}
      tooltip={tooltip}
      align={align}
      panelClassName="w-72 p-0"
      buttonClassName={buttonClassName}
      button={button}
    >
      {(close) => (
        <PeopleList
          label={label}
          people={people}
          selected={value ? [value] : []}
          emptyNote={emptyNote}
          onPick={(id) => {
            close();
            if (id !== value) onPick(id);
          }}
          footer={
            value && onClear ? (
              <button
                type="button"
                onClick={() => {
                  close();
                  onClear();
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-600 hover:bg-zinc-100"
              >
                <X className="size-4 text-zinc-400" aria-hidden />
                {clearLabel}
              </button>
            ) : null
          }
        />
      )}
    </Popover>
  );
}

// The searchable list inside a picker: ↑/↓ move, Enter picks the highlighted person.
export function PeopleList({
  label,
  people,
  selected,
  onPick,
  footer,
  emptyNote,
  autoFocus = true,
}: {
  label: string;
  people: Profile[];
  selected: string[];
  onPick: (profileId: string) => void;
  footer?: ReactNode;
  emptyNote: string;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  // Start on the current person, so Enter keeps them and ↑/↓ move from there.
  const [active, setActive] = useState(() => Math.max(people.findIndex((p) => selected.includes(p.id)), 0));
  const q = query.trim().toLowerCase();
  const shown = people
    .filter((p) => !q || displayName(p).toLowerCase().includes(q) || p.email.toLowerCase().includes(q))
    .slice(0, 50);
  const index = Math.min(active, shown.length - 1);

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length) setActive((index + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[index]) onPick(shown[index].id);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-zinc-100 px-2.5">
        <Search className="size-4 shrink-0 text-zinc-400" aria-hidden />
        <input
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={onKey}
          aria-label={`${label}: search by name or email`}
          placeholder="Name or email"
          className="h-9 min-w-0 flex-1 border-0 bg-transparent p-0 text-sm shadow-none outline-none focus-visible:shadow-none"
        />
      </div>
      <ul aria-label={label} className="max-h-64 overflow-y-auto p-1">
        {shown.map((person, i) => {
          const name = displayName(person);
          const on = selected.includes(person.id);
          return (
            <li key={person.id}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => onPick(person.id)}
                onMouseMove={() => i !== index && setActive(i)}
                className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left ${i === index ? "bg-zinc-100" : ""}`}
              >
                <Avatar name={name} size="md" />
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-sm text-zinc-900">{name}</span>
                  {name !== person.email ? <span className="block truncate text-xs text-zinc-500">{person.email}</span> : null}
                </span>
                {on ? <Check className="size-4 shrink-0 text-accent-600" aria-label="Selected" /> : null}
              </button>
            </li>
          );
        })}
        {shown.length === 0 ? (
          <li className="flex items-center gap-2 px-2 py-2 text-xs text-zinc-500">
            <UserRound className="size-3.5 shrink-0" aria-hidden />
            {q ? `Nobody matches “${query.trim()}”.` : emptyNote}
          </li>
        ) : null}
      </ul>
      {footer ? <div className="border-t border-zinc-100 p-1">{footer}</div> : null}
    </div>
  );
}
