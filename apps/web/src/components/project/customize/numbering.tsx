"use client";

// Nov 8 notes (batch 30): task numbering in Customize. On the home screen it's one row: the name and the
// next label open the format page, and a switch behind a hairline turns numbering on or off (turning it on
// asks first, in a small box beside the switch, whether to number the tasks already here). The prefix is
// never edited inline: it lives on the format page, with a live preview, the everyday settings (Prefix,
// Next number, Digits, Brackets), the rarer rules as rows showing their current value, a Save bar that says
// what it will relabel, and "Renumber every task…" at the bottom. The full Settings page keeps the old form.
import { useEffect, useId, useOptimistic, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Hash, RotateCcw } from "lucide-react";
import { Dialog } from "@/components/dialog";
import { registerPopover } from "@/components/overlay-registry";
import { useProjectPermissions } from "@/components/project/project-access";
import { useTimeZones } from "@/components/project/task-numbering";
import { SmartPicker } from "@/components/smart-picker";
import { useServerAction } from "@/components/toast";
import { saveTaskNumbering } from "@/lib/actions/numbering";
import {
  NUMBER_DIGITS,
  digitsSample,
  nextTaskLabel,
  numberExistingLabel,
  numberFormatFrom,
  numberScopeValue,
  numberingChanged,
  numberingSaveNote,
  restartValue,
  reuseValue,
  separateCounters,
  simpleNumberFormat,
  subtaskValue,
  type NumberingCounts,
} from "@alhc/core/customize";
import type { FieldDef } from "@alhc/core/fields";
import {
  emptyNumbering,
  templateProblem,
  type NumberScope,
  type ResetPeriod,
  type SubtaskSeparator,
  type TaskNumbering,
} from "@alhc/core/request-numbers";
import { Chevron, GroupLabel, PanelSwitch } from "./ui";

type SaveMode = "save" | "number_missing" | "renumber";

// Only a number someone changed is sent (resending it on every save moved where new counters and
// Renumber all start).
function startNumberToSend(saved: TaskNumbering, next: TaskNumbering, mode: SaveMode, renumberStart: number): number | null {
  if (mode === "renumber") return renumberStart;
  if (separateCounters(next)) return next.startNumber !== saved.startNumber ? next.startNumber : null;
  return next.nextNumber !== saved.nextNumber ? next.nextNumber : null;
}

function fieldName(fields: FieldDef[], id: string | null) {
  return fields.find((f) => f.id === id)?.name ?? null;
}

// ---------------------------------------------------------------------------------------------
// The home row

export function NumberingRow({
  projectId,
  numbering,
  fields,
  counts,
  onOpen,
}: {
  projectId: string;
  numbering: TaskNumbering | null;
  fields: FieldDef[];
  counts: NumberingCounts | null;
  onOpen: () => void;
}) {
  const { canEdit } = useProjectPermissions();
  const [pending, run] = useServerAction();
  const saved = numbering ?? emptyNumbering();
  const [enabled, setEnabled] = useOptimistic(saved.enabled);
  // Where the "Turn on task numbering?" box sits (under the row, by the switch), null while it's closed.
  const [confirming, setConfirming] = useState<{ top: number; right: number } | null>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  const label = enabled ? nextTaskLabel(saved, { fieldSample: fieldName(fields, saved.counterFieldId) ?? undefined }) : null;
  const unavailable = numbering?.advanced === false;

  function save(next: TaskNumbering, mode: SaveMode) {
    run(
      () => saveTaskNumbering(projectId, { ...next, startNumber: null }, mode),
      () => setEnabled(next.enabled),
    );
  }

  return (
    <li ref={rowRef} className="flex min-h-row items-center gap-2.5 px-2.5 text-sm hover:bg-zinc-50">
      <button
        type="button"
        onClick={onOpen}
        aria-label={label ? `Task numbering: next number ${label}` : "Task numbering"}
        className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch text-left"
      >
        <Hash className="size-4 shrink-0 text-zinc-500" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-zinc-900">Task numbering</span>
        {label ? (
          <span className="shrink-0 truncate rounded bg-zinc-100 px-1.5 font-mono text-2xs leading-[18px] text-zinc-600">{label}</span>
        ) : null}
        <Chevron />
      </button>
      <span aria-hidden className="h-[18px] w-px shrink-0 bg-zinc-200" />
      <PanelSwitch
        checked={enabled}
        label="Number new tasks"
        disabled={!canEdit || pending || unavailable}
        tooltip={unavailable ? "Needs this release’s database update" : enabled ? "Turn off numbering" : "Turn on numbering"}
        ring={confirming !== null}
        onChange={(on) => {
          if (!on) return save({ ...saved, enabled: false }, "save");
          const rect = rowRef.current?.getBoundingClientRect();
          if (rect) setConfirming({ top: rect.bottom - 6, right: Math.max(window.innerWidth - rect.right - 2, 8) });
        }}
      />
      {confirming ? (
        <TurnOnConfirm
          anchor={rowRef}
          position={confirming}
          sample={nextTaskLabel({ ...saved, nextNumber: Math.max(saved.nextNumber, 1) })}
          count={counts?.unnumbered ?? null}
          onCancel={() => setConfirming(null)}
          onConfirm={(numberExisting) => {
            setConfirming(null);
            save({ ...saved, enabled: true }, numberExisting ? "number_missing" : "save");
          }}
        />
      ) : null}
    </li>
  );
}

