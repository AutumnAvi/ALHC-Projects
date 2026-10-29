"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
import { Popover } from "@/components/popover";
import {
  OPTION_COLOR_GRID,
  OPTION_COLOR_GRID_COLUMNS,
  OPTION_COLOR_LABELS,
  OPTION_SWATCH_CLASSES,
  type OptionColor,
} from "@/lib/fields";

export function ColorSwatch({ color, className = "size-3" }: { color: OptionColor; className?: string }) {
  return <span aria-hidden className={`inline-block shrink-0 rounded-full ring-1 ring-black/10 ${OPTION_SWATCH_CLASSES[color]} ${className}`} />;
}

// The one color picker (tags, field options, portfolio field options): the button shows the swatch (and
// the color's name unless compact); it opens a grid of every color in the palette (Oct 29 notes, item
// 54). `label` names what is being colored for screen readers, e.g. "Color of High".
export function ColorPicker({
  value,
  onChange,
  label,
  disabled = false,
  compact = false,
}: {
  value: OptionColor;
  onChange: (color: OptionColor) => void;
  label: string;
  disabled?: boolean;
  // Just the swatch (inside a chip); otherwise swatch + name.
  compact?: boolean;
}) {
  if (disabled) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-zinc-600">
        <ColorSwatch color={value} />
        {compact ? <span className="sr-only">{OPTION_COLOR_LABELS[value]}</span> : OPTION_COLOR_LABELS[value]}
      </span>
    );
  }
  return (
    <Popover
      label={`${label}: ${OPTION_COLOR_LABELS[value]}`}
      tooltip={compact ? `Color: ${OPTION_COLOR_LABELS[value]}` : undefined}
      panelClassName="w-auto p-2"
      buttonClassName={
        compact
          ? "inline-flex size-5 items-center justify-center rounded hover:bg-black/10"
          : "control inline-flex h-8 w-auto items-center gap-1.5 font-normal"
      }
      button={
        <>
          <ColorSwatch color={value} />
          {compact ? null : <span className="text-sm text-zinc-800">{OPTION_COLOR_LABELS[value]}</span>}
        </>
      }
    >
      {(close) => (
        <ColorGrid
          value={value}
          label={label}
          onPick={(color) => {
            close();
            if (color !== value) onChange(color);
          }}
        />
      )}
    </Popover>
  );
}

// Where the arrow keys take the focus in the grid (OPTION_COLOR_GRID_COLUMNS wide): left / right wrap
// through the whole palette, up / down move a row and stop at the edges, Home / End go to the ends.
export function colorGridStep(index: number, key: string, count = OPTION_COLOR_GRID.length, columns = OPTION_COLOR_GRID_COLUMNS) {
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "ArrowDown":
      return index + columns < count ? index + columns : index;
    case "ArrowUp":
      return index - columns >= 0 ? index - columns : index;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

// The palette as a grid of swatches: the picked one has a ring and a check, the name of the color under
// the pointer or the focus shows below (each swatch also has its name as a tooltip and label). Focus
// starts on the picked color; arrow keys move, Enter or Space picks.
export function ColorGrid({
  value,
  label,
  onPick,
}: {
  value: OptionColor;
  label: string;
  onPick: (color: OptionColor) => void;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const [focused, setFocused] = useState(() => Math.max(OPTION_COLOR_GRID.indexOf(value), 0));
  const [named, setNamed] = useState<OptionColor | null>(null);

  // When the grid opens, focus the picked color (later moves focus their button themselves).
  useEffect(() => {
    (buttons.current.find((b) => b?.getAttribute("aria-selected") === "true") ?? buttons.current[0])?.focus();
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const next = colorGridStep(focused, e.key);
    if (next === null) return;
    e.preventDefault();
    setFocused(next);
    buttons.current[next]?.focus();
  }

  return (
    <div>
      <div
        role="listbox"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${OPTION_COLOR_GRID_COLUMNS}, minmax(0, 1fr))` }}
        onMouseLeave={() => setNamed(null)}
      >
        {OPTION_COLOR_GRID.map((color, index) => {
          const selected = color === value;
          return (
            <button
              key={color}
              ref={(el) => {
                buttons.current[index] = el;
              }}
              type="button"
              role="option"
              aria-selected={selected}
              aria-label={OPTION_COLOR_LABELS[color]}
              data-tooltip={OPTION_COLOR_LABELS[color]}
              data-color={color}
              tabIndex={index === focused ? 0 : -1}
              onClick={() => onPick(color)}
              onMouseEnter={() => setNamed(color)}
              onFocus={() => {
                setFocused(index);
                setNamed(color);
              }}
              className={`flex size-7 items-center justify-center rounded-full outline-none hover:bg-zinc-100 focus-visible:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-accent-500 ${
                selected ? "ring-2 ring-zinc-700" : ""
              }`}
            >
              <span aria-hidden className={`flex size-5 items-center justify-center rounded-full ring-1 ring-black/10 ${OPTION_SWATCH_CLASSES[color]}`}>
                {selected ? <Check className="size-3 text-white drop-shadow-[0_1px_1px_rgb(0_0_0/0.6)]" strokeWidth={3} aria-hidden /> : null}
              </span>
            </button>
          );
        })}
      </div>
      <p aria-hidden className="mt-1.5 truncate px-0.5 text-xs text-zinc-600">
        {OPTION_COLOR_LABELS[named ?? value]}
      </p>
    </div>
  );
}
