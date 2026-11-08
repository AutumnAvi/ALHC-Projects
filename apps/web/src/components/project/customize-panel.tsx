"use client";

import { useClosesPopovers } from "@/components/overlay-registry";
import { usePathname } from "next/navigation";
import { useEffect, useOptimistic, useRef, useState } from "react";
import {
  ArrowLeft,
  Blocks,
  FileInput,
  FileText,
  Lock,
  Mail,
  PanelsTopLeft,
  SlidersHorizontal,
  Workflow,
  X,
} from "lucide-react";
import { StatusTemplatesView } from "@/components/project/status-templates";
import { useProjectPermissions } from "@/components/project/project-access";
import { useRightPanel } from "@/components/shell/right-panel";
import { useServerAction } from "@/components/toast";
import { setSectionsLocked } from "@/lib/actions/projects";
import { loadCustomizeDetails, loadNumberingCounts } from "@/lib/actions/project-page";
import { connectedAppCount, emailSourceCount, hiddenTabsLabel, type NumberingCounts } from "@alhc/core/customize";
import type { ProjectTabEntry } from "@alhc/core/views";
import type { FieldDef } from "@alhc/core/fields";
import type { CustomizeDetails } from "@alhc/core/project-page";
import type { StatusTemplate } from "@alhc/core/status-templates";
import type { TaskNumbering } from "@alhc/core/request-numbers";
import { SCROLL_AREA } from "@/components/shell/shell-frame";
import { AutomationsView } from "@/components/project/customize/automations";
import { NumberingPage, NumberingRow } from "@/components/project/customize/numbering";
import { AppsPage, EmailsPage, FieldsPage, FormsPage, TabsPage } from "@/components/project/customize/pages";
import { Group, GroupLabel, NavRow, PanelHeaderSlot, PanelSwitch, StaticRow } from "@/components/project/customize/ui";

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
  // Real features 4: the project's status templates (false = the database update isn't applied yet).
  statusTemplates: StatusTemplate[];
  statusTemplatesAvailable: boolean;
  numbering: TaskNumbering | null;
  sections: { id: string; name: string }[];
  // Oct 27 notes (batch 5): Owner settings, sent only to the project's Owners (null for everyone else).
  owner?: { sectionsLocked: boolean } | null;
  // Nov 2 notes (batch 15, 117): every tab and whether it's hidden (null without the database support).
  tabs?: ProjectTabEntry[] | null;
};

type View = "home" | "rules" | "fields" | "forms" | "emails" | "apps" | "status" | "numbers" | "tabs";

const VIEW_TITLES: Record<Exclude<View, "home">, string> = {
  rules: "Automations",
  fields: "Fields",
  forms: "Forms",
  emails: "Emails",
  apps: "Apps",
  status: "Status templates",
  numbers: "Task numbering",
  tabs: "Tabs",
};

// The Customize panel (Asana parity, batch 4; redesigned in Nov 8 notes, batch 30): a 320px panel on the
// right. Its first screen lists everything under three light headings — Build (Automations, Fields,
// Forms), Connect (Emails, Apps), and Project settings (Task numbering with its own switch, Lock sections
// for Owners, Tabs, Status templates) — each a name and one quiet count. Each opens a side page in the
// panel (back arrow to return) with the same header ("+ Add" top right), switch, and footer link. Each role
// sees only what it can use. It sits next to the page, so new fields show up in the List while it's open.
// Task templates live in the "+ Add task" menu (From a template).
export function CustomizePanel({
  projectId,
  summary,
  buttonClassName = "",
}: {
  projectId: string;
  summary: CustomizeSummary;
  // Extra classes for the toolbar button (the header hides it on narrow widths; Nov 2 notes, batch 14).
  buttonClassName?: string;
}) {
  // The app's one right-panel slot: opening Customize closes the task pane (and the status sheet), and
  // opening a task closes Customize.
  const { open, setOpen } = useRightPanel(`customize:${projectId}`);
  useClosesPopovers(open);
  const [view, setView] = useState<View>("home");
  // Closed for any reason (a task opened too): the next open starts on the first screen.
  if (!open && view !== "home") setView("home");
  const pathname = usePathname();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const base = `/projects/${projectId}`;
  const customizing = ["fields", "forms", "rules"].some(
    (part) => pathname === `${base}/${part}` || pathname.startsWith(`${base}/${part}/`),
  );
  const canManage = useProjectPermissions().canManage;
  const details = usePanelLoad(open && canManage, () => loadCustomizeDetails(projectId), [projectId, summary]);
  const counts = usePanelLoad(open, () => loadNumberingCounts(projectId), [projectId, summary.numbering]);

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
  }, [open, setOpen]);

  const close = () => setOpen(false);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-controls={open ? "customize-panel" : undefined}
        className={`btn-secondary h-7 gap-1.5 px-2.5 ${customizing || open ? "border-accent-300 text-accent-700" : ""} ${buttonClassName}`}
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
          className="fixed bottom-0 right-0 top-topbar z-40 flex w-full max-w-80 flex-col border-l border-zinc-200 bg-zinc-50 text-sm shadow-xl print:hidden"
        >
          <div className="flex h-12 shrink-0 items-center gap-1 border-b border-zinc-200 bg-white pl-1.5 pr-2.5">
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
            <h2 className={`min-w-0 flex-1 truncate text-sm font-semibold text-zinc-900 ${view === "home" ? "pl-1.5" : "pl-0.5"}`}>
              {view === "home" ? "Customize" : VIEW_TITLES[view]}
            </h2>
            {/* Each side page's "+ Add" lands here (PanelAdd). */}
            <span ref={setHeaderSlot} className="contents" />
            <button type="button" onClick={close} aria-label="Close Customize" data-tooltip="Close" className="btn-icon">
              <X className="size-4" />
            </button>
          </div>
          <PanelHeaderSlot.Provider value={headerSlot}>
            <div className={`min-h-0 flex-1 px-3 py-3 ${SCROLL_AREA}`}>
              {view === "home" ? (
                <CustomizeHome
                  projectId={projectId}
                  summary={summary}
                  counts={counts ?? null}
                  details={details ?? null}
                  onOpen={setView}
                />
              ) : view === "rules" ? (
                <AutomationsView base={base} back={pathname} projectId={projectId} rules={summary.rules} />
              ) : view === "fields" ? (
                <FieldsPage projectId={projectId} base={base} summary={summary} />
              ) : view === "forms" ? (
                <FormsPage projectId={projectId} base={base} forms={summary.forms} />
              ) : view === "emails" ? (
                <EmailsPage base={base} back={pathname} summary={summary} details={details === undefined ? "loading" : details} />
              ) : view === "apps" ? (
                <AppsPage base={base} details={details === undefined ? "loading" : details} />
              ) : view === "numbers" ? (
                <NumberingPage
                  projectId={projectId}
                  sequence={summary.numbering}
                  sections={summary.sections}
                  fields={summary.fields}
                  counts={counts ?? null}
                />
              ) : view === "tabs" && summary.tabs ? (
                <TabsPage projectId={projectId} tabs={summary.tabs} />
              ) : (
                <StatusTemplatesView
                  projectId={projectId}
                  templates={summary.statusTemplates}
                  available={summary.statusTemplatesAvailable}
                />
              )}
            </div>
          </PanelHeaderSlot.Provider>
        </div>
      ) : null}
    </>
  );
}

