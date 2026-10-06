"use client";

import Link from "next/link";
import { useRef } from "react";
import { History, ShieldCheck, UserPlus } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { addWorkspaceAdmin, removeWorkspaceAdmin } from "@/lib/actions";
import type { WorkspaceAdmin, WorkspaceImportRun } from "@/lib/data";
import { describeImportCreated } from "@/lib/imports-shared";

const CARD = "rounded-lg border border-zinc-200";
const CARD_HEADER = "border-b border-zinc-200 px-5 py-4";

export function WorkspaceSettings({
  memberId,
  isAdmin,
  admins,
  runs,
}: {
  memberId: string;
  isAdmin: boolean;
  admins: WorkspaceAdmin[];
  runs: WorkspaceImportRun[];
}) {
  const [pending, run] = useServerAction();
  const emailRef = useRef<HTMLInputElement>(null);
  const lastAdmin = admins.length <= 1;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-gutter py-5">
      <section className={CARD} aria-labelledby="workspace-admins-heading">
        <div className={CARD_HEADER}>
          <h2 id="workspace-admins-heading" className="text-sm font-semibold text-zinc-900">
            Workspace admins <span className="font-normal text-zinc-500">· {admins.length}</span>
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            Workspace admins manage what belongs to the whole workspace: every project template (including the
            Creative Requests example) and the list of past Asana imports. Being a workspace admin doesn’t open
            private projects. Project access always comes from project membership, and imports still run from each
            project’s Settings → Import.
          </p>
        </div>

        {isAdmin ? (
          <form
            className="flex flex-wrap items-end gap-3 border-b border-zinc-100 px-5 py-4"
            onSubmit={(e) => {
              e.preventDefault();
              const input = emailRef.current;
              const email = input?.value.trim();
              if (!input || !email) return;
              run(async () => {
                const result = await addWorkspaceAdmin(email);
                if (!result.error) input.value = "";
                return result;
              });
            }}
          >
            <div className="flex min-w-56 flex-1 flex-col gap-1">
              <label htmlFor="workspace-admin-email" className="text-xs font-medium text-zinc-600">
                Add an admin by email
              </label>
              <input
                ref={emailRef}
                id="workspace-admin-email"
                type="email"
                required
                autoComplete="off"
                placeholder="name@example.com"
                className="control"
              />
            </div>
            <button type="submit" disabled={pending} className="btn-primary">
              <UserPlus className="size-3.5" aria-hidden />
              Add admin
            </button>
            <p className="basis-full text-xs text-zinc-500">
              They must be on the workspace allowlist and have signed in at least once.
            </p>
          </form>
        ) : null}

        {admins.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="No workspace admins yet" size="inline">
            The first admin is set up in SQL (see the README). After that, admins add each other here.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {admins.map((admin) => {
              const self = admin.profileId === memberId;
              return (
                <li key={admin.profileId} className="flex items-center gap-3 px-5 py-3">
                  <Avatar name={admin.name} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-zinc-900">
                      {admin.name}
                      {self ? <span className="font-normal text-zinc-500"> (you)</span> : null}
                    </p>
                    <p className="truncate text-xs text-zinc-500">
                      {admin.email} · added <Timestamp iso={admin.addedAt} />
                    </p>
                  </div>
                  {isAdmin ? (
                    <button
                      type="button"
                      disabled={pending || lastAdmin}
                      title={lastAdmin ? "A workspace needs at least one admin. Add another admin first." : undefined}
                      onClick={() => {
                        const question = self
                          ? "Stop being a workspace admin? Another admin will have to add you back."
                          : `Remove ${admin.name} as a workspace admin?`;
                        if (window.confirm(question)) run(() => removeWorkspaceAdmin(admin.profileId));
                      }}
                      className="btn-ghost text-zinc-600 hover:text-red-700"
                    >
                      {self ? "Leave" : "Remove"}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {isAdmin && lastAdmin ? (
          <p className="border-t border-zinc-100 px-5 py-3 text-xs text-zinc-500">
            You’re the only workspace admin, so you can’t leave until you add another.
          </p>
        ) : null}
        {!isAdmin ? (
          <p className="border-t border-zinc-100 px-5 py-3 text-xs text-zinc-500">
            Ask a workspace admin if something here needs to change.
          </p>
        ) : null}
      </section>

      {isAdmin ? (
        <section className={CARD} aria-labelledby="workspace-imports-heading">
          <div className={CARD_HEADER}>
            <h2 id="workspace-imports-heading" className="text-sm font-semibold text-zinc-900">
              Past imports
            </h2>
            <p className="mt-1 text-sm text-zinc-600">
              Asana imports into projects you can open, newest first. Projects you aren’t a member of aren’t listed.
            </p>
          </div>
          {runs.length === 0 ? (
            <EmptyState icon={History} title="No imports yet" size="inline">
              A project admin imports Asana exports from that project’s Settings → Import; each run shows up here.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {runs.map((importRun) => (
                <li key={importRun.id} className="px-5 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Link
                      href={`/projects/${importRun.projectId}/settings/import`}
                      className="font-medium text-zinc-900 hover:underline"
                    >
                      {importRun.projectName}
                    </Link>
                    <span className="truncate text-zinc-600">{importRun.fileNames.join(", ") || "Asana export"}</span>
                    <span className={`chip ${importRun.status === "failed" ? "bg-red-50 text-red-700" : ""}`}>
                      {importRun.status === "completed"
                        ? "Completed"
                        : importRun.status === "failed"
                          ? "Failed"
                          : "Not finished"}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    <Timestamp iso={importRun.createdAt} />
                    {importRun.createdByName ? ` by ${importRun.createdByName}` : ""}
                    {" · "}
                    {describeImportCreated(importRun.summary.created)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
