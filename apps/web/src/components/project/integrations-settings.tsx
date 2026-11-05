"use client";

import Link from "next/link";
import { useState } from "react";
import { useConfirm } from "@/components/confirm";
import { useServerAction } from "@/components/toast";
import {
  clearProjectSigningSecret,
  generateProjectSigningSecret,
  setProjectIntegration,
} from "@/lib/actions/integrations";
import { Hash, Link2 } from "lucide-react";
import { SmartPicker } from "@/components/smart-picker";
import { NO_SLACK, destinationLabel, type SlackSettings } from "@alhc/core/slack";
import { setProjectSlackDestination } from "@/lib/actions/slack";
import {
  DEFAULT_SECRET_HEADER,
  SIGNATURE_HEADER,
  SIGNATURE_TOLERANCE_SECONDS,
  TIMESTAMP_HEADER,
  WEBHOOK_URL_ERROR,
  isAllowedHeaderName,
  isAllowedWebhookUrl,
  type IntegrationSetting,
  type ProjectIntegrations,
} from "@alhc/core/integrations-shared";

// Nov 2 notes (batch 14, 105): the project's Slack channel, picked from the workspace's list. Slack is
// connected once in Admin console → Integrations; nobody pastes a webhook per project any more. A project
// still on its own old webhook keeps posting there until a channel is picked.
function SlackChannelSetting({
  projectId,
  slack,
  current,
  legacyWebhook,
}: {
  projectId: string;
  slack: SlackSettings;
  current: ProjectIntegrations["slackDestination"];
  legacyWebhook: string | null;
}) {
  const [pending, run] = useServerAction();
  const [value, setValue] = useState(current?.id ?? "");
  const options = slack.destinations.map((d) => ({
    value: d.id,
    label: destinationLabel(d),
    group: d.kind === "channel" ? "Channels" : "Saved webhooks",
    description: d.kind === "channel" ? (d.available ? undefined : "Posts once Slack is connected again") : d.hint ?? undefined,
    icon: d.kind === "channel" ? <Hash className="size-3.5 text-zinc-400" aria-hidden /> : <Link2 className="size-3.5 text-zinc-400" aria-hidden />,
  }));
  return (
    <section className="rounded-lg border border-zinc-200 p-5" aria-labelledby="slack-heading">
      <h2 id="slack-heading" className="text-sm font-semibold text-zinc-900">
        Slack
      </h2>
      <p className="mt-1 text-sm text-zinc-600">
        Where this project’s <span className="font-medium text-zinc-900">Send Slack message</span> automations post
        (each automation can also pick its own channel). Slack is connected once for the whole workspace in{" "}
        <span className="font-medium text-zinc-900">Admin console → Integrations</span>; pick one of its channels here.
      </p>
      {options.length === 0 ? (
        <p className="mt-3 rounded-md bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
          No Slack channels yet. Ask a workspace admin to connect Slack in Admin console → Integrations.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label htmlFor="project-slack-channel" className="text-sm text-zinc-700">
            Channel
          </label>
          <SmartPicker
            id="project-slack-channel"
            label="Slack channel"
            value={value}
            searchable
            placeholder="Choose a channel"
            className="min-w-56"
            options={[{ value: "", label: "None", group: "Channels" }, ...options]}
            onChange={(next) => {
              const previous = value;
              setValue(next);
              run(async () => {
                const result = await setProjectSlackDestination(projectId, next || null);
                if (result.error) setValue(previous);
                return result;
              });
            }}
            disabled={pending}
          />
        </div>
      )}
      {legacyWebhook && !value ? (
        <p className="mt-3 text-xs text-amber-800">
          This project still posts through its own old webhook ({legacyWebhook}). Pick a channel above to use the
          workspace’s Slack connection instead.
        </p>
      ) : null}
    </section>
  );
}

const inputClass =
  "field h-auto py-1.5";
const buttonClass = "rounded-md px-2.5 py-1 text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-50";

