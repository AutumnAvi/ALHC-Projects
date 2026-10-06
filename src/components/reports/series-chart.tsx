"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
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
  const rows = data.map((d) => ({ ...d, label: seriesLabel(d.start, interval).replace("Week of ", "") }));
  return (
    <figure>
      <div aria-hidden style={{ height }} className="text-xs">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 4, left: -16 }}>
            <CartesianGrid vertical={false} stroke="#e4e4e7" />
            <XAxis
              dataKey="label"
              tick={{ fill: "#71717a", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis allowDecimals={false} tick={{ fill: "#71717a", fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip
              cursor={{ fill: "#f4f4f5" }}
              formatter={(value) => [value, "Completed"]}
              labelFormatter={(label) => (interval === "week" ? `Week of ${label}` : String(label))}
              contentStyle={{ borderRadius: 8, borderColor: "#e4e4e7", fontSize: 12 }}
            />
            <Bar dataKey="count" fill="var(--color-accent-500)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
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
          {data.map((d) => (
            <tr key={d.start}>
              <th scope="row">{seriesLabel(d.start, interval)}</th>
              <td>{d.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
