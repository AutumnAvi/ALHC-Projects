"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Plus, Undo2, UserRound, X } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { SmartPicker } from "@/components/smart-picker";
import {
  customizationSummary,
  type TemplateCustomization,
  type TemplateOutline,
} from "@alhc/core/project-roles";

// Nov 2 notes (batch 14, 95): "Customize before creating" a project from a template — rename or leave out
// sections, tasks, and fields, add tasks, and pick who fills each of the template's roles (their tasks'
// assignees, approvers, and followers, and the automations that name the role, follow). Nothing is written
// until Create project; the template itself never changes.
export function TemplateRolesPicker({
  outline,
  people,
  value,
  onChange,
  idPrefix,
}: {
  outline: TemplateOutline;
  people: { id: string; name: string }[];
  value: TemplateCustomization;
  onChange: (next: TemplateCustomization) => void;
  idPrefix: string;
}) {
  if (outline.roles.length === 0) return null;
  return (
    <fieldset className="rounded-lg border border-zinc-200 px-3 py-2.5">
      <legend className="px-1 text-xs font-medium text-zinc-700">Who does what</legend>
      <p className="text-xs text-zinc-500">
        This template’s tasks and automations name roles. Pick a person for each: their tasks are assigned to them, and
        they join the project as Editors if they aren’t in it.
      </p>
      <ul className="mt-2 space-y-1.5">
        {outline.roles.map((role) => (
          <li key={role.id} className="flex flex-wrap items-center gap-2">
            <label htmlFor={`${idPrefix}-role-${role.id}`} className="w-32 truncate text-sm text-zinc-800">
              {role.name}
            </label>
            <SmartPicker
              id={`${idPrefix}-role-${role.id}`}
              label={`Who is the ${role.name}`}
              value={value.roles[role.id] ?? ""}
              searchable
              placeholder="Pick later"
              className="min-w-0 flex-1"
              options={[
                { value: "", label: "Pick later", icon: <UserRound className="size-4 text-zinc-400" /> },
                ...people.map((p) => ({ value: p.id, label: p.name, icon: <Avatar name={p.name} profileId={p.id} /> })),
              ]}
              onChange={(next) => onChange({ ...value, roles: { ...value.roles, [role.id]: next || null } })}
            />
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

export function TemplateCustomizer({
  outline,
  value,
  onChange,
  idPrefix,
}: {
  outline: TemplateOutline;
  value: TemplateCustomization;
  onChange: (next: TemplateCustomization) => void;
  idPrefix: string;
}) {
  const [open, setOpen] = useState(false);
  const summary = customizationSummary(value);
  const known = new Set(outline.sections.map((s) => s.id));
  const groups = [
    ...(outline.tasks.some((t) => !t.sectionId || !known.has(t.sectionId))
      ? [{ id: null as string | null, name: "No section" }]
      : []),
    ...outline.sections.map((s) => ({ id: s.id as string | null, name: s.name })),
  ];
  const setSection = (sid: string, patch: { name?: string; skip?: boolean }) =>
    onChange({ ...value, sections: { ...value.sections, [sid]: { ...value.sections[sid], ...patch } } });
  const setTask = (tid: string, patch: { title?: string; skip?: boolean }) =>
    onChange({ ...value, tasks: { ...value.tasks, [tid]: { ...value.tasks[tid], ...patch } } });
  const setField = (fid: string, patch: { name?: string; skip?: boolean }) =>
    onChange({ ...value, fields: { ...value.fields, [fid]: { ...value.fields[fid], ...patch } } });

  return (
    <div className="rounded-lg border border-zinc-200">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-zinc-800 hover:bg-zinc-50"
      >
        {open ? <ChevronDown className="size-4 text-zinc-500" aria-hidden /> : <ChevronRight className="size-4 text-zinc-500" aria-hidden />}
        Customize before creating
        <span className="ml-auto truncate text-xs font-normal text-zinc-500">{summary ?? "Sections, tasks, and fields"}</span>
      </button>
      {open ? (
        <div className="max-h-[50vh] space-y-4 overflow-y-auto border-t border-zinc-100 px-3 py-3">
          <p className="text-xs text-zinc-500">
            Rename or leave out what this project doesn’t need, and add tasks. The template stays as it is.
          </p>
          {groups.map((group) => {
            const sectionEdit = group.id ? value.sections[group.id] : undefined;
            const skipped = Boolean(sectionEdit?.skip);
            const tasks = outline.tasks.filter((t) => (group.id ? t.sectionId === group.id : !t.sectionId || !known.has(t.sectionId)));
            const added = value.added_tasks
              .map((a, index) => ({ ...a, index }))
              .filter((a) => a.section_id === group.id);
            return (
              <section key={group.id ?? "none"} aria-label={group.name}>
                <div className="flex items-center gap-2">
                  {group.id ? (
                    <>
                      <label htmlFor={`${idPrefix}-section-${group.id}`} className="sr-only">
                        Section name
                      </label>
                      <input
                        id={`${idPrefix}-section-${group.id}`}
                        value={sectionEdit?.name ?? group.name}
                        disabled={skipped}
                        maxLength={200}
                        onChange={(e) => setSection(group.id!, { name: e.target.value })}
                        className={`control min-w-0 flex-1 font-medium ${skipped ? "line-through opacity-60" : ""}`}
                      />
                      <SkipToggle
                        skipped={skipped}
                        what={`section ${group.name}`}
                        onToggle={() => setSection(group.id!, { skip: !skipped })}
                      />
                    </>
                  ) : (
                    <span className="text-sm font-medium text-zinc-600">{group.name}</span>
                  )}
                </div>
                {skipped ? (
                  <p className="mt-1 text-xs text-zinc-500">Left out, with its {tasks.length} task{tasks.length === 1 ? "" : "s"}.</p>
                ) : (
                  <ul className="mt-1.5 space-y-1 pl-3">
                    {tasks.map((task) => {
                      const edit = value.tasks[task.id];
                      const taskSkipped = Boolean(edit?.skip);
                      return (
                        <li key={task.id} className="flex items-center gap-2">
                          <label htmlFor={`${idPrefix}-task-${task.id}`} className="sr-only">
                            Task name
                          </label>
                          <input
                            id={`${idPrefix}-task-${task.id}`}
                            value={edit?.title ?? task.title}
                            disabled={taskSkipped}
                            maxLength={1000}
                            onChange={(e) => setTask(task.id, { title: e.target.value })}
                            className={`control min-w-0 flex-1 ${taskSkipped ? "line-through opacity-60" : ""}`}
                          />
                          <SkipToggle skipped={taskSkipped} what={`task ${task.title}`} onToggle={() => setTask(task.id, { skip: !taskSkipped })} />
                        </li>
                      );
                    })}
                    {added.map((a) => (
                      <li key={`added-${a.index}`} className="flex items-center gap-2">
                        <label htmlFor={`${idPrefix}-added-${a.index}`} className="sr-only">
                          New task name
                        </label>
                        <input
                          id={`${idPrefix}-added-${a.index}`}
                          value={a.title}
                          autoFocus={!a.title}
                          maxLength={1000}
                          placeholder="New task"
                          onChange={(e) =>
                            onChange({
                              ...value,
                              added_tasks: value.added_tasks.map((x, i) => (i === a.index ? { ...x, title: e.target.value } : x)),
                            })
                          }
                          className="control min-w-0 flex-1 border-accent-200"
                        />
                        <button
                          type="button"
                          aria-label="Remove this new task"
                          data-tooltip="Remove"
                          onClick={() => onChange({ ...value, added_tasks: value.added_tasks.filter((_, i) => i !== a.index) })}
                          className="btn-icon"
                        >
                          <X className="size-3.5" />
                        </button>
                      </li>
                    ))}
                    {value.added_tasks.length < 200 ? (
                      <li>
                        <button
                          type="button"
                          onClick={() => onChange({ ...value, added_tasks: [...value.added_tasks, { section_id: group.id, title: "" }] })}
                          className="btn-ghost h-7 text-xs"
                        >
                          <Plus className="size-3.5" aria-hidden /> Add task
                        </button>
                      </li>
                    ) : null}
                  </ul>
                )}
              </section>
            );
          })}
          {outline.fields.length > 0 ? (
            <section aria-label="Fields">
              <p className="text-sm font-medium text-zinc-600">Fields</p>
              <ul className="mt-1.5 space-y-1 pl-3">
                {outline.fields.map((field) => {
                  const edit = value.fields[field.id];
                  const skipped = Boolean(edit?.skip);
                  return (
                    <li key={field.id} className="flex items-center gap-2">
                      <label htmlFor={`${idPrefix}-field-${field.id}`} className="sr-only">
                        Field name
                      </label>
                      <input
                        id={`${idPrefix}-field-${field.id}`}
                        value={edit?.name ?? field.name}
                        disabled={skipped}
                        maxLength={100}
                        onChange={(e) => setField(field.id, { name: e.target.value })}
                        className={`control min-w-0 flex-1 ${skipped ? "line-through opacity-60" : ""}`}
                      />
                      <SkipToggle skipped={skipped} what={`field ${field.name}`} onToggle={() => setField(field.id, { skip: !skipped })} />
                    </li>
                  );
                })}
              </ul>
              <p className="mt-1 text-xs text-zinc-500">Automations or forms that need a field you leave out are left out too.</p>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SkipToggle({ skipped, what, onToggle }: { skipped: boolean; what: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={skipped ? `Keep ${what}` : `Leave out ${what}`}
      data-tooltip={skipped ? "Keep" : "Leave out"}
      className="btn-icon"
    >
      {skipped ? <Undo2 className="size-3.5" /> : <X className="size-3.5" />}
    </button>
  );
}
