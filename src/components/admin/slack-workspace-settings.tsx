"use client";

import { useState, useTransition } from "react";
import { ExternalLink, Hash, Link2, Lock, MessageSquare, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useConfirm } from "@/components/confirm";
import { useNotify } from "@/components/toast";
import { Timestamp } from "@/components/timestamp";
import { EmptyState } from "@/components/ui";
import {
  SLACK_WEBHOOK_PATTERN,
  destinationLabel,
  slackManifestUrl,
  slackTokenProblem,
  type SlackDestination,
  type SlackSettings,
} from "@/lib/slack";
import {
  addSlackWebhookDestination,
  connectSlack,
  disconnectSlack,
  refreshSlackChannels,
  removeSlackDestination,
  renameSlackDestination,
} from "@/lib/slack-actions";

// Nov 2 notes (batch 14, 105): Admin console → Integrations → Slack. A workspace admin connects the
// workspace's Slack app once (its bot token is checked with Slack and kept in the database, out of every
// client's reach); its channels become the choices for every project and automation. Slack incoming
// webhooks can be saved here too (each project's old webhook already was), for teams without an app.
export function SlackWorkspaceSettings({ initial }: { initial: SlackSettings }) {
  const notify = useNotify();
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const [token, setToken] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const settings = initial;
  const channels = settings.destinations.filter((d) => d.kind === "channel");
  const webhooks = settings.destinations.filter((d) => d.kind === "webhook");

  const act = (fn: () => Promise<{ error?: string }>, ok?: string) =>
    start(async () => {
      const result = await fn();
      if (result.error) notify(result.error);
      else if (ok) notify(ok);
    });

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-zinc-200" aria-labelledby="slack-connection-heading">
        <div className="flex items-start gap-3 border-b border-zinc-200 px-5 py-4">
          <MessageSquare className="mt-0.5 size-5 shrink-0 text-zinc-700" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 id="slack-connection-heading" className="text-sm font-semibold text-zinc-900">
              Slack
            </h2>
            <p className="mt-1 text-sm text-zinc-600">
              Connect your Slack workspace once. Then each project picks its channel in Settings → Integrations, and each
              <span className="font-medium text-zinc-900"> Send Slack message </span> automation can pick its own — nobody
              connects Slack again per project.
            </p>
          </div>
          {settings.connected ? <span className="chip bg-green-50 text-green-700">Connected</span> : <span className="chip">Not connected</span>}
        </div>
        <div className="px-5 py-4">
          {settings.connected ? (
            <div className="space-y-3">
              <p className="text-sm text-zinc-700">
                Connected to <span className="font-medium text-zinc-900">{settings.teamName ?? "your Slack workspace"}</span>
                {settings.connectedAt ? (
                  <>
                    {" "}
                    since <Timestamp iso={settings.connectedAt} />
                  </>
                ) : null}
                . {channels.length} channel{channels.length === 1 ? "" : "s"} available
                {settings.channelsRefreshedAt ? (
                  <>
                    {" "}
                    (checked <Timestamp iso={settings.channelsRefreshedAt} />)
                  </>
                ) : null}
                .
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => act(refreshSlackChannels, "Channel list updated")}
                  className="btn-secondary"
                >
                  <RefreshCw className="size-3.5" aria-hidden /> Refresh channels
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Disconnect Slack?",
                      message:
                        "Automations and projects that post to a channel stop posting until Slack is connected again (their choices are kept). Saved webhooks keep working.",
                      confirmLabel: "Disconnect",
                      tone: "danger",
                    });
                    if (ok) act(disconnectSlack, "Slack disconnected");
                  }}
                  className="btn-ghost text-red-700 hover:bg-red-50"
                >
                  Disconnect
                </button>
              </div>
              <p className="text-xs text-zinc-500">
                Private channels show up once the app is invited to them (in Slack: /invite @ALHC Projects). Public channels
                work without inviting it.
              </p>
            </div>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                const problem = slackTokenProblem(token);
                setTokenError(problem);
                if (problem) return;
                start(async () => {
                  const result = await connectSlack(token);
                  if (result.error) setTokenError(result.error);
                  else {
                    setToken("");
                    notify(`Slack connected (${result.channels ?? 0} channels)`);
                  }
                });
              }}
            >
              <ol className="list-decimal space-y-1 pl-5 text-sm text-zinc-600">
                <li>
                  <a href={slackManifestUrl()} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent-700 underline">
                    Create the Slack app <ExternalLink className="size-3" aria-hidden />
                  </a>{" "}
                  (opens Slack with the app’s settings filled in: it can post messages and see the channel list), and pick your
                  workspace.
                </li>
                <li>Choose <em>Install to Workspace</em> and allow it.</li>
                <li>
                  On <em>OAuth &amp; Permissions</em>, copy the <em>Bot User OAuth Token</em> (it starts with xoxb-) and paste it
                  here.
                </li>
              </ol>
              <div>
                <label htmlFor="slack-token" className="block text-xs font-medium text-zinc-700">
                  Bot User OAuth Token
                </label>
                <div className="mt-1 flex flex-wrap gap-2">
                  <input
                    id="slack-token"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={token}
                    onChange={(e) => {
                      setToken(e.target.value);
                      setTokenError(null);
                    }}
                    placeholder="xoxb-…"
                    aria-invalid={tokenError ? true : undefined}
                    aria-describedby={tokenError ? "slack-token-error" : "slack-token-hint"}
                    className="field min-w-0 flex-1 font-mono text-xs"
                  />
                  <button type="submit" disabled={pending} className="btn-primary">
                    {pending ? "Checking with Slack…" : "Connect Slack"}
                  </button>
                </div>
                {tokenError ? (
                  <p id="slack-token-error" role="alert" className="mt-1 text-xs text-red-700">
                    {tokenError}
                  </p>
                ) : (
                  <p id="slack-token-hint" className="mt-1 text-xs text-zinc-500">
                    Checked with Slack, then kept in the database where no browser can read it back.
                  </p>
                )}
              </div>
            </form>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-zinc-200" aria-labelledby="slack-destinations-heading">
        <div className="border-b border-zinc-200 px-5 py-4">
          <h2 id="slack-destinations-heading" className="text-sm font-semibold text-zinc-900">
            Where messages can go
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            Projects and automations choose from this list. Channels come from the connected app; webhooks are Slack incoming
            webhooks saved here (each project’s earlier webhook was moved here, so it keeps working).
          </p>
          {settings.legacyProjects ? (
            <p className="mt-2 text-xs text-amber-800">
              {settings.legacyProjects} project{settings.legacyProjects === 1 ? " still posts" : "s still post"} through a webhook
              set in its own settings. They keep working; pick a channel in each project’s Settings → Integrations to move them
              here.
            </p>
          ) : null}
        </div>
        {settings.destinations.length === 0 ? (
          <EmptyState icon={Hash} title="Nothing to post to yet" size="inline">
            Connect Slack above, or add a Slack incoming webhook below.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {[...channels, ...webhooks].map((d) => (
              <DestinationRow key={d.id} destination={d} pending={pending} act={act} />
            ))}
          </ul>
        )}
        <AddWebhook pending={pending} act={act} />
      </section>
    </div>
  );
}

