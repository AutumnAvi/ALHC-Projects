"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Download, FileQuestion, MessageSquarePlus } from "lucide-react";
import { reviewMediaKind, timeLabel } from "@/lib/review-checks";
import { timeScaleTicks } from "@/lib/review-portal";

// Oct 26 notes (batch 3): one file of a review, in full quality, with its pins. Shared by the public review
// page (where clicking adds a pin) and the task's Reviews tab (read-only).
//   * Images: click a point to pin it (x, y from 0 to 1 of the image).
//   * PDFs: every page drawn by pdf.js (loaded only when a PDF is shown); click a point on a page.
//   * Videos: the browser's player; "Comment at 0:12" pins the moment; markers under the player seek to
//     theirs (and so does picking a pin in the list).
//   * Anything else: a download.

export type ViewerPin = {
  key: string;
  number: number;
  page: number | null;
  x: number | null;
  y: number | null;
  time: number | null;
  body: string;
};
export type PinPlace = { page?: number | null; x?: number | null; y?: number | null; time?: number | null };
export type ViewerFile = { id: string; name: string; contentType: string | null; src: string; downloadHref: string };

const PIN =
  "absolute z-10 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white text-xs font-semibold text-white shadow-md focus-visible:outline-2 focus-visible:outline-accent-500";

function pinClass(active: boolean) {
  return `${PIN} ${active ? "bg-amber-500 ring-2 ring-amber-300" : "bg-accent-600 hover:bg-accent-700"}`;
}

// Where in an element a click landed, from 0 to 1 each way.
function placeOf(e: MouseEvent<HTMLElement>) {
  const rect = e.currentTarget.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
  return { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 };
}

export function ReviewViewer({
  file,
  pins,
  activePin,
  onPick,
  onSelectPin,
}: {
  file: ViewerFile;
  pins: ViewerPin[];
  activePin: string | null;
  // Set on the review page while feedback can still be given: a click (or "Comment at …") adds a pin.
  onPick?: (place: PinPlace) => void;
  onSelectPin?: (key: string) => void;
}) {
  const kind = reviewMediaKind(file.name, file.contentType);
  if (kind === "image") return <ImageView file={file} pins={pins} activePin={activePin} onPick={onPick} onSelectPin={onSelectPin} />;
  if (kind === "pdf") return <PdfView file={file} pins={pins} activePin={activePin} onPick={onPick} onSelectPin={onSelectPin} />;
  if (kind === "video") return <VideoView file={file} pins={pins} activePin={activePin} onPick={onPick} onSelectPin={onSelectPin} />;
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-zinc-300 bg-white px-6 py-12 text-center">
      <FileQuestion className="size-8 text-zinc-400" aria-hidden />
      <p className="text-sm text-zinc-700">{file.name} can’t be shown here.</p>
      <a href={file.downloadHref} className="btn-secondary h-8 px-3">
        <Download className="size-4" aria-hidden />
        Download
      </a>
    </div>
  );
}

type ViewProps = {
  file: ViewerFile;
  pins: ViewerPin[];
  activePin: string | null;
  onPick?: (place: PinPlace) => void;
  onSelectPin?: (key: string) => void;
};

function PinMarkers({ pins, activePin, onSelectPin }: Pick<ViewProps, "pins" | "activePin" | "onSelectPin">) {
  return (
    <>
      {pins
        .filter((p) => p.x !== null && p.y !== null)
        .map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelectPin?.(p.key);
            }}
            aria-label={`Comment ${p.number}: ${p.body || "(no text yet)"}`}
            data-tooltip={p.body || undefined}
            data-pin-key={p.key}
            className={pinClass(activePin === p.key)}
            style={{ left: `${(p.x ?? 0) * 100}%`, top: `${(p.y ?? 0) * 100}%` }}
          >
            {p.number}
          </button>
        ))}
    </>
  );
}

