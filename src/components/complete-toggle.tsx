"use client";

import { Check } from "lucide-react";

export function CompleteToggle({
  completed,
  onToggle,
  label,
  size = "md",
  disabled = false,
}: {
  completed: boolean;
  onToggle: () => void;
  label: string;
  size?: "sm" | "md";
  disabled?: boolean;
}) {
  const dimensions = size === "sm" ? "size-4" : "size-[18px]";
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={completed}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={`${dimensions} inline-flex shrink-0 items-center justify-center rounded-full border transition ${
        completed
          ? "border-accent-600 bg-accent-600 text-white"
          : "border-zinc-300 text-transparent enabled:hover:border-accent-500 enabled:hover:text-accent-500"
      } disabled:cursor-default`}
    >
      <Check className="size-[70%]" strokeWidth={3} />
    </button>
  );
}