// Admin+ defaults for the Send Slack message / Call webhook rule actions. Saved values never come back
// to the browser: rows show a redacted hint (host + last 4 characters) with Replace / Clear.
export function IntegrationsSettings({
  projectId,
  initial,
  slack = NO_SLACK,
}: {
  projectId: string;
  initial: ProjectIntegrations;
  // Nov 2 notes (batch 14, 105): the workspace's Slack connection and channels (Admin console → Integrations).
  slack?: SlackSettings;
}) {
  const [settings, setSettings] = useState(initial);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-gutter py-5">
      <SlackChannelSetting projectId={projectId} slack={slack} current={settings.slackDestination ?? null} legacyWebhook={settings.slackWebhook} />

      <section className="rounded-lg border border-zinc-200 p-5" aria-labelledby="webhook-heading">
        <h2 id="webhook-heading" className="text-sm font-semibold text-zinc-900">
          Outbound webhook
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          The default target for the <span className="font-medium text-zinc-900">Call webhook</span> automation action,
          which POSTs a JSON summary of the task. Only public https:// addresses are accepted. The optional shared
          secret is sent in a request header (never in the body) so the receiver can check the call came from here;
          it is only sent to this URL, never to a URL set on an individual automation.
        </p>
        <dl className="mt-4 divide-y divide-zinc-100">
          <SecretSetting
            projectId={projectId}
            setting="webhook_url"
            label="Webhook URL"
            placeholder="https://example.com/hooks/alhc"
            current={settings.webhook}
            validate={(v) => (isAllowedWebhookUrl(v) ? null : WEBHOOK_URL_ERROR)}
            onSaved={setSettings}
          />
          <SecretSetting
            projectId={projectId}
            setting="webhook_secret"
            label="Shared secret"
            placeholder="A long random string"
            current={settings.webhookSecretSet ? "Saved" : null}
            validate={(v) => (v.length > 500 ? "The shared secret is limited to 500 characters" : null)}
            onSaved={setSettings}
          />
          <HeaderSetting projectId={projectId} current={settings.webhookSecretHeader} onSaved={setSettings} />
          <SigningSetting projectId={projectId} settings={settings} onSaved={setSettings} />
        </dl>
      </section>

      <p className="text-xs text-zinc-500">
        Deliveries are queued when an automation runs and sent within moments of the next change in the app, or by the
        scheduled job. Each queued or failed delivery shows in the task’s activity with the destination’s host
        only, and every delivery is listed under{" "}
        <Link href={`/projects/${projectId}/settings/deliveries`} className="text-accent-700 hover:underline">
          Deliveries
        </Link>{" "}
        with retry and cancel. To create tasks here from another tool, use{" "}
        <Link href={`/projects/${projectId}/settings/inbound`} className="text-accent-700 hover:underline">
          Inbound
        </Link>{" "}
        webhooks.
      </p>
    </div>
  );
}

