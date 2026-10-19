"use client";

import { Check, ChevronDown, Search } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  filterOptions,
  flatOptions,
  initialActive,
  isPrintableKey,
  pickerKey,
  typeAhead,
  type PickerOption,
} from "@/lib/smart-picker";

export type SmartOption = PickerOption & {
  // A small icon (or avatar / color dot) before the label.
  icon?: ReactNode;
};

type CommonProps = {
  // The accessible name ("Trigger", "Section", "Assignee").
  label: string;
  options: readonly SmartOption[];
  // Shown when nothing is chosen ("Choose section"). Chips draw it with a dashed underline.
  placeholder?: string;
  // control: an input-like box; chip: an inline sentence token; ghost: a plain text button (+ Add …).
  variant?: "control" | "chip" | "ghost";
  disabled?: boolean;
  // A search box is shown for longer lists (or always / never).
  searchable?: boolean;
  // What the closed button shows (defaults to the chosen option's icon and label).
  renderValue?: (selected: SmartOption[]) => ReactNode;
  // Marks an unfilled slot that still needs a value (amber), e.g. after installing a template.
  highlight?: boolean;
  className?: string;
  id?: string;
  emptyText?: string;
  // Width of the list (at least the button's width).
  panelWidth?: number;
};

type SingleProps = CommonProps & {
  multiple?: false;
  value: string | null | undefined;
  onChange: (value: string) => void;
};

type MultiProps = CommonProps & {
  multiple: true;
  value: readonly string[];
  onChange: (value: string[]) => void;
};

const BUTTON_CLASS = {
  control:
    "control inline-flex h-auto min-h-7 max-w-full items-center gap-1.5 py-0.5 text-left aria-expanded:border-accent-500/60 aria-expanded:shadow-[0_0_0_3px_var(--focus-ring)]",
  chip: "inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-left font-medium text-accent-700 hover:bg-accent-50 focus-visible:bg-accent-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 aria-expanded:bg-accent-50 disabled:cursor-default disabled:text-zinc-700 disabled:hover:bg-transparent",
  ghost: "btn-ghost",
} as const;

// Inside a provider set to true, every empty picker (but "ghost" buttons) is highlighted: the rule
// builder turns it on for a rule that came from a template, so the slots still to fill stand out.
export const PickerHighlightContext = createContext(false);

