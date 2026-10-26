"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Archive, ArrowDown, ArrowUp, Check, ChevronDown, FolderKanban, Globe, Lock, Search, X } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { PROJECT_STATUS_DOT } from "@/components/project-status-badge";
import { Popover } from "@/components/popover";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { joinProject } from "@/lib/actions";
import { PROJECT_STATUSES, PROJECT_STATUS_LABELS, isProjectStatus } from "@/lib/portfolios";
import { projectColorClass } from "@/lib/project-colors";
import { ROLE_LABELS, isProjectRole } from "@/lib/roles";
import { VISIBILITY_LABELS, type BrowseProject } from "@/lib/workspace";

export type BrowseRow = BrowseProject & {
  // Null when the database can't tell yet (a preview without this release's migration).
  ownerIds: string[] | null;
  memberIds: string[] | null;
  modifiedAt: string | null;
};
type Person = { id: string; name: string };
type Team = { id: string; name: string };
type SortKey = "name" | "modified";

const ARCHIVED = "archived";

// Asana's Browse projects (Asana parity, batch 4): one table of every project the viewer may see — their
// own, plus projects shared with their teams (Join = Editor) — with a search box, filter pills (Owner,
// Members, Teams, Status), and Name / Members / Last modified columns. Private projects of others never
// reach it, workspace admins included.
export function BrowseProjectsTable({
  projects,
  people,
  teams,
  meId,
  initialTeamId,
  peopleKnown,
}: {
  projects: BrowseRow[];
  people: Person[];
  teams: Team[];
  meId: string;
  initialTeamId: string | null;
  // False on a database without browse_project_people: Owner and Members can't filter yet.
  peopleKnown: boolean;
}) {
  const [pending, run] = useServerAction();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [owners, setOwners] = useState<string[]>([]);
  const [members, setMembers] = useState<string[]>([]);
  const [teamIds, setTeamIds] = useState<string[]>(initialTeamId ? [initialTeamId] : []);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "name", dir: "asc" });
  const names = useMemo(() => new Map(people.map((p) => [p.id, p.name] as const)), [people]);

  // People and teams that occur in the list (the viewer first), so pickers never offer an empty filter.
  const ownerChoices = useMemo(() => choices(projects.flatMap((p) => p.ownerIds ?? []), people, meId), [projects, people, meId]);
  const memberChoices = useMemo(() => choices(projects.flatMap((p) => p.memberIds ?? []), people, meId), [projects, people, meId]);
  const teamChoices = useMemo(() => {
    const present = new Set(projects.map((p) => p.teamId));
    return teams.filter((t) => present.has(t.id) || teamIds.includes(t.id));
  }, [projects, teams, teamIds]);

  const needle = query.trim().toLowerCase();
  const shown = useMemo(() => {
    const filtered = projects.filter((p) => {
      if (needle && !p.name.toLowerCase().includes(needle) && !(p.description ?? "").toLowerCase().includes(needle)) return false;
      if (owners.length && !(p.ownerIds ?? []).some((id) => owners.includes(id))) return false;
      if (members.length && !(p.memberIds ?? []).some((id) => members.includes(id))) return false;
      if (teamIds.length && !teamIds.includes(p.teamId)) return false;
      if (statuses.length) {
        const key = p.archived ? ARCHIVED : p.status;
        if (!statuses.includes(key)) return false;
      }
      return true;
    });
    const factor = sort.dir === "asc" ? 1 : -1;
    return filtered.sort((a, b) => {
      if (sort.key === "modified") {
        const diff = (a.modifiedAt ?? "").localeCompare(b.modifiedAt ?? "");
        if (diff) return diff * factor;
      }
      return a.name.localeCompare(b.name) * (sort.key === "name" ? factor : 1);
    });
  }, [projects, needle, owners, members, teamIds, statuses, sort]);

  const filtering = Boolean(needle || owners.length || members.length || teamIds.length || statuses.length);
  // Oct 26 notes (batch 4): archived projects get their own section under the rest.
  const activeRows = shown.filter((p) => !p.archived);
  const archivedRows = shown.filter((p) => p.archived);

  function clear() {
    setQuery("");
    setOwners([]);
    setMembers([]);
    setTeamIds([]);
    setStatuses([]);
  }

  function toggleSort(key: SortKey) {
    setSort((current) =>
      current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "modified" ? "desc" : "asc" },
    );
  }

  function join(project: BrowseRow) {
    run(async () => {
      const result = await joinProject(project.projectId);
      if (!result.error) router.push(`/projects/${project.projectId}`);
      return result;
    });
  }

  const statusChoices = [
    ...PROJECT_STATUSES.map((s) => ({ id: s, name: PROJECT_STATUS_LABELS[s], dot: PROJECT_STATUS_DOT[s] })),
    { id: ARCHIVED, name: "Archived", dot: "bg-zinc-300" },
  ];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative block w-full sm:w-64">
          <span className="sr-only">Find a project</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Find a project"
            className="control h-8 w-full pl-8"
          />
        </label>
        <FilterPill
          label="Owner"
          options={ownerChoices}
          value={owners}
          onChange={setOwners}
          disabledNote={peopleKnown ? null : "Owners show once this release’s database update is applied"}
        />
        <FilterPill
          label="Members"
          options={memberChoices}
          value={members}
          onChange={setMembers}
          disabledNote={peopleKnown ? null : "Members show once this release’s database update is applied"}
        />
        <FilterPill label="Teams" options={teamChoices} value={teamIds} onChange={setTeamIds} />
        <FilterPill label="Status" options={statusChoices} value={statuses} onChange={setStatuses} />
        {filtering ? (
          <button type="button" onClick={clear} className="btn-ghost h-8 text-xs">
            <X className="size-3.5" aria-hidden />
            Clear filters
          </button>
        ) : null}
        <span className="ml-auto text-xs tabular-nums text-zinc-500" aria-live="polite">
          {shown.length} of {projects.length} {projects.length === 1 ? "project" : "projects"}
        </span>
      </div>

      {projects.length === 0 ? (
        <div className="mt-4">
          <EmptyState icon={FolderKanban} title="No projects to show">
            Projects you’re in, and projects set to “Public to team” in your teams, show up here.
          </EmptyState>
        </div>
      ) : shown.length === 0 ? (
        <div className="mt-4">
          <EmptyState icon={Search} title="No projects match" size="inline">
            Try another name or remove a filter.
          </EmptyState>
        </div>
      ) : (
        <>
          {activeRows.length > 0 ? (
            <ProjectTable rows={activeRows} sort={sort} onSort={toggleSort} names={names} pending={pending} onJoin={join} />
          ) : (
            <div className="mt-4">
              <EmptyState icon={Search} title={filtering ? "No active projects match" : "No active projects"} size="inline">
                {filtering ? "Try another name or remove a filter." : "Every project here is archived."}
              </EmptyState>
            </div>
          )}
          {archivedRows.length > 0 ? (
            <section aria-labelledby="browse-archived-heading" className="mt-8">
              <h2 id="browse-archived-heading" className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
                <Archive className="size-4 text-zinc-500" aria-hidden />
                Archived
                <span className="text-xs font-normal tabular-nums text-zinc-500">{archivedRows.length}</span>
              </h2>
              <p className="mt-0.5 text-xs text-zinc-500">
                Read-only for everyone until an admin or owner unarchives them. They’re not in the sidebar, Home, or
                project pickers.
              </p>
              <ProjectTable rows={archivedRows} sort={sort} onSort={toggleSort} names={names} pending={pending} onJoin={join} />
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

// One table of projects (the active ones, or the Archived section's).
function ProjectTable({
  rows,
  sort,
  onSort,
  names,
  pending,
  onJoin,
}: {
  rows: BrowseRow[];
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (key: SortKey) => void;
  names: Map<string, string>;
  pending: boolean;
  onJoin: (project: BrowseRow) => void;
}) {
  const toggleSort = onSort;
  const join = onJoin;
  return (
    <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-200">
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs text-zinc-500">
            <th scope="col" aria-sort={sort.key === "name" ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className="px-3 py-2 font-medium">
              <SortButton label="Name" active={sort.key === "name"} dir={sort.dir} onClick={() => toggleSort("name")} />
            </th>
            <th scope="col" className="w-44 px-3 py-2 font-medium">
              Members
            </th>
            <th
              scope="col"
              aria-sort={sort.key === "modified" ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
              className="w-36 px-3 py-2 font-medium"
            >
              <SortButton label="Last modified" active={sort.key === "modified"} dir={sort.dir} onClick={() => toggleSort("modified")} />
            </th>
            <th scope="col" className="w-28 px-3 py-2 font-medium">
              <span className="sr-only">Join</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const member = p.myRole !== null;
            const memberIds = p.memberIds ?? [];
            const shownMembers = memberIds.slice(0, 3);
            return (
              <tr key={p.projectId} className="border-b border-zinc-100 last:border-b-0 hover:bg-zinc-50">
                <td className="px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span aria-hidden className={`size-4 shrink-0 rounded-[5px] ${projectColorClass(p.projectId)}`} />
                    <div className="min-w-0">
                      <p className="flex min-w-0 items-center gap-1.5">
                        {member ? (
                          <Link href={`/projects/${p.projectId}`} className="truncate font-medium text-zinc-900 hover:underline">
                            {p.name}
                          </Link>
                        ) : (
                          <span className="truncate font-medium text-zinc-900">{p.name}</span>
                        )}
                        <span className="shrink-0 text-zinc-400" data-tooltip={VISIBILITY_LABELS[p.visibility]}>
                          {p.visibility === "team" ? <Globe className="size-3.5" aria-hidden /> : <Lock className="size-3.5" aria-hidden />}
                          <span className="sr-only">{VISIBILITY_LABELS[p.visibility]}</span>
                        </span>
                        {p.archived ? <span className="chip shrink-0">Archived</span> : null}
                        {isProjectStatus(p.status) && !p.archived ? (
                          <span className="hidden shrink-0 items-center gap-1 text-2xs text-zinc-500 md:inline-flex">
                            <span aria-hidden className={`size-1.5 rounded-full ${PROJECT_STATUS_DOT[p.status]}`} />
                            {PROJECT_STATUS_LABELS[p.status]}
                          </span>
                        ) : null}
                      </p>
                      <p className="truncate text-xs text-zinc-500">
                        {p.teamName}
                        {p.description ? ` · ${p.description}` : ""}
                      </p>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2">
                  {p.memberIds ? (
                    <span
                      className="inline-flex items-center gap-1.5"
                      aria-label={`${p.memberCount} ${p.memberCount === 1 ? "member" : "members"}: ${memberIds
                        .slice(0, 5)
                        .map((id) => names.get(id) ?? "Someone")
                        .join(", ")}${memberIds.length > 5 ? ", and others" : ""}`}
                    >
                      <span className="flex -space-x-1" aria-hidden>
                        {shownMembers.map((id) => (
                          <span key={id} className="rounded-full ring-2 ring-white">
                            <Avatar name={names.get(id) ?? "?"} profileId={id} size="md" />
                          </span>
                        ))}
                      </span>
                      {p.memberCount > shownMembers.length ? (
                        <span aria-hidden className="text-xs tabular-nums text-zinc-500">
                          +{p.memberCount - shownMembers.length}
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-xs tabular-nums text-zinc-600">
                      {p.memberCount} {p.memberCount === 1 ? "member" : "members"}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-zinc-600">
                  {p.modifiedAt ? <Timestamp iso={p.modifiedAt} /> : <span className="text-zinc-400">—</span>}
                </td>
                <td className="px-3 py-2 text-right">
                  {member ? (
                    <span
                      className="inline-flex h-7 w-24 items-center justify-center gap-1 rounded-md bg-zinc-100 text-xs font-medium text-zinc-600"
                      data-tooltip={isProjectRole(p.myRole) ? `Your role: ${ROLE_LABELS[p.myRole]}` : undefined}
                    >
                      <Check className="size-3.5" aria-hidden />
                      Joined
                    </span>
                  ) : p.archived ? (
                    <span className="inline-block w-24 text-center text-xs text-zinc-400">Can’t join</span>
                  ) : (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => join(p)}
                      aria-label={`Join ${p.name}`}
                      className="btn-secondary h-7 w-24 border-accent-300 text-accent-700 hover:border-accent-400 hover:bg-accent-50"
                    >
                      Join
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function choices(ids: string[], people: Person[], meId: string): Person[] {
  const present = new Set(ids);
  const byId = new Map(people.map((p) => [p.id, p] as const));
  return [...present]
    .flatMap((id) => {
      const person = byId.get(id);
      return person ? [{ id, name: id === meId ? `${person.name} (you)` : person.name }] : [];
    })
    .sort((a, b) => Number(b.id === meId) - Number(a.id === meId) || a.name.localeCompare(b.name));
}

function SortButton({ label, active, dir, onClick }: { label: string; active: boolean; dir: "asc" | "desc"; onClick: () => void }) {
  const Icon = dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-zinc-200/60 hover:text-zinc-900">
      {label}
      {active ? <Icon className="size-3" aria-hidden /> : null}
    </button>
  );
}

// A filter pill: "Owner", or "Owner: 2" once something is picked; a checklist in a popover.
function FilterPill({
  label,
  options,
  value,
  onChange,
  disabledNote = null,
}: {
  label: string;
  options: { id: string; name: string; dot?: string }[];
  value: string[];
  onChange: (next: string[]) => void;
  disabledNote?: string | null;
}) {
  const active = value.length > 0;
  const summary = active
    ? value.length === 1
      ? (options.find((o) => o.id === value[0])?.name ?? "1 selected")
      : `${value.length} selected`
    : null;
  if (disabledNote) {
    return (
      <span
        data-tooltip={disabledNote}
        tabIndex={0}
        className="inline-flex h-8 cursor-not-allowed items-center gap-1 rounded-full border border-zinc-200 px-3 text-xs text-zinc-400"
      >
        {label}
        <ChevronDown className="size-3.5" aria-hidden />
        <span className="sr-only">{disabledNote}</span>
      </span>
    );
  }
  return (
    <Popover
      label={`Filter by ${label.toLowerCase()}`}
      panelClassName="w-64 p-1.5"
      buttonClassName={`inline-flex h-8 max-w-56 items-center gap-1 rounded-full border px-3 text-xs font-medium ${
        active
          ? "border-accent-300 bg-accent-50 text-accent-800 hover:bg-accent-100"
          : "border-zinc-200 text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50"
      }`}
      button={
        <>
          <span className="truncate">{summary ? `${label}: ${summary}` : label}</span>
          <ChevronDown className="size-3.5 shrink-0" aria-hidden />
        </>
      }
    >
      {() => (
        <div className="flex flex-col">
          {options.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-zinc-500">Nothing to filter by yet.</p>
          ) : (
            <ul className="max-h-64 overflow-y-auto">
              {options.map((option) => {
                const checked = value.includes(option.id);
                return (
                  <li key={option.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => onChange(checked ? value.filter((id) => id !== option.id) : [...value, option.id])}
                        className="size-3.5 accent-accent-600"
                      />
                      {option.dot ? <span aria-hidden className={`size-2 shrink-0 rounded-full ${option.dot}`} /> : null}
                      <span className="truncate">{option.name}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {active ? (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mt-1 rounded-md border-t border-zinc-100 px-2 py-1.5 text-left text-xs text-accent-700 hover:bg-zinc-50"
            >
              Clear {label.toLowerCase()}
            </button>
          ) : null}
        </div>
      )}
    </Popover>
  );
}
