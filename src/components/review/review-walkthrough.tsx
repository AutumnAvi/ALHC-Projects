"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check, Download, MessageSquarePlus, Upload, X } from "lucide-react";

// Oct 27 notes (batch 5): "How it works" on the public review page. A small modal of five slides that slide
// sideways (no motion when the browser asks for reduced motion): pins on images and PDFs, comments on a
// moment of a video, full-quality files, sending files back, and the answer. X (or Escape) closes it from
// any slide, Finish on the last one; Back / Next and the dots move between slides. Tab stays inside.

type Slide = { title: string; body: string; art: ReactNode };

function PinDot({ n, className = "" }: { n: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={`absolute flex size-5 items-center justify-center rounded-full border-2 border-white bg-accent-600 text-2xs font-semibold text-white shadow ${className}`}
    >
      {n}
    </span>
  );
}

const SLIDES: Slide[] = [
  {
    title: "Pin comments right on the file",
    body: "Click anywhere on an image or a PDF page to drop a numbered pin, then type what should change there.",
    art: (
      <div className="relative h-24 w-40 rounded-md border border-zinc-200 bg-gradient-to-br from-zinc-100 to-zinc-200">
        <span aria-hidden className="absolute left-3 top-3 h-2 w-16 rounded bg-white/80" />
        <span aria-hidden className="absolute left-3 top-7 h-2 w-24 rounded bg-white/60" />
        <PinDot n={1} className="left-[60%] top-[30%]" />
        <PinDot n={2} className="left-[25%] top-[65%]" />
      </div>
    ),
  },
  {
    title: "Comment on a moment of a video",
    body: "Pause where you want and use “Comment at 0:12”. Each comment gets a marker on the timeline; click one to jump back to it.",
    art: (
      <div className="w-44">
        <div className="flex h-20 items-center justify-center rounded-md bg-zinc-900 text-white/80">
          <span aria-hidden className="ml-1 border-y-[10px] border-l-[16px] border-y-transparent border-l-white/80" />
        </div>
        <div className="relative mt-3 h-1.5 rounded bg-zinc-200">
          <span aria-hidden className="absolute left-0 top-0 h-full w-[45%] rounded bg-zinc-400" />
          <PinDot n={1} className="left-[30%] top-1/2 -translate-x-1/2 -translate-y-1/2" />
          <PinDot n={2} className="left-[72%] top-1/2 -translate-x-1/2 -translate-y-1/2" />
        </div>
      </div>
    ),
  },
  {
    title: "See every file in full quality",
    body: "Files show one at a time. Use Previous and Next, or pick one from the list. Full size opens it on its own, and Download keeps the original.",
    art: (
      <div className="flex items-center gap-2">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            aria-hidden
            className={`h-20 rounded-md border ${i === 1 ? "w-20 border-accent-400 bg-accent-50 shadow" : "w-12 border-zinc-200 bg-zinc-100"}`}
          />
        ))}
        <Download className="size-5 text-zinc-500" aria-hidden />
      </div>
    ),
  },
  {
    title: "Send files back",
    body: "Have a better file, or something they asked for? Upload it in full quality (up to 25 MB each). It goes straight to the team.",
    art: (
      <div className="flex h-20 w-40 flex-col items-center justify-center gap-1.5 rounded-md border-2 border-dashed border-zinc-300 text-zinc-500">
        <Upload className="size-6" aria-hidden />
        <span className="text-2xs">Upload files</span>
      </div>
    ),
  },
  {
    title: "Approve or request changes",
    body: "Pick an answer, add a note if you like, and send it. Everything saves as you go, so you can leave and come back to this link.",
    art: (
      <div className="flex flex-col gap-1.5">
        <span className="flex h-8 w-40 items-center gap-2 rounded-md border border-green-500 bg-green-50 px-2 text-xs font-medium text-green-800">
          <Check className="size-4" aria-hidden /> Approve
        </span>
        <span className="flex h-8 w-40 items-center gap-2 rounded-md border border-zinc-200 bg-white px-2 text-xs font-medium text-zinc-700">
          <MessageSquarePlus className="size-4" aria-hidden /> Request changes
        </span>
      </div>
    ),
  },
];

