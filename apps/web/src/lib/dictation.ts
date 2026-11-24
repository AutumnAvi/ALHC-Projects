"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

// Batch 45 (item 3): free, built-in dictation. The browser's own Web Speech API turns speech into text —
// no paid service, no keys, nothing of ours on a server. Chrome, Edge, and Safari have it (Chrome as
// `webkitSpeechRecognition`); Firefox doesn't, so the "Talk" button simply isn't drawn there. The pure
// parts (the support check, where recognised words go) are unit-tested; useDictation runs one session.

// The bits of the API this file uses (the DOM library has no types for it).
type RecognitionAlternative = { transcript: string };
type RecognitionResult = { isFinal: boolean; length: number; [index: number]: RecognitionAlternative };
type RecognitionResultEvent = { resultIndex: number; results: { length: number; [index: number]: RecognitionResult } };
type RecognitionErrorEvent = { error: string };
export type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

// The constructor dictation would use on this window, or null where it can't work: no API (Firefox), or a
// page that isn't a secure context (the browser refuses the microphone there anyway).
export function dictationSupport(win: unknown): SpeechRecognitionCtor | null {
  if (!win || typeof win !== "object") return null;
  const w = win as { isSecureContext?: boolean; SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  if (w.isSecureContext === false) return null;
  const ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return typeof ctor === "function" ? (ctor as SpeechRecognitionCtor) : null;
}

// "0:07", "1:15".
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Where recognised words go: in place of the selection [start, end) (the cursor when they're equal), with a
// space before them unless they start a line or follow a space, a space after them unless a space or
// punctuation follows, and a capital letter at the start of the text or of a sentence. Returns the new text
// and the cursor after the words. Spoken punctuation the browser already wrote ("," "?") stays as it is.
// `from` is where the words themselves begin (after the space put before them).
export function insertDictated(
  text: string,
  start: number,
  end: number,
  spoken: string,
): { text: string; caret: number; from: number } {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  let words = spoken.replace(/\s+/g, " ").trim();
  if (!words) return { text, caret: from, from };
  const before = text.slice(0, from);
  const after = text.slice(to);
  const prev = before.replace(/[ \t ]+$/, "");
  const sentenceStart = prev === "" || /[.!?]["'”’)]*$/.test(prev) || /\n$/.test(before);
  if (sentenceStart) words = words.charAt(0).toUpperCase() + words.slice(1);
  const leadingPunct = /^[,.;:!?)\]}’”]/.test(words);
  const lead = before === "" || /\s$/.test(before) || leadingPunct ? "" : " ";
  const trail = after === "" || /^[\s,.;:!?)\]}’”]/.test(after) ? "" : " ";
  const inserted = `${lead}${words}${trail}`;
  return {
    text: before + inserted + after,
    caret: before.length + lead.length + words.length,
    from: before.length + lead.length,
  };
}

// What the browser said went wrong, in plain words (null = nothing to tell: the person stopped, or there
// was no speech and the session just ended).
export function dictationErrorMessage(code: string): string | null {
  switch (code) {
    case "aborted":
    case "no-speech":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access is blocked. Allow it for this site in the browser to dictate.";
    case "audio-capture":
      return "No microphone was found.";
    case "network":
      return "Dictation needs an internet connection in this browser.";
    case "language-not-supported":
      return "Dictation doesn’t support this language in this browser.";
    default:
      return "Dictation stopped. Try again.";
  }
}

// The box dictation writes into: its own text (with whatever invisible marks it keeps), a way to set it and
// the cursor, the selection when dictation starts, and focus.
export type DictationTarget = {
  getText(): string;
  setText(next: string, caret: number): void;
  getRange(): { start: number; end: number };
  // Focus the box with the cursor at `caret` (where the words will go).
  focus?(caret: number): void;
};

export type Dictation = {
  supported: boolean;
  listening: boolean;
  // Words heard but not settled yet (shown greyed at `at` in the box's text).
  interim: string;
  at: number | null;
  elapsed: number;
  error: string | null;
  start(): void;
  // Keep what was said (Stop, Esc).
  stop(): void;
  // Take back everything this session wrote (Cancel).
  cancel(): void;
  // End the session right away keeping the greyed words as typed text (someone typed into the box): the
  // box writes them itself; nothing more arrives.
  abandon(): void;
  // The box this dictation writes into calls this while it's on the page (returns the detach).
  attach(target: DictationTarget): () => void;
};

const noopSubscribe = () => () => {};

// Whether this browser can dictate (false on the server and until hydration, so nothing is drawn twice).
export function useDictationSupported(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => dictationSupport(window) !== null,
    () => false,
  );
}

// Escape belongs to an open dictation first (it stops it), so other window listeners can tell.
let activeSessions = 0;
export function isDictating(): boolean {
  return activeSessions > 0;
}

type Session = {
  recognition: SpeechRecognitionLike;
  snapshot: string;
  range: { start: number; end: number };
  cursor: number;
  selEnd: number;
  // The text the box returns until it renders our last write (two results can land between renders).
  before: string | null;
  expected: string | null;
  done: boolean;
  // Stop was pressed: the last words may still come; nothing more is shown as unsettled.
  stopping: boolean;
  counted: boolean;
};

