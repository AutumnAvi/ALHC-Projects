import { formatRequestLabel, type RequestLabel } from "@/lib/request-numbers";

// Oct 26 notes, batch 4: a task's number as a small muted badge next to its name — on Timeline rows,
// Calendar bars, the dependency picker, and search — with the project's name when the task comes from
// another project than the one on screen ("Task #12 · Website"). Nothing when the task has no number.
// Server-safe (no hooks), so search results and other server components can use it too.
export function TaskNumberBadge({
  label,
  projectName = null,
  size = "xs",
  tone = "muted",
  className = "",
}: {
  label: RequestLabel | null | undefined;
  // Only when the task is from a different project than the screen's.
  projectName?: string | null;
  // "2xs" = calendar bars: tiny, so the task's name keeps the room.
  size?: "xs" | "2xs";
  // "inherit" = the surrounding text color, a little lighter (inside a colored bar).
  tone?: "muted" | "inherit";
  className?: string;
}) {
  const text = formatRequestLabel(label);
  if (!text && !projectName) return null;
  return (
    <span
      className={`inline-flex min-w-0 shrink-0 items-center gap-1 whitespace-nowrap font-normal tabular-nums ${
        tone === "muted" ? "text-zinc-400" : "opacity-75"
      } ${
        size === "2xs" ? "text-[10px] leading-none" : "text-2xs"
      } ${className}`}
    >
      {text ? <span>{text}</span> : null}
      {text && projectName ? <span aria-hidden>·</span> : null}
      {projectName ? <span className="truncate">{projectName}</span> : null}
    </span>
  );
}

// Screen-reader / tooltip text for the same thing: "Task #12, in Website".
export function taskNumberText(label: RequestLabel | null | undefined, projectName: string | null = null): string {
  const text = formatRequestLabel(label);
  return [text, projectName ? `in ${projectName}` : ""].filter(Boolean).join(", ");
}
