"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronRight,
  FileInput,
  ListPlus,
  Mail,
  Settings,
  SlidersHorizontal,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";

export type CustomizeSummary = {
  fields: { id: string; name: string; type: string }[];
  forms: { id: string; title: string; open: boolean }[];
  rules: { id: string; name: string; enabled: boolean }[];
  taskTemplates: { id: string; name: string }[];
};

const MAX_LISTED = 6;

// Asana's "Customize" menu: a right-side panel with everything that shapes the project — fields, forms,
// rules, task templates, emails / integrations, and settings — instead of more header tabs. Each section
// lists what exists and links to the page that edits it (those pages keep their own role checks).
export function CustomizePanel({ projectId, summary }: { projectId: string; summary: CustomizeSummary }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const base = `/projects/${projectId}`;
  const customizing = ["fields", "forms", "rules", "settings"].some(
    (part) => pathname === `${base}/${part}` || pathname.startsWith(`${base}/${part}/`),
  );

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const close = () => setOpen(false);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`btn-secondary h-7 gap-1.5 px-2.5 ${customizing ? "border-accent-300 text-accent-700" : ""}`}
      >
        <SlidersHorizontal className="size-3.5" aria-hidden />
        Customize
      </button>
      {open ? (
        <div className="fixed inset-0 z-40 bg-zinc-900/10" onMouseDown={close}>
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Customize this project"
            onMouseDown={(e) => e.stopPropagation()}
            className="absolute inset-y-0 right-0 flex w-full max-w-sm flex-col border-l border-zinc-200 bg-white shadow-xl"
          >
            <div className="flex h-bar shrink-0 items-center gap-2 border-b border-zinc-200 px-4">
              <h2 className="flex-1 text-sm font-semibold text-zinc-900">Customize</h2>
              <button type="button" onClick={close} aria-label="Close" className="btn-icon">
                <X className="size-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3">
              <Group
                icon={SlidersHorizontal}
                title="Fields"
                count={summary.fields.length}
                href={`${base}/fields`}
                manage="Manage fields"
                onNavigate={close}
                empty="Add fields such as Priority or Status to track details on every task."
              >
                {summary.fields.slice(0, MAX_LISTED).map((f) => (
                  <Item key={f.id} label={f.name} meta={f.type} />
                ))}
                <More total={summary.fields.length} />
              </Group>
              <Group
                icon={FileInput}
                title="Forms"
                count={summary.forms.length}
                href={`${base}/forms`}
                manage="Manage forms"
                onNavigate={close}
                empty="Forms turn requests from anyone into tasks in this project."
              >
                {summary.forms.slice(0, MAX_LISTED).map((f) => (
                  <Item key={f.id} label={f.title} meta={f.open ? "Open" : "Closed"} href={`${base}/forms/${f.id}`} onNavigate={close} />
                ))}
                <More total={summary.forms.length} />
              </Group>
              <Group
                icon={Workflow}
                title="Rules"
                count={summary.rules.length}
                href={`${base}/rules`}
                manage="Manage rules"
                onNavigate={close}
                empty="Rules automate routine steps: move, assign, comment, email, Slack, and more."
              >
                {summary.rules.slice(0, MAX_LISTED).map((r) => (
                  <Item key={r.id} label={r.name} meta={r.enabled ? "On" : "Off"} />
                ))}
                <More total={summary.rules.length} />
              </Group>
              <Group
                icon={ListPlus}
                title="Task templates"
                count={summary.taskTemplates.length}
                href={`${base}/settings/templates`}
                manage="Manage templates"
                onNavigate={close}
                empty="Save a task as a template from its pane, then add it from Add task → Template."
              >
                {summary.taskTemplates.slice(0, MAX_LISTED).map((t) => (
                  <Item key={t.id} label={t.name} />
                ))}
                <More total={summary.taskTemplates.length} />
              </Group>
              <Group icon={Mail} title="Emails and integrations" onNavigate={close}>
                <Item label="Slack and webhooks" href={`${base}/settings/integrations`} onNavigate={close} />
                <Item label="Deliveries (emails, Slack, webhooks)" href={`${base}/settings/deliveries`} onNavigate={close} />
                <Item label="Inbound webhooks" href={`${base}/settings/inbound`} onNavigate={close} />
              </Group>
              <Group icon={Settings} title="Settings" onNavigate={close}>
                <Item label="General (status, Req #, approvals)" href={`${base}/settings`} onNavigate={close} />
                <Item label="Members" href={`${base}/settings/members`} onNavigate={close} />
                <Item label="Import from Asana" href={`${base}/settings/import`} onNavigate={close} />
                <Item label="Trash" href={`${base}/settings/trash`} onNavigate={close} />
              </Group>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Group({
  icon: Icon,
  title,
  count,
  href,
  manage,
  empty,
  onNavigate,
  children,
}: {
  icon: LucideIcon;
  title: string;
  count?: number;
  href?: string;
  manage?: string;
  empty?: string;
  onNavigate: () => void;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-zinc-100 py-3 last:border-b-0" aria-label={title}>
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-zinc-500" aria-hidden />
        <h3 className="flex-1 text-sm font-semibold text-zinc-900">
          {title}
          {count !== undefined ? <span className="ml-1.5 text-xs font-normal tabular-nums text-zinc-400">{count}</span> : null}
        </h3>
        {href && manage ? (
          <Link href={href} onClick={onNavigate} className="text-xs font-medium text-accent-700 hover:underline">
            {manage}
          </Link>
        ) : null}
      </div>
      {count === 0 && empty ? (
        <p className="mt-1.5 pl-6 text-xs text-zinc-500">{empty}</p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-px pl-4">{children}</ul>
      )}
    </section>
  );
}

function Item({ label, meta, href, onNavigate }: { label: string; meta?: string; href?: string; onNavigate?: () => void }) {
  const body = (
    <>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {meta ? <span className="shrink-0 text-2xs text-zinc-400">{meta}</span> : null}
      {href ? <ChevronRight className="size-3.5 shrink-0 text-zinc-400" aria-hidden /> : null}
    </>
  );
  return (
    <li>
      {href ? (
        <Link
          href={href}
          onClick={onNavigate}
          className="flex h-7 items-center gap-2 rounded-md px-2 text-sm text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900"
        >
          {body}
        </Link>
      ) : (
        <span className="flex h-7 items-center gap-2 px-2 text-sm text-zinc-700">{body}</span>
      )}
    </li>
  );
}

function More({ total }: { total: number }) {
  if (total <= MAX_LISTED) return null;
  return <li className="px-2 text-2xs text-zinc-400">and {total - MAX_LISTED} more</li>;
}