// One dictation session at a time per box: start → words land at the cursor as they settle (the unsettled
// ones are `interim`) → Stop (keep) / Cancel (take back) / the browser ending it (silence). Esc stops it
// anywhere on the page, and never reaches the pane or dialog behind. `onEnd` runs once the session is
// fully over (after its last words), e.g. to save a box that saves on blur.
export function useDictation({ lang, onEnd }: { lang?: string; onEnd?: () => void } = {}): Dictation {
  const supported = useDictationSupported();
  const target = useRef<DictationTarget | null>(null);
  const session = useRef<Session | null>(null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [at, setAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const startedAt = useRef(0);
  const onEndRef = useRef(onEnd);
  useEffect(() => {
    onEndRef.current = onEnd;
  });

  const release = useCallback((s: Session) => {
    if (s.counted) {
      s.counted = false;
      activeSessions = Math.max(0, activeSessions - 1);
    }
  }, []);

  const finish = useCallback(
    (s: Session) => {
      if (s.done) return;
      s.done = true;
      release(s);
      if (session.current === s) session.current = null;
      setListening(false);
      setInterim("");
      setAt(null);
      onEndRef.current?.();
    },
    [release],
  );

  const insertFinal = useCallback((s: Session, spoken: string) => {
    const box = target.current;
    if (!box) return;
    const current = box.getText();
    const stale = s.expected !== null && current === s.before;
    const base = stale ? (s.expected as string) : current;
    const result = insertDictated(base, s.cursor, s.selEnd, spoken);
    if (result.text === base) return;
    s.before = stale ? s.before : current;
    s.expected = result.text;
    s.cursor = result.caret;
    s.selEnd = result.caret;
    box.setText(result.text, result.caret);
  }, []);

  const start = useCallback(() => {
    if (session.current || !supported) return;
    const Ctor = dictationSupport(window);
    const box = target.current;
    if (!Ctor || !box) return;
    const range = box.getRange();
    box.focus?.(range.start);
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = lang || document.documentElement.lang || navigator.language || "en-US";
    const s: Session = {
      recognition,
      snapshot: box.getText(),
      range,
      cursor: range.start,
      selEnd: range.end,
      before: null,
      expected: null,
      done: false,
      stopping: false,
      counted: false,
    };
    recognition.onresult = (event) => {
      if (s.done || session.current !== s) return;
      let unsettled = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const words = result[0]?.transcript ?? "";
        if (result.isFinal) insertFinal(s, words);
        else unsettled += words;
      }
      if (s.stopping) return;
      setInterim(unsettled.replace(/\s+/g, " ").trim());
      setAt(s.cursor);
    };
    recognition.onerror = (event) => {
      const message = dictationErrorMessage(event.error);
      if (message) setError(message);
    };
    recognition.onend = () => finish(s);
    try {
      recognition.start();
    } catch {
      setError("Dictation couldn’t start. Try again.");
      return;
    }
    session.current = s;
    s.counted = true;
    activeSessions += 1;
    startedAt.current = Date.now();
    setElapsed(0);
    setError(null);
    setInterim("");
    setAt(range.start);
    setListening(true);
  }, [supported, lang, insertFinal, finish]);

  const stop = useCallback(() => {
    const s = session.current;
    if (!s) return;
    // The last words may still arrive after stop(); they're kept (insertFinal still runs until `end`).
    s.stopping = true;
    release(s);
    setListening(false);
    setInterim("");
    try {
      s.recognition.stop();
    } catch {
      finish(s);
      return;
    }
    // A browser that never says it ended doesn't keep the box waiting.
    window.setTimeout(() => finish(s), 4000);
  }, [finish, release]);

  const cancel = useCallback(() => {
    const s = session.current;
    if (!s) return;
    s.done = true;
    release(s);
    session.current = null;
    try {
      s.recognition.abort();
    } catch {
      // Already over.
    }
    target.current?.setText(s.snapshot, s.range.start);
    setListening(false);
    setInterim("");
    setAt(null);
    onEndRef.current?.();
  }, [release]);

  const abandon = useCallback(() => {
    const s = session.current;
    if (!s) return;
    s.done = true;
    release(s);
    session.current = null;
    try {
      s.recognition.abort();
    } catch {
      // Already over.
    }
    setListening(false);
    setInterim("");
    setAt(null);
  }, [release]);

  // The clock while listening.
  useEffect(() => {
    if (!listening) return;
    const timer = window.setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 250);
    return () => window.clearInterval(timer);
  }, [listening]);

  // Esc stops dictation wherever focus is (the textarea, the Stop button…), before the pane, a dialog, or
  // a menu sees it: a capture listener on window runs first, and stopping it there keeps it from them.
  useEffect(() => {
    if (!listening) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      stop();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening, stop]);

  // Leaving the page (or the box going away) ends the session without touching the text.
  useEffect(
    () => () => {
      const s = session.current;
      if (!s) return;
      s.done = true;
      release(s);
      session.current = null;
      try {
        s.recognition.abort();
      } catch {
        // Already over.
      }
    },
    [release],
  );

  const attach = useCallback((box: DictationTarget) => {
    target.current = box;
    return () => {
      if (target.current === box) target.current = null;
    };
  }, []);

  return { supported, listening, interim, at, elapsed, error, start, stop, cancel, abandon, attach };
}

// A plain controlled <textarea> as a dictation target (the long text editor, a status update's summary).
export function textareaTarget(
  element: () => HTMLTextAreaElement | null,
  getText: () => string,
  setText: (next: string) => void,
): DictationTarget {
  return {
    getText,
    setText(next, caret) {
      setText(next);
      requestAnimationFrame(() => element()?.setSelectionRange(caret, caret));
    },
    getRange() {
      const el = element();
      const text = getText();
      if (!el || document.activeElement !== el) return { start: text.length, end: text.length };
      return { start: el.selectionStart ?? text.length, end: el.selectionEnd ?? text.length };
    },
    focus(caret) {
      const el = element();
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    },
  };
}