export const WALKTHROUGH_SLIDE_COUNT = SLIDES.length;

export function ReviewWalkthrough({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  const last = index === SLIDES.length - 1;

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  // Fade and scale in (after the first paint), focus the main button, and give focus back on close.
  useEffect(() => {
    const returnFocus = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => setShown(true));
    primaryRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
      returnFocus?.focus?.();
    };
  }, []);

  // Tab and Shift+Tab stay inside the dialog.
  function trapTab(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowRight" && !last && !(e.target instanceof HTMLTextAreaElement)) setIndex((i) => Math.min(i + 1, SLIDES.length - 1));
    if (e.key === "ArrowLeft" && index > 0) setIndex((i) => Math.max(i - 1, 0));
    if (e.key !== "Tab") return;
    const items = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]") ?? [],
    ).filter((el) => !el.closest("[inert]"));
    if (!items.length) return;
    const first = items[0];
    const end = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      end.focus();
    } else if (!e.shiftKey && document.activeElement === end) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className={`fixed inset-0 z-50 flex items-end justify-center bg-zinc-900/40 p-3 transition-opacity duration-200 motion-reduce:transition-none sm:items-center ${
        shown ? "opacity-100" : "opacity-0"
      }`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${titleId}-body`}
        onKeyDown={trapTab}
        className={`relative w-full max-w-sm overflow-hidden rounded-xl bg-white shadow-2xl transition-transform duration-200 motion-reduce:transition-none ${
          shown ? "translate-y-0 scale-100" : "translate-y-2 scale-95"
        }`}
      >
        <div className="flex items-center justify-between px-4 pt-3">
          <p className="text-2xs font-medium uppercase tracking-wide text-zinc-400">
            How it works · {index + 1} of {SLIDES.length}
          </p>
          <button type="button" onClick={onClose} aria-label="Close how it works" data-tooltip="Close" className="btn-icon size-8">
            <X className="size-4" />
          </button>
        </div>

        <div className="overflow-hidden">
          <div
            className="flex transition-transform duration-300 ease-out motion-reduce:transition-none"
            style={{ transform: `translateX(-${index * 100}%)` }}
          >
            {SLIDES.map((slide, i) => (
              <section
                key={slide.title}
                aria-hidden={i !== index}
                inert={i !== index}
                className="w-full shrink-0 px-5 pb-2 pt-1"
              >
                <div className="flex h-32 items-center justify-center rounded-lg bg-zinc-50">{slide.art}</div>
                <h2 id={i === index ? titleId : undefined} className="mt-4 text-base font-semibold text-zinc-900">
                  {slide.title}
                </h2>
                <p id={i === index ? `${titleId}-body` : undefined} className="mt-1 text-sm leading-relaxed text-zinc-600">
                  {slide.body}
                </p>
              </section>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 px-4 pb-4 pt-3">
          <div role="group" aria-label="Slides" className="flex flex-1 items-center gap-1.5">
            {SLIDES.map((slide, i) => (
              <button
                key={slide.title}
                type="button"
                onClick={() => setIndex(i)}
                aria-label={`Slide ${i + 1}: ${slide.title}`}
                aria-current={i === index ? "step" : undefined}
                className="flex size-6 items-center justify-center rounded-full"
              >
                <span
                  aria-hidden
                  className={`block rounded-full transition-all duration-200 motion-reduce:transition-none ${
                    i === index ? "h-2 w-4 bg-accent-600" : "size-2 bg-zinc-300"
                  }`}
                />
              </button>
            ))}
          </div>
          {index > 0 ? (
            <button type="button" onClick={() => setIndex((i) => Math.max(i - 1, 0))} className="btn-secondary h-9 px-3">
              <ArrowLeft className="size-4" aria-hidden />
              Back
            </button>
          ) : null}
          <button
            ref={primaryRef}
            type="button"
            onClick={() => (last ? onClose() : setIndex((i) => Math.min(i + 1, SLIDES.length - 1)))}
            className="btn-primary h-9 px-3"
          >
            {last ? (
              <>
                <Check className="size-4" aria-hidden />
                Finish
              </>
            ) : (
              <>
                Next
                <ArrowRight className="size-4" aria-hidden />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