function DestinationRow({
  destination: d,
  pending,
  act,
}: {
  destination: SlackDestination;
  pending: boolean;
  act: (fn: () => Promise<{ error?: string }>, ok?: string) => void;
}) {
  const confirm = useConfirm();
  const [renaming, setRenaming] = useState(false);
  const Icon = d.kind === "channel" ? (d.isPrivate ? Lock : Hash) : Link2;
  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-2.5">
      <Icon className="size-4 shrink-0 text-zinc-400" aria-hidden />
      {renaming && d.kind === "webhook" ? (
        <form
          className="flex min-w-0 flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const name = String(new FormData(e.currentTarget).get("name") ?? "");
            setRenaming(false);
            act(() => renameSlackDestination(d.id, name));
          }}
        >
          <label htmlFor={`rename-${d.id}`} className="sr-only">
            Name
          </label>
          <input id={`rename-${d.id}`} name="name" defaultValue={d.name} autoFocus maxLength={100} className="control min-w-0 flex-1" />
          <button type="submit" className="btn-secondary">
            Save
          </button>
        </form>
      ) : (
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-zinc-900">{destinationLabel(d)}</p>
          <p className="text-xs text-zinc-500">
            {d.kind === "channel"
              ? `${d.isPrivate ? "Private channel" : "Channel"}${d.available ? "" : " · posts once Slack is connected again"}`
              : `Incoming webhook · ${d.hint ?? "saved"}`}
          </p>
        </div>
      )}
      {d.kind === "webhook" && !renaming ? (
        <span className="flex items-center gap-1">
          <button type="button" disabled={pending} onClick={() => setRenaming(true)} className="btn-ghost">
            Rename
          </button>
          <button
            type="button"
            disabled={pending}
            aria-label={`Remove ${d.name}`}
            data-tooltip="Remove"
            onClick={async () => {
              const ok = await confirm({
                title: `Remove “${d.name}”?`,
                message: "Projects and automations that post here stop posting to Slack until they pick another channel.",
                confirmLabel: "Remove",
                tone: "danger",
              });
              if (ok) act(() => removeSlackDestination(d.id), "Removed");
            }}
            className="btn-icon hover:bg-red-50 hover:text-red-700"
          >
            <Trash2 className="size-4" />
          </button>
        </span>
      ) : null}
    </li>
  );
}

function AddWebhook({ pending, act }: { pending: boolean; act: (fn: () => Promise<{ error?: string }>, ok?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <div className="border-t border-zinc-100 px-5 py-3">
        <button type="button" onClick={() => setOpen(true)} className="btn-ghost">
          <Plus className="size-3.5" aria-hidden /> Add a Slack incoming webhook
        </button>
      </div>
    );
  }
  return (
    <form
      className="space-y-2 border-t border-zinc-100 px-5 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const name = String(data.get("name") ?? "").trim();
        const url = String(data.get("url") ?? "").trim();
        if (!name) return setError("Name the channel this webhook posts to.");
        if (!SLACK_WEBHOOK_PATTERN.test(url)) return setError("Paste a Slack incoming webhook URL (https://hooks.slack.com/…).");
        setError(null);
        setOpen(false);
        act(() => addSlackWebhookDestination(name, url), "Webhook saved");
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
        <div>
          <label htmlFor="slack-webhook-name" className="block text-xs font-medium text-zinc-700">
            Channel name
          </label>
          <input id="slack-webhook-name" name="name" maxLength={100} placeholder="#marketing" className="field mt-1 w-full" />
        </div>
        <div>
          <label htmlFor="slack-webhook-url" className="block text-xs font-medium text-zinc-700">
            Webhook URL
          </label>
          <input
            id="slack-webhook-url"
            name="url"
            type="password"
            autoComplete="off"
            placeholder="https://hooks.slack.com/services/…"
            className="field mt-1 w-full font-mono text-xs"
          />
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : (
        <p className="text-xs text-zinc-500">Anyone with this URL can post to the channel, so it’s never shown again after saving.</p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className="btn-primary">
          Save webhook
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn-ghost">
          Cancel
        </button>
      </div>
    </form>
  );
}
