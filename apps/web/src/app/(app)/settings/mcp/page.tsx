import { notFound } from "next/navigation";
import { Plug } from "lucide-react";
import { getAiBuilderAccess } from "@alhc/core/api/ai-builder/queries";
import { listAccessTokens } from "@alhc/core/api/mcp/queries";
import { mcpRunsWithoutConfirm } from "@alhc/core/api/mcp/tools";
import { TOOL_GROUP_LABELS, toolMeta, toolsFor, type ToolGroup } from "@alhc/core/ai-tools";
import { McpTokens } from "@/components/mcp/mcp-tokens";
import { PageHeader } from "@/components/ui";
import { mcpConfigured } from "@/lib/mcp/auth";
import { requestOrigin } from "@/lib/origin";
import { bind } from "@/lib/server/context";

// AI builder round 5 (experimental, note 178): Settings → AI & MCP — personal access tokens for the MCP
// endpoint (made here, shown once, stored only as a hash; revoke any time), how to connect an MCP client,
// and the tools it gets (generated from the capability registry). A 404 for everyone but workspace admins
// of the Testing data pilot.
const access = bind(getAiBuilderAccess);
const tokens = bind(listAccessTokens);

export default async function McpSettingsPage() {
  const state = await access();
  if (state.status !== "ready") notFound();
  const list = await tokens();
  const origin = await requestOrigin();
  const url = `${origin.replace(/\/$/, "")}/api/mcp`;
  const groups = new Map<ToolGroup, { name: string; label: string; kind: string; flags: string }[]>();
  for (const n of toolsFor("mcp")) {
    const m = toolMeta(n);
    const read = mcpRunsWithoutConfirm(n);
    const flags = [read ? "read" : "write (confirm: true)", m.destructive ? "destructive" : "", m.notifies ? "messages people" : "", m.kind === "write" && m.undo === "no" ? "no Undo" : ""].filter(Boolean).join(" · ");
    groups.set(m.group, [...(groups.get(m.group) ?? []), { name: n, label: m.label, kind: m.kind, flags }]);
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PageHeader icon={Plug} title="AI & MCP" description={`Experimental pilot · ${state.workspaceName} workspace only`} />
      <div className="max-w-3xl space-y-6 px-gutter py-4 text-sm">
        <section className="space-y-2">
          <h2 className="font-semibold text-zinc-900">Connect an MCP client</h2>
          <p className="text-zinc-700">
            Claude Desktop, Claude Code, Cursor, or any MCP client can use the same tools as the in-app assistant, as you: never more than your role in each project allows, and only in the {state.workspaceName} workspace. Changes are logged with Undo in{" "}
            <a href="/ai-builder" className="font-medium text-accent-700 hover:underline">AI history</a>. Every change needs <code>confirm: true</code>; without it you get a preview and nothing changes.
          </p>
          <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1">
            <dt className="text-zinc-500">URL</dt>
            <dd><code className="break-all">{url}</code></dd>
            <dt className="text-zinc-500">Header</dt>
            <dd><code>Authorization: Bearer alhc_pat_…</code> (a token from below)</dd>
            <dt className="text-zinc-500">Transport</dt>
            <dd>Streamable HTTP (stateless)</dd>
          </dl>
          <details className="rounded-md border border-zinc-200 px-3 py-2">
            <summary className="cursor-pointer font-medium text-zinc-800">Setup snippets</summary>
            <p className="mt-2 font-medium text-zinc-700">Claude Code</p>
            <pre className="mt-1 overflow-x-auto rounded bg-zinc-100 p-2 text-xs">{`claude mcp add --transport http alhc ${url} \\\n  --header "Authorization: Bearer $ALHC_TOKEN"`}</pre>
            <p className="mt-2 font-medium text-zinc-700">Cursor (~/.cursor/mcp.json)</p>
            <pre className="mt-1 overflow-x-auto rounded bg-zinc-100 p-2 text-xs">{JSON.stringify({ mcpServers: { alhc: { url, headers: { Authorization: "Bearer alhc_pat_…" } } } }, null, 2)}</pre>
            <p className="mt-2 font-medium text-zinc-700">Claude Desktop (claude_desktop_config.json, through mcp-remote)</p>
            <pre className="mt-1 overflow-x-auto rounded bg-zinc-100 p-2 text-xs">{JSON.stringify({ mcpServers: { alhc: { command: "npx", args: ["mcp-remote", url, "--header", "Authorization:${ALHC_TOKEN}"], env: { ALHC_TOKEN: "Bearer alhc_pat_…" } } } }, null, 2)}</pre>
          </details>
        </section>
        <McpTokens tokens={list} configured={mcpConfigured()} />
        <section className="space-y-2">
          <h2 className="font-semibold text-zinc-900">Tools</h2>
          <p className="text-zinc-600">Generated from the capability registry. Read tools need a token with read; changes need read + write.</p>
          {[...groups].map(([g, items]) => (
            <div key={g}>
              <h3 className="mt-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{TOOL_GROUP_LABELS[g]}</h3>
              <ul className="mt-1 space-y-0.5">
                {items.map((t) => (
                  <li key={t.name}>
                    <code className="text-xs">{t.name}</code> — {t.label} <span className="text-2xs text-zinc-500">({t.flags})</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="text-2xs text-zinc-500">
            Not available (by design): signing in, passwords, workspace admin settings, secrets and integrations (Slack, webhooks, inbound tokens), imports, background jobs, public endpoints, and anything that emails or posts outward immediately. See docs/MCP.md.
          </p>
        </section>
      </div>
    </div>
  );
}
