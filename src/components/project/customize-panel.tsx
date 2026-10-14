"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useOptimistic, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Blocks,
  ChevronRight,
  Diamond,
  FileInput,
  FileText,
  GitBranch,
  LayoutTemplate,
  ListChecks,
  Mail,
  Plus,
  SlidersHorizontal,
  ThumbsUp,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import { FieldEditorDialog, FieldList } from "@/components/project/field-editor";
import { StatusTemplatesView } from "@/components/project/status-templates";
import { useCan } from "@/components/project/project-access";
import { useProjectPage } from "@/components/project/project-page-context";
import { useServerAction } from "@/components/toast";
import { createForm, setRuleEnabled } from "@/lib/actions";
import type { FieldDef } from "@/lib/fields";
import type { CustomizeDetails } from "@/lib/project-page";
import type { StatusTemplate } from "@/lib/status-templates";
import { loadCustomizeDetails } from "@/lib/project-page-actions";

export type CustomizeRule = {
  id: string;
  name: string;
  enabled: boolean;
  trigger: string;
  // Action types across all branches (send_email, send_slack, …).
  actionTypes: string[];
  branches: number;
};

export type CustomizeSummary = {
  fields: FieldDef[];
  sectionNames: string[];
  forms: { id: string; title: string; open: boolean; sendsConfirmation: boolean }[];
  rules: CustomizeRule[];
  taskTemplates: { id: string; name: string; title: string }[];
  // Real features 4: the project's status templates (false = the database update isn't applied yet).
  statusTemplates: StatusTemplate[];
  statusTemplatesAvailable: boolean;
};

type View = "home" | "rules" | "fields" | "forms" | "emails" | "apps" | "types" | "status";

const VIEW_TITLES: Record<Exclude<View, "home">, string> = {
  rules: "Automations",
  fields: "Fields",
  forms: "Forms",
  emails: "Emails",
  apps: "Apps",
  types: "Task types and templates",
  status: "Status templates",
};

