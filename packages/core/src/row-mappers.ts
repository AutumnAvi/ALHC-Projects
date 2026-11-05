// Pure row → app-type mappers shared by the per-table reads in data.ts and the batch 22 screen loaders
// (screen-loaders.ts), so a row means the same thing whichever way it was read. No server-only imports:
// the unit tests use these too.
import { parseOptions, type FieldDef, type FieldType } from "./fields";
import { parseQuestions, type FormDef } from "./forms";
import { templateFromPrefix, type TaskNumbering } from "./request-numbers";
import type { Tables } from "./supabase/database.types";
import { parseSubtaskTitles } from "./templates";
import { isViewLayout, parseViewConfig, type ProjectView } from "./views";

export type TaskTemplate = {
  id: string;
  projectId: string;
  name: string;
  title: string;
  notes: string | null;
  subtasks: string[];
  fieldValueCount: number;
  assigneeId: string | null;
  updatedAt: string;
};

export type TaskTemplateRow = Pick<
  Tables<"task_templates">,
  "id" | "project_id" | "name" | "title" | "notes" | "subtasks" | "field_values" | "assignee_id" | "updated_at"
>;


export function toFieldDef(row: Tables<"custom_fields">): FieldDef {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    fieldType: row.field_type as FieldType,
    options: parseOptions(row.options),
    boundToSections: row.bound_to_sections,
    showInViews: row.show_in_views,
    sortOrder: row.sort_order,
    description: row.description ?? null,
    notifyOnChange: row.notify_on_change ?? false,
    inLibrary: row.in_library ?? false,
    numberPrefix: row.number_prefix ?? null,
    libraryFieldId: row.library_field_id ?? null,
    locked: row.locked ?? false,
    lockedBy: row.locked_by ?? null,
    lockedAt: row.locked_at ?? null,
  };
}

export function numberingFromRow(row: {
  enabled: boolean;
  prefix: string;
  pad_width: number;
  add_to_title: boolean;
  assign_to: string;
  last_number: number;
  template?: string;
  wrap_brackets?: boolean;
  number_subtasks?: boolean;
  subtask_separator?: string;
  number_scope?: string;
  section_ids?: string[] | null;
  task_kinds?: string[] | null;
  reuse_deleted?: boolean;
  fill_gaps?: boolean;
  reset_period?: string;
  counter_field_id?: string | null;
  project_code?: string | null;
  renumber_on_move?: boolean;
  time_zone?: string;
  start_number?: number;
  advanced: boolean;
}): TaskNumbering {
  const scope = row.number_scope === "sections" || row.number_scope === "kinds" || row.number_scope === "form_submissions" || row.number_scope === "all_tasks"
    ? row.number_scope
    : row.assign_to === "form_submissions"
      ? "form_submissions"
      : "all_tasks";
  const separator = row.subtask_separator === "-" || row.subtask_separator === "/" ? row.subtask_separator : ".";
  const reset = row.reset_period === "yearly" || row.reset_period === "monthly" ? row.reset_period : "never";
  const kinds = (row.task_kinds ?? []).filter((k): k is "task" | "milestone" | "approval" => k === "task" || k === "milestone" || k === "approval");
  return {
    enabled: row.enabled,
    template: row.template || templateFromPrefix(row.prefix, row.pad_width),
    wrapBrackets: row.wrap_brackets !== false,
    addToTitle: row.add_to_title,
    numberScope: scope,
    sectionIds: row.section_ids ?? [],
    taskKinds: kinds.length ? kinds : ["task", "milestone", "approval"],
    numberSubtasks: row.number_subtasks !== false,
    subtaskSeparator: separator,
    reuseDeleted: row.reuse_deleted === true,
    fillGaps: row.fill_gaps === true,
    resetPeriod: reset,
    counterFieldId: row.counter_field_id ?? null,
    projectCode: row.project_code ?? "",
    renumberOnMove: row.renumber_on_move === true,
    timeZone: row.time_zone || "UTC",
    nextNumber: row.last_number + 1,
    lastNumber: row.last_number,
    startNumber: Math.max(1, Number(row.start_number ?? 1) || 1),
    advanced: row.advanced,
  };
}

export function toProjectView(row: Tables<"project_views">): ProjectView {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    layout: isViewLayout(row.layout) ? row.layout : "list",
    config: parseViewConfig(row.config),
    sortOrder: row.sort_order,
    ownerId: row.owner_id ?? null,
  };
}

export function toTaskTemplate(t: TaskTemplateRow): TaskTemplate {
  return {
    id: t.id,
    projectId: t.project_id,
    name: t.name,
    title: t.title,
    notes: t.notes,
    subtasks: parseSubtaskTitles(t.subtasks),
    fieldValueCount: Array.isArray(t.field_values) ? t.field_values.length : 0,
    assigneeId: t.assignee_id,
    updatedAt: t.updated_at,
  };
}

export function toFormDef(row: Tables<"forms">): FormDef {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    questions: parseQuestions(row.questions),
    destinationSectionId: row.destination_section_id,
    acceptingResponses: row.accepting_responses,
    sendConfirmation: row.send_confirmation,
    confirmationMessage: row.confirmation_message,
    verifiedDomainsOnly: row.verified_domains_only ?? false,
  };
}
