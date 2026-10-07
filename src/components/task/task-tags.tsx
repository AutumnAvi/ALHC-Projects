"use client";

import { useMemo, useOptimistic, useState } from "react";
import { Plus } from "lucide-react";
import { Popover } from "@/components/popover";
import { TagChip } from "@/components/tags/tag-chip";
import { useServerAction } from "@/components/toast";
import { addNewTaskTag, addTaskTag, removeTaskTag } from "@/lib/actions";
import { MAX_TAG_NAME, addableTags, tagsFor, type Tag } from "@/lib/tags";

// The pane's Tags row: chips (× removes) and a picker that searches workspace tags and can create one.
// Editors+ only; the database decides (task_tags RLS follows the task, subtasks through their root).
export function TaskTags({ taskId, tagIds, tags, canEdit }: { taskId: string; tagIds: string[]; tags: Tag[]; canEdit: boolean }) {
  const [, run] = useServerAction();
  const byId = useMemo(() => new Map(tags.map((t) => [t.id, t] as const)), [tags]);
  const [ids, setIds] = useOptimistic(tagIds);
  const [query, setQuery] = useState("");
  const current = tagsFor(ids, byId);
  const trimmed = query.trim();
  const candidates = addableTags(tags)
    .filter((t) => !ids.includes(t.id))
    .filter((t) => !trimmed || t.name.toLowerCase().includes(trimmed.toLowerCase()))
    .slice(0, 50);
  const exact = tags.some((t) => t.name.toLowerCase() === trimmed.toLowerCase());

  function add(tagId: string) {
    run(
      () => addTaskTag(taskId, tagId),
      () => setIds([...ids, tagId]),
    );
  }
  function remove(tagId: string) {
    run(
      () => removeTaskTag(taskId, tagId),
      () => setIds(ids.filter((t) => t !== tagId)),
    );
  }

  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1 px-2 py-1">
      {current.map((t) => (
        <TagChip key={t.id} tag={t} onRemove={canEdit ? () => remove(t.id) : undefined} />
      ))}
      {current.length === 0 && !canEdit ? <span className="text-zinc-400">No tags</span> : null}
      {canEdit ? (
        <Popover
          label="Add a tag"
          buttonClassName="btn-ghost h-6 px-1.5 text-xs"
          button={
            <>
              <Plus className="size-3.5" aria-hidden />
              {current.length ? <span className="sr-only">Add a tag</span> : "Add tag"}
            </>
          }
          panelClassName="w-64"
        >
          {(close) => (
            <div className="p-2">
              <label htmlFor={`tag-search-${taskId}`} className="sr-only">
                Find or create a tag
              </label>
              <input
                id={`tag-search-${taskId}`}
                autoFocus
                value={query}
                maxLength={MAX_TAG_NAME}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  const match = candidates.find((t) => t.name.toLowerCase() === trimmed.toLowerCase());
                  if (match) add(match.id);
                  else if (trimmed && !exact) run(() => addNewTaskTag(taskId, trimmed));
                  else if (candidates[0]) add(candidates[0].id);
                  else return;
                  setQuery("");
                  close();
                }}
                placeholder="Find or create a tag"
                className="control w-full"
              />
              <ul className="mt-1 max-h-60 overflow-auto" aria-label="Tags">
                {candidates.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => {
                        add(t.id);
                        setQuery("");
                        close();
                      }}
                      className="flex w-full items-center rounded px-2 py-1.5 text-left text-sm hover:bg-zinc-100"
                    >
                      <TagChip tag={t} />
                    </button>
                  </li>
                ))}
                {trimmed && !exact ? (
                  <li>
                    <button
                      type="button"
                      onClick={() => {
                        run(() => addNewTaskTag(taskId, trimmed));
                        setQuery("");
                        close();
                      }}
                      className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-sm text-accent-700 hover:bg-zinc-100"
                    >
                      <Plus className="size-3.5" aria-hidden />
                      Create tag “{trimmed}”
                    </button>
                  </li>
                ) : null}
                {!trimmed && candidates.length === 0 ? (
                  <li className="px-2 py-1.5 text-sm text-zinc-500">No more tags. Type a name to create one.</li>
                ) : null}
              </ul>
            </div>
          )}
        </Popover>
      ) : null}
    </div>
  );
}
