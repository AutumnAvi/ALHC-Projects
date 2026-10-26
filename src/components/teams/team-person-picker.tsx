"use client";

import { useState, type KeyboardEvent } from "react";
import { ChevronDown, Mail, Search, UserRound } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { Popover } from "@/components/popover";
import { EMAIL_PATTERN } from "@/lib/workspace";

export type TeamCandidate = { id: string; name: string; email: string };

// Who the Members tab adds: someone in the workspace, an allowlisted address that hasn't signed in yet
// (a pending invite; `waiting`), or (workspace admins only) a new address.
export type TeamPick = { kind: "person"; person: TeamCandidate } | { kind: "email"; email: string; waiting?: boolean };

type Row = TeamPick;

// The rows a search shows: matching people by name or email (at most 50), then — for workspace admins,
// when the search is an address nobody listed has — "Invite <address>". Pure, for the tests.
export function teamPickRows(
  people: readonly TeamCandidate[],
  query: string,
  {
    allowNewEmail,
    takenEmails = [],
    waitingEmails = [],
  }: { allowNewEmail: boolean; takenEmails?: readonly string[]; waitingEmails?: readonly string[] },
): Row[] {
  const q = query.trim().toLowerCase();
  const matches: Row[] = people
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q))
    .slice(0, 50)
    .map((person) => ({ kind: "person", person }));
  const taken = new Set(takenEmails.map((e) => e.toLowerCase()));
  const known = new Set([...people.map((p) => p.email.toLowerCase()), ...taken]);
  // Allowlisted addresses that haven't signed in yet: any manager can add them (a pending invite).
  const waiting = q
    ? waitingEmails.filter((e) => !known.has(e.toLowerCase()) && e.toLowerCase().includes(q)).slice(0, 10)
    : [];
  for (const email of waiting) matches.push({ kind: "email", email: email.toLowerCase(), waiting: true });
  const listed = new Set([...known, ...waiting.map((e) => e.toLowerCase())]);
  if (allowNewEmail && EMAIL_PATTERN.test(q) && !listed.has(q)) matches.push({ kind: "email", email: q });
  return matches;
}

// A searchable picker of people in the workspace who aren't on the team yet (Oct 26 notes, batch 4),
// instead of typing an address. Workspace admins can also invite a brand-new address: only they can add
// people to the workspace. ↑/↓ move, Enter picks; the database checks everything again on Add.
export function TeamPersonPicker({
  id,
  people,
  value,
  onChange,
  allowNewEmail,
  takenEmails,
  waitingEmails,
  disabled = false,
}: {
  id: string;
  people: readonly TeamCandidate[];
  value: TeamPick | null;
  onChange: (pick: TeamPick) => void;
  allowNewEmail: boolean;
  // Addresses already on the team or invited (never offered as "Invite …").
  takenEmails?: readonly string[];
  // Allowlisted addresses that haven't signed in yet.
  waitingEmails?: readonly string[];
  disabled?: boolean;
}) {
  const chosen = value?.kind === "person" ? value.person.name : value?.email ?? null;
  return (
    <Popover
      label={chosen ? `Person to add: ${chosen}. Change` : "Choose a person to add"}
      buttonId={id}
      disabled={disabled}
      panelClassName="w-80 p-0"
      buttonClassName="control flex h-9 w-full items-center gap-1.5 text-left aria-expanded:border-accent-500/60 disabled:opacity-60"
      button={
        <>
          {value?.kind === "person" ? (
            <>
              <Avatar name={value.person.name} profileId={value.person.id} size="sm" />
              <span className="truncate text-zinc-900">{value.person.name}</span>
            </>
          ) : value?.kind === "email" ? (
            <>
              <Mail className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
              <span className="truncate text-zinc-900">{value.email}</span>
            </>
          ) : (
            <span className="truncate text-zinc-400">Search by name or email</span>
          )}
          <ChevronDown className="ml-auto size-3.5 shrink-0 text-zinc-400" aria-hidden />
        </>
      }
    >
      {(close) => (
        <PickList
          people={people}
          allowNewEmail={allowNewEmail}
          takenEmails={takenEmails}
          waitingEmails={waitingEmails}
          onPick={(pick) => {
            close();
            onChange(pick);
          }}
        />
      )}
    </Popover>
  );
}

function PickList({
  people,
  allowNewEmail,
  takenEmails,
  waitingEmails,
  onPick,
}: {
  people: readonly TeamCandidate[];
  allowNewEmail: boolean;
  takenEmails?: readonly string[];
  waitingEmails?: readonly string[];
  onPick: (pick: TeamPick) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rows = teamPickRows(people, query, { allowNewEmail, takenEmails, waitingEmails });
  const index = Math.min(active, rows.length - 1);
  const q = query.trim().toLowerCase();
  const typedNewEmail = EMAIL_PATTERN.test(q) && rows.length === 0;

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length) setActive((index + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rows[index]) onPick(rows[index]);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-zinc-100 px-2.5">
        <Search className="size-4 shrink-0 text-zinc-400" aria-hidden />
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={onKey}
          aria-label="Search people by name or email"
          placeholder={allowNewEmail ? "Name, email, or a new address" : "Name or email"}
          className="h-9 min-w-0 flex-1 border-0 bg-transparent p-0 text-sm shadow-none outline-none focus-visible:shadow-none"
        />
      </div>
      <ul aria-label="People to add" className="max-h-64 overflow-y-auto p-1">
        {rows.map((row, i) => (
          <li key={row.kind === "person" ? row.person.id : `email:${row.email}`}>
            <button
              type="button"
              onClick={() => onPick(row)}
              onMouseMove={() => i !== index && setActive(i)}
              className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left ${i === index ? "bg-zinc-100" : ""}`}
            >
              {row.kind === "person" ? (
                <>
                  <Avatar name={row.person.name} profileId={row.person.id} size="md" />
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-sm text-zinc-900">{row.person.name}</span>
                    {row.person.name !== row.person.email ? (
                      <span className="block truncate text-xs text-zinc-500">{row.person.email}</span>
                    ) : null}
                  </span>
                </>
              ) : (
                <>
                  <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-500">
                    <Mail className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-sm text-zinc-900">Invite {row.email}</span>
                    <span className="block truncate text-xs text-zinc-500">
                      {row.waiting
                        ? "In the workspace, hasn’t signed in yet: joins the team on first sign-in"
                        : "New to the workspace: they get an invite email"}
                    </span>
                  </span>
                </>
              )}
            </button>
          </li>
        ))}
        {rows.length === 0 ? (
          <li className="flex items-start gap-2 px-2 py-2 text-xs text-zinc-500">
            <UserRound className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {typedNewEmail && !allowNewEmail
              ? "That address isn’t in the workspace. Only workspace admins can add new people; ask one to invite them."
              : q
                ? `Nobody matches “${query.trim()}”.`
                : "Everyone in the workspace is already on this team."}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
