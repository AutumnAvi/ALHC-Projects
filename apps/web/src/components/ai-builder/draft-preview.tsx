"use client";

// AI builder round 2 (note 168): the draft drawn with the app's real List and Board views (not a form),
// over the draft's in-memory data source. The views behave as on a project an Editor opens — rename in
// place, drag tasks and sections, pick assignees, dates, and values, add tasks and sections — and a row or
// card opens the draft's task editor. Nothing here reaches the server.
import { useMemo, useState } from "react";
import { AI_BUILDER_LIMITS } from "@alhc/core/ai-builder";
import { draftView, type AiDraft, type DraftEdit, type DraftPerson } from "@alhc/core/ai-builder-draft";
import { fieldRef, type ViewConfig } from "@alhc/core/views";
import { BoardView } from "@/components/project/board-view";
import { ListView } from "@/components/project/list-view";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { ProjectDataSourceProvider } from "@/components/project/project-data-source";
import { Segmented } from "@/components/project/view-chrome";
import { TaskOpenOverride } from "@/components/task/task-link";
import { useDraftSource } from "./draft-data-source";
import { DraftFieldDialog, DraftTaskDialog } from "./draft-editors";

export type PreviewLayout = "list" | "board";

const LAYOUTS = [
  { value: "list", label: "List" },
  { value: "board", label: "Board" },
] as const;

export function DraftPreview({
  draftKey,
  draft,
  setDraft,
  today,
  members,
}: {
  draftKey: string;
  draft: AiDraft;
  setDraft: (draft: AiDraft) => void;
  today: string;
  members: readonly DraftPerson[];
}) {
  const [layout, setLayout] = useState<PreviewLayout>("list");
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [field, setField] = useState<{ id: string | null } | null>(null);
  const source = useDraftSource({
    draft,
    setDraft,
    today,
    hooks: {
      // A subtask opens its task (a draft's subtasks only have a name).
      openTask: (id) => setOpenTaskId(draft.tasks.some((t) => t.id === id) ? id : (draft.tasks.find((t) => t.subtasks.some((s) => s.id === id))?.id ?? null)),
      addField: () => setField({ id: null }),
      editField: (id) => setField({ id }),
    },
  });
  const view = useMemo(() => draftView(draft, { key: draftKey, today, members }), [draft, draftKey, today, members]);
  const config: ViewConfig = useMemo(
    () => ({
      columns: ["assignee", "start", "due", ...view.fields.map((f) => fieldRef(f.id))],
      show_subtasks: true,
    }),
    [view.fields],
  );
  // The editors apply an edit and answer its problem (or null).
  const change = (edit: (d: AiDraft) => DraftEdit) => {
    const res = edit(draft);
    if (!res.ok) return res.error;
    setDraft(res.draft);
    return null;
  };

  return (
    <section aria-label="Draft project preview" className="flex min-h-0 flex-col rounded-lg border border-zinc-200 bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-2">
        <Segmented label="Preview layout" options={LAYOUTS} value={layout} onChange={setLayout} />
        <span className="text-2xs text-zinc-500">
          Click any name to rename it, drag to reorder, pick assignees, dates, and values in place, or open a task for its details.
        </span>
        {draft.fields.length < AI_BUILDER_LIMITS.fieldsMax ? (
          <button type="button" className="btn-ghost ml-auto h-7 px-2" onClick={() => setField({ id: null })}>
            Add field
          </button>
        ) : null}
      </div>
      <div className={layout === "board" ? "h-[34rem] min-h-0 overflow-auto" : "max-h-[34rem] min-h-0 overflow-auto"}>
        <ProjectAccessProvider role="editor">
          <ProjectDataSourceProvider value={source}>
            <TaskOpenOverride.Provider value={(id) => source.draft?.openTask(id)}>
              {layout === "list" ? (
                <ListView
                  key={`${draftKey}:list`}
                  projectId={view.projectId}
                  projectName={draft.name}
                  sections={view.sections}
                  tasks={view.tasks}
                  profiles={view.profiles}
                  fields={view.fields}
                  config={config}
                  tags={[]}
                  subtasks={view.subtasks}
                  sectionTaskCounts={view.sectionTaskCounts}
                />
              ) : (
                <BoardView
                  key={`${draftKey}:board`}
                  projectId={view.projectId}
                  projectName={draft.name}
                  sections={view.sections}
                  tasks={view.tasks}
                  profiles={view.profiles}
                  fields={view.fields}
                  config={config}
                  tags={[]}
                  sectionTaskCounts={view.sectionTaskCounts}
                />
              )}
            </TaskOpenOverride.Provider>
          </ProjectDataSourceProvider>
        </ProjectAccessProvider>
      </div>
      {openTaskId ? (
        <DraftTaskDialog draft={draft} taskId={openTaskId} today={today} members={members} change={change} onClose={() => setOpenTaskId(null)} />
      ) : null}
      {field ? <DraftFieldDialog draft={draft} fieldId={field.id} change={change} onClose={() => setField(null)} /> : null}
    </section>
  );
}
