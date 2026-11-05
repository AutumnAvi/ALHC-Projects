"use client";

// Oct 26 notes (batch 3): a form is either Live (taking responses) or Off. One badge for the forms
// list, the Customize panel, and the form editor, and one switch for the editor's header.

export function FormStatusBadge({ live, className = "" }: { live: boolean; className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium ${
        live ? "bg-green-50 text-green-800" : "bg-zinc-100 text-zinc-600"
      } ${className}`}
      data-tooltip={live ? "Taking responses: anyone with the link can submit" : "Off: the form shows a closed notice"}
    >
      <span aria-hidden className={`size-1.5 rounded-full ${live ? "bg-green-500" : "bg-zinc-400"}`} />
      {live ? "Live" : "Off"}
    </span>
  );
}

// A switch that says what it does. It saves at once (onChange), so turning a form on or off never waits
// for the editor's Save.
export function FormLiveSwitch({
  live,
  disabled,
  onChange,
}: {
  live: boolean;
  disabled?: boolean;
  onChange: (live: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={live}
      aria-label={live ? "Form is live. Turn it off" : "Form is off. Turn it on"}
      data-tooltip={live ? "Turn off: stop taking responses" : "Turn on: start taking responses"}
      disabled={disabled}
      onClick={() => onChange(!live)}
      className={`inline-flex h-8 shrink-0 items-center gap-2 rounded-full border px-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        live
          ? "border-green-200 bg-green-50 text-green-800 hover:bg-green-100"
          : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50"
      }`}
    >
      <span
        aria-hidden
        className={`relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors ${live ? "bg-green-500" : "bg-zinc-300"}`}
      >
        <span
          className={`absolute top-0.5 size-3 rounded-full bg-white shadow transition-[left] ${live ? "left-3.5" : "left-0.5"}`}
        />
      </span>
      {live ? "Live" : "Off"}
    </button>
  );
}
