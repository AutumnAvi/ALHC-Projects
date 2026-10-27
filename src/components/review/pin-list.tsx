"use client";

import { Trash2 } from "lucide-react";
import { MAX_PIN_TEXT, pinPlace, type ReviewFile } from "@/lib/review-checks";

// The numbered comments, in order: pick one to show it on its file (and jump a video to it). Each item has
// an id (pin-item-<key>) so picking a pin on the file can scroll its comment into view.
export function PinList({
  pins,
  assets,
  activePin,
  editable,
  onChoose,
  onChange,
  onRemove,
}: {
  pins: { key: string; number: number; assetId: string; page: number | null; time: number | null; body: string }[];
  assets: ReviewFile[];
  activePin: string | null;
  editable: boolean;
  onChoose: (key: string, assetId: string) => void;
  onChange?: (key: string, body: string) => void;
  onRemove?: (key: string) => void;
}) {
  if (!pins.length) {
    return editable ? <p className="mt-3 text-xs text-zinc-400">No pinned comments yet.</p> : null;
  }
  const nameOf = (assetId: string) => assets.find((a) => a.id === assetId)?.name ?? "A file";
  return (
    <ol className="mt-3 space-y-2" aria-label="Pinned comments">
      {pins.map((p) => (
        <li
          key={p.key}
          id={`pin-item-${p.key}`}
          className={`rounded-md border px-2.5 py-2 ${activePin === p.key ? "border-amber-300 bg-amber-50" : "border-zinc-200"}`}
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onChoose(p.key, p.assetId)}
              aria-label={`Show comment ${p.number} on ${nameOf(p.assetId)}`}
              className={`flex size-6 shrink-0 items-center justify-center rounded-full text-2xs font-semibold text-white ${
                activePin === p.key ? "bg-amber-500" : "bg-accent-600"
              }`}
            >
              {p.number}
            </button>
            <button type="button" onClick={() => onChoose(p.key, p.assetId)} className="min-w-0 flex-1 truncate text-left text-xs text-zinc-500 hover:underline">
              {nameOf(p.assetId)} {pinPlace(p) ? `· ${pinPlace(p)}` : ""}
            </button>
            {editable && onRemove ? (
              <button type="button" onClick={() => onRemove(p.key)} aria-label={`Remove comment ${p.number}`} data-tooltip="Remove" className="btn-icon size-6">
                <Trash2 className="size-3.5" />
              </button>
            ) : null}
          </div>
          {editable && onChange ? (
            <textarea
              id={`pin-text-${p.key}`}
              value={p.body}
              maxLength={MAX_PIN_TEXT}
              rows={2}
              onChange={(e) => onChange(p.key, e.currentTarget.value)}
              onFocus={() => onChoose(p.key, p.assetId)}
              placeholder="What should change here?"
              aria-label={`Comment ${p.number}`}
              className="field mt-1.5 h-auto w-full py-1 text-sm"
            />
          ) : (
            <p className="mt-1 whitespace-pre-line text-sm text-zinc-800">{p.body}</p>
          )}
        </li>
      ))}
    </ol>
  );
}
