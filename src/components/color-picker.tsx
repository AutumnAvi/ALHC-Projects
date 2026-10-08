"use client";

import { Check } from "lucide-react";
import { Popover } from "@/components/popover";
import { OPTION_COLORS, OPTION_COLOR_LABELS, OPTION_SWATCH_CLASSES, type OptionColor } from "@/lib/fields";

export function ColorSwatch({ color, className = "size-3" }: { color: OptionColor; className?: string }) {
  return <span aria-hidden className={`inline-block shrink-0 rounded-full ring-1 ring-black/10 ${OPTION_SWATCH_CLASSES[color]} ${className}`} />;
}

// The one color picker (tags, field options, portfolio field options): a swatch next to every color
// name. `label` names what is being colored for screen readers, e.g. "Color of High".
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
      panelClassName="w-44 p-1.5"
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
        <ul role="listbox" aria-label={label} className="flex flex-col gap-px">
          {OPTION_COLORS.map((color) => (
            <li key={color} role="option" aria-selected={color === value}>
              <button
                type="button"
                onClick={() => {
                  close();
                  if (color !== value) onChange(color);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100"
              >
                <ColorSwatch color={color} />
                <span className="flex-1">{OPTION_COLOR_LABELS[color]}</span>
                {color === value ? <Check className="size-3.5 text-accent-600" aria-hidden /> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  );
}
