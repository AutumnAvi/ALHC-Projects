"use client";

// Nov 8 notes (batch 30): Customize's side pages in the shared pattern — Fields (04), Forms, Emails (05),
// Apps (06), and Tabs (07). Each has the same header (with "+ Add" top right when there's something to
// add), rows with a name and one thing on the right, the one switch size, and one footer link.
import { useOptimistic, useState, type KeyboardEvent } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  FileInput,
  GripVertical,
  Hash,
  LayoutTemplate,
  Link2,
  MessageSquare,
  Plus,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { FieldEditorDialog } from "@/components/project/field-editor";
import { FieldLockIcon } from "@/components/project/field-lock";
import { FieldTypeIcon } from "@/components/project/field-type-icon";
import { useProjectPermissions } from "@/components/project/project-access";
import { useProjectPage } from "@/components/project/project-page-context";
import { MenuItem, Popover } from "@/components/popover";
import { useNotify, useServerAction } from "@/components/toast";
import { createForm, updateForm } from "@/lib/actions/forms";
import { setRuleEnabled } from "@/lib/actions/automations";
import { moveViewBy, setProjectTabHidden, setProjectViewHidden } from "@/lib/actions/views";
import {
  inboundWebhooksStatus,
  moveTabEntry,
  outboundWebhookStatus,
  slackStatus,
  type AppStatus,
} from "@alhc/core/customize";
import { sharedFieldTooltip, sharedFieldView, type FieldDef } from "@alhc/core/fields";
import type { CustomizeDetails } from "@alhc/core/project-page";
import type { ProjectTabEntry } from "@alhc/core/views";
import type { CustomizeSummary } from "../customize-panel";
import { ruleHref } from "./automations";
import {
  ADD_BUTTON,
  Chevron,
  EmptyGroup,
  FooterLink,
  Group,
  GroupLabel,
  Intro,
  NavRow,
  PanelAdd,
  PanelSwitch,
  RowIcon,
  RowMenu,
  StaticRow,
} from "./ui";

// ---------------------------------------------------------------------------------------------
// Fields (04): a type icon on each row; "+ Add" offers New field or From the field library.

export function FieldsPage({ projectId, base, summary }: { projectId: string; base: string; summary: CustomizeSummary }) {
  const canEdit = useProjectPermissions().canEdit;
  const { batch4, fieldSharing } = useProjectPage();
  const [adding, setAdding] = useState<"new" | "library" | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = summary.fields.find((f) => f.id === editingId) ?? null;
  return (
    <div>
      {canEdit ? (
        <PanelAdd>
          <Popover
            label="Add field"
            align="end"
            panelClassName="w-52 p-1"
            buttonClassName={ADD_BUTTON}
            tooltip="Add field"
            button={
              <>
                <Plus className="size-3.5" aria-hidden />
                Add
              </>
            }
          >
            {(close) => (
              <>
                <MenuItem
                  onClick={() => {
                    close();
                    setAdding("new");
                  }}
                >
                  <Plus className="size-3.5 text-zinc-500" aria-hidden /> New field
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    close();
                    setAdding("library");
                  }}
                >
                  <LayoutTemplate className="size-3.5 text-zinc-500" aria-hidden /> From the field library
                </MenuItem>
              </>
            )}
          </Popover>
        </PanelAdd>
      ) : null}
      {summary.fields.length === 0 ? (
        <EmptyGroup>No fields yet. Add one like Priority, Channel, or Reviewer, or pick a shared one from the field library.</EmptyGroup>
      ) : (
        <Group label="Fields">
          {summary.fields.map((field, i) => (
            <FieldRow
              key={field.id}
              field={field}
              shared={sharedFieldTooltip(sharedFieldView(field, fieldSharing[field.id]))}
              canEdit={canEdit}
              focus={i === 0}
              onOpen={() => setEditingId(field.id)}
            />
          ))}
        </Group>
      )}
      <FooterLink href={`${base}/fields`}>Open full page</FooterLink>
      {adding ? (
        <FieldEditorDialog
          projectId={projectId}
          field={null}
          sectionNames={summary.sectionNames}
          batch4={batch4}
          existingFields={summary.fields}
          initialTab={adding}
          onClose={() => setAdding(null)}
        />
      ) : null}
      {editing ? (
        <FieldEditorDialog
          projectId={projectId}
          field={editing}
          sectionNames={summary.sectionNames}
          batch4={batch4}
          sharing={fieldSharing[editing.id]}
          onClose={() => setEditingId(null)}
        />
      ) : null}
    </div>
  );
}

