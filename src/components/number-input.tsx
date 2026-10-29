"use client";

import { useId, type CSSProperties, type InputHTMLAttributes, type Ref } from "react";
import { normalizeNumberPrefix } from "@/lib/fields";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "prefix"> & {
  // The field's symbol (item 49): drawn inside the box before the digits; none = a plain number box.
  symbol?: string | null;
  // Layout classes for the wrapper when there is a symbol (the input then fills it).
  wrapperClassName?: string;
  // The symbol's text size, to match the box's (text-sm by default).
  symbolClassName?: string;
  ref?: Ref<HTMLInputElement>;
};

// Room for the symbol: the box's own left padding, the symbol (about 1ch a character), and a gap.
export function prefixPadding(prefix: string): CSSProperties {
  return { paddingLeft: `calc(0.875rem + ${[...prefix].length}ch)` };
}

// A number box that shows a number field's symbol ("$", "€", "#") as an adornment. The value stays a
// plain number; the symbol is decoration (aria-hidden) and is read out through aria-describedby.
export function NumberInput({
  symbol: rawSymbol,
  wrapperClassName = "",
  symbolClassName = "text-sm",
  className = "",
  style,
  ...props
}: Props) {
  const descriptionId = useId();
  const symbol = normalizeNumberPrefix(rawSymbol);
  if (!symbol) return <input type="number" step="any" {...props} className={className} style={style} />;
  const describedBy = [props["aria-describedby"], descriptionId].filter(Boolean).join(" ");
  return (
    <span className={`relative inline-flex min-w-0 items-center ${wrapperClassName}`} data-number-prefix={symbol}>
      <span
        aria-hidden
        className={`pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 select-none text-zinc-500 ${symbolClassName}`}
      >
        {symbol}
      </span>
      <span id={descriptionId} className="sr-only">
        In {symbol}
      </span>
      <input
        type="number"
        step="any"
        {...props}
        aria-describedby={describedBy}
        className={`w-full ${className}`}
        style={{ ...style, ...prefixPadding(symbol) }}
      />
    </span>
  );
}
