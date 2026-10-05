"use client";

import { useState } from "react";
import { useServerAction } from "@/components/toast";
import { setProjectIntegration } from "@/lib/actions";
import {
  DEFAULT_SECRET_HEADER,
  WEBHOOK_URL_ERROR,
  isAllowedHeaderName,
  isAllowedWebhookUrl,
  type IntegrationSetting,
  type ProjectIntegrations,
} from "@/lib/integrations-shared";

const inputClass =
  "rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm focus:border-accent-500 focus:outline-none disabled:opacity-50";
const buttonClass = "rounded-md px-2.5 py-1 text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-50";

// Admin+ defaults for the Send Slack message / Call webhook rule actions. Saved values never come back
// to the browser: rows show a redacted hint (host + last 4 characters) with Replace / Clear.
export function IntegrationsSettings({
  projectId,
  initial,
}: {
  projectId: string;
  initial: ProjectIntegrations;
}) {
  const [settings, setSettings] = useState(initial);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-gutter py-5">
      <section className="rounded-lg border border-zinc-200 p-5" aria-labelledby="slack-heading">
        <h2 id="slack-heading" className="text-sm font-semibold text-zinc-900">
          Slack
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          The default channel for the <span className="font-medium text-zinc-900">Send Slack message</span> rule
          action. In Slack, create an app (or open an existing one), turn on <em>Incoming Webhooks</em>, choose{" "}
          <em>Add New Webhook to Workspace</em>, pick a channel, and paste the URL it gives you (it starts with
          https://hooks.slack.com/services/). Anyone with that URL can post to the channel, so treat it like a
          password.
        </p>
        <dl className="mt-4 divide-y divide-zinc-100">
          <SecretSetting
            projectId={projectId}
            setting="slack_webhook_url"
            label="Slack incoming webhook URL"
            placeholder="https://hooks.slack.com/services/…"
            current={settings.slackWebhook}
            validate={(v) => (isAllowedWebhookUrl(v) ? null : WEBHOOK_URL_ERROR)}
            onSaved={setSettings}
          />
        </dl>
      </section>

      <section className="rounded-lg border border-zinc-200 p-5" aria-labelledby="webhook-heading">
        <h2 id="webhook-heading" className="text-sm font-semibold text-zinc-900">
          Outbound webhook
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          The default target for the <span className="font-medium text-zinc-900">Call webhook</span> rule action,
          which POSTs a JSON summary of the task. Only public https:// addresses are accepted. The optional shared
          secret is sent in a request header (never in the body) so the receiver can check the call came from here;
          it is only sent to this URL, never to a URL set on an individual rule.
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
        </dl>
      </section>

      <p className="text-xs text-zinc-500">
        Deliveries are queued when a rule runs and sent within moments of the next change in the app, or by the
        scheduled job. Each queued or failed delivery shows in the task’s activity with the destination’s host
        only.
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
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
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
                onClick={() => {
                  if (window.confirm(`Clear the ${label.toLowerCase()}? Rules that rely on it will fail until it is set again.`)) {
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
