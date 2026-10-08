"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { History, ImageUp, Trash2 } from "lucide-react";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { SettingsCard } from "@/components/workspace/settings-chrome";
import { setWorkspaceLogo, updateWorkspaceSettings } from "@/lib/actions";
import type { Workspace, WorkspaceImportRun } from "@/lib/data";
import { describeImportCreated } from "@/lib/imports-shared";
import { createClient } from "@/lib/supabase/client";
import { LOGO_MAX_BYTES, LOGO_TYPES, WORKSPACE_ASSETS_BUCKET, logoObjectPath } from "@/lib/workspace";

const LABEL = "text-xs font-medium text-zinc-600";

// Settings → Workspace → General: name, logo, default team (workspace admins), and past imports.
export function GeneralSettings({
  workspace,
  isAdmin,
  teams,
  runs,
}: {
  workspace: Workspace;
  isAdmin: boolean;
  teams: { id: string; name: string }[];
  runs: WorkspaceImportRun[];
}) {
  const [pending, run] = useServerAction();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const initial = workspace.name.slice(0, 1).toUpperCase() || "A";

  async function uploadLogo(file: File) {
    setLogoError(null);
    if (!(LOGO_TYPES as readonly string[]).includes(file.type)) {
      setLogoError("Use a PNG, JPEG, WebP, or GIF image.");
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setLogoError("The logo must be 2 MB or smaller.");
      return;
    }
    setUploading(true);
    const path = logoObjectPath(workspace.id, file.name);
    const { error } = await createClient()
      .storage.from(WORKSPACE_ASSETS_BUCKET)
      .upload(path, file, { contentType: file.type, upsert: false });
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
    if (error) {
      setLogoError(`Couldn’t upload the logo: ${error.message}`);
      return;
    }
    run(() => setWorkspaceLogo(path, file.size));
  }

  return (
    <>
      <SettingsCard
        id="workspace-general"
        title="Workspace"
        description="The name and logo everyone sees in the sidebar."
        adminOnly
        isAdmin={isAdmin}
      >
        <div className="flex flex-col gap-5">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const value = new FormData(e.currentTarget).get("name");
              if (typeof value === "string" && value.trim() && value.trim() !== workspace.name) {
                run(() => updateWorkspaceSettings({ name: value }));
              }
            }}
          >
            <div className="flex min-w-56 flex-1 flex-col gap-1">
              <label htmlFor="workspace-name" className={LABEL}>
                Workspace name
              </label>
              <input
                id="workspace-name"
                name="name"
                key={workspace.name}
                defaultValue={workspace.name}
                required
                maxLength={100}
                className="field"
              />
            </div>
            <button type="submit" disabled={pending} className="btn-secondary h-9">
              Save name
            </button>
          </form>

          <div className="flex flex-wrap items-center gap-4">
            {workspace.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- a public Storage URL, any size
              <img src={workspace.logoUrl} alt={`${workspace.name} logo`} className="size-14 rounded-lg border border-zinc-200 object-contain" />
            ) : (
              <span
                aria-hidden
                className="flex size-14 items-center justify-center rounded-lg bg-zinc-900 text-xl font-semibold text-white"
              >
                {initial}
              </span>
            )}
            <div className="flex flex-col gap-1.5">
              <span className={LABEL}>Logo</span>
              <div className="flex flex-wrap gap-2">
                <input
                  ref={fileRef}
                  id="workspace-logo"
                  type="file"
                  accept={LOGO_TYPES.join(",")}
                  className="sr-only"
                  onChange={(e) => {
                    const file = e.currentTarget.files?.[0];
                    if (file) void uploadLogo(file);
                  }}
                />
                <button
                  type="button"
                  disabled={pending || uploading}
                  onClick={() => fileRef.current?.click()}
                  className="btn-secondary"
                >
                  <ImageUp className="size-3.5" aria-hidden />
                  {uploading ? "Uploading…" : workspace.logoUrl ? "Replace logo" : "Upload logo"}
                </button>
                {workspace.logoUrl ? (
                  <button
                    type="button"
                    disabled={pending || uploading}
                    onClick={() => run(() => setWorkspaceLogo(null))}
                    className="btn-ghost text-zinc-600 hover:text-red-700"
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                    Remove
                  </button>
                ) : null}
              </div>
              <p className="text-xs text-zinc-500">PNG, JPEG, WebP, or GIF up to 2 MB. Square images look best.</p>
              {logoError ? (
                <p role="alert" className="text-xs text-red-600">
                  {logoError}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        id="workspace-default-team"
        title="Default team"
        description="New members join this team automatically, and new projects are put in it unless you pick another team."
        adminOnly
        isAdmin={isAdmin}
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-56 flex-col gap-1">
            <label htmlFor="workspace-default-team-select" className={LABEL}>
              Team
            </label>
            <select
              id="workspace-default-team-select"
              key={workspace.defaultTeamId ?? ""}
              defaultValue={workspace.defaultTeamId ?? ""}
              onChange={(e) => {
                const select = e.currentTarget;
                if (!select.value) return;
                run(async () => {
                  const result = await updateWorkspaceSettings({ defaultTeamId: select.value });
                  if (result.error) select.value = workspace.defaultTeamId ?? "";
                  return result;
                });
              }}
              className="field"
            >
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </div>
          <Link href="/settings/workspace/teams" className="btn-ghost h-9">
            Manage teams
          </Link>
        </div>
      </SettingsCard>

      <SettingsCard
        id="workspace-imports"
        title="Past imports"
        description="Asana imports into projects you can open, newest first. Projects you aren’t a member of aren’t listed."
        isAdmin={isAdmin}
        flush
      >
        {runs.length === 0 ? (
          <EmptyState icon={History} title="No imports yet" size="inline">
            A project admin imports Asana exports from that project’s Settings → Import; each run shows up here.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {runs.map((importRun) => (
              <li key={importRun.id} className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Link href={`/projects/${importRun.projectId}/settings/import`} className="font-medium text-zinc-900 hover:underline">
                    {importRun.projectName}
                  </Link>
                  <span className="truncate text-zinc-600">{importRun.fileNames.join(", ") || "Asana export"}</span>
                  <span className={`chip ${importRun.status === "failed" ? "bg-red-50 text-red-700" : ""}`}>
                    {importRun.status === "completed" ? "Completed" : importRun.status === "failed" ? "Failed" : "Not finished"}
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
      </SettingsCard>
    </>
  );
}
