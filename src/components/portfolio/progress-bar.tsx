import { formatProgress } from "@/lib/portfolios";

// Accessible progress meter. `percent` null means the denominator was 0 ("No tasks").
export function ProgressBar({
  percent,
  label,
  size = "md",
}: {
  percent: number | null;
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      aria-valuetext={formatProgress(percent)}
      className={`w-full overflow-hidden rounded-full bg-zinc-200 ${size === "sm" ? "h-1.5" : "h-2"}`}
    >
      <div className="h-full rounded-full bg-accent-600" style={{ width: `${percent ?? 0}%` }} />
    </div>
  );
}