// One searchable, grouped picker for the rules builder (and anything else that needs one): a button
// that opens a listbox drawn on document.body, so panels and scroll containers never clip it.
// Keyboard: ↑ ↓ Home End PageUp PageDown to move, Enter to choose, Esc to close (a first Esc clears the
// search), Tab to leave; typing searches (or, without a search box, jumps to the matching option);
// on the closed button ↓ / Enter / Space open it and typing jumps there too. ARIA: the button is a
// combobox with a listbox popup; options sit in labelled groups with aria-selected / aria-disabled.
export function SmartPicker(props: SingleProps | MultiProps) {
  const {
    label,
    options,
    placeholder = "Choose…",
    variant = "control",
    disabled = false,
    renderValue,
    className = "",
    emptyText = "Nothing matches",
    panelWidth = 300,
  } = props;
  // "" counts as a choice when an option has that value ("Any form", "any tag", "Nobody").
  const selected = useMemo<string[]>(
    () =>
      props.multiple
        ? [...props.value]
        : props.value || (props.value === "" && options.some((o) => o.value === ""))
          ? [props.value]
          : [],
    [props.multiple, props.value, options],
  );
  const highlightAll = useContext(PickerHighlightContext);
  const highlight = props.highlight ?? (highlightAll && variant !== "ghost");
  const searchable = props.searchable ?? options.length > 7;
  const autoId = useId();
  const buttonId = props.id ?? `picker-${autoId}`;
  const listId = `${buttonId}-list`;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typed = useRef<{ buffer: string; at: number }>({ buffer: "", at: 0 });

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);

  const groups = useMemo(() => filterOptions(options, query), [options, query]);
  const visible = useMemo(() => flatOptions(groups), [groups]);
  const selectedOptions = options.filter((o) => selected.includes(o.value));

  const place = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 8;
    // At least the button's width (for input-like boxes), but never a sprawling list.
    const width = Math.min(Math.max(Math.min(rect.width, 480), panelWidth), window.innerWidth - margin * 2);
    const below = window.innerHeight - rect.bottom - margin;
    const above = rect.top - margin;
    const wanted = Math.min(panelRef.current?.scrollHeight ?? 360, 360);
    const downward = below >= Math.min(wanted, 240) || below >= above;
    const maxHeight = Math.max(Math.min(360, (downward ? below : above) - 4), 120);
    const height = Math.min(wanted, maxHeight);
    const top = downward ? rect.bottom + 4 : rect.top - 4 - height;
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
    setPosition({ top, left, width, maxHeight });
  }, [panelWidth]);

  function openList(initialQuery = "") {
    if (disabled) return;
    setQuery(initialQuery);
    const nextVisible = flatOptions(filterOptions(options, initialQuery));
    setActive(initialQuery ? initialActive(nextVisible, []) : initialActive(nextVisible, selected));
    // Placed right away (not hidden for a frame), so the search box can take focus — and the first
    // typed letters — at once; the layout effect refines it once the list is measured.
    place();
    setOpen(true);
  }

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setQuery("");
    setPosition(null);
    if (refocus) buttonRef.current?.focus();
  }, []);

  function choose(value: string) {
    if (props.multiple) {
      const next = selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value];
      props.onChange(next);
    } else {
      props.onChange(value);
      close();
    }
  }

  // Place the list once drawn (and again whenever its content changes size), and follow the button
  // when anything scrolls or the window resizes.
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place, visible.length]);

  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) close(false);
    };
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    document.addEventListener("mousedown", onPointer);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open, place, close]);

  useEffect(() => {
    if (!open) return;
    (searchable ? inputRef.current : listRef.current)?.focus({ preventScroll: true });
  }, [open, searchable]);

  // Keep the highlighted option in view.
  useEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, listId]);

  function onListKey(e: ReactKeyboardEvent) {
    // Escape is handled here so the page around (the rule canvas, the task pane) leaves it alone.
    const result = pickerKey({ open, active, query }, e.key, visible);
    if (!result.handled && !searchable && isPrintableKey(e.key, { ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey })) {
      const now = Date.now();
      typed.current = { buffer: (now - typed.current.at < 1000 ? typed.current.buffer : "") + e.key, at: now };
      setActive(typeAhead(visible, typed.current.buffer, active));
      e.preventDefault();
      return;
    }
    if (!result.handled) {
      if (result.effect.kind === "blur") close(false);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (result.state.query !== query) {
      setQuery(result.state.query);
      setActive(initialActive(flatOptions(filterOptions(options, result.state.query)), selected));
    } else {
      setActive(result.state.active);
    }
    if (result.effect.kind === "select") choose(result.effect.value);
    else if (result.effect.kind === "close") close();
  }

  function onButtonKey(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (disabled || open) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openList();
    } else if (isPrintableKey(e.key, { ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey })) {
      e.preventDefault();
      if (searchable) {
        openList(e.key);
      } else {
        // Type-ahead on a short list: open it on the first match.
        const now = Date.now();
        typed.current = { buffer: (now - typed.current.at < 1000 ? typed.current.buffer : "") + e.key, at: now };
        const all = flatOptions(filterOptions(options, ""));
        openList();
        setActive(typeAhead(all, typed.current.buffer, initialActive(all, selected)));
      }
    }
  }

  const empty = selectedOptions.length === 0;
  const display = renderValue ? (
    renderValue(selectedOptions)
  ) : empty ? (
    <span className={variant === "chip" ? "border-b border-dashed border-current font-normal" : "text-zinc-400"}>{placeholder}</span>
  ) : props.multiple ? (
    <span className="truncate">{selectedOptions.map((o) => o.label).join(", ")}</span>
  ) : (
    <>
      {selectedOptions[0].icon ? <span className="flex shrink-0 items-center">{selectedOptions[0].icon}</span> : null}
      <span className="truncate">{selectedOptions[0].label}</span>
    </>
  );

  let optionIndex = -1;
  return (
    <>
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        data-picker-empty={empty || undefined}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onButtonKey}
        className={`${BUTTON_CLASS[variant]} ${
          highlight && empty ? "rounded-md bg-amber-50 text-amber-800 ring-1 ring-amber-300" : ""
        } ${className}`}
      >
        {display}
        {variant === "control" ? <ChevronDown className="ml-auto size-3.5 shrink-0 text-zinc-400" aria-hidden /> : null}
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              data-smart-picker
              style={
                position
                  ? { top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight }
                  : { visibility: "hidden", top: 0, left: 0, width: panelWidth }
              }
              className="fixed z-[70] flex flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white text-sm shadow-lg"
              onKeyDown={onListKey}
            >
              {searchable ? (
                <div className="flex shrink-0 items-center gap-2 border-b border-zinc-100 px-2.5 py-2">
                  <Search className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
                  <input
                    ref={inputRef}
                    role="combobox"
                    aria-label={`Search ${label.toLowerCase()}`}
                    aria-autocomplete="list"
                    aria-expanded
                    aria-controls={listId}
                    aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
                    value={query}
                    placeholder="Search…"
                    onChange={(e) => {
                      const next = e.currentTarget.value;
                      setQuery(next);
                      setActive(initialActive(flatOptions(filterOptions(options, next)), next ? [] : selected));
                    }}
                    className="min-w-0 flex-1 bg-transparent text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none"
                  />
                </div>
              ) : null}
              <ul
                ref={listRef}
                id={listId}
                role="listbox"
                aria-label={label}
                aria-multiselectable={props.multiple || undefined}
                aria-activedescendant={!searchable && active >= 0 ? `${listId}-${active}` : undefined}
                tabIndex={searchable ? undefined : -1}
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1 focus:outline-none"
              >
                {visible.length === 0 ? (
                  <li role="presentation" className="px-2.5 py-3 text-center text-xs text-zinc-500">
                    {emptyText}
                  </li>
                ) : (
                  groups.map((group, g) => {
                    const headingId = `${listId}-g${g}`;
                    const items = group.options.map((option) => {
                      optionIndex += 1;
                      const index = optionIndex;
                      const isSelected = selected.includes(option.value);
                      const note = option.disabled ? option.disabledReason : option.description;
                      return (
                        <li
                          key={option.value}
                          id={`${listId}-${index}`}
                          role="option"
                          aria-selected={isSelected}
                          aria-disabled={option.disabled || undefined}
                          data-active={index === active || undefined}
                          onMouseMove={() => {
                            if (index !== active && !option.disabled) setActive(index);
                          }}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            if (!option.disabled) choose(option.value);
                          }}
                          className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 data-[active]:bg-accent-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                        >
                          {option.icon ? (
                            <span aria-hidden className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded text-zinc-500">
                              {option.icon}
                            </span>
                          ) : null}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-zinc-900">{option.label}</span>
                            {note ? <span className="block text-xs leading-snug text-zinc-500">{note}</span> : null}
                          </span>
                          {isSelected ? <Check className="mt-0.5 size-4 shrink-0 text-accent-600" aria-hidden /> : null}
                        </li>
                      );
                    });
                    return group.name ? (
                      <li key={group.name} role="presentation">
                        <div id={headingId} role="presentation" className="px-2 pb-0.5 pt-2 text-2xs font-semibold uppercase tracking-wide text-zinc-400">
                          {group.name}
                        </div>
                        <ul role="group" aria-labelledby={headingId}>
                          {items}
                        </ul>
                      </li>
                    ) : (
                      items
                    );
                  })
                )}
              </ul>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
