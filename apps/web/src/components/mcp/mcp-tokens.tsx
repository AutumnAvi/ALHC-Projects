"use client";

// AI builder round 5 (note 178): make, see, and revoke your MCP personal access tokens. A new token is shown
// once (copy it now); afterwards only its prefix is known.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, KeyRound } from "lucide-react";
import type { AccessToken } from "@alhc/core/api/mcp/model";
import { createMcpToken, revokeMcpToken } from "@/lib/actions/mcp-tokens";

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—");

export function McpTokens({ tokens, configured }: { tokens: AccessToken[]; configured: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [write, setWrite] = useState(false);
  const [days, setDays] = useState(30);
  const [shown, setShown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function create() {
    if (!name.trim()) return;
    setError(null);
    start(async () => {
      const res = await createMcpToken({ name: name.trim(), scopes: write ? ["read", "write"] : ["read"], days });
      if (res.error || !res.token) return setError(res.error ?? "The token wasn’t made");
      setShown(res.token);
      setName("");
      router.refresh();
    });
  }

  function revoke(id: string) {
    start(async () => {
      const res = await revokeMcpToken(id);
      if (res.error) setError(res.error);
      router.refresh();
    });
  }

  return (
    <section className="space-y-2">
      <h2 className="font-semibold text-zinc-900">Personal access tokens</h2>
      {!configured ? <p className="rounded-md bg-amber-50 px-2 py-1.5 text-amber-900">The MCP endpoint isn’t set up on this deployment yet, so tokens can’t be made here.</p> : null}
      {shown ? (
        <div role="status" className="rounded-md border border-green-300 bg-green-50 px-3 py-2">
          <p className="font-medium text-green-900">Copy your token now — it won’t be shown again.</p>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all text-xs">{shown}</code>
            <button type="button" className="btn-secondary h-7 px-2" onClick={() => void navigator.clipboard?.writeText(shown)}>
              <Copy className="size-3.5" aria-hidden /> Copy
            </button>
          </div>
          <button type="button" className="mt-1 text-xs text-green-900 underline" onClick={() => setShown(null)}>
            I’ve copied it
          </button>
        </div>
      ) : null}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <label className="flex flex-col text-xs text-zinc-600">
          Name
          <input className="control w-48" value={name} onChange={(e) => setName(e.currentTarget.value.slice(0, 100))} placeholder="Claude Desktop" disabled={!configured} />
        </label>
        <label className="flex flex-col text-xs text-zinc-600">
          Expires in (days)
          <input className="control w-24" type="number" min={1} max={90} value={days} onChange={(e) => setDays(Math.max(1, Math.min(90, Number(e.currentTarget.value) || 30)))} disabled={!configured} />
        </label>
        <label className="flex items-center gap-1.5 pb-1 text-xs text-zinc-700">
          <input type="checkbox" checked={write} onChange={(e) => setWrite(e.currentTarget.checked)} disabled={!configured} />
          Can make changes (write)
        </label>
        <button type="submit" className="btn-primary h-8 px-3" disabled={!configured || pending || !name.trim()}>
          <KeyRound className="size-4" aria-hidden /> Make token
        </button>
      </form>
      {error ? <p role="alert" className="text-red-700">{error}</p> : null}
      {tokens.length ? (
        <table className="w-full text-left text-xs">
          <thead className="text-zinc-500">
            <tr>
              <th className="py-1 font-medium">Name</th>
              <th className="font-medium">Token</th>
              <th className="font-medium">Scopes</th>
              <th className="font-medium">Last used</th>
              <th className="font-medium">Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => {
              const dead = Boolean(t.revokedAt) || new Date(t.expiresAt) < new Date();
              return (
                <tr key={t.id} className={`border-t border-zinc-100 ${dead ? "text-zinc-400" : ""}`}>
                  <td className="py-1">{t.name}</td>
                  <td><code>{t.prefix}…</code></td>
                  <td>{t.scopes.join(" + ")}</td>
                  <td>{day(t.lastUsedAt)}</td>
                  <td>{t.revokedAt ? "Revoked" : day(t.expiresAt)}</td>
                  <td className="text-right">
                    {!dead ? (
                      <button type="button" className="btn-ghost h-7 px-2 text-red-700" onClick={() => revoke(t.id)} disabled={pending}>
                        Revoke
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="text-zinc-500">No tokens yet.</p>
      )}
    </section>
  );
}