// Loads something the panel shows once it opens (undefined until it answers, null when it can't be
// read), again whenever the page's data changes (after a save).
function usePanelLoad<T>(enabled: boolean, load: () => Promise<T>, deps: unknown[]): T | null | undefined {
  const [value, setValue] = useState<T | null | undefined>(undefined);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    loadRef
      .current()
      .then((loaded) => live && setValue(loaded))
      .catch(() => live && setValue(null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
  return enabled ? value : undefined;
}

// The first screen (01): three groups, a name and one count per row, and only what the viewer's role can
// use (01d: an Editor sees no Lock sections or Apps).
export function CustomizeHome({
  projectId,
  summary,
  counts,
  details,
  onOpen,
}: {
  projectId: string;
  summary: CustomizeSummary;
  counts: NumberingCounts | null;
  details: CustomizeDetails | null;
  onOpen: (view: Exclude<View, "home">) => void;
}) {
  const { canManage } = useProjectPermissions();
  const apps =
    details?.admin
      ? connectedAppCount({
          slackWebhook: details.integrations?.slackWebhook ?? null,
          slackDestination: details.integrations?.slackDestination ?? null,
          webhook: details.integrations?.webhook ?? null,
          inbound: details.inbound ?? [],
        })
      : undefined;
  return (
    <div>
      <GroupLabel>Build</GroupLabel>
      <Group label="Build">
        <NavRow icon={Workflow} label="Automations" count={summary.rules.length} onClick={() => onOpen("rules")} focus />
        <NavRow icon={SlidersHorizontal} label="Fields" count={summary.fields.length} onClick={() => onOpen("fields")} />
        <NavRow icon={FileInput} label="Forms" count={summary.forms.length} onClick={() => onOpen("forms")} />
      </Group>
      <GroupLabel>Connect</GroupLabel>
      <Group label="Connect">
        <NavRow icon={Mail} label="Emails" count={emailSourceCount(summary.rules, summary.forms)} onClick={() => onOpen("emails")} />
        {/* Apps are Admin+ only, so below Admin the row isn't shown at all. */}
        {canManage ? <NavRow icon={Blocks} label="Apps" count={apps} onClick={() => onOpen("apps")} /> : null}
      </Group>
      <GroupLabel>Project settings</GroupLabel>
      <Group label="Project settings">
        <NumberingRow
          projectId={projectId}
          numbering={summary.numbering}
          fields={summary.fields}
          counts={counts}
          onOpen={() => onOpen("numbers")}
        />
        {summary.owner ? <LockSectionsRow projectId={projectId} locked={summary.owner.sectionsLocked} /> : null}
        {summary.tabs ? (
          <NavRow icon={PanelsTopLeft} label="Tabs" count={hiddenTabsLabel(summary.tabs)} onClick={() => onOpen("tabs")} />
        ) : null}
        <NavRow
          icon={FileText}
          label="Status templates"
          count={summary.statusTemplatesAvailable ? summary.statusTemplates.length : undefined}
          onClick={() => onOpen("status")}
        />
      </Group>
    </div>
  );
}

export const LOCK_SECTIONS_TIP = "Only owners see this. When on, only owners can add, rename, or reorder sections.";

// Oct 27 notes (batch 5): only the project's Owners lock the sections (the database checks their own
// role). A plain switch on the first screen; hovering explains it (01b).
function LockSectionsRow({ projectId, locked }: { projectId: string; locked: boolean }) {
  const [pending, run] = useServerAction();
  const [on, setOn] = useOptimistic(locked);
  return (
    <StaticRow icon={Lock} label="Lock sections" tooltip={LOCK_SECTIONS_TIP}>
      <PanelSwitch
        checked={on}
        label="Lock sections"
        disabled={pending}
        tooltip={LOCK_SECTIONS_TIP}
        onChange={(next) => run(() => setSectionsLocked(projectId, next), () => setOn(next))}
      />
    </StaticRow>
  );
}
