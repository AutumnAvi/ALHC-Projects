import type { ReactNode } from "react";

// A Home widget (Asana parity, batch 5): a bordered white card with its own header and a body that
// scrolls inside the card's fixed height, so the cards in a row line up. The card is a size container:
// its contents follow its own width, which shrinks when the task pane opens next to Home. Server-safe.
export function Widget({
  labelledBy,
  header,
  footer,
  children,
  className = "h-108",
}: {
  // The id of the heading inside `header`.
  labelledBy: string;
  header: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  // The card's height (and grid placement); the body takes what the header and footer leave.
  className?: string;
}) {
  return (
    <section
      aria-labelledby={labelledBy}
      className={`@container flex min-w-0 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white ${className}`}
    >
      <div className="shrink-0 px-5 pt-4">{header}</div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      {footer ? (
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-100 px-5 py-2.5">{footer}</div>
      ) : null}
    </section>
  );
}

// The widget's title: the h2 the section is labelled by.
export function WidgetTitle({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="text-base font-semibold text-zinc-900">
      {children}
    </h2>
  );
}

// Footer links ("Browse projects", "Archived projects (2)").
export const WIDGET_FOOTER_LINK = "inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-900 hover:underline";
