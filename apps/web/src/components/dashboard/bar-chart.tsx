// Nov 2 notes (batch 13, note 91): one light hue per chart (a bar's own tone wins — status bars wear the
// status colors). Values and labels stay in text ink; the color only marks the bar.
export type BarTone = "blue" | "teal" | "violet" | "amber" | "red" | "green";
export type BarDatum = { key: string; label: string; count: number; tone?: BarTone };

const TONE_CLASS: Record<BarTone, string> = {
  blue: "bg-accent-500",
  teal: "bg-teal-500",
  violet: "bg-violet-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  green: "bg-emerald-500",
};

function shortLabel(label: string) {
  return label.length > 18 ? `${label.slice(0, 17)}…` : label;
}

// Horizontal bars so long section and assignee names stay readable. The visually hidden table
// carries the same numbers for screen readers. Plain markup, so the reports pages do not ship
// a chart library.
export function CountBarChart({ data, caption, tone = "blue" }: { data: BarDatum[]; caption: string; tone?: BarTone }) {
  const max = Math.max(1, ...data.map((item) => item.count));
  return (
    <figure>
      <div aria-hidden className="flex flex-col gap-2 text-xs">
        {data.map((item) => (
          <div key={item.key} className="grid grid-cols-[7.5rem_minmax(0,1fr)_2.5rem] items-center gap-2" title={`${item.label}: ${item.count} tasks`}>
            <span className="truncate text-zinc-700" title={item.label}>
              {shortLabel(item.label)}
            </span>
            <span className="h-3.5 overflow-hidden rounded bg-zinc-100/80">
              <span
                className={`block h-full rounded ${TONE_CLASS[item.tone ?? tone]}`}
                style={{ width: `${Math.max(item.count === 0 ? 0 : 2, (item.count / max) * 100)}%` }}
              />
            </span>
            <span className="text-right font-medium tabular-nums text-zinc-700">{item.count.toLocaleString("en-US")}</span>
          </div>
        ))}
      </div>
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Group</th>
            <th scope="col">Tasks</th>
          </tr>
        </thead>
        <tbody>
          {data.map((item) => (
            <tr key={item.key}>
              <th scope="row">{item.label}</th>
              <td>{item.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