// Asana's Customize panel (Asana parity, batch 4): a ~320px panel on the right with a card row per
// thing that shapes the project — Automations, Fields, Forms, Emails, Apps, Task types and templates,
// and (Real features 4) Status templates —
// each opening its own view in the panel (back arrow to return). It sits next to the page, so new
// fields show up in the List while it's open. The pages it links to keep their own role checks.
export function CustomizePanel({ projectId, summary }: { projectId: string; summary: CustomizeSummary }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("home");
  const pathname = usePathname();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  const base = `/projects/${projectId}`;
  const customizing = ["fields", "forms", "rules"].some(
    (part) => pathname === `${base}/${part}` || pathname.startsWith(`${base}/${part}/`),
  );

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // Focus the panel's first control whenever it opens or changes view.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    (panel?.querySelector<HTMLElement>("[data-panel-focus]") ?? panel?.querySelector<HTMLElement>("a, button"))?.focus();
  }, [open, view]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // A dialog opened from the panel (Edit field) handles its own Escape.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      if (viewRef.current !== "home") {
        setView("home");
      } else {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const close = () => {
    setOpen(false);
    setView("home");
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-controls={open ? "customize-panel" : undefined}
        className={`btn-secondary h-7 gap-1.5 px-2.5 ${customizing || open ? "border-accent-300 text-accent-700" : ""}`}
      >
        <SlidersHorizontal className="size-3.5" aria-hidden />
        Customize
      </button>
      {open ? (
        <div
          id="customize-panel"
          ref={panelRef}
          role="dialog"
          aria-label={view === "home" ? "Customize this project" : VIEW_TITLES[view]}
          className="fixed bottom-0 right-0 top-topbar z-40 flex w-full max-w-80 flex-col border-l border-zinc-200 bg-white text-sm shadow-xl print:hidden"
        >
          <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-zinc-200 px-3">
            {view === "home" ? null : (
              <button
                type="button"
                onClick={() => setView("home")}
                aria-label="Back to Customize"
                data-tooltip="Back"
                className="btn-icon"
              >
                <ArrowLeft className="size-4" />
              </button>
            )}
            <h2 className="min-w-0 flex-1 truncate pl-1 text-sm font-semibold text-zinc-900">
              {view === "home" ? "Customize" : VIEW_TITLES[view]}
            </h2>
            <button type="button" onClick={close} aria-label="Close Customize" data-tooltip="Close" className="btn-icon">
              <X className="size-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {view === "home" ? (
              <Home summary={summary} onOpen={setView} />
            ) : view === "rules" ? (
              <RulesView base={base} back={pathname} rules={summary.rules} />
            ) : view === "fields" ? (
              <FieldsView projectId={projectId} base={base} summary={summary} />
            ) : view === "forms" ? (
              <FormsView projectId={projectId} base={base} forms={summary.forms} />
            ) : view === "emails" ? (
              <EmailsView projectId={projectId} base={base} back={pathname} summary={summary} />
            ) : view === "apps" ? (
              <AppsView projectId={projectId} base={base} />
            ) : view === "status" ? (
              <StatusTemplatesView
                projectId={projectId}
                templates={summary.statusTemplates}
                available={summary.statusTemplatesAvailable}
              />
            ) : (
              <TypesView base={base} templates={summary.taskTemplates} />
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

function Home({ summary, onOpen }: { summary: CustomizeSummary; onOpen: (view: View) => void }) {
  const activeRules = summary.rules.filter((r) => r.enabled).length;
  const openForms = summary.forms.filter((f) => f.open).length;
  const emailRules = summary.rules.filter((r) => r.actionTypes.includes("send_email")).length;
  const appRules = summary.rules.filter((r) => r.actionTypes.some((t) => t === "send_slack" || t === "call_webhook")).length;
  return (
    <ul className="flex flex-col gap-2">
      <CardRow
        icon={Workflow}
        label="Automations"
        count={summary.rules.length}
        meta={summary.rules.length ? `${activeRules} on · rules that move, assign, and notify` : "Rules that move, assign, and notify"}
        onClick={() => onOpen("rules")}
        focus
      />
      <CardRow
        icon={SlidersHorizontal}
        label="Fields"
        count={summary.fields.length}
        meta={summary.fields.length ? summary.fields.slice(0, 3).map((f) => f.name).join(", ") : "Priority, status, and other details"}
        onClick={() => onOpen("fields")}
      />
      <CardRow
        icon={FileInput}
        label="Forms"
        count={summary.forms.length}
        meta={summary.forms.length ? `${openForms} accepting responses` : "Turn requests into tasks"}
        onClick={() => onOpen("forms")}
      />
      <CardRow
        icon={Mail}
        label="Emails"
        count={emailRules + summary.forms.filter((f) => f.sendsConfirmation).length}
        meta="Rule emails, form confirmations, comment emails"
        onClick={() => onOpen("emails")}
      />
      <CardRow
        icon={Blocks}
        label="Apps"
        count={appRules || undefined}
        meta="Slack, webhooks, inbound webhooks"
        onClick={() => onOpen("apps")}
      />
      <CardRow
        icon={ListChecks}
        label="Task types and templates"
        count={summary.taskTemplates.length}
        meta="Milestones, approvals, and task templates"
        onClick={() => onOpen("types")}
      />
      <CardRow
        icon={FileText}
        label="Status templates"
        count={summary.statusTemplatesAvailable ? summary.statusTemplates.length : undefined}
        meta={
          summary.statusTemplates.length
            ? summary.statusTemplates.slice(0, 3).map((t) => t.name).join(", ")
            : "Saved layouts for status updates"
        }
        onClick={() => onOpen("status")}
      />
    </ul>
  );
}

function CardRow({
  icon: Icon,
  label,
  count,
  meta,
  onClick,
  focus = false,
}: {
  icon: LucideIcon;
  label: string;
  count?: number;
  meta: string;
  onClick: () => void;
  // The card focused when the panel opens.
  focus?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        data-panel-focus={focus ? true : undefined}
        onClick={onClick}
        className="flex w-full items-center gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-left hover:border-zinc-300 hover:bg-zinc-50"
      >
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-600">
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-zinc-900">
            {label}
            {count !== undefined ? <span className="ml-1.5 text-xs font-normal tabular-nums text-zinc-400">{count}</span> : null}
          </span>
          <span className="block truncate text-xs text-zinc-500">{meta}</span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-zinc-400" aria-hidden />
      </button>
    </li>
  );
}

function Intro({ children }: { children: ReactNode }) {
  return <p className="mb-3 text-xs text-zinc-500">{children}</p>;
}

function PanelLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="mt-3 flex items-center justify-between rounded-md px-1 py-1 text-xs font-medium text-accent-700 hover:bg-accent-50"
    >
      {children}
      <ChevronRight className="size-3.5" aria-hidden />
    </Link>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return <h3 className="mb-1.5 mt-4 text-xs font-semibold text-zinc-700 first:mt-0">{children}</h3>;
}

// Rule links come back here (?back=) after Save or Cancel on the canvas.
function ruleHref(base: string, back: string, ruleId: string | "new") {
  return `${base}/rules/${ruleId}?back=${encodeURIComponent(back)}`;
}

function RulesView({ base, back, rules }: { base: string; back: string; rules: CustomizeRule[] }) {
  const canEdit = useCan("admin");
  const [pending, run] = useServerAction();
  const [shown, setEnabled] = useOptimistic(rules, (current, patch: { id: string; enabled: boolean }) =>
    current.map((r) => (r.id === patch.id ? { ...r, enabled: patch.enabled } : r)),
  );
  return (
    <div>
      <Intro>When something happens in this project, a rule checks its conditions and runs the actions of the first branch that matches.</Intro>
      {canEdit ? (
        <Link href={ruleHref(base, back, "new")} data-panel-focus className="btn-primary mb-3 h-8 w-full">
          <Plus className="size-4" aria-hidden />
          Add rule
        </Link>
      ) : null}
      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-200 px-3 py-4 text-center text-xs text-zinc-500">
          No rules yet. Start from a template or build one: move tasks, assign people, comment, email, or post to Slack.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
          {shown.map((rule) => (
            <li key={rule.id} className="flex items-center gap-2.5 px-3 py-2">
              <label className="flex shrink-0 items-center" data-tooltip={rule.enabled ? "Turn off" : "Turn on"}>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={`${rule.name} on`}
                  checked={rule.enabled}
                  disabled={!canEdit || pending}
                  onChange={(e) => {
                    const enabled = e.currentTarget.checked;
                    run(() => setRuleEnabled(rule.id, enabled), () => setEnabled({ id: rule.id, enabled }));
                  }}
                  className="peer sr-only"
                />
                <span
                  aria-hidden
                  className="relative inline-block h-4 w-7 rounded-full bg-zinc-300 transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-3 after:rounded-full after:bg-white after:transition-transform peer-checked:bg-accent-500 peer-checked:after:translate-x-3 peer-disabled:opacity-60 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-500"
                />
              </label>
              <Link href={ruleHref(base, back, rule.id)} className="min-w-0 flex-1 rounded hover:bg-zinc-50">
                <span className="block truncate text-sm text-zinc-900">{rule.name}</span>
                <span className="flex items-center gap-1 truncate text-xs text-zinc-500">
                  {rule.branches > 1 ? <GitBranch className="size-3 shrink-0" aria-label="Branches" /> : null}
                  {rule.trigger}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <PanelLink href={`${base}/rules`}>Rule templates and recent runs</PanelLink>
    </div>
  );
}

function FieldsView({ projectId, base, summary }: { projectId: string; base: string; summary: CustomizeSummary }) {
  const canEdit = useCan("editor");
  const { batch4 } = useProjectPage();
  const [adding, setAdding] = useState(false);
  return (
    <div>
      <Intro>Fields add the same detail to every task here. Fields shown in List and Board appear as columns and card pills.</Intro>
      {canEdit ? (
        <button type="button" data-panel-focus onClick={() => setAdding(true)} className="btn-primary mb-3 h-8 w-full">
          <Plus className="size-4" aria-hidden />
          Add field
        </button>
      ) : null}
      {summary.fields.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-200 px-3 py-4 text-center text-xs text-zinc-500">
          No fields yet. Add one like Priority, Channel, or Reviewer, or copy one from the workspace field library.
        </p>
      ) : (
        <FieldList
          projectId={projectId}
          fields={summary.fields}
          sectionNames={summary.sectionNames}
          canEdit={canEdit}
          batch4={batch4}
          dense
        />
      )}
      <PanelLink href={`${base}/fields`}>Open the Fields page</PanelLink>
      {adding ? (
        <FieldEditorDialog
          projectId={projectId}
          field={null}
          sectionNames={summary.sectionNames}
          batch4={batch4}
          existingFieldIds={summary.fields.map((f) => f.id)}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </div>
  );
}

function FormsView({ projectId, base, forms }: { projectId: string; base: string; forms: CustomizeSummary["forms"] }) {
  const canEdit = useCan("admin");
  const [pending, run] = useServerAction();
  return (
    <div>
      <Intro>Forms turn requests from anyone with the link into tasks in this project.</Intro>
      {canEdit ? (
        <button
          type="button"
          data-panel-focus
          disabled={pending}
          onClick={() => run(() => createForm(projectId, "New request form"))}
          className="btn-primary mb-3 h-8 w-full"
        >
          <Plus className="size-4" aria-hidden />
          {pending ? "Creating…" : "Add form"}
        </button>
      ) : null}
      {forms.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-200 px-3 py-4 text-center text-xs text-zinc-500">
          No forms yet. A form asks the questions you choose and files each answer set as a task.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
          {forms.map((form) => (
            <li key={form.id}>
              <Link href={`${base}/forms/${form.id}`} className="flex items-center gap-2.5 px-3 py-2 hover:bg-zinc-50">
                <FileInput className="size-4 shrink-0 text-zinc-500" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm text-zinc-900">{form.title}</span>
                <span
                  className={`shrink-0 rounded-full px-2 py-px text-2xs font-medium ${
                    form.open ? "bg-green-50 text-green-800" : "bg-zinc-100 text-zinc-600"
                  }`}
                >
                  {form.open ? "Accepting" : "Closed"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <PanelLink href={`${base}/forms`}>All forms</PanelLink>
    </div>
  );
}

// Loads the Admin+ details (hints and counts) once a view that needs them opens.
function useDetails(projectId: string) {
  const [details, setDetails] = useState<CustomizeDetails | null | "loading">("loading");
  useEffect(() => {
    let live = true;
    loadCustomizeDetails(projectId)
      .then((loaded) => live && setDetails(loaded))
      .catch(() => live && setDetails(null));
    return () => {
      live = false;
    };
  }, [projectId]);
  return details;
}

function EmailsView({
  projectId,
  base,
  back,
  summary,
}: {
  projectId: string;
  base: string;
  back: string;
  summary: CustomizeSummary;
}) {
  const details = useDetails(projectId);
  const emailRules = summary.rules.filter((r) => r.actionTypes.includes("send_email"));
  const confirming = summary.forms.filter((f) => f.sendsConfirmation);
  return (
    <div>
      <Intro>Everything this project emails: rule emails, form confirmations, and comment emails to collaborators.</Intro>
      <SubHeading>Rule emails</SubHeading>
      {emailRules.length ? (
        <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
          {emailRules.map((rule) => (
            <li key={rule.id}>
              <Link href={ruleHref(base, back, rule.id)} className="flex items-center gap-2 px-3 py-2 hover:bg-zinc-50" data-panel-focus>
                <Workflow className="size-4 shrink-0 text-zinc-500" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm text-zinc-900">{rule.name}</span>
                <span className="shrink-0 text-2xs text-zinc-500">{rule.enabled ? "On" : "Off"}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-zinc-500">No rule sends email yet. Add a “Send email” action to a rule (Automations).</p>
      )}
      <SubHeading>Form confirmations</SubHeading>
      {confirming.length ? (
        <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
          {confirming.map((form) => (
            <li key={form.id}>
              <Link href={`${base}/forms/${form.id}`} className="flex items-center gap-2 px-3 py-2 hover:bg-zinc-50">
                <FileInput className="size-4 shrink-0 text-zinc-500" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm text-zinc-900">{form.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-zinc-500">No form emails a confirmation. Turn it on in a form’s Settings.</p>
      )}
      <SubHeading>Comment emails</SubHeading>
      <p className="text-xs text-zinc-500">
        Collaborators get an email for each new comment unless they turned it off in Settings → Notifications. Replying to
        the email posts a comment.
      </p>
      <SubHeading>Deliveries</SubHeading>
      {details === "loading" ? (
        <p role="status" className="text-xs text-zinc-500">
          Loading…
        </p>
      ) : details && details.admin && details.deliveries ? (
        <>
          <p className="text-xs text-zinc-600">
            {details.deliveries.emailsSent} sent recently · {details.deliveries.waiting} waiting ·{" "}
            <span className={details.deliveries.failed ? "font-medium text-red-700" : undefined}>
              {details.deliveries.failed} failed
            </span>
          </p>
          <PanelLink href={`${base}/settings/deliveries`}>Open deliveries</PanelLink>
        </>
      ) : (
        <p className="text-xs text-zinc-500">Project admins see delivery status and retry failed emails.</p>
      )}
    </div>
  );
}

function AppsView({ projectId, base }: { projectId: string; base: string }) {
  const details = useDetails(projectId);
  if (details === "loading") {
    return (
      <p role="status" className="text-xs text-zinc-500">
        Loading…
      </p>
    );
  }
  if (!details || !details.admin) {
    return (
      <div>
        <Intro>Slack, webhooks, and inbound webhooks connect this project to other tools.</Intro>
        <p className="text-xs text-zinc-500">Only project admins and owners can see and change apps.</p>
      </div>
    );
  }
  const integrations = details.integrations;
  const inbound = details.inbound ?? [];
  return (
    <div>
      <Intro>Connect this project to other tools. Rules post to Slack or call webhooks; inbound webhooks add tasks.</Intro>
      <ul className="flex flex-col gap-2">
        <AppRow
          href={`${base}/settings/integrations`}
          title="Slack"
          state={integrations?.slackWebhook ? `Webhook ${integrations.slackWebhook}` : "No project Slack webhook"}
          on={Boolean(integrations?.slackWebhook)}
        />
        <AppRow
          href={`${base}/settings/integrations`}
          title="Outbound webhook"
          state={
            integrations?.webhook
              ? `${integrations.webhook}${integrations.signingSecretSet ? " · signed" : ""}`
              : "No project webhook"
          }
          on={Boolean(integrations?.webhook)}
        />
        <AppRow
          href={`${base}/settings/inbound`}
          title="Inbound webhooks"
          state={
            inbound.length
              ? `${inbound.filter((e) => e.enabled).length} of ${inbound.length} on: ${inbound.map((e) => e.name).join(", ")}`
              : "None yet"
          }
          on={inbound.some((e) => e.enabled)}
        />
        <AppRow
          href={`${base}/settings/deliveries`}
          title="Deliveries"
          state={
            details.deliveries
              ? `${details.deliveries.waiting} waiting · ${details.deliveries.failed} failed`
              : "Emails, Slack messages, and webhook calls"
          }
          on={false}
        />
      </ul>
    </div>
  );
}

function AppRow({ href, title, state, on }: { href: string; title: string; state: string; on: boolean }) {
  return (
    <li>
      <Link href={href} className="flex items-center gap-2.5 rounded-lg border border-zinc-200 px-3 py-2.5 hover:border-zinc-300 hover:bg-zinc-50">
        <span aria-hidden className={`size-2 shrink-0 rounded-full ${on ? "bg-green-500" : "bg-zinc-300"}`} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-zinc-900">{title}</span>
          <span className="block truncate text-xs text-zinc-500">{state}</span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-zinc-400" aria-hidden />
      </Link>
    </li>
  );
}

function TypesView({ base, templates }: { base: string; templates: CustomizeSummary["taskTemplates"] }) {
  const canSaveProject = useCan("admin");
  const types: { icon: LucideIcon; name: string; body: string }[] = [
    { icon: ListChecks, name: "Task", body: "Ordinary work with an assignee and dates." },
    { icon: Diamond, name: "Milestone", body: "A checkpoint on its due date (a diamond on Timeline). Add task → Add milestone." },
    { icon: ThumbsUp, name: "Approval", body: "The assignee approves, requests changes, or rejects." },
  ];
  return (
    <div>
      <Intro>Pick a task’s type from its “…” menu → Task type. Task templates prefill new tasks from Add task.</Intro>
      <SubHeading>Task types</SubHeading>
      <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
        {types.map(({ icon: Icon, name, body }) => (
          <li key={name} className="flex items-start gap-2.5 px-3 py-2">
            <Icon className="mt-0.5 size-4 shrink-0 text-zinc-500" aria-hidden />
            <span className="min-w-0">
              <span className="block text-sm text-zinc-900">{name}</span>
              <span className="block text-xs text-zinc-500">{body}</span>
            </span>
          </li>
        ))}
      </ul>
      <SubHeading>Task templates</SubHeading>
      {templates.length ? (
        <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
          {templates.map((t) => (
            <li key={t.id} className="flex items-center gap-2.5 px-3 py-2">
              <LayoutTemplate className="size-4 shrink-0 text-zinc-500" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-zinc-900">{t.name}</span>
                <span className="block truncate text-xs text-zinc-500">{t.title}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-zinc-500">No task templates yet. Open a task, then “…” → Save as task template.</p>
      )}
      <PanelLink href={`${base}/settings/templates`}>
        {canSaveProject ? "Manage templates (and save this project as one)" : "Manage task templates"}
      </PanelLink>
    </div>
  );
}
