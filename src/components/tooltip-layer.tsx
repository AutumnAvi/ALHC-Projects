"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Tip = { text: string; anchor: DOMRect };

// Asana-style dark tooltips for icon buttons (Asana parity, batch 3): any element with
// data-tooltip="Copy task link" shows that text below it (above when there's no room) after a short
// hover, or right away on keyboard focus. One layer for the whole app, drawn on <body>, so scrolling
// containers and tab rows never clip it. The element keeps its own aria-label for screen readers. A line
// break in the text starts a new line (a task's numbers, one per project; Oct 29 notes, 55b).
export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    let timer = 0;
    let current: HTMLElement | null = null;
    const show = (el: HTMLElement) => {
      const text = el.dataset.tooltip;
      if (text && el.isConnected) setTip({ text, anchor: el.getBoundingClientRect() });
    };
    const hide = () => {
      window.clearTimeout(timer);
      current = null;
      setTip(null);
    };
    const target = (node: EventTarget | null) =>
      node instanceof Element ? node.closest<HTMLElement>("[data-tooltip]") : null;

    function onOver(e: PointerEvent) {
      if (e.pointerType === "touch") return;
      const el = target(e.target);
      if (el === current) return;
      hide();
      if (!el) return;
      current = el;
      timer = window.setTimeout(() => show(el), 400);
    }
    function onFocus(e: FocusEvent) {
      const el = target(e.target);
      if (el && el.matches(":focus-visible")) {
        hide();
        current = el;
        show(el);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") hide();
    }
    document.addEventListener("pointerover", onOver);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", hide);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, []);

  return tip ? createPortal(<TooltipBubble key={`${tip.text}-${tip.anchor.x}-${tip.anchor.y}`} tip={tip} />, document.body) : null;
}

function TooltipBubble({ tip }: { tip: Tip }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  // Measure once, then place it centered under the element (above when it would leave the window).
  useLayoutEffect(() => {
    const bubble = ref.current?.getBoundingClientRect();
    if (!bubble) return;
    const margin = 6;
    const below = tip.anchor.bottom + margin;
    const top = below + bubble.height > window.innerHeight - 4 ? tip.anchor.top - bubble.height - margin : below;
    const center = tip.anchor.left + tip.anchor.width / 2;
    const left = Math.min(Math.max(center - bubble.width / 2, 4), window.innerWidth - bubble.width - 4);
    setPosition({ top, left });
  }, [tip]);

  return (
    <div
      ref={ref}
      role="tooltip"
      style={position ?? { top: 0, left: 0, visibility: "hidden" }}
      className="pointer-events-none fixed z-[70] max-w-64 whitespace-pre-line rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white shadow-md print:hidden"
    >
      {tip.text}
    </div>
  );
}