function SecretSetting({
  projectId,
  setting,
  label,
  placeholder,
  current,
  validate,
  onSaved,
}: {
  projectId: string;
  setting: IntegrationSetting;
  label: string;
  placeholder: string;
  current: string | null;
  validate: (value: string) => string | null;
  onSaved: (settings: ProjectIntegrations) => void;
}) {
  const [pending, run] = useServerAction();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const error = value.trim() ? validate(value.trim()) : null;
  const inputId = `integration-${setting}`;

  function save(next: string) {
    run(async () => {
      const result = await setProjectIntegration(projectId, setting, next);
      if (!result.error && result.settings) {
        onSaved(result.settings);
        setEditing(false);
        setValue("");
      }
      return result;
    });
  }

  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start">
      <dt className="w-48 shrink-0 pt-1 text-xs font-medium text-zinc-600">
        {editing ? <label htmlFor={inputId}>{label}</label> : label}
      </dt>
      <dd className="min-w-0 flex-1">
        {editing ? (
          <form
            className="flex flex-col gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (!error && value.trim()) save(value);
            }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <input
                id={inputId}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={placeholder}
                value={value}
                maxLength={2000}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? `${inputId}-error` : undefined}
                onChange={(e) => setValue(e.currentTarget.value)}
                className={`${inputClass} min-w-0 flex-1`}
              />
              <button
                type="submit"
                disabled={pending || !value.trim() || Boolean(error)}
                className="rounded-md bg-accent-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-600 disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setValue("");
                }}
                className={buttonClass}
              >
                Cancel
              </button>
            </div>
            {error ? (
              <p id={`${inputId}-error`} className="text-xs text-red-700">
                {error}
              </p>
            ) : null}
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {current ? (
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-700">{current}</span>
            ) : (
              <span className="text-sm text-zinc-500">Not set</span>
            )}
            <button type="button" onClick={() => setEditing(true)} className={buttonClass} aria-label={`${current ? "Replace" : "Set"} ${label}`}>
              {current ? "Replace" : "Set"}
            </button>
            {current ? (
              <button
                type="button"
                disabled={pending}
                aria-label={`Clear ${label}`}
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Clear the ${label.toLowerCase()}?`,
                      message: "Automations that rely on it will fail until it is set again.",
                      confirmLabel: "Clear",
                      tone: "danger",
                    })
                  ) {
                    save("");
                  }
                }}
                className={buttonClass}
              >
                Clear
              </button>
            ) : null}
          </div>
        )}
      </dd>
    </div>
  );
}

function HeaderSetting({
  projectId,
  current,
  onSaved,
}: {
  projectId: string;
  current: string | null;
  onSaved: (settings: ProjectIntegrations) => void;
}) {
  const [pending, run] = useServerAction();
  const [value, setValue] = useState(current ?? "");
  const invalid = value.trim() !== "" && !isAllowedHeaderName(value.trim());

  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start">
      <dt className="w-48 shrink-0 pt-1 text-xs font-medium text-zinc-600">
        <label htmlFor="integration-webhook_secret_header">Secret header name</label>
      </dt>
      <dd className="min-w-0 flex-1">
        <form
          className="flex flex-col gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (invalid) return;
            run(async () => {
              const result = await setProjectIntegration(projectId, "webhook_secret_header", value);
              if (!result.error && result.settings) onSaved(result.settings);
              return result;
            });
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="integration-webhook_secret_header"
              value={value}
              maxLength={100}
              placeholder={DEFAULT_SECRET_HEADER}
              aria-invalid={invalid}
              aria-describedby="integration-webhook_secret_header-help"
              onChange={(e) => setValue(e.currentTarget.value)}
              className={`${inputClass} w-64`}
            />
            <button
              type="submit"
              disabled={pending || invalid || value.trim() === (current ?? "")}
              className={buttonClass}
            >
              Save
            </button>
          </div>
          <p id="integration-webhook_secret_header-help" className={`text-xs ${invalid ? "text-red-700" : "text-zinc-500"}`}>
            {invalid
              ? "Use letters, digits, and dashes; standard headers like Content-Type are reserved."
              : `Defaults to ${DEFAULT_SECRET_HEADER}. Use “Authorization” with a secret like “Bearer …” for token auth.`}
          </p>
        </form>
      </dd>
    </div>
  );
}

// The project signing secret: generated by the app, shown once right after it is created, and never
// again (the settings RPC only says whether one is set). Requests to the project URL then carry
// X-ALHC-Timestamp and X-ALHC-Signature.
function SigningSetting({
  projectId,
  settings,
  onSaved,
}: {
  projectId: string;
  settings: ProjectIntegrations;
  onSaved: (settings: ProjectIntegrations) => void;
}) {
  const [pending, run] = useServerAction();
  const confirm = useConfirm();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const label = "Signing secret";

  function generate() {
    run(async () => {
      const result = await generateProjectSigningSecret(projectId);
      if (!result.error && result.secret && result.settings) {
        onSaved(result.settings);
        setRevealed(result.secret);
        setCopied(false);
      }
      return result;
    });
  }

  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start">
      <dt className="w-48 shrink-0 pt-1 text-xs font-medium text-zinc-600">{label}</dt>
      <dd className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {settings.signingSecretSet ? (
            <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-700">Saved</span>
          ) : (
            <span className="text-sm text-zinc-500">Not set — requests aren’t signed</span>
          )}
          <button
            type="button"
            disabled={pending}
            onClick={async () => {
              if (
                !settings.signingSecretSet ||
                (await confirm({
                  title: "Generate a new signing secret?",
                  message: "The receiver must switch to the new one: requests queued from now on are signed with it.",
                  confirmLabel: "Regenerate",
                  tone: "danger",
                }))
              ) {
                generate();
              }
            }}
            className={buttonClass}
          >
            {settings.signingSecretSet ? "Regenerate" : "Generate"}
          </button>
          {settings.signingSecretSet ? (
            <button
              type="button"
              disabled={pending}
              aria-label={`Clear ${label}`}
              onClick={async () => {
                if (
                  await confirm({
                    title: "Stop signing requests to the project webhook?",
                    message: "Receivers that check signatures will reject them.",
                    confirmLabel: "Stop signing",
                    tone: "danger",
                  })
                ) {
                  run(async () => {
                    const result = await clearProjectSigningSecret(projectId);
                    if (!result.error && result.settings) {
                      onSaved(result.settings);
                      setRevealed(null);
                    }
                    return result;
                  });
                }
              }}
              className={buttonClass}
            >
              Clear
            </button>
          ) : null}
        </div>
        {revealed ? (
          <div role="status" className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3">
            <p className="text-sm font-medium text-amber-900">Copy this secret now — it won’t be shown again.</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-white px-2 py-1 font-mono text-xs text-zinc-900">
                {revealed}
              </code>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(revealed).then(() => setCopied(true));
                }}
                className={buttonClass}
              >
                {copied ? "Copied" : "Copy"}
              </button>
              <button type="button" onClick={() => setRevealed(null)} className={buttonClass}>
                Done
              </button>
            </div>
          </div>
        ) : null}
        <p className="text-xs text-zinc-500">
          Signs each request to the project URL: {TIMESTAMP_HEADER} is the send time in Unix seconds and{" "}
          {SIGNATURE_HEADER} is <span className="font-mono">sha256=</span> + the hex HMAC-SHA256 of “timestamp.raw body”
          with this secret. Receivers should recompute it over the raw body, compare in constant time, and reject
          timestamps more than {SIGNATURE_TOLERANCE_SECONDS / 60} minutes old. Works alongside the shared secret header.
        </p>
      </dd>
    </div>
  );
}
