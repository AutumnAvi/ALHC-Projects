"use client";

import type { ReactNode } from "react";
import { Mic, Square } from "lucide-react";
import { formatElapsed, type Dictation } from "@/lib/dictation";

// Batch 45 (item 3): the dictation controls shared by every box that takes speech. `TalkButton` is the
// "Talk" pill (idle) and, while listening, the red "Listening… 0:07" pill (a click stops); `DictationBar` is
// the full row the comment box shows while listening (waveform, the pill, Cancel, Stop, then the box's own
// buttons). Nothing is drawn where the browser can't dictate (Firefox).

const PILL =
  "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-xs font-medium transition-colors";

export function TalkButton({
  dictation,
  onStart,
  label = "Dictate",
  className = "",
}: {
  dictation: Dictation;
  // Runs instead of dictation.start() (a box that must open for editing first starts it itself).
  onStart?: () => void;
  // What the box is, for the button's accessible name: "Dictate a comment".
  label?: string;
  className?: string;
}) {
  if (!dictation.supported) return null;
  if (dictation.listening) {
    return (
      <span className={`inline-flex items-center ${className}`}>
        <ListeningPill dictation={dictation} />
      </span>
    );
  }
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
      <button
        type="button"
        // mousedown, not click, keeps the box's cursor where it was (and the box open) until start() reads it.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (onStart ? onStart() : dictation.start())}
        aria-label={label}
        data-tooltip="Talk instead of typing (Esc stops)"
        data-dictation-talk=""
        className={`${PILL} border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900`}
      >
        <Mic className="size-3.5" strokeWidth={2.2} aria-hidden />
        Talk
      </button>
      <DictationError dictation={dictation} />
    </span>
  );
}

// The red pill: a dot, a mic, "Listening… 0:07". A button that stops (keeping what was said).
function ListeningPill({ dictation }: { dictation: Dictation }) {
  const clock = formatElapsed(dictation.elapsed);
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={dictation.stop}
      aria-label={`Listening, ${clock}. Stop dictation`}
      data-tooltip="Stop (Esc)"
      data-dictation-listening=""
      className={`${PILL} border-red-300 bg-red-50 pl-2 text-red-700 hover:bg-red-100`}
    >
      <span className="dictation-rec-dot size-2 rounded-full bg-red-500" aria-hidden />
      <Mic className="size-3.5" strokeWidth={2.2} aria-hidden />
      <span className="tabular-nums" aria-hidden>
        Listening… {clock}
      </span>
    </button>
  );
}

function DictationError({ dictation }: { dictation: Dictation }) {
  if (!dictation.error) return null;
  return (
    <span role="alert" className="min-w-0 truncate text-2xs text-red-600" title={dictation.error}>
      {dictation.error}
    </span>
  );
}

// A small moving waveform (still for people who asked for less motion).
export function DictationWave({ className = "" }: { className?: string }) {
  const heights = [6, 12, 18, 10, 22, 14, 8, 16, 20, 9, 13, 6, 17, 11, 7];
  return (
    <span className={`inline-flex h-6 items-center gap-0.5 ${className}`} aria-hidden data-dictation-wave="">
      {heights.map((h, i) => (
        <i
          key={i}
          className="dictation-wave-bar block w-[3px] rounded-sm bg-red-400"
          style={{ height: h, animationDelay: `${(i % 5) * 110}ms` }}
        />
      ))}
    </span>
  );
}

// The listening row: waveform, the red pill, Cancel (take back what this session wrote), Stop (keep it),
// then the box's own buttons (`children`, e.g. a disabled Comment). `compact` drops the waveform (heading
// rows). A polite live region tells screen readers dictation started and stopped.
export function DictationBar({
  dictation,
  compact = false,
  children,
  className = "",
}: {
  dictation: Dictation;
  compact?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  if (!dictation.supported || !dictation.listening) return null;
  return (
    <div className={`flex min-w-0 items-center gap-1.5 ${className}`} data-dictation-bar="">
      <span className="sr-only" role="status" aria-live="polite">
        Listening. Speak now; press Escape or Stop when you’re done.
      </span>
      {compact ? null : <DictationWave className="mr-auto max-sm:hidden" />}
      {compact ? <span className="mr-auto" /> : <span className="mr-auto sm:hidden" />}
      <ListeningPill dictation={dictation} />
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={dictation.cancel}
        data-tooltip="Remove what you just said"
        className="btn-ghost h-6 shrink-0 px-2 text-xs"
      >
        Cancel
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={dictation.stop}
        data-tooltip="Stop and keep the text (Esc)"
        className="btn-secondary h-6 shrink-0 gap-1 px-2 text-xs"
      >
        <Square className="size-2.5 fill-current" strokeWidth={3} aria-hidden />
        Stop
      </button>
      {children}
    </div>
  );
}

// For a plain textarea (no chip layer): the words heard but not settled yet, greyed, right under the box.
export function DictationInterim({ dictation, className = "" }: { dictation: Dictation; className?: string }) {
  if (!dictation.listening) return null;
  return (
    <p className={`min-h-5 truncate text-sm italic text-zinc-400 ${className}`} aria-hidden data-dictation-interim="">
      {dictation.interim || "Listening…"}
    </p>
  );
}
