"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export type BarDatum = { key: string; label: string; count: number };

// Horizontal bars so long section/assignee names stay readable. The visually hidden table carries
// the same numbers for screen readers.
export function CountBarChart({ data, caption }: { data: BarDatum[]; caption: string }) {
  const height = Math.max(140, data.length * 34 + 30);
  return (
    <figure>
      <div aria-hidden style={{ height }} className="text-xs">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 4 }}>
            <CartesianGrid horizontal={false} stroke="#e4e4e7" />
            <XAxis type="number" allowDecimals={false} tick={{ fill: "#71717a", fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis
              type="category"
              dataKey="label"
              width={120}
              tick={{ fill: "#3f3f46", fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(value: string) => (value.length > 18 ? `${value.slice(0, 17)}…` : value)}
            />
            <Tooltip
              cursor={{ fill: "#f4f4f5" }}
              formatter={(value) => [value, "Tasks"]}
              contentStyle={{ borderRadius: 8, borderColor: "#e4e4e7", fontSize: 12 }}
            />
            <Bar dataKey="count" fill="var(--color-accent-500)" radius={[0, 4, 4, 0]} barSize={18} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
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
          {data.map((d) => (
            <tr key={d.key}>
              <th scope="row">{d.label}</th>
              <td>{d.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