function ImageView({ file, pins, activePin, onPick, onSelectPin }: ViewProps) {
  return (
    <div className="flex justify-center">
      <div
        className={`relative inline-block max-w-full ${onPick ? "cursor-crosshair" : ""}`}
        onClick={onPick ? (e) => onPick(placeOf(e)) : undefined}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link to the private bucket; next/image can't optimise it */}
        <img src={file.src} alt={file.name} className="block h-auto max-h-[80vh] w-auto max-w-full select-none" draggable={false} />
        <PinMarkers pins={pins} activePin={activePin} onSelectPin={onSelectPin} />
      </div>
    </div>
  );
}

// pdf.js, loaded on first use (a big library; only PDFs need it).
type PdfDocument = { numPages: number; getPage: (n: number) => Promise<PdfPage> };
type PdfPage = {
  getViewport: (o: { scale: number }) => { width: number; height: number };
  render: (o: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<void> };
};

async function loadPdf(src: string): Promise<PdfDocument> {
  const pdfjs = await import("pdfjs-dist");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  }
  const response = await fetch(src);
  if (!response.ok) throw new Error(`PDF ${response.status}`);
  const data = new Uint8Array(await response.arrayBuffer());
  return (await pdfjs.getDocument({ data, isEvalSupported: false }).promise) as unknown as PdfDocument;
}

function PdfView({ file, pins, activePin, onPick, onSelectPin }: ViewProps) {
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    loadPdf(file.src)
      .then((loaded) => live && setDoc(loaded))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [file.src]);
  if (failed) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-zinc-300 bg-white px-6 py-12 text-center">
        <p className="text-sm text-zinc-700">This PDF couldn’t be shown here.</p>
        <a href={file.downloadHref} className="btn-secondary h-8 px-3">
          <Download className="size-4" aria-hidden />
          Download
        </a>
      </div>
    );
  }
  if (!doc) {
    return (
      <p role="status" className="py-12 text-center text-sm text-zinc-500">
        Loading the PDF…
      </p>
    );
  }
  return (
    <div className="flex flex-col items-center gap-4">
      {Array.from({ length: Math.min(doc.numPages, 200) }, (_, i) => i + 1).map((page) => (
        <PdfPageView
          key={page}
          doc={doc}
          page={page}
          pins={pins.filter((p) => (p.page ?? 1) === page)}
          activePin={activePin}
          onPick={onPick ? (place) => onPick({ ...place, page }) : undefined}
          onSelectPin={onSelectPin}
        />
      ))}
      {doc.numPages > 200 ? <p className="text-xs text-zinc-500">Only the first 200 pages are shown.</p> : null}
    </div>
  );
}

function PdfPageView({
  doc,
  page,
  pins,
  activePin,
  onPick,
  onSelectPin,
}: {
  doc: PdfDocument;
  page: number;
  pins: ViewerPin[];
  activePin: string | null;
  onPick?: (place: PinPlace) => void;
  onSelectPin?: (key: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ratio, setRatio] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const p = await doc.getPage(page);
      const base = p.getViewport({ scale: 1 });
      const scale = Math.min(2.5, Math.max(1, 1600 / base.width));
      const viewport = p.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas || !live) return;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      setRatio(viewport.height / viewport.width);
      const context = canvas.getContext("2d");
      if (context) await p.render({ canvasContext: context, viewport }).promise;
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [doc, page]);
  return (
    <div className="w-full max-w-3xl">
      <p className="mb-1 text-xs text-zinc-500">Page {page}</p>
      <div
        className={`relative w-full border border-zinc-200 bg-white shadow-sm ${onPick ? "cursor-crosshair" : ""}`}
        style={ratio ? { aspectRatio: `1 / ${ratio}` } : { minHeight: "12rem" }}
        onClick={onPick ? (e) => onPick(placeOf(e)) : undefined}
      >
        <canvas ref={canvasRef} aria-label={`Page ${page}`} className="block h-full w-full" />
        <PinMarkers pins={pins} activePin={activePin} onSelectPin={onSelectPin} />
      </div>
    </div>
  );
}

