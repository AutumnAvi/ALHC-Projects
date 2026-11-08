"use client";

// Nov 8 notes (batch 30): the Customize panel's shared pieces, so every page looks alike — one switch size,
// grouped rows with a name and one quiet count, the light group headings, "+ Add" in the header (a portal
// into the panel's header), a "…" that shows only on the row you point at, and one footer link.
import Link from "next/link";
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, ChevronRight, Ellipsis, Plus, type LucideIcon } from "lucide-react";
import { Popover } from "@/components/popover";

// ---------------------------------------------------------------------------------------------
// The one switch (28 × 16) every Customize page uses.

export function PanelSwitch({
  checked,
  onChange,
  label,
  disabled = false,
  tooltip,
  focus = false,
  describedBy,
  ring = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  tooltip?: string;
  // The control focused when the page opens.
  focus?: boolean;
  describedBy?: string;
  // Drawn with the focus ring while something it opened (a confirm) is showing.
  ring?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      data-tooltip={tooltip}
      data-panel-focus={focus ? true : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors focus-visible:shadow-[0_0_0_3px_var(--focus-ring)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-accent-500" : "bg-zinc-300"
      } ${ring ? "shadow-[0_0_0_3px_var(--focus-ring)]" : ""}`}
    >
      <span
        aria-hidden
        className={`absolute top-0.5 size-3 rounded-full bg-white shadow-sm transition-[left] ${checked ? "left-3.5" : "left-0.5"}`}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// Groups and rows

export function GroupLabel({ children, count, id }: { children: ReactNode; count?: number; id?: string }) {
  return (
    <h3 id={id} className="mb-1.5 mt-[18px] flex items-center gap-1.5 px-1 text-xs font-medium text-zinc-500 first:mt-1">
      {children}
      {count !== undefined ? <span className="font-normal tabular-nums text-zinc-400">{count}</span> : null}
    </h3>
  );
}

export function Group({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ul aria-label={label} className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 bg-white">
      {children}
    </ul>
  );
}

const ROW = "flex min-h-row w-full items-center gap-2.5 px-2.5 text-left text-sm";

export function RowIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="size-4 shrink-0 text-zinc-500" aria-hidden />;
}

export function Count({ children }: { children: ReactNode }) {
  return <span className="shrink-0 text-xs tabular-nums text-zinc-400">{children}</span>;
}

export function Chevron() {
  return <ChevronRight className="size-3.5 shrink-0 text-zinc-300" aria-hidden />;
}

/** A row that opens something: a name, one count on the right, a chevron. */
export function NavRow({
  icon,
  label,
  count,
  onClick,
  href,
  focus = false,
  muted = false,
}: {
  icon?: LucideIcon;
  label: ReactNode;
  count?: ReactNode;
  onClick?: () => void;
  href?: string;
  focus?: boolean;
  muted?: boolean;
}) {
  const body = (
    <>
      {icon ? <RowIcon icon={icon} /> : null}
      <span className={`min-w-0 flex-1 truncate ${muted ? "text-zinc-400" : "text-zinc-900"}`}>{label}</span>
      {count !== undefined && count !== null && count !== "" ? <Count>{count}</Count> : null}
      <Chevron />
    </>
  );
  return (
    <li>
      {href ? (
        <Link href={href} data-panel-focus={focus ? true : undefined} className={`${ROW} hover:bg-zinc-50`}>
          {body}
        </Link>
      ) : (
        <button type="button" data-panel-focus={focus ? true : undefined} onClick={onClick} className={`${ROW} hover:bg-zinc-50`}>
          {body}
        </button>
      )}
    </li>
  );
}

/** A row with something on its right (a switch, a status) and no navigation of its own. */
export function StaticRow({
  icon,
  label,
  children,
  tooltip,
  muted = false,
  className = "",
}: {
  icon?: LucideIcon;
  label: ReactNode;
  children?: ReactNode;
  tooltip?: string;
  muted?: boolean;
  className?: string;
}) {
  return (
    <li className={`${ROW} ${className}`} data-tooltip={tooltip}>
      {icon ? <RowIcon icon={icon} /> : null}
      <span className={`min-w-0 flex-1 truncate ${muted ? "text-zinc-400" : "text-zinc-900"}`}>{label}</span>
      {children}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// "…" on a row: only shown while you point at (or focus) the row, or while it's open.

export function RowMenu({
  label,
  children,
}: {
  label: string;
  children: (close: () => void) => ReactNode;
}) {
  return (
    <Popover
      label={label}
      align="end"
      panelClassName="w-44 p-1"
      buttonClassName="btn-icon size-[22px] shrink-0 text-zinc-400 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 aria-expanded:bg-zinc-200 aria-expanded:text-zinc-700 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100"
      tooltip="More"
      button={<Ellipsis className="size-4" aria-hidden />}
    >
      {children}
    </Popover>
  );
}

// ---------------------------------------------------------------------------------------------
// The footer link ("Open full page →", "Delivery log →")

export function FooterLink({ href, children, aside }: { href: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 px-1 pt-3">
      <Link href={href} className="inline-flex items-center gap-1 rounded text-xs font-medium text-accent-700 hover:underline">
        {children}
        <ArrowRight className="size-3.5" aria-hidden />
      </Link>
      {aside}
    </div>
  );
}

export function Intro({ children }: { children: ReactNode }) {
  return <p className="mb-2.5 mt-0.5 px-1 text-xs text-zinc-500">{children}</p>;
}

export function EmptyGroup({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-zinc-200 bg-white px-3 py-4 text-center text-xs text-zinc-500">{children}</p>
  );
}

// ---------------------------------------------------------------------------------------------
// "+ Add" in the panel's header: each page renders it where it has the state it needs, and it shows up
// in the header (top right) through a portal.

export const PanelHeaderSlot = createContext<HTMLElement | null>(null);

export function PanelAdd({ children }: { children: ReactNode }) {
  const slot = useContext(PanelHeaderSlot);
  return slot ? createPortal(children, slot) : null;
}

export const ADD_BUTTON = "btn-primary h-7 gap-1 pl-1.5 pr-2.5";

export function AddButton({ onClick, href, label, disabled = false }: { onClick?: () => void; href?: string; label: string; disabled?: boolean }) {
  const body = (
    <>
      <Plus className="size-3.5" aria-hidden />
      Add
    </>
  );
  return (
    <PanelAdd>
      {href ? (
        <Link href={href} aria-label={label} data-tooltip={label} className={ADD_BUTTON}>
          {body}
        </Link>
      ) : (
        <button type="button" aria-label={label} data-tooltip={label} disabled={disabled} onClick={onClick} className={ADD_BUTTON}>
          {body}
        </button>
      )}
    </PanelAdd>
  );
}
