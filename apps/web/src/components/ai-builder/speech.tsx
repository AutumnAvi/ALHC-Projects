"use client";

// AI builder round 2: dictation for the AI boxes, with the browser's own Web Speech API (SpeechRecognition,
// or webkitSpeechRecognition in Chrome / Safari). It only fills the text box: the person reads it and sends
// it themselves. Where the browser has no speech recognition the mic isn't shown at all.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Mic, MicOff } from "lucide-react";

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> };
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type RecognitionCtor = new () => Recognition;

export function speechRecognitionCtor(win: unknown = typeof window === "undefined" ? undefined : window): RecognitionCtor | null {
  if (!win || typeof win !== "object") return null;
  const w = win as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const noSubscribe = () => () => undefined;

// True only in a browser that can listen (false on the server, so the first render matches).
export function useSpeechSupported(): boolean {
  return useSyncExternalStore(noSubscribe, () => speechRecognitionCtor() !== null, () => false);
}

// Appends what was said to the text (with a space), final words only; `onText` gets the whole new text.
export function MicButton({ text, onText, disabled = false }: { text: string; onText: (next: string) => void; disabled?: boolean }) {
  const supported = useSpeechSupported();
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognition = useRef<Recognition | null>(null);
  const textRef = useRef(text);
  const onTextRef = useRef(onText);
  useEffect(() => {
    textRef.current = text;
    onTextRef.current = onText;
  }, [text, onText]);
  useEffect(() => () => recognition.current?.abort(), []);

  if (!supported) return null;

  function toggle() {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = navigator.language || "en-US";
    r.continuous = true;
    r.interimResults = false;
    r.onresult = (event) => {
      let said = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) said += result[0].transcript;
      }
      said = said.trim();
      if (!said) return;
      const current = textRef.current;
      onTextRef.current(current ? `${current.trimEnd()} ${said}` : said);
    };
    r.onerror = (event) => setError(event.error === "not-allowed" ? "Allow the microphone to dictate" : "Dictation stopped");
    r.onend = () => setListening(false);
    recognition.current = r;
    setError(null);
    try {
      r.start();
      setListening(true);
    } catch {
      setError("Dictation couldn’t start");
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-pressed={listening}
        aria-label={listening ? "Stop dictating" : "Dictate"}
        data-tooltip={listening ? "Stop dictating" : "Dictate (fills the box; you send it)"}
        className={`btn-icon ${listening ? "bg-red-50 text-red-700 hover:bg-red-100" : ""}`}
      >
        {listening ? <MicOff className="size-4" aria-hidden /> : <Mic className="size-4" aria-hidden />}
      </button>
      {listening ? (
        <span role="status" className="text-2xs text-red-700">
          Listening…
        </span>
      ) : error ? (
        <span role="status" className="text-2xs text-amber-800">
          {error}
        </span>
      ) : null}
    </span>
  );
}
