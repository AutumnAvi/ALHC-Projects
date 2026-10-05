"use client";

import { Check } from "lucide-react";

export function CompleteToggle({
  completed,
  onToggle,
  label,
  size = "md",
}: {
  completed: boolean;
  onToggle: () => void;
  label: string;
  size?: "sm" | "md";
}) {
  const dimensions = size === "sm" ? "size-4" : "size-[18px]";
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={completed}
      aria-label={label}
      onClick={onToggle}
      className={`${dimensions} inline-flex shrink-0 items-center justify-center rounded-full border transition ${
        completed
          ? "border-accent-600 bg-accent-600 text-white"
          : "border-zinc-300 text-transparent hover:border-accent-500 hover:text-accent-500"
      }`}
    >
      <Check className="size-[70%]" strokeWidth={3} />
    </button>
  );
}