function VideoView({ file, pins, activePin, onPick, onSelectPin }: ViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(0);
  const [now, setNow] = useState(0);
  const timed = pins.filter((p) => p.time !== null);
  const ticks = timeScaleTicks(duration);
  // Picking a pin (here or in the list) jumps the player to it.
  useEffect(() => {
    const pin = timed.find((p) => p.key === activePin);
    const video = videoRef.current;
    if (pin && pin.time !== null && video) {
      video.currentTime = pin.time;
      video.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the chosen pin changes
  }, [activePin]);
  return (
    <div className="flex flex-col gap-2">
      <video
        ref={videoRef}
        src={file.src}
        controls
        preload="metadata"
        playsInline
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
        className="max-h-[70vh] w-full rounded-lg bg-black"
      >
        <a href={file.downloadHref}>Download {file.name}</a>
      </video>
      <div className="flex flex-wrap items-center gap-3">
        {/* Oct 27 notes (batch 5): a timeline under the player — light time-scale ticks, a tick and a
            numbered marker per comment at its moment (click to jump there), and the playhead. Clicking the
            track itself seeks too. */}
        <div className="min-w-40 flex-1">
          <div
            className="relative h-8 cursor-pointer rounded bg-zinc-100"
            role="group"
            aria-label={`Comments on the timeline${duration > 0 ? ` (${timed.length})` : ""}`}
            onClick={(e) => {
              const video = videoRef.current;
              if (!video || duration <= 0) return;
              const rect = e.currentTarget.getBoundingClientRect();
              video.currentTime = Math.min(duration, Math.max(0, ((e.clientX - rect.left) / rect.width) * duration));
            }}
          >
            {duration > 0
              ? ticks.map((t) => (
                  <span
                    key={`tick-${t}`}
                    aria-hidden
                    className="absolute bottom-0 h-1.5 w-px bg-zinc-300"
                    style={{ left: `${(t / duration) * 100}%` }}
                  />
                ))
              : null}
            {duration > 0
              ? timed.map((p) => (
                  <span
                    key={`line-${p.key}`}
                    aria-hidden
                    className={`absolute top-0 h-full w-0.5 -translate-x-1/2 ${activePin === p.key ? "bg-amber-400" : "bg-accent-300"}`}
                    style={{ left: `${Math.min(100, ((p.time ?? 0) / duration) * 100)}%` }}
                  />
                ))
              : null}
            {duration > 0
              ? timed.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectPin?.(p.key);
                    }}
                    aria-label={`Comment ${p.number} at ${timeLabel(p.time ?? 0)}: ${p.body || "(no text yet)"}`}
                    data-tooltip={`${timeLabel(p.time ?? 0)} · ${p.body}`}
                    className={`${pinClass(activePin === p.key)} top-1/2 size-5 text-2xs`}
                    style={{ left: `${Math.min(100, ((p.time ?? 0) / duration) * 100)}%` }}
                  >
                    {p.number}
                  </button>
                ))
              : null}
            {duration > 0 ? (
              <span aria-hidden className="absolute top-0 h-full w-px bg-zinc-500" style={{ left: `${Math.min(100, (now / duration) * 100)}%` }} />
            ) : null}
          </div>
          {duration > 0 ? (
            <div aria-hidden className="relative mt-0.5 h-4 text-2xs tabular-nums text-zinc-400">
              <span className="absolute left-0">0:00</span>
              {ticks.map((t) => (
                <span key={`label-${t}`} className="absolute -translate-x-1/2" style={{ left: `${(t / duration) * 100}%` }}>
                  {timeLabel(t)}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {onPick ? (
          <button
            type="button"
            onClick={() => {
              const video = videoRef.current;
              video?.pause();
              onPick({ time: Math.round((video?.currentTime ?? 0) * 10) / 10 });
            }}
            className="btn-secondary h-8 px-3"
          >
            <MessageSquarePlus className="size-4" aria-hidden />
            Comment at {timeLabel(now)}
          </button>
        ) : null}
      </div>
    </div>
  );
}
