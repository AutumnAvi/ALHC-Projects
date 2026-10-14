import { seriesLabel, type SeriesInterval } from "@/lib/reports";

export type SeriesDatum = { start: string; count: number };

// Completed tasks per local day or week as vertical bars. The visually hidden table carries the same
// numbers for screen readers (like CountBarChart).
export function SeriesChart({
  data,
  interval,
  caption,
  height = 220,
}: {
  data: SeriesDatum[];
  interval: SeriesInterval;
  caption: string;
  height?: number;
}) {
  const max = Math.max(1, ...data.map((item) => item.count));
  const rows = data.map((item) => ({
    ...item,
    label: seriesLabel(item.start, interval).replace("Week of ", ""),
  }));
  return (
    <figure>
      <div aria-hidden className="flex items-end gap-1" style={{ height }}>
        {rows.map((item) => (
          <div key={item.start} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${interval === "week" ? "Week of " : ""}${item.label}: ${item.count} completed`}>
            <span
              className="w-full rounded-t bg-accent-500"
              style={{ height: `${Math.max(item.count === 0 ? 0 : 2, (item.count / max) * 100)}%` }}
            />
            <span className="mt-1 truncate text-center text-[10px] text-zinc-500">{item.label}</span>
          </div>
        ))}
      </div>
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{interval === "week" ? "Week" : "Day"}</th>
            <th scope="col">Completed</th>
          </tr>
        </thead>
        <tbody>
          {data.map((item) => (
            <tr key={item.start}>
              <th scope="row">{seriesLabel(item.start, interval)}</th>
              <td>{item.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
