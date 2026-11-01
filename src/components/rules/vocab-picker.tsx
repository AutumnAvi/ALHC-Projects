"use client";

import { ChevronDown, PenLine, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SmartOption } from "@/components/smart-picker";
import { FOCUSABLE_SELECTOR, trappedTabTarget } from "@/lib/focus-trap";
import { filterOptions, flatOptions } from "@/lib/smart-picker";
import { VOCAB_KIND_NOUN, VOCAB_KIND_TITLE, groupStep, type VocabKind } from "@/lib/vocab-picker";

// Nov 1 notes, batch 10 (79, 80): the When / If / Then pickers. Instead of a short scrolling dropdown,
// the button opens a large pop-up with every trigger, condition, or action as an icon tile, grouped,
// with the search box focused — laid out in columns so the whole list fits a laptop screen without
// scrolling. The closed button ("block") is drawn as an obviously clickable, editable token: a bordered,
// tinted chip with a pencil and "Click to change". "add" buttons are the plain "+ And…" / "Then…" links.
//
// Keyboard: typing searches; ↑ ↓ move through the tiles (column order), ← → jump to the previous / next
// group, Home / End, Enter picks, Esc clears the search and then closes. ARIA: the search box is a
// combobox controlling a listbox of grouped options (aria-activedescendant).
export function VocabPicker({
  kind,
  label,
  value,
  options,
  onChange,
  variant = "chip",
  renderValue,
  className = "",
  id,
  disabled = false,
}: {
  kind: VocabKind;
  // The accessible name ("Trigger", "Condition 2", "Add action").
  label: string;
  value: string | null;
  options: readonly SmartOption[];
  onChange: (value: string) => void;
  // chip: the step's block (When / If / Then); ghost: an "add" link.
  variant?: "chip" | "ghost";
  renderValue?: (selected: SmartOption[]) => ReactNode;
  className?: string;
  id?: string;
  disabled?: boolean;
  // Accepted for drop-in use where a SmartPicker was; the pop-up is always searchable and wide.
  searchable?: boolean;
  panelWidth?: number;
}) {
  const autoId = useId();
  const buttonId = id ?? `vocab-${autoId}`;
  const dialogId = `${buttonId}-dialog`;
  const listId = `${buttonId}-list`;
  const titleId = `${buttonId}-title`;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);

  const selected = options.find((o) => o.value === value) ?? null;
  const groups = useMemo(() => filterOptions(options, query), [options, query]);
  const flat = useMemo(() => flatOptions(groups), [groups]);
  const enabledFlat = useMemo(() => flat.filter((o) => !o.disabled), [flat]);
  const activeOption = flat.find((o) => o.value === active) ?? null;

  function openPicker() {
    if (disabled) return;
    setQuery("");
    setActive(selected && !selected.disabled ? selected.value : null);
    setOpen(true);
  }

  function close(focusButton = true) {
    setOpen(false);
    if (focusButton) window.setTimeout(() => buttonRef.current?.focus(), 0);
  }

  function pick(option: SmartOption) {
    if (option.disabled) return;
    onChange(option.value);
    close();
  }

  // The first enabled tile is the one Enter picks while searching.
  const effectiveActive =
    active && enabledFlat.some((o) => o.value === active) ? active : (enabledFlat[0]?.value ?? null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open || !effectiveActive) return;
    document.getElementById(`${listId}-${effectiveActive}`)?.scrollIntoView({ block: "nearest" });
  }, [open, effectiveActive, listId]);

  function onKeyDown(event: ReactKeyboardEvent) {
    const index = enabledFlat.findIndex((o) => o.value === effectiveActive);
    const move = (next: number) => {
      event.preventDefault();
      const option = enabledFlat[Math.max(0, Math.min(enabledFlat.length - 1, next))];
      if (option) setActive(option.value);
    };
    switch (event.key) {
      case "Escape":
        // Handled here so the canvas behind doesn't also close (it skips prevented events).
        event.preventDefault();
        event.stopPropagation();
        if (query) setQuery("");
        else close();
        return;
      case "ArrowDown":
        return move(index + 1);
      case "ArrowUp":
        return move(index - 1);
      case "ArrowRight":
      case "ArrowLeft": {
        if (event.currentTarget === inputRef.current && query && (event.key === "ArrowLeft" || inputRef.current?.selectionStart !== query.length)) {
          return; // moving the caret inside the search text
        }
        const target = groupStep(groups, effectiveActive, event.key === "ArrowRight" ? 1 : -1);
        if (target) {
          event.preventDefault();
          setActive(target);
        }
        return;
      }
      case "Home":
        if (event.currentTarget === inputRef.current && query) return;
        return move(0);
      case "End":
        if (event.currentTarget === inputRef.current && query) return;
        return move(enabledFlat.length - 1);
      case "Enter": {
        event.preventDefault();
        const option = enabledFlat.find((o) => o.value === effectiveActive);
        if (option) pick(option);
        return;
      }
      case "Tab": {
        // Keep focus inside the pop-up (the search box and the close button).
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
        const target = trappedTabTarget(controls.length, controls.indexOf(document.activeElement as HTMLElement), event.shiftKey);
        if (target !== null) {
          event.preventDefault();
          controls[target]?.focus();
        }
        return;
      }
    }
  }

  const noun = VOCAB_KIND_NOUN[kind];
  const closed =
    renderValue?.(selected ? [selected] : []) ??
    (selected ? (
      <>
        {selected.icon ? <span className="shrink-0 text-accent-600">{selected.icon}</span> : null}
        <span className="truncate">{selected.label}</span>
      </>
    ) : (
      <span className="text-accent-700">Choose {noun}</span>
    ));

  return (
    <>
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        aria-label={selected && variant === "chip" ? `${label}: ${selected.label}. Click to change` : label}
        data-tooltip={disabled ? undefined : variant === "chip" ? `Click to change the ${noun}` : undefined}
        data-vocab-block={variant === "chip" || undefined}
        onClick={openPicker}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            openPicker();
          }
        }}
        className={`${variant === "chip" ? VOCAB_BLOCK_CLASS : "btn-ghost"} ${className}`}
      >
        {closed}
        {variant === "chip" && !disabled ? (
          <>
            <PenLine className="size-3 shrink-0 text-accent-500 opacity-70 group-hover/vocab:opacity-100" aria-hidden />
            <ChevronDown className="-ml-0.5 size-3.5 shrink-0 text-accent-500" aria-hidden />
          </>
        ) : null}
      </button>
      {open
        ? createPortal(
            <div
              className="fixed inset-0 z-[70] flex items-start justify-center bg-zinc-900/40 p-3 sm:items-center sm:p-6"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) close();
              }}
            >
              <div
                id={dialogId}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                data-vocab-picker={kind}
                onKeyDown={onKeyDown}
                className="flex max-h-[94vh] w-full max-w-[1180px] flex-col overflow-hidden rounded-xl bg-white text-sm shadow-2xl"
              >
                <div className="flex items-center gap-3 border-b border-zinc-200 px-4 py-3">
                  <h2 id={titleId} className="shrink-0 text-base font-semibold text-zinc-900">
                    {VOCAB_KIND_TITLE[kind]}
                  </h2>
                  <div className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" aria-hidden />
                    <input
                      ref={inputRef}
                      role="combobox"
                      aria-label={`Search ${noun}s`}
                      aria-expanded="true"
                      aria-controls={listId}
                      aria-autocomplete="list"
                      aria-activedescendant={effectiveActive ? `${listId}-${effectiveActive}` : undefined}
                      value={query}
                      onChange={(e) => {
                        setQuery(e.currentTarget.value);
                        setActive(null);
                      }}
                      placeholder={`Search ${options.length} ${noun}s…`}
                      className="field h-9 w-full pl-8"
                    />
                  </div>
                  <button type="button" onClick={() => close()} aria-label="Close" data-tooltip="Close (Esc)" className="btn-icon size-8">
                    <X className="size-4" />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                  {flat.length === 0 ? (
                    <p className="py-10 text-center text-sm text-zinc-500">No {noun} matches “{query}”.</p>
                  ) : (
                    <div id={listId} role="listbox" aria-label={label} className="gap-x-4 [column-width:15.5rem]">
                      {groups.map((group) => (
                        <div
                          key={group.name ?? "_"}
                          role="group"
                          aria-label={group.name ?? "Other"}
                          className="mb-3 break-inside-avoid"
                        >
                          {group.name ? (
                            <p className="mb-1 px-1 text-2xs font-semibold uppercase tracking-wide text-zinc-500" aria-hidden>
                              {group.name}
                            </p>
                          ) : null}
                          <div className="flex flex-col gap-0.5">
                            {group.options.map((option) => {
                              const isActive = option.value === effectiveActive;
                              const isSelected = option.value === value;
                              return (
                                <div
                                  key={option.value}
                                  id={`${listId}-${option.value}`}
                                  role="option"
                                  aria-selected={isSelected}
                                  aria-disabled={option.disabled || undefined}
                                  data-active={isActive || undefined}
                                  title={option.disabled ? option.disabledReason : option.description}
                                  onMouseEnter={() => {
                                    if (!option.disabled) setActive(option.value);
                                  }}
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => pick(option)}
                                  className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 py-1 text-[13px] leading-tight text-zinc-800 hover:bg-accent-50 data-[active]:border-accent-300 data-[active]:bg-accent-50 aria-selected:font-semibold aria-selected:text-accent-800 aria-disabled:cursor-not-allowed aria-disabled:text-zinc-400 aria-disabled:hover:bg-transparent"
                                >
                                  <span
                                    aria-hidden
                                    className={`flex size-6 shrink-0 items-center justify-center rounded-md ${
                                      option.disabled ? "bg-zinc-50 text-zinc-300" : isSelected ? "bg-accent-500 text-white" : "bg-zinc-100 text-zinc-600"
                                    }`}
                                  >
                                    {option.icon}
                                  </span>
                                  <span className="min-w-0 flex-1 line-clamp-2">{option.label}</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex min-h-10 items-center gap-2 border-t border-zinc-100 bg-zinc-50 px-4 py-2 text-xs text-zinc-600" aria-live="polite">
                  {activeOption ? (
                    <>
                      <span className="font-medium text-zinc-800">{activeOption.label}</span>
                      <span className="min-w-0 truncate">
                        {activeOption.disabled ? activeOption.disabledReason : activeOption.description}
                      </span>
                    </>
                  ) : (
                    <span>Type to search · ↑ ↓ to move · ← → to change group · Enter to pick · Esc to close</span>
                  )}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

// The step's block: bordered and tinted so it reads as a control, darker on hover (80).
export const VOCAB_BLOCK_CLASS =
  "group/vocab inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md border border-accent-300 bg-accent-50 px-2 py-1 text-left font-medium text-accent-900 shadow-xs transition-colors hover:border-accent-500 hover:bg-accent-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 aria-expanded:border-accent-500 aria-expanded:bg-accent-100 disabled:cursor-default disabled:border-zinc-200 disabled:bg-zinc-50 disabled:text-zinc-700 disabled:shadow-none";