function FieldRow({
  field,
  shared,
  canEdit,
  focus,
  onOpen,
}: {
  field: FieldDef;
  shared: string | null;
  canEdit: boolean;
  focus: boolean;
  onOpen: () => void;
}) {
  const marks = (
    <>
      {field.locked ? <FieldLockIcon className="size-3.5 text-zinc-400" focusable={!canEdit} /> : null}
      {shared ? (
        <span className="shrink-0 text-2xs text-zinc-400" data-tooltip={shared}>
          Shared
        </span>
      ) : null}
    </>
  );
  const body = (
    <>
      <FieldTypeIcon field={field} />
      <span className="min-w-0 flex-1 truncate text-zinc-900">{field.name}</span>
      {marks}
    </>
  );
  return (
    <li>
      {canEdit ? (
        <button
          type="button"
          data-panel-focus={focus ? true : undefined}
          onClick={onOpen}
          aria-label={`Edit field ${field.name}${shared ? " (shared)" : ""}${field.locked ? " (locked)" : ""}`}
          className="flex min-h-row w-full items-center gap-2.5 px-2.5 text-left text-sm hover:bg-zinc-50"
        >
          {body}
          <Chevron />
        </button>
      ) : (
        <div className="flex min-h-row items-center gap-2.5 px-2.5 text-sm">{body}</div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// Forms: each form with Live / Off; Copy link under "…".

export function FormsPage({ projectId, base, forms }: { projectId: string; base: string; forms: CustomizeSummary["forms"] }) {
  const canManage = useProjectPermissions().canManage;
  const [pending, run] = useServerAction();
  const notify = useNotify();
  return (
    <div>
      {canManage ? (
        <PanelAdd>
          <button
            type="button"
            aria-label="Add form"
            data-tooltip="Add form"
            disabled={pending}
            onClick={() => run(() => createForm(projectId, "New request form"))}
            className={ADD_BUTTON}
          >
            <Plus className="size-3.5" aria-hidden />
            {pending ? "Adding…" : "Add"}
          </button>
        </PanelAdd>
      ) : null}
      {forms.length === 0 ? (
        <EmptyGroup>No forms yet. A form asks the questions you choose and files each answer as a task.</EmptyGroup>
      ) : (
        <Group label="Forms">
          {forms.map((form, i) => (
            <li key={form.id} className="group flex min-h-row items-center gap-2.5 px-2.5 text-sm hover:bg-zinc-50">
              <Link
                href={`${base}/forms/${form.id}`}
                data-panel-focus={i === 0 ? true : undefined}
                className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch"
              >
                <RowIcon icon={FileInput} />
                <span className="min-w-0 flex-1 truncate text-zinc-900">{form.title}</span>
              </Link>
              <RowMenu label={`More for ${form.title}`}>
                {(close) => (
                  <MenuItem
                    onClick={() => {
                      close();
                      const url = `${window.location.origin}/forms/${form.id}`;
                      void navigator.clipboard?.writeText(url).then(
                        () => notify("Form link copied"),
                        () => notify("Couldn’t copy the link"),
                      );
                    }}
                  >
                    <Link2 className="size-3.5 text-zinc-500" aria-hidden /> Copy link
                  </MenuItem>
                )}
              </RowMenu>
              <Status status={{ text: form.open ? "Live" : "Off", on: form.open }} />
              <Chevron />
            </li>
          ))}
        </Group>
      )}
      <FooterLink href={`${base}/forms`}>Open full page</FooterLink>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Emails (05): a switch for each automation that emails and each form's confirmation. Comment emails are
// each person's own choice, so they link to Settings.

export function EmailsPage({
  base,
  back,
  summary,
  details,
}: {
  base: string;
  back: string;
  summary: CustomizeSummary;
  details: CustomizeDetails | null | "loading";
}) {
  const canManage = useProjectPermissions().canManage;
  const [, run] = useServerAction();
  const [rules, patchRule] = useOptimistic(
    summary.rules.filter((r) => r.actionTypes.includes("send_email")),
    (current, change: { id: string; on: boolean }) => current.map((r) => (r.id === change.id ? { ...r, enabled: change.on } : r)),
  );
  const [forms, patchForm] = useOptimistic(summary.forms, (current, change: { id: string; on: boolean }) =>
    current.map((f) => (f.id === change.id ? { ...f, sendsConfirmation: change.on } : f)),
  );
  const failed = details && details !== "loading" && details.deliveries ? details.deliveries.failed : 0;
  return (
    <div>
      <GroupLabel>Automations that send email</GroupLabel>
      {rules.length === 0 ? (
        <EmptyGroup>No automation sends email yet. Add a Send email step to one.</EmptyGroup>
      ) : (
        <Group label="Automations that send email">
          {rules.map((rule, i) => (
            <li key={rule.id} className="flex min-h-row items-center gap-2.5 px-2.5 text-sm">
              <RowIcon icon={Workflow} />
              <Link href={ruleHref(base, back, rule.id)} className="min-w-0 flex-1 truncate text-zinc-900 hover:underline">
                {rule.name}
              </Link>
              {canManage ? (
                <PanelSwitch
                  checked={rule.enabled}
                  label={`${rule.name} on`}
                  focus={i === 0}
                  onChange={(on) => run(() => setRuleEnabled(rule.id, on), () => patchRule({ id: rule.id, on }))}
                />
              ) : (
                <OnOff on={rule.enabled} />
              )}
            </li>
          ))}
        </Group>
      )}
      <GroupLabel>Form confirmations</GroupLabel>
      {forms.length === 0 ? (
        <EmptyGroup>No forms yet.</EmptyGroup>
      ) : (
        <Group label="Form confirmations">
          {forms.map((form) => (
            <StaticRow key={form.id} icon={FileInput} label={form.title}>
              {canManage ? (
                <PanelSwitch
                  checked={form.sendsConfirmation}
                  label={`Email a confirmation for ${form.title}`}
                  onChange={(on) =>
                    run(() => updateForm(form.id, { sendConfirmation: on }), () => patchForm({ id: form.id, on }))
                  }
                />
              ) : (
                <OnOff on={form.sendsConfirmation} />
              )}
            </StaticRow>
          ))}
        </Group>
      )}
      <GroupLabel>Comment emails</GroupLabel>
      <Group label="Comment emails">
        <NavRow icon={MessageSquare} label="Each person chooses in Settings" href={`${back}?settings=notifications`} />
      </Group>
      {canManage ? (
        <FooterLink
          href={`${base}/settings/deliveries`}
          aside={failed > 0 ? <span className="text-xs text-red-700">{failed} failed</span> : null}
        >
          Delivery log
        </FooterLink>
      ) : null}
    </div>
  );
}

function OnOff({ on }: { on: boolean }) {
  return <span className={`shrink-0 text-xs ${on ? "text-green-700" : "text-zinc-400"}`}>{on ? "On" : "Off"}</span>;
}

// ---------------------------------------------------------------------------------------------
// Apps (06): one row per app with its connection status. The delivery log is the footer link.

export function AppsPage({ base, details }: { base: string; details: CustomizeDetails | null | "loading" }) {
  if (details === "loading") {
    return (
      <p role="status" className="px-1 text-xs text-zinc-500">
        Loading…
      </p>
    );
  }
  if (!details || !details.admin) {
    return <Intro>Only project Admins and Owners connect apps.</Intro>;
  }
  const state = {
    slackWebhook: details.integrations?.slackWebhook ?? null,
    slackDestination: details.integrations?.slackDestination ?? null,
    webhook: details.integrations?.webhook ?? null,
    inbound: details.inbound ?? [],
  };
  return (
    <div>
      <Group label="Apps">
        <AppRow href={`${base}/settings/integrations`} icon={Hash} label="Slack" status={slackStatus(state)} focus />
        <AppRow href={`${base}/settings/integrations`} icon={ArrowUpFromLine} label="Outbound webhook" status={outboundWebhookStatus(state)} />
        <AppRow href={`${base}/settings/inbound`} icon={ArrowDownToLine} label="Inbound webhooks" status={inboundWebhooksStatus(state)} />
      </Group>
      <FooterLink href={`${base}/settings/deliveries`}>Delivery log</FooterLink>
    </div>
  );
}

function Status({ status }: { status: AppStatus }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs ${status.on ? "text-green-700" : "text-zinc-500"}`}>
      {status.on ? <span aria-hidden className="size-1.5 rounded-full bg-green-500" /> : null}
      {status.text}
    </span>
  );
}

function AppRow({
  href,
  icon,
  label,
  status,
  focus = false,
}: {
  href: string;
  icon: typeof Hash;
  label: string;
  status: AppStatus;
  focus?: boolean;
}) {
  return (
    <li>
      <Link
        href={href}
        data-panel-focus={focus ? true : undefined}
        className="flex min-h-row w-full items-center gap-2.5 px-2.5 text-sm hover:bg-zinc-50"
      >
        <RowIcon icon={icon} />
        <span className="min-w-0 flex-1 truncate text-zinc-900">{label}</span>
        <Status status={status} />
        <Chevron />
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// Tabs (07): a switch on each tab (hidden for everyone; one view always stays shown), and the views
// dragged to reorder (or moved with the arrow keys on their handle).

type TabChange = { type: "hide"; key: string; hidden: boolean } | { type: "move"; key: string; steps: number };

export function TabsPage({ projectId, tabs }: { projectId: string; tabs: ProjectTabEntry[] }) {
  const [, run] = useServerAction();
  const [shown, apply] = useOptimistic(tabs, (current, change: TabChange) =>
    change.type === "hide"
      ? current.map((t) => (t.key === change.key ? { ...t, hidden: change.hidden } : t))
      : moveTabEntry(current, change.key, change.steps),
  );
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const shownViews = shown.filter((t) => t.kind === "view" && !t.hidden).length;
  const viewKeys = shown.filter((t) => t.kind === "view").map((t) => t.key);

  const move = (key: string, steps: number) => {
    if (steps === 0) return;
    run(() => moveViewBy(key, steps), () => apply({ type: "move", key, steps }));
  };
  const onGripKey = (e: KeyboardEvent, key: string) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const index = viewKeys.indexOf(key);
    const steps = e.key === "ArrowUp" ? -1 : 1;
    if (index + steps < 0 || index + steps >= viewKeys.length) return;
    move(key, steps);
  };

  return (
    <div>
      <Intro>Hidden tabs are hidden for everyone. Drag views to reorder them.</Intro>
      <ul aria-label="Tabs" className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 bg-white">
        {shown.map((tab, i) => {
          const view = tab.kind === "view";
          const lastView = view && !tab.hidden && shownViews <= 1;
          return (
            <li
              key={tab.key}
              draggable={view}
              onDragStart={(e) => {
                if (!view) return;
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", tab.key);
                setDragging(tab.key);
              }}
              onDragOver={(e) => {
                if (!view || !dragging || dragging === tab.key) return;
                e.preventDefault();
                setOver(tab.key);
              }}
              onDragLeave={() => setOver((current) => (current === tab.key ? null : current))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging && view && dragging !== tab.key) {
                  move(dragging, viewKeys.indexOf(tab.key) - viewKeys.indexOf(dragging));
                }
                setDragging(null);
                setOver(null);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              className={`flex min-h-row items-center gap-2 pl-1.5 pr-2.5 text-sm ${dragging === tab.key ? "opacity-50" : ""} ${
                over === tab.key ? "bg-accent-50" : ""
              }`}
            >
              {view ? (
                <button
                  type="button"
                  aria-label={`Move the ${tab.label} tab (arrow keys)`}
                  data-tooltip="Drag to reorder"
                  onKeyDown={(e) => onGripKey(e, tab.key)}
                  className="flex h-[22px] w-3.5 shrink-0 cursor-grab items-center justify-center rounded text-zinc-300 hover:text-zinc-500"
                >
                  <GripVertical className="size-3.5" aria-hidden />
                </button>
              ) : (
                <span aria-hidden className="w-3.5 shrink-0" />
              )}
              <span className={`min-w-0 flex-1 truncate ${tab.hidden ? "text-zinc-400" : "text-zinc-900"}`}>{tab.label}</span>
              {view ? <span className="shrink-0 text-2xs text-zinc-400">View</span> : null}
              <PanelSwitch
                checked={!tab.hidden}
                label={`Show the ${tab.label} tab`}
                focus={i === 0}
                disabled={lastView}
                tooltip={lastView ? "Keep at least one view tab shown" : tab.hidden ? "Hidden for everyone" : "Shown"}
                onChange={(on) =>
                  run(
                    () => (view ? setProjectViewHidden(projectId, tab.key, !on) : setProjectTabHidden(projectId, tab.key, !on)),
                    () => apply({ type: "hide", key: tab.key, hidden: !on }),
                  )
                }
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
