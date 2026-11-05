"use client";

// Pause a rule for a while (Automations V3, batch E): the rule stays on but doesn't run until the time
// passes (its waiting steps wait too), then it resumes on its own. Used by project and portfolio rules.

import { CirclePause, Play } from "lucide-react";
import { useSyncExternalStore } from "react";
import { SmartPicker } from "@/components/smart-picker";
import { Timestamp } from "@/components/timestamp";

const DURATIONS = [
  { value: "1h", label: "For 1 hour", ms: 3600e3 },
  { value: "4h", label: "For 4 hours", ms: 4 * 3600e3 },
  { value: "1d", label: "For 1 day", ms: 24 * 3600e3 },
  { value: "3d", label: "For 3 days", ms: 3 * 24 * 3600e3 },
  { value: "1w", label: "For 1 week", ms: 7 * 24 * 3600e3 },
  { value: "2w", label: "For 2 weeks", ms: 14 * 24 * 3600e3 },
  { value: "30d", label: "For 30 days", ms: 30 * 24 * 3600e3 },
] as const;

function noSubscribe() {
  return () => {};
}

// Whether a pause is still on (read in the browser after hydration; the server says "not yet known").
export function usePausedNow(pausedUntil: string | null | undefined): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => Boolean(pausedUntil && Date.parse(pausedUntil) > Date.now()),
    () => false,
  );
}

export function isPausedNow(pausedUntil: string | null | undefined) {
  return Boolean(pausedUntil && Date.parse(pausedUntil) > Date.now());
}

export function RulePauseControls({
  name,
  pausedUntil,
  disabled,
  unavailable,
  onChange,
}: {
  name: string;
  pausedUntil: string | null | undefined;
  disabled?: boolean;
  // A reason pausing isn't offered (e.g. the database update isn't applied).
  unavailable?: string | null;
  onChange: (until: string | null) => void;
}) {
  const paused = usePausedNow(pausedUntil);
  if (paused && pausedUntil) {
    return (
      <span className="flex items-center gap-1">
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-2xs font-medium text-amber-800">
          Paused until <Timestamp iso={pausedUntil} />
        </span>
        <button
          type="button"
          aria-label={`Resume ${name} now`}
          data-tooltip="Resume now"
          disabled={disabled}
          onClick={() => onChange(null)}
          className="btn-secondary h-7 px-2 text-xs"
        >
          <Play className="size-3.5" aria-hidden />
          Resume
        </button>
      </span>
    );
  }
  return (
    <SmartPicker
      label={`Pause ${name}`}
      value={null}
      options={DURATIONS.map((d) => ({
        value: d.value,
        label: d.label,
        ...(unavailable ? { disabled: true, disabledReason: unavailable } : {}),
      }))}
      onChange={(v) => {
        const d = DURATIONS.find((x) => x.value === v);
        if (d) onChange(new Date(Date.now() + d.ms).toISOString());
      }}
      variant="ghost"
      disabled={disabled}
      className="h-7 px-1.5 text-xs"
      renderValue={() => (
        <>
          <CirclePause className="size-3.5" aria-hidden />
          Pause
        </>
      )}
    />
  );
}
