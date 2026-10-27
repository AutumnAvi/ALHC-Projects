"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bell,
  Calendar,
  CircleChevronDown,
  Columns3,
  Hash,
  Library,
  ListChecks,
  Plus,
  Search,
  SquareCheck,
  Trash2,
  Type,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { ColorPicker } from "@/components/color-picker";
import { useConfirm } from "@/components/confirm";
import { Dialog, DIALOG_HINT, DIALOG_LABEL } from "@/components/dialog";
import { SmartPicker } from "@/components/smart-picker";
import { useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { createField, deleteField, loadFieldLibrary, updateField } from "@/lib/actions";
import {
  FIELD_TYPES,
  MAX_FIELD_DESCRIPTION,
  OPTION_COLORS,
  OPTION_COLOR_CLASSES,
  fieldTypeLabel,
  hasOptions,
  type FieldDef,
  type FieldOption,
  type FieldType,
  type LibraryField,
} from "@/lib/fields";

const TYPE_ICONS: Record<FieldType, LucideIcon> = {
  text: Type,
  number: Hash,
  date: Calendar,
  boolean: SquareCheck,
  single_select: CircleChevronDown,
  multi_select: ListChecks,
  people: Users,
};

// The small icon in front of a field's name (Fields list, Customize → Fields, the field library).
export function FieldTypeIcon({
  field,
  className = "size-4",
}: {
  field: Pick<FieldDef, "fieldType" | "boundToSections">;
  className?: string;
}) {
  const Icon = field.boundToSections ? Columns3 : TYPE_ICONS[field.fieldType];
  return <Icon className={`shrink-0 text-zinc-500 ${className}`} aria-hidden />;
}

// The first few options as pills, then "+N".
export function OptionPreview({ options, max = 3 }: { options: FieldOption[]; max?: number }) {
  if (options.length === 0) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {options.slice(0, max).map((o) => (
        <span
          key={o.id}
          className={`inline-flex max-w-28 items-center rounded-full px-2 py-px text-xs font-medium ${OPTION_COLOR_CLASSES[o.color]}`}
        >
          <span className="truncate">{o.name}</span>
        </span>
      ))}
      {options.length > max ? <span className="text-2xs tabular-nums text-zinc-400">+{options.length - max}</span> : null}
    </span>
  );
}

