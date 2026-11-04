"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { MentionText } from "@/components/task/comment-parts";
import { MentionTextarea } from "@/components/task/mention-textarea";
import { useServerAction } from "@/components/toast";
import { updateTask } from "@/lib/actions";
import { appLinkSegments } from "@/lib/app-links";
import type { TaskDetail } from "@/lib/data";

const EMPTY_REFS = { tasks: {}, projects: {} };

const EDIT_CLASS =
  "-mx-2 mt-1 field-sizing-content min-h-16 w-[calc(100%+1rem)] resize-none rounded-md border border-transparent bg-transparent px-2 py-1.5 text-sm leading-relaxed text-zinc-800 placeholder:text-zinc-500 hover:border-zinc-200 focus:border-accent-500/60 focus:bg-white focus:shadow-[0_0_0_3px_var(--focus-ring)] focus:outline-none";

function hasAppLinks(text: string) {
  return appLinkSegments(text).some((segment) => segment.type === "link");
}

// The pane's Description. Nov 3 notes (batch 18, 133): "#" links a task or project (like comments; no
// @people here — a description notifies nobody), and links show as chips with the name while the
// description isn't being edited (click it, or Edit, to change the text). Saved on blur as before.
export function TaskDescription({ task, canEdit }: { task: TaskDetail; canEdit: boolean }) {
  const [, run] = useServerAction();
  const saved = task.notes ?? "";
  const [draft, setDraft] = useState(saved);
  const [base, setBase] = useState(saved);
  const [editing, setEditing] = useState(false);
  // A newer save (or someone else's) arrives while the box isn't being edited: show it.
  if (saved !== base && !editing) {
    setBase(saved);
    setDraft(saved);
  }
  const refs = task.commentRefs ?? EMPTY_REFS;

  if (!canEdit) {
    return saved ? (
      <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-zinc-800">
        <MentionText body={saved} people={[]} refs={refs} />
      </p>
    ) : (
      <p className="mt-1 text-sm text-zinc-500">No description.</p>
    );
  }

  if (!editing && hasAppLinks(draft)) {
    return (
      <div className="group/desc relative -mx-2 mt-1 rounded-md border border-transparent px-2 py-1.5 hover:border-zinc-200">
        <p
          className="cursor-text whitespace-pre-wrap text-sm leading-relaxed text-zinc-800"
          onClick={(e) => {
            // A chip opens its task or project; anywhere else starts editing.
            if ((e.target as HTMLElement).closest("a,button")) return;
            setEditing(true);
          }}
        >
          <MentionText body={draft} people={[]} refs={refs} />
        </p>
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label="Edit description"
          data-tooltip="Edit description"
          className="btn-icon absolute right-1 top-1 opacity-0 group-hover/desc:opacity-100 focus-visible:opacity-100"
        >
          <Pencil className="size-3.5" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <MentionTextarea
      id="task-notes"
      value={draft}
      onValueChange={setDraft}
      candidates={[]}
      people={false}
      links
      autoFocus={editing}
      onFocus={() => setEditing(true)}
      linkRefs={refs}
      onBlur={() => {
        // The draft (the body with its links), not the box's own text, which shows links as chips.
        const notes = draft;
        setEditing(false);
        if (notes.trim() !== saved.trim()) run(() => updateTask(task.id, { notes }));
      }}
      placeholder="What is this task about? Add details or context. Type # to link a task or project."
      // Borderless until hovered or focused, like Asana's description.
      className={EDIT_CLASS}
    />
  );
}