// "Turn on task numbering?" in a small box under the switch (01c).
function TurnOnConfirm({
  anchor,
  position,
  sample,
  count,
  onCancel,
  onConfirm,
}: {
  anchor: RefObject<HTMLElement | null>;
  position: { top: number; right: number };
  sample: string;
  count: number | null;
  onCancel: () => void;
  onConfirm: (numberExisting: boolean) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const turnOnRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [numberExisting, setNumberExisting] = useState(true);
  const cancelRef = useRef(onCancel);
  useEffect(() => {
    cancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    turnOnRef.current?.focus();
  }, []);

  useEffect(() => {
    const close = () => cancelRef.current();
    const unregister = registerPopover(
      { close, contains: (node) => Boolean(boxRef.current?.contains(node) || anchor.current?.contains(node)) },
      anchor.current,
    );
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!boxRef.current?.contains(target) && !anchor.current?.contains(target)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Handled here: Customize itself stays open.
      e.preventDefault();
      close();
    };
    const onScroll = (e: Event) => {
      if (!boxRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      unregister();
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={boxRef}
      role="dialog"
      aria-labelledby={titleId}
      data-popover-panel=""
      style={{ top: position.top, right: position.right }}
      className="fixed z-[60] w-60 rounded-lg border border-zinc-200 bg-white p-3 text-sm shadow-lg"
    >
      <p id={titleId} className="mb-1 font-semibold text-zinc-900">
        Turn on task numbering?
      </p>
      <p className="mb-2.5 text-xs text-zinc-500">
        New tasks get the next number, like{" "}
        <span className="rounded bg-zinc-100 px-1 font-mono text-2xs text-zinc-600">{sample}</span>.
      </p>
      {count === 0 ? null : (
        <label className="mb-3 flex items-start gap-2 text-xs text-zinc-700">
          <input
            type="checkbox"
            checked={numberExisting}
            onChange={(e) => setNumberExisting(e.currentTarget.checked)}
            className="mt-px size-3.5 shrink-0 accent-accent-500"
          />
          {numberExistingLabel(count)}
        </label>
      )}
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={onCancel} className="btn-secondary h-7 px-2.5">
          Cancel
        </button>
        <button ref={turnOnRef} type="button" onClick={() => onConfirm(count !== 0 && numberExisting)} className="btn-primary h-7 px-2.5">
          Turn on
        </button>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------------------------
// The format page (03)

export function NumberingPage({
  projectId,
  sequence,
  sections,
  fields,
  counts,
}: {
  projectId: string;
  sequence: TaskNumbering | null;
  sections: { id: string; name: string }[];
  fields: FieldDef[];
  counts: NumberingCounts | null;
}) {
  const { canEdit, canManage: canRenumber } = useProjectPermissions();
  const [pending, run] = useServerAction();
  const saved = sequence ?? emptyNumbering();
  const [draft, setDraft] = useState(saved);
  // After a save the page refreshes with what the database stored: start from that (a refresh with the
  // same settings keeps unsaved edits).
  const savedKey = JSON.stringify(saved);
  const [syncedKey, setSyncedKey] = useState(savedKey);
  if (savedKey !== syncedKey) {
    setSyncedKey(savedKey);
    setDraft(saved);
  }
  const [openRule, setOpenRule] = useState<string | null>(null);
  const [custom, setCustom] = useState(() => simpleNumberFormat(saved.template) === null);
  const [renumberOpen, setRenumberOpen] = useState(false);
  const [renumberStart, setRenumberStart] = useState(saved.startNumber);
  const [confirmation, setConfirmation] = useState("");
  const timeZones = useTimeZones(draft.timeZone);

  const simple = simpleNumberFormat(draft.template);
  const counters = separateCounters(draft);
  const formatError = templateProblem(draft.template, draft.resetPeriod);
  const sampleField = fieldName(fields, draft.counterFieldId) ?? undefined;
  const label = nextTaskLabel(draft, { fieldSample: sampleField });
  const dirty = numberingChanged(saved, draft);
  const singleSelects = fields.filter((f) => f.fieldType === "single_select" && !f.boundToSections);
  const readOnly = !canEdit;
  const set = (patch: Partial<TaskNumbering>) => setDraft({ ...draft, ...patch });

  function save(mode: SaveMode) {
    const startNumber = startNumberToSend(saved, draft, mode, renumberStart);
    run(() =>
      saveTaskNumbering(
        projectId,
        { ...draft, startNumber, confirmation: mode === "renumber" ? confirmation : undefined },
        mode,
      ),
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1">
        <div className="rounded-lg border border-zinc-200 bg-white p-3">
          <p className="mb-2 text-xs text-zinc-500">How the next new task will look</p>
          <div className="flex h-8 items-center gap-2 rounded-md bg-zinc-50 px-2">
            <span aria-hidden className="size-3.5 shrink-0 rounded-full border-[1.5px] border-zinc-400" />
            <span className="min-w-0 flex-1 truncate text-zinc-900">Design spring flyer</span>
            <span className="shrink-0 text-2xs tabular-nums text-zinc-400">{formatError ? "—" : label}</span>
          </div>
          {!draft.enabled ? (
            <p className="mt-2 text-xs text-zinc-500">Numbering is off. Turn it on from Customize to number new tasks.</p>
          ) : null}
        </div>
        {sequence?.advanced === false ? (
          <p className="mt-2 px-1 text-xs text-amber-800">Task numbering’s extra rules need this release’s database update.</p>
        ) : null}

        <GroupLabel>Format</GroupLabel>
        <div className="flex flex-col gap-3.5 rounded-lg border border-zinc-200 bg-white p-3">
          {custom || !simple ? (
            <Field label="Format" htmlFor="num-format">
              <input
                id="num-format"
                value={draft.template}
                disabled={readOnly}
                data-panel-focus
                onChange={(e) => set({ template: e.currentTarget.value })}
                className="control h-8 w-full font-mono"
              />
              <span className="text-xs text-zinc-400">
                {"{n}"} the number, {"{n:3}"} with digits, {"{yyyy}"} {"{mm}"} the date, {"{field:Name}"} a field, {"{project}"}{" "}
                the short code.
              </span>
              {formatError ? <span className="text-xs text-red-700">{formatError}</span> : null}
            </Field>
          ) : null}
          <div className="flex gap-2.5">
            {custom || !simple ? (
              <Field label="Short code" htmlFor="num-code">
                <input
                  id="num-code"
                  value={draft.projectCode}
                  maxLength={12}
                  disabled={readOnly}
                  placeholder="MKT"
                  onChange={(e) => set({ projectCode: e.currentTarget.value })}
                  className="control h-8 w-full"
                />
              </Field>
            ) : (
              <Field label="Prefix" htmlFor="num-prefix" grow={1.3}>
                <input
                  id="num-prefix"
                  value={simple.prefix}
                  maxLength={20}
                  disabled={readOnly}
                  data-panel-focus
                  placeholder="MKT-"
                  onChange={(e) => set({ template: numberFormatFrom({ prefix: e.currentTarget.value, digits: simple.digits }) })}
                  className="control h-8 w-full"
                />
              </Field>
            )}
            <Field label={counters ? "Counters start at" : "Next number"} htmlFor="num-next">
              <input
                id="num-next"
                type="number"
                min={1}
                value={counters ? draft.startNumber : draft.nextNumber}
                disabled={readOnly}
                onChange={(e) => {
                  const value = Math.max(1, Number(e.currentTarget.value) || 1);
                  set(counters ? { startNumber: value } : { nextNumber: value });
                }}
                className="control h-8 w-full tabular-nums"
              />
            </Field>
          </div>
          {!custom && simple ? (
            <Field label="Digits">
              <div role="radiogroup" aria-label="Digits" className="flex h-8 rounded-md bg-zinc-100 p-0.5">
                {[...new Set<number>([...NUMBER_DIGITS, simple.digits])].map((digits) => (
                  <button
                    key={digits}
                    type="button"
                    role="radio"
                    aria-checked={simple.digits === digits}
                    disabled={readOnly}
                    onClick={() => set({ template: numberFormatFrom({ prefix: simple.prefix, digits }) })}
                    className={`flex-1 rounded font-mono text-xs ${
                      simple.digits === digits ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-800"
                    }`}
                  >
                    {digitsSample(digits)}
                  </button>
                ))}
              </div>
            </Field>
          ) : null}
          <div className="flex items-center gap-2.5">
            <span className="min-w-0 flex-1 text-sm text-zinc-900">
              Wrap in brackets <span className="text-2xs text-zinc-400">[{label.replace(/^\[(.*)\]$/, "$1")}]</span>
            </span>
            <PanelSwitch
              checked={draft.wrapBrackets}
              label="Wrap in brackets"
              disabled={readOnly}
              onChange={(wrapBrackets) => set({ wrapBrackets })}
            />
          </div>
          {canEdit ? (
            <button
              type="button"
              onClick={() => {
                if (custom && simple) setCustom(false);
                else if (custom || !simple) {
                  set({ template: numberFormatFrom({ prefix: draft.projectCode ? `${draft.projectCode}-` : "", digits: 0 }) });
                  setCustom(false);
                } else setCustom(true);
              }}
              className="self-start text-xs font-medium text-accent-700 hover:underline"
            >
              {custom || !simple ? "Use a prefix and digits instead" : "Use a custom format (dates, fields)…"}
            </button>
          ) : null}
        </div>

        <GroupLabel>Rules</GroupLabel>
        <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <RuleRow
            id="scope"
            label="What gets numbered"
            value={numberScopeValue(draft)}
            open={openRule}
            onToggle={setOpenRule}
          >
            <SmartPicker
              id="num-scope"
              label="What gets numbered"
              value={draft.numberScope}
              disabled={readOnly}
              onChange={(value) => set({ numberScope: value as NumberScope })}
              className="h-8 w-full"
              options={[
                { value: "all_tasks", label: "All tasks" },
                { value: "form_submissions", label: "Only tasks created by forms" },
                { value: "sections", label: "Only tasks in chosen sections" },
                { value: "kinds", label: "Only chosen task types" },
              ]}
            />
            {draft.numberScope === "sections"
              ? sections.map((section) => (
                  <Check
                    key={section.id}
                    checked={draft.sectionIds.includes(section.id)}
                    disabled={readOnly}
                    onChange={(on) =>
                      set({ sectionIds: on ? [...draft.sectionIds, section.id] : draft.sectionIds.filter((id) => id !== section.id) })
                    }
                  >
                    {section.name}
                  </Check>
                ))
              : null}
            {draft.numberScope === "kinds"
              ? (["task", "milestone", "approval"] as const).map((kind) => (
                  <Check
                    key={kind}
                    checked={draft.taskKinds.includes(kind)}
                    disabled={readOnly}
                    onChange={(on) => set({ taskKinds: on ? [...draft.taskKinds, kind] : draft.taskKinds.filter((k) => k !== kind) })}
                  >
                    {kind === "task" ? "Tasks" : kind === "milestone" ? "Milestones" : "Approvals"}
                  </Check>
                ))
              : null}
          </RuleRow>
          <RuleRow
            id="restart"
            label="Restart the count"
            value={restartValue(draft, fieldName(fields, draft.counterFieldId))}
            open={openRule}
            onToggle={setOpenRule}
          >
            <SmartPicker
              id="num-reset"
              label="Restart the count"
              value={draft.resetPeriod}
              disabled={readOnly}
              onChange={(value) => set({ resetPeriod: value as ResetPeriod })}
              className="h-8 w-full"
              options={[
                { value: "never", label: "Never" },
                { value: "yearly", label: "Every year" },
                { value: "monthly", label: "Every month" },
              ]}
            />
            {draft.resetPeriod !== "never" ? (
              <span className="text-xs text-zinc-500">The format needs {"{yyyy}"}, {"{yy}"}, or {"{mm}"} (a custom format) so numbers stay unique.</span>
            ) : null}
            <SmartPicker
              id="num-field"
              label="Separate counters per field value"
              value={draft.counterFieldId ?? ""}
              disabled={readOnly}
              onChange={(value) => set({ counterFieldId: value || null })}
              className="h-8 w-full"
              options={[
                { value: "", label: "One counter for the project" },
                ...singleSelects.map((field) => ({ value: field.id, label: `A counter per ${field.name}` })),
              ]}
            />
            <SmartPicker
              id="num-zone"
              label="Time zone"
              value={draft.timeZone}
              disabled={readOnly}
              searchable
              onChange={(value) => set({ timeZone: value })}
              className="h-8 w-full"
              options={timeZones.map((zone) => ({ value: zone, label: zone.replaceAll("_", " "), keywords: [zone] }))}
            />
          </RuleRow>
          <RuleRow id="subtasks" label="Subtasks" value={subtaskValue(label, draft)} open={openRule} onToggle={setOpenRule}>
            <Check checked={draft.numberSubtasks} disabled={readOnly} onChange={(numberSubtasks) => set({ numberSubtasks })}>
              Number subtasks under their parent
            </Check>
            <SmartPicker
              id="num-sep"
              label="Subtask separator"
              value={draft.subtaskSeparator}
              disabled={readOnly || !draft.numberSubtasks}
              onChange={(value) => set({ subtaskSeparator: value as SubtaskSeparator })}
              className="h-8 w-full"
              options={[
                { value: ".", label: "Period (12.1)" },
                { value: "-", label: "Dash (12-1)" },
                { value: "/", label: "Slash (12/1)" },
              ]}
            />
          </RuleRow>
          <RuleRow id="reuse" label="Reused numbers" value={reuseValue(draft)} open={openRule} onToggle={setOpenRule}>
            <Check
              checked={draft.reuseDeleted}
              disabled={readOnly}
              onChange={(reuseDeleted) => set({ reuseDeleted, fillGaps: reuseDeleted ? draft.fillGaps : false })}
            >
              Reuse numbers of tasks moved to the Trash
            </Check>
            <Check checked={draft.fillGaps} disabled={readOnly || !draft.reuseDeleted} onChange={(fillGaps) => set({ fillGaps })}>
              Fill every gap, including old ones
            </Check>
            <Check checked={draft.renumberOnMove} disabled={readOnly} onChange={(renumberOnMove) => set({ renumberOnMove })}>
              Give a task moved into this project a new number
            </Check>
          </RuleRow>
        </ul>

        {canRenumber ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setRenumberStart(saved.startNumber);
              setConfirmation("");
              setRenumberOpen(true);
            }}
            className="mt-3.5 inline-flex items-center gap-1.5 px-1 text-xs text-red-700 hover:underline"
          >
            <RotateCcw className="size-3.5" aria-hidden />
            Renumber every task…
          </button>
        ) : null}
      </div>

      {dirty && canEdit ? (
        <div className="sticky bottom-0 -mx-3 -mb-3 mt-4 flex items-center gap-2 border-t border-zinc-200 bg-white px-3 py-2.5">
          <span className="min-w-0 flex-1 text-xs text-zinc-500" role="status">
            {formatError ?? numberingSaveNote(saved, draft, counts?.labelled ?? null)}
          </span>
          <button type="button" onClick={() => setDraft(saved)} className="btn-secondary h-7 px-2.5">
            Cancel
          </button>
          <button type="button" disabled={pending || Boolean(formatError)} onClick={() => save("save")} className="btn-primary h-7 px-3">
            Save
          </button>
        </div>
      ) : null}

      {renumberOpen ? (
        <Dialog title="Renumber every task?" onClose={() => setRenumberOpen(false)}>
          <p className="text-sm text-zinc-600">
            This gives every task in this project a new number, in the order they were created. It can’t be undone.
          </p>
          <label htmlFor="num-renumber-start" className="mt-3 block text-xs font-medium text-zinc-600">
            Start at
          </label>
          <input
            id="num-renumber-start"
            type="number"
            min={1}
            value={renumberStart}
            onChange={(e) => setRenumberStart(Math.max(1, Number(e.currentTarget.value) || 1))}
            className="field mt-1 max-w-32"
          />
          <label htmlFor="num-renumber-confirm" className="mt-3 block text-xs font-medium text-zinc-600">
            Type RENUMBER to confirm
          </label>
          <input
            id="num-renumber-confirm"
            value={confirmation}
            onChange={(e) => setConfirmation(e.currentTarget.value)}
            className="field mt-1"
            autoComplete="off"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setRenumberOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={pending || confirmation !== "RENUMBER" || Boolean(formatError)}
              onClick={() => {
                setRenumberOpen(false);
                save("renumber");
              }}
            >
              Renumber all
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

function Field({ label, htmlFor, children, grow = 1 }: { label: string; htmlFor?: string; children: ReactNode; grow?: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5" style={{ flex: grow }}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-xs font-medium text-zinc-600">
          {label}
        </label>
      ) : (
        <span className="text-xs font-medium text-zinc-600">{label}</span>
      )}
      {children}
    </div>
  );
}

function Check({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex items-start gap-2 text-xs text-zinc-700">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
        className="mt-px size-3.5 shrink-0 accent-accent-500"
      />
      {children}
    </label>
  );
}

// A rule row shows its current value; clicking it opens its settings right below (no page of its own).
function RuleRow({
  id,
  label,
  value,
  open,
  onToggle,
  children,
}: {
  id: string;
  label: string;
  value: string;
  open: string | null;
  onToggle: (id: string | null) => void;
  children: ReactNode;
}) {
  const expanded = open === id;
  const panelId = `num-rule-${id}`;
  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => onToggle(expanded ? null : id)}
        className="flex min-h-row w-full items-center gap-2.5 px-2.5 text-left text-sm hover:bg-zinc-50"
      >
        <span className="min-w-0 flex-1 truncate text-zinc-900">{label}</span>
        <span className="max-w-[45%] shrink-0 truncate text-xs text-zinc-500">{value}</span>
        <ChevronRight className={`size-3.5 shrink-0 text-zinc-300 transition-transform ${expanded ? "rotate-90" : ""}`} aria-hidden />
      </button>
      {expanded ? (
        <div id={panelId} className="flex flex-col gap-2 px-2.5 pb-3 pt-0.5">
          {children}
        </div>
      ) : null}
    </li>
  );
}