// Asana's Fields list: type icon, name, option preview. Editors click a row to edit it (the Edit field
// modal); everyone else reads. Used by the Fields page and Customize → Fields.
export function FieldList({
  projectId,
  fields,
  sectionNames,
  canEdit,
  batch4,
  dense = false,
}: {
  projectId: string;
  fields: FieldDef[];
  sectionNames: string[];
  canEdit: boolean;
  batch4: boolean;
  dense?: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = fields.find((f) => f.id === editingId) ?? null;
  return (
    <>
      <ul aria-label="Fields" className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 bg-white">
        {fields.map((field) => {
          const options = field.boundToSections
            ? sectionNames.map((name, i) => ({ id: `section-${i}`, name, color: "zinc" as const }))
            : field.options;
          const body = (
            <>
              <FieldTypeIcon field={field} />
              <span className={`flex min-w-0 flex-1 ${dense ? "flex-col gap-1" : "items-center gap-3"}`}>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-medium text-zinc-900">{field.name}</span>
                  {field.inLibrary ? (
                    <Library className="size-3.5 shrink-0 text-zinc-400" aria-label="In the field library" />
                  ) : null}
                  {field.notifyOnChange ? (
                    <Bell className="size-3.5 shrink-0 text-zinc-400" aria-label="Notifies followers when changed" />
                  ) : null}
                </span>
                {hasOptions(field) || field.boundToSections ? (
                  <OptionPreview options={options} max={dense ? 3 : 4} />
                ) : field.description || dense ? (
                  <span className="truncate text-xs text-zinc-500">{field.description || fieldTypeLabel(field)}</span>
                ) : null}
              </span>
              {!dense ? <span className="hidden shrink-0 text-xs text-zinc-500 sm:inline">{fieldTypeLabel(field)}</span> : null}
              {!dense && field.showInViews ? (
                <span className="hidden shrink-0 text-2xs text-zinc-400 md:inline" title="Shown in List and Board">
                  <Columns3 className="size-3.5" aria-label="Shown in List and Board" />
                </span>
              ) : null}
            </>
          );
          return (
            <li key={field.id}>
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => setEditingId(field.id)}
                  aria-label={`Edit field ${field.name}`}
                  className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-zinc-50"
                >
                  {body}
                </button>
              ) : (
                <div className="flex min-h-11 items-center gap-3 px-3 py-2 text-sm">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      {editing ? (
        <FieldEditorDialog
          projectId={projectId}
          field={editing}
          sectionNames={sectionNames}
          batch4={batch4}
          onClose={() => setEditingId(null)}
        />
      ) : null}
    </>
  );
}

type Draft = {
  name: string;
  fieldType: FieldType;
  description: string;
  options: FieldOption[];
  showInViews: boolean;
  inLibrary: boolean;
  notifyOnChange: boolean;
};

function draftOf(field: FieldDef | null): Draft {
  return {
    name: field?.name ?? "",
    fieldType: field?.fieldType ?? "single_select",
    description: field?.description ?? "",
    options: field?.options ?? [],
    showInViews: field ? field.showInViews : true,
    inLibrary: field?.inLibrary ?? false,
    notifyOnChange: field?.notifyOnChange ?? false,
  };
}

// Asana's Add field / Edit field modal: title, type, description, options with color dots, "Add to
// field library", and "Notify followers when changed". Adding also offers the workspace field
// library (a copy of a library field's definition). Description, library, and notify need this
// release's database update (batch4); without it they stay hidden.
export function FieldEditorDialog({
  projectId,
  field,
  sectionNames,
  batch4,
  existingFieldIds = [],
  onCreated,
  onClose,
}: {
  projectId: string;
  // Null = a new field.
  field: FieldDef | null;
  sectionNames: string[];
  batch4: boolean;
  // This project's fields (library fields that came from this project aren't offered again).
  existingFieldIds?: string[];
  onCreated?: (fieldId: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"new" | "library">("new");
  const creating = field === null;
  return (
    <Dialog
      title={creating ? "Add field" : "Edit field"}
      description={
        creating
          ? "A field adds the same detail to every task in this project."
          : "Changes apply to every task in this project."
      }
      onClose={onClose}
      width="max-w-lg"
    >
      {creating ? (
        <div role="tablist" aria-label="Add a field" className="tab-strip -mx-5 -mt-1 mb-4 gap-1 px-5">
          {(
            [
              { key: "new", label: "Create new field" },
              { key: "library", label: "Choose from library" },
            ] as const
          ).map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className="inline-flex h-9 shrink-0 items-center border-b-2 border-transparent px-2 text-sm text-zinc-500 hover:text-zinc-900 aria-selected:border-accent-500 aria-selected:font-medium aria-selected:text-zinc-900"
            >
              {t.label}
            </button>
          ))}
        </div>
      ) : null}
      {creating && tab === "library" ? (
        <LibraryPicker
          projectId={projectId}
          batch4={batch4}
          existingFieldIds={existingFieldIds}
          onCreated={(fieldId) => {
            onCreated?.(fieldId);
            onClose();
          }}
        />
      ) : (
        <FieldForm
          projectId={projectId}
          field={field}
          sectionNames={sectionNames}
          batch4={batch4}
          onCreated={onCreated}
          onClose={onClose}
        />
      )}
    </Dialog>
  );
}

function FieldForm({
  projectId,
  field,
  sectionNames,
  batch4,
  onCreated,
  onClose,
}: {
  projectId: string;
  field: FieldDef | null;
  sectionNames: string[];
  batch4: boolean;
  onCreated?: (fieldId: string) => void;
  onClose: () => void;
}) {
  const [pending, run] = useServerAction();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<Draft>(() => draftOf(field));
  const [newOption, setNewOption] = useState("");
  const creating = field === null;
  const bound = field?.boundToSections ?? false;
  const withOptions = hasOptions({ fieldType: draft.fieldType, boundToSections: bound });
  const removed = field ? field.options.filter((o) => !draft.options.some((d) => d.id === o.id)) : [];
  const prefix = field ? `field-${field.id}` : "field-new";

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function addOption() {
    const name = newOption.trim();
    if (!name) return;
    const color = OPTION_COLORS[(draft.options.length + 1) % OPTION_COLORS.length];
    set("options", [...draft.options, { id: crypto.randomUUID(), name, color }]);
    setNewOption("");
  }

  function moveOption(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= draft.options.length) return;
    const next = [...draft.options];
    [next[index], next[target]] = [next[target], next[index]];
    set("options", next);
  }

  function save() {
    const name = draft.name.trim();
    if (!name || pending) return;
    // A name typed in the "Add an option" box but not added yet still counts.
    const pendingOption = newOption.trim();
    const options =
      withOptions && pendingOption
        ? [...draft.options, { id: crypto.randomUUID(), name: pendingOption, color: OPTION_COLORS[(draft.options.length + 1) % OPTION_COLORS.length] }]
        : draft.options;
    const extras = batch4 && !bound
      ? { description: draft.description.trim() || null, inLibrary: draft.inLibrary, notifyOnChange: draft.notifyOnChange }
      : batch4
        ? { description: draft.description.trim() || null }
        : {};
    run(async () => {
      if (creating) {
        const result = await createField(projectId, {
          name,
          fieldType: draft.fieldType,
          showInViews: draft.showInViews,
          options: withOptions ? options : undefined,
          ...extras,
        });
        if (!result.error && result.fieldId) {
          onCreated?.(result.fieldId);
          onClose();
        }
        return result;
      }
      const patch: Parameters<typeof updateField>[1] = {};
      if (name !== field.name) patch.name = name;
      if (withOptions && JSON.stringify(options) !== JSON.stringify(field.options)) patch.options = options;
      if (draft.showInViews !== field.showInViews) patch.showInViews = draft.showInViews;
      if ("description" in extras && (extras.description ?? null) !== (field.description ?? null)) {
        patch.description = extras.description;
      }
      if ("inLibrary" in extras && extras.inLibrary !== field.inLibrary) patch.inLibrary = extras.inLibrary;
      if ("notifyOnChange" in extras && extras.notifyOnChange !== field.notifyOnChange) patch.notifyOnChange = extras.notifyOnChange;
      if (Object.keys(patch).length === 0) {
        onClose();
        return {};
      }
      const result = await updateField(field.id, patch);
      if (!result.error) onClose();
      return result;
    });
  }

  return (
    // Not a <form>: Enter in the option box adds an option instead of saving.
    <div className="flex flex-col gap-4">
      <div>
        <label htmlFor={`${prefix}-name`} className={DIALOG_LABEL}>
          Field title
        </label>
        <input
          id={`${prefix}-name`}
          data-autofocus
          value={draft.name}
          maxLength={100}
          placeholder="e.g. Priority"
          onChange={(e) => set("name", e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
          className="field mt-1 w-full"
        />
      </div>
      <div>
        <label htmlFor={`${prefix}-type`} className={DIALOG_LABEL}>
          Field type
        </label>
        {bound ? (
          <p id={`${prefix}-type`} className="mt-1 flex h-9 items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-sm text-zinc-600">
            <Columns3 className="size-4 text-zinc-500" aria-hidden />
            Status from sections
          </p>
        ) : (
          <div className="mt-1">
            <SmartPicker
              id={`${prefix}-type`}
              label="Field type"
              value={draft.fieldType}
              disabled={!creating}
              aria-describedby={creating ? undefined : `${prefix}-type-hint`}
              onChange={(value) => set("fieldType", value as FieldType)}
              className="h-9 w-full"
              options={FIELD_TYPES.map((t) => ({
                value: t.value,
                label: t.label,
                icon: <FieldTypeIcon field={{ fieldType: t.value, boundToSections: false }} />,
              }))}
            />
          </div>
        )}
        {!creating && !bound ? (
          <p id={`${prefix}-type-hint`} className={DIALOG_HINT}>
            A field keeps its type; add a new field for another kind of value.
          </p>
        ) : null}
      </div>
      {batch4 ? (
        <div>
          <label htmlFor={`${prefix}-description`} className={DIALOG_LABEL}>
            Description <span className="font-normal text-zinc-400">(optional)</span>
          </label>
          <textarea
            id={`${prefix}-description`}
            value={draft.description}
            maxLength={MAX_FIELD_DESCRIPTION}
            rows={2}
            placeholder="What this field is for and how to fill it in"
            onChange={(e) => set("description", e.currentTarget.value)}
            className="field mt-1 h-auto w-full py-2"
          />
        </div>
      ) : null}

      {bound ? (
        <div>
          <p className={DIALOG_LABEL}>Options</p>
          <p className={DIALOG_HINT}>
            The options are this project’s sections, so changing the Status moves the task:{" "}
            {sectionNames.length ? sectionNames.join(", ") : "this project has no sections yet"}.
          </p>
        </div>
      ) : withOptions ? (
        <fieldset>
          <legend className={DIALOG_LABEL}>Options</legend>
          <ul className="mt-1.5 flex flex-col gap-1">
            {draft.options.map((option, index) => (
              <li key={option.id} className="group flex items-center gap-1.5">
                <ColorPicker
                  compact
                  value={option.color}
                  onChange={(color) => set("options", draft.options.map((o) => (o.id === option.id ? { ...o, color } : o)))}
                  label={`Color of ${option.name || `option ${index + 1}`}`}
                />
                <input
                  aria-label={`Option ${index + 1}`}
                  value={option.name}
                  maxLength={100}
                  onChange={(e) => {
                    const name = e.currentTarget.value;
                    set("options", draft.options.map((o) => (o.id === option.id ? { ...o, name } : o)));
                  }}
                  className="control h-8 min-w-0 flex-1"
                />
                <span className="flex opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                  <button
                    type="button"
                    aria-label={`Move ${option.name || `option ${index + 1}`} up`}
                    disabled={index === 0}
                    onClick={() => moveOption(index, -1)}
                    className="btn-icon size-7 text-xs"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${option.name || `option ${index + 1}`} down`}
                    disabled={index === draft.options.length - 1}
                    onClick={() => moveOption(index, 1)}
                    className="btn-icon size-7 text-xs"
                  >
                    ↓
                  </button>
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${option.name || `option ${index + 1}`}`}
                  data-tooltip="Remove option"
                  onClick={() => set("options", draft.options.filter((o) => o.id !== option.id))}
                  className="btn-icon size-7"
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="flex size-5 items-center justify-center text-zinc-400">
                <Plus className="size-3.5" />
              </span>
              <input
                aria-label="Add an option"
                value={newOption}
                maxLength={100}
                placeholder="Add an option"
                onChange={(e) => setNewOption(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addOption();
                  }
                }}
                className="control h-8 min-w-0 flex-1"
              />
              <button type="button" onClick={addOption} disabled={!newOption.trim()} className="btn-ghost h-8">
                Add
              </button>
            </li>
          </ul>
          {removed.length ? (
            <p className="mt-1.5 text-xs text-amber-700">
              Tasks set to {removed.map((o) => `“${o.name}”`).join(", ")} lose that value when you save.
            </p>
          ) : null}
        </fieldset>
      ) : null}

      <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3">
        <Toggle
          id={`${prefix}-views`}
          checked={draft.showInViews}
          onChange={(v) => set("showInViews", v)}
          label="Show in List and Board"
          hint="A column in List views and a pill on Board cards (views that list their own columns add it from their column menu)."
        />
        {batch4 && !bound ? (
          <>
            <Toggle
              id={`${prefix}-library`}
              checked={draft.inLibrary}
              onChange={(v) => set("inLibrary", v)}
              label="Add to field library"
              hint="Everyone in the workspace can find this field’s title, type, description, and options and add a copy to their projects. Tasks and values stay private."
            />
            <Toggle
              id={`${prefix}-notify`}
              checked={draft.notifyOnChange}
              onChange={(v) => set("notifyOnChange", v)}
              label="Notify followers when changed"
              hint="When a task’s value changes, its followers get an Inbox notification."
            />
          </>
        ) : null}
        {!batch4 ? (
          <p className="text-xs text-zinc-500">
            Descriptions, the field library, and notifications arrive with this release’s database update.
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        {!creating ? (
          <button
            type="button"
            disabled={pending}
            onClick={async () => {
              const ok = await confirm({
                title: `Delete the “${field.name}” field?`,
                message: "Existing values are kept in the database.",
                confirmLabel: "Delete",
                tone: "danger",
              });
              if (!ok) return;
              run(async () => {
                const result = await deleteField(field.id);
                if (!result.error) onClose();
                return result;
              });
            }}
            className="btn-ghost h-8 text-red-700 hover:bg-red-50 hover:text-red-800"
          >
            <Trash2 className="size-4" aria-hidden />
            Delete field
          </button>
        ) : null}
        <span className="flex-1" />
        <button type="button" onClick={onClose} className="btn-secondary h-8 px-3">
          Cancel
        </button>
        <button type="button" onClick={save} disabled={pending || !draft.name.trim()} className="btn-primary h-8 px-3">
          {pending ? "Saving…" : creating ? "Create field" : "Save"}
        </button>
      </div>
    </div>
  );
}

function Toggle({
  id,
  checked,
  onChange,
  label,
  hint,
}: {
  id: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
        aria-describedby={`${id}-hint`}
        className="peer sr-only"
      />
      <label
        htmlFor={id}
        aria-hidden
        className="relative mt-0.5 inline-block h-4 w-7 shrink-0 cursor-pointer rounded-full bg-zinc-300 transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-3 after:rounded-full after:bg-white after:transition-transform peer-checked:bg-accent-500 peer-checked:after:translate-x-3 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-500 peer-focus-visible:ring-offset-1"
      />
      <span className="min-w-0">
        <label htmlFor={id} className="block cursor-pointer text-sm text-zinc-800">
          {label}
        </label>
        <span id={`${id}-hint`} className="block text-xs text-zinc-500">
          {hint}
        </span>
      </span>
    </div>
  );
}

// Choose from library: a copy of a library field's definition becomes a new field of this project.
function LibraryPicker({
  projectId,
  batch4,
  existingFieldIds,
  onCreated,
}: {
  projectId: string;
  batch4: boolean;
  existingFieldIds: string[];
  onCreated: (fieldId: string) => void;
}) {
  const [pending, run] = useServerAction();
  const [library, setLibrary] = useState<LibraryField[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!batch4) return;
    let live = true;
    loadFieldLibrary()
      .then((loaded) => {
        if (!live) return;
        if (loaded) setLibrary(loaded);
        else setFailed(true);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [batch4]);

  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (library ?? []).filter(
        (f) =>
          !existingFieldIds.includes(f.fieldId) &&
          (!needle || f.name.toLowerCase().includes(needle) || (f.description ?? "").toLowerCase().includes(needle)),
      ),
    [library, existingFieldIds, needle],
  );

  if (!batch4 || failed) {
    return (
      <p className="text-sm text-zinc-600">
        {failed && batch4
          ? "Couldn’t load the field library. Try again."
          : "The field library arrives with this release’s database update."}
      </p>
    );
  }
  if (!library) {
    return (
      <p role="status" className="text-sm text-zinc-500">
        Loading the field library…
      </p>
    );
  }

  function add(field: LibraryField) {
    run(async () => {
      const result = await createField(projectId, {
        name: field.name,
        fieldType: field.fieldType,
        description: field.description,
        options: field.options,
        showInViews: true,
      });
      if (!result.error && result.fieldId) onCreated(result.fieldId);
      return result;
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="relative block">
        <span className="sr-only">Search the field library</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" aria-hidden />
        <input
          type="search"
          data-autofocus
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder="Search fields"
          className="field w-full pl-9"
        />
      </label>
      {shown.length === 0 ? (
        <EmptyState icon={Library} title={library.length === 0 ? "The library is empty" : "No fields match"} size="inline">
          {library.length === 0
            ? "Edit a field and turn on “Add to field library” to share its definition with the workspace."
            : "Try another name."}
        </EmptyState>
      ) : (
        <ul className="flex max-h-80 flex-col divide-y divide-zinc-100 overflow-y-auto rounded-lg border border-zinc-200">
          {shown.map((field) => (
            <li key={field.fieldId} className="flex items-start gap-3 px-3 py-2.5">
              <span className="mt-0.5">
                <FieldTypeIcon field={{ fieldType: field.fieldType, boundToSections: false }} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium text-zinc-900">{field.name}</span>
                  <span className="shrink-0 text-xs text-zinc-500">{fieldTypeLabel({ fieldType: field.fieldType, boundToSections: false })}</span>
                </span>
                {field.description ? <span className="mt-0.5 line-clamp-2 block text-xs text-zinc-500">{field.description}</span> : null}
                {field.options.length ? (
                  <span className="mt-1 block">
                    <OptionPreview options={field.options} max={5} />
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() => add(field)}
                aria-label={`Add ${field.name} to this project`}
                className="btn-secondary h-7 shrink-0"
              >
                Add
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-zinc-500">
        Adding copies the field into this project; later changes to either copy don’t sync.
      </p>
    </div>
  );
}
