export type BarDatum = { key: string; label: string; count: number };

function shortLabel(label: string) {
  return label.length > 18 ? `${label.slice(0, 17)}…` : label;
}

// Horizontal bars so long section and assignee names stay readable. The visually hidden table
// carries the same numbers for screen readers. Plain markup, so the reports pages do not ship
// a chart library.
export function CountBarChart({ data, caption }: { data: BarDatum[]; caption: string }) {
  const max = Math.max(1, ...data.map((item) => item.count));
  return (
    <figure>
      <div aria-hidden className="flex flex-col gap-1.5 text-xs">
        {data.map((item) => (
          <div key={item.key} className="grid grid-cols-[7.5rem_minmax(0,1fr)_2.5rem] items-center gap-2" title={`${item.label}: ${item.count} tasks`}>
            <span className="truncate text-zinc-700" title={item.label}>
              {shortLabel(item.label)}
            </span>
            <span className="h-4 overflow-hidden rounded-r bg-zinc-100">
              <span
                className="block h-full rounded-r bg-accent-500"
                style={{ width: `${Math.max(item.count === 0 ? 0 : 2, (item.count / max) * 100)}%` }}
              />
            </span>
            <span className="text-right tabular-nums text-zinc-500">{item.count}</span>
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
