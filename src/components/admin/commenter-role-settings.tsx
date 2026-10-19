"use client";

import { useOptimistic } from "react";
import Link from "next/link";
import { useServerAction } from "@/components/toast";
import { convertCommenterMember, setCommenterRoleAllowed } from "@/lib/actions";
import type { CommenterMember } from "@/lib/data";
import { personHref } from "@/lib/people";

// Admin console → Security → Project roles: whether the Commenter role is offered in Share and invite
// menus (off by default), and everyone who already has it — they keep it until an admin moves them to
// Viewer or Editor here, one person at a time. Nothing changes on its own.
export function CommenterRoleSettings({ allowed, commenters }: { allowed: boolean; commenters: CommenterMember[] }) {
  const [pending, run] = useServerAction();
  const [on, setOn] = useOptimistic(allowed);
  const [list, removeFromList] = useOptimistic(commenters, (current, profileId: string) =>
    current.filter((c) => c.profileId !== profileId),
  );

  return (
    <div className="space-y-4">
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          role="switch"
          checked={on}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.checked;
            run(() => setCommenterRoleAllowed(next), () => setOn(next));
          }}
          className="mt-0.5 size-4 shrink-0 accent-accent-600"
        />
        <span>
          <span className="block text-sm font-medium text-zinc-900">Allow Commenter role</span>
          <span className="block text-sm text-zinc-600">
            Commenters can read a project and comment, but not edit tasks. While this is off, Commenter isn’t offered when
            sharing a project or inviting people. People who already have it keep it.
          </span>
        </span>
      </label>

      {list.length ? (
        <div className={`rounded-md border px-4 py-3 ${on ? "border-zinc-200" : "border-amber-200 bg-amber-50"}`}>
          <p className="text-sm text-zinc-800">
            {list.length === 1 ? "1 person is a Commenter" : `${list.length} people are Commenters`} in at least one project.
            {on ? "" : " Their role still works; move them to Viewer or Editor when you’re ready."}
          </p>
          <ul className="mt-2 divide-y divide-zinc-200/70">
            {list.map((c) => {
              const hidden = c.projectCount - c.projects.length;
              return (
                <li key={c.profileId} className="flex flex-wrap items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <Link href={personHref(c.profileId)} className="text-sm font-medium text-zinc-900 hover:underline">
                      {c.name}
                    </Link>
                    <p className="truncate text-xs text-zinc-500">
                      {c.projects.map((p) => p.name).join(", ")}
                      {hidden > 0
                        ? `${c.projects.length ? " and " : ""}${hidden} project${hidden === 1 ? "" : "s"} you’re not in`
                        : ""}
                    </p>
                  </div>
                  {(["viewer", "editor"] as const).map((role) => (
                    <button
                      key={role}
                      type="button"
                      className="btn-secondary"
                      disabled={pending}
                      onClick={() => {
                        const where = c.projectCount === 1 ? "their project" : `all ${c.projectCount} projects`;
                        if (!window.confirm(`Make ${c.name} ${role === "viewer" ? "a Viewer" : "an Editor"} in ${where}?`)) return;
                        run(() => convertCommenterMember(c.profileId, role), () => removeFromList(c.profileId));
                      }}
                    >
                      Make {role === "viewer" ? "Viewer" : "Editor"}
                    </button>
                  ))}
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-zinc-500">Nobody has the Commenter role right now.</p>
      )}
    </div>
  );
}
