"use client";

import { useId, useRef, useState, type TextareaHTMLAttributes } from "react";
import { Avatar, displayName } from "@/components/avatar";
import type { Profile } from "@/lib/data";
import { mentionToken } from "@/lib/reactions";

const MAX_SUGGESTIONS = 6;

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

// A textarea with @mention autocomplete. Choosing a person inserts the token the comments trigger
// parses (`@Full Name`, else `@emaillocalpart`), so the mention notifies them through the usual inbox.
// candidates: people who can read the task (its projects' members), without the viewer.
export function MentionTextarea({
  value,
  onValueChange,
  candidates,
  onSubmit,
  onCancel,
  ...props
}: {
  value: string;
  onValueChange: (value: string) => void;
  candidates: Profile[];
  // ⌘/Ctrl+Enter.
  onSubmit?: () => void;
  // Escape while no suggestions are open.
  onCancel?: () => void;
} & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "onSubmit">) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);

  const suggestions =
    trigger && dismissed !== trigger.start
      ? candidates.filter((p) => matches(p, trigger.query)).slice(0, MAX_SUGGESTIONS)
      : [];
  const open = suggestions.length > 0;
  const activeIndex = Math.min(active, Math.max(suggestions.length - 1, 0));

  function sync(element: HTMLTextAreaElement) {
    const next = findTrigger(element.value, element.selectionStart ?? element.value.length);
    if (next?.start !== trigger?.start || next?.query !== trigger?.query) setActive(0);
    setTrigger(next);
  }

  function choose(profile: Profile) {
    if (!trigger) return;
    const token = mentionToken(profile);
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
          aria-label="People to mention"
          className="absolute bottom-full left-0 z-40 mb-1 w-64 overflow-hidden rounded-md border border-zinc-200 bg-white py-1 shadow-lg shadow-zinc-900/10"
        >
          {suggestions.map((profile, index) => (
            <li
              key={profile.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              // mousedown, not click: keep focus (and the caret) in the textarea.
              onMouseDown={(e) => {
                e.preventDefault();
                choose(profile);
              }}
              onMouseEnter={() => setActive(index)}
              className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm text-zinc-800 aria-selected:bg-accent-50 aria-selected:text-accent-900"
            >
              <Avatar name={displayName(profile)} />
              <span className="min-w-0 flex-1 truncate">{displayName(profile)}</span>
              {profile.full_name ? <span className="truncate text-xs text-zinc-500">{profile.email}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
