"use client";

import { useEffect, useRef, useState } from "react";
import { previewKind } from "@alhc/core/attachment-preview";
import { FileTypeIcon } from "./file-type-icon";

// Nov 5 note 166: a tiny picture of a task's file — on a feedback pill, in its detail, and on a file chip.
// An image shows itself; another file the thumbnail drawn when it was sent for approval (a PDF's first
// page, /attachments/<id>?thumb=1); without one — or when the picture doesn't load — its file-type icon.
export function assetThumbSrc(fileId: string, fileName: string, contentType: string | null): string {
  return previewKind(fileName, contentType) === "image" ? `/attachments/${fileId}?preview=1` : `/attachments/${fileId}?thumb=1`;
}

export function AssetThumb({
  fileId,
  fileName,
  contentType = null,
  className = "size-5",
  iconClassName = "size-3.5",
}: {
  fileId: string | null;
  fileName: string;
  contentType?: string | null;
  className?: string;
  iconClassName?: string;
}) {
  const [broken, setBroken] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  // A load that failed before hydration never reaches onError.
  useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0) setBroken(true);
  }, []);
  const box = `inline-flex shrink-0 items-center justify-center overflow-hidden rounded bg-white ring-1 ring-black/5 ${className}`;
  if (!fileId || broken) {
    return (
      <span className={box} data-asset-thumb="icon" aria-hidden>
        <FileTypeIcon fileName={fileName} contentType={contentType} className={iconClassName} />
      </span>
    );
  }
  return (
    <span className={box} data-asset-thumb="image" aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element -- auth-gated redirect to a short-lived signed URL */}
      <img
        ref={ref}
        src={assetThumbSrc(fileId, fileName, contentType)}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
        className="size-full object-cover"
      />
    </span>
  );
}
