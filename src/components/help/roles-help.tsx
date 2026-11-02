import { Check, Minus } from "lucide-react";
import { NAMED_ROLES_NOTE, ROLE_TABLES, type RoleTable } from "@/lib/role-help";

// Nov 2 notes (batch 15, 109): the "Roles & permissions" page — one plain table per kind of role. Server
// component (no state). The Commenter column is left out while the workspace has the role turned off.
export function RolesHelp({ allowCommenter }: { allowCommenter: boolean }) {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8 px-gutter py-6">
      <nav aria-label="On this page" className="flex flex-wrap gap-2 text-xs">
        {ROLE_TABLES.map((table) => (
          <a key={table.id} href={`#${table.id}`} className="chip hover:bg-zinc-200">
            {table.title}
          </a>
        ))}
      </nav>
      {ROLE_TABLES.map((table) => (
        <RoleTableSection
          key={table.id}
          table={allowCommenter ? table : { ...table, columns: table.columns.filter((c) => c.key !== "commenter") }}
          footnote={table.id === "project-roles" ? NAMED_ROLES_NOTE : null}
        />
      ))}
      <p className="text-xs text-zinc-500">
        Older projects may still have an <strong className="font-medium text-zinc-700">Admin</strong> project role: it
        works like Owner but can&rsquo;t change owners. It isn&rsquo;t handed out any more.
      </p>
    </div>
  );
}

function RoleTableSection({ table, footnote }: { table: RoleTable; footnote: string | null }) {
  const headingId = `${table.id}-heading`;
  return (
    <section id={table.id} aria-labelledby={headingId} className="scroll-mt-4">
      <h2 id={headingId} className="text-base font-semibold text-zinc-900">
        {table.title}
      </h2>
      <p className="mt-1 max-w-3xl text-sm text-zinc-600">{table.intro}</p>
      <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-200">
        <table className="w-full min-w-[32rem] border-collapse text-sm">
          <caption className="sr-only">{table.title}: what each role can do</caption>
          <thead className="bg-zinc-50 text-left text-xs font-medium text-zinc-600">
            <tr>
              <th scope="col" className="px-3 py-2">
                Can…
              </th>
              {table.columns.map((column) => (
                <th key={column.key} scope="col" className="w-24 px-3 py-2 text-center" title={column.note}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row) => (
              <tr key={row.label} className="border-t border-zinc-100 even:bg-zinc-50/50">
                <th scope="row" className="px-3 py-2 text-left font-normal text-zinc-800">
                  {row.label}
                  {row.detail ? <span className="mt-0.5 block text-xs text-zinc-500">{row.detail}</span> : null}
                </th>
                {table.columns.map((column) => (
                  <td key={column.key} className="px-3 py-2 text-center">
                    {row.allowed[column.key] ? (
                      <Check className="mx-auto size-4 text-emerald-600" aria-label="Yes" />
                    ) : (
                      <Minus className="mx-auto size-4 text-zinc-300" aria-label="No" />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footnote ? <p className="mt-2 text-xs text-zinc-500">{footnote}</p> : null}
    </section>
  );
}
