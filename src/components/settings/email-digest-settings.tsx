"use client";

import { useState, useSyncExternalStore } from "react";
import { Segmented } from "@/components/project/view-chrome";
import { SmartPicker } from "@/components/smart-picker";
import { useServerAction } from "@/components/toast";
import { setEmailDigest, setReportEmails } from "@/lib/actions";
import {
  DIGEST_FREQUENCIES,
  HOURS,
  WEEKDAYS,
  describeSchedule,
  hourLabel,
  type DigestFrequency,
  type EmailPreferences,
} from "@/lib/email-schedules";

const HEADING = "text-sm font-semibold text-zinc-900";

// The browser's IANA time zone (the digest's hour is in it). Server render: none yet.
function subscribeNever() {
  return () => {};
}
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function nextLabel(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString("en-US");
  }
}

// Settings → Notifications (Real features 3): the Inbox email digest — Off / Daily / Weekly, the hour
// (and weekday) in this browser's time zone — and whether scheduled report emails reach you. Each change
// saves at once; the database works out the next send time.
export function EmailDigestSettings({
  email,
  preferences,
  sending,
}: {
  email: string;
  preferences: EmailPreferences;
  sending: boolean;
}) {
  const zone = useSyncExternalStore(subscribeNever, browserTimeZone, () => null);
  const [values, setValues] = useState(preferences);
  const [pending, run] = useServerAction();
  // The zone the digest is saved in; a browser elsewhere shows it and saves its own zone on the next change.
  const savedZone = values.timeZone;
  const differentZone = zone && values.digest !== "off" && zone !== savedZone;

  function save(next: Pick<EmailPreferences, "digest" | "hour" | "weekday">) {
    const previous = values;
    const timeZone = zone ?? savedZone;
    setValues({ ...values, ...next, timeZone });
    run(async () => {
      const result = await setEmailDigest({ frequency: next.digest, hour: next.hour, weekday: next.weekday, timeZone });
      if (result.error) setValues(previous);
      else setValues((v) => ({ ...v, nextDigestAt: result.nextAt ?? null }));
      return result;
    });
  }

  function toggleReports(enabled: boolean) {
    const previous = values;
    setValues({ ...values, reportEmails: enabled });
    run(async () => {
      const result = await setReportEmails(enabled);
      if (result.error) setValues(previous);
      return result;
    });
  }

  return (
    <section aria-labelledby="email-digest-heading" className="flex flex-col gap-3">
      <div>
        <h3 id="email-digest-heading" className={HEADING}>
          Inbox email digest
        </h3>
        <p className="mt-1 text-sm text-zinc-600">
          One email to {email} with your unread Inbox notifications since the last digest, grouped by project. It’s
          skipped when there’s nothing new, and leaves out anything you’ve read, archived, or can no longer open.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Segmented<DigestFrequency>
          label="Inbox email digest"
          options={DIGEST_FREQUENCIES}
          value={values.digest}
          onChange={(digest) => {
            if (!pending && digest !== values.digest) save({ digest, hour: values.hour, weekday: values.weekday });
          }}
        />
        {values.digest === "weekly" ? (
          <span className="flex items-center gap-1.5 text-sm text-zinc-600">
            on
            <SmartPicker
              className="w-auto"
              label="Digest weekday"
              value={String(values.weekday)}
              disabled={pending}
              onChange={(v) => save({ digest: values.digest, hour: values.hour, weekday: Number(v) })}
              options={WEEKDAYS.map((day, index) => ({ value: String(index), label: day }))}
            />
          </span>
        ) : null}
        {values.digest !== "off" ? (
          <span className="flex items-center gap-1.5 text-sm text-zinc-600">
            at
            <SmartPicker
              className="w-auto"
              label="Digest hour"
              value={String(values.hour)}
              disabled={pending}
              onChange={(v) => save({ digest: values.digest, hour: Number(v), weekday: values.weekday })}
              options={HOURS.map((hour) => ({ value: String(hour), label: hourLabel(hour) }))}
            />
          </span>
        ) : null}
      </div>
      {values.digest !== "off" ? (
        <p className="text-xs text-zinc-500" aria-live="polite">
          {describeSchedule({ frequency: values.digest, hour: values.hour, weekday: values.weekday, timeZone: zone ?? savedZone })}
          {values.nextDigestAt && !pending ? ` · next one ${nextLabel(values.nextDigestAt, zone ?? savedZone)}` : ""}
          {differentZone ? ` · saved in ${savedZone.replace(/_/g, " ")}; your next change here uses this browser’s time zone` : ""}
          {sending ? "" : " · emails aren’t sent from this workspace yet (no email provider is set up)"}
        </p>
      ) : null}

      <label className="mt-2 flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 px-4 py-3 hover:bg-zinc-50">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-accent-600"
          checked={values.reportEmails}
          disabled={pending}
          onChange={(e) => toggleReports(e.target.checked)}
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-zinc-900">Scheduled report emails</span>
          <span className="mt-0.5 block text-sm text-zinc-600">
            Reports teammates schedule for you (Reports → Schedule email). Each one counts only projects you can open.
            Turning this off stops all of them, including ones already queued.
          </span>
        </span>
      </label>
    </section>
  );
}
