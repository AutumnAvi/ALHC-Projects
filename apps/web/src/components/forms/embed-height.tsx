"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { EMBED_HEIGHT_MESSAGE, type EmbedHeightMessage } from "@/lib/form-embed";

// Batch 43 (item 6): the embed page tells the page framing it how tall the form is, so the Share snippet
// can size the frame. It measures this wrapper (the form itself, not the full-height page around it), so
// the frame shrinks as well as grows: a path opening, an error, the thank-you message. Only the height and
// the form's id are sent (to any parent: there's nothing private in them); the snippet checks who sent it.
export function EmbedHeightReporter({ formId, children }: { formId: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || window.parent === window) return;
    let last = 0;
    let frame = 0;
    const send = () => {
      frame = 0;
      const height = Math.ceil(element.getBoundingClientRect().height);
      if (!height || height === last) return;
      last = height;
      const message: EmbedHeightMessage = { type: EMBED_HEIGHT_MESSAGE, formId, height };
      window.parent.postMessage(message, "*");
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(send);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    schedule();
    window.addEventListener("load", schedule);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("load", schedule);
    };
  }, [formId]);
  return (
    <div ref={ref} data-embed-content="">
      {children}
    </div>
  );
}
