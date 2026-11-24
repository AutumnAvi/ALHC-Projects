"use client";

import { patchedAction } from "@/lib/patched-writes";
import { useLayoutEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { MentionText } from "@/components/task/comment-parts";
import { MentionTextarea } from "@/components/task/mention-textarea";
import { useServerAction } from "@/components/toast";
import { updateTask } from "@/lib/actions/tasks";
import { appLinkSegments } from "@alhc/core/app-links";
import type { TaskDetail } from "@alhc/core/api/task-pane/model";
import { PANE_HEADING } from "./pane-styles";
import { DictationBar, TalkButton } from "@/components/dictation-button";
import { useDictation } from "@/lib/dictation";

const EMPTY_REFS = { tasks: {}, projects: {} };

const EDIT_CLASS =
  "-mx-2 mt-1 field-sizing-content min-h-16 w-[calc(100%+1rem)] resize-none rounded-md border border-transparent bg-transparent px-2 py-1.5 text-sm leading-relaxed text-zinc-800 placeholder:text-zinc-500 hover:border-zinc-200 focus:border-accent-500/60 focus:bg-white focus:shadow-[0_0_0_3px_var(--focus-ring)] focus:outline-none";

function hasAppLinks(text: string) {
  return appLinkSegments(text).some((segment) => segment.type === "link");
}

// The pane's Description. Nov 3 notes (batch 18, 133): "#" links a task or project (like comments; no
// @people here — a description notifies nobody), and links show as chips with the name while the
// description isn't being edited (click it, or Edit, to change the text). Saved on blur as before.
// Batch 45: the section's heading lives here too, with Talk (dictation) at its right end (mockups 01–02).
// Talk opens the box for editing and the words land at the cursor; the box saves when the dictation ends
// with the box no longer focused (clicking Stop moves focus out of it), else on blur as usual.
export function TaskDescription({ task, canEdit }: { task: TaskDetail; canEdit: boolean }) {
  const [, run] = useServerAction();
  const saved = task.notes ?? "";
  const [draft, setDraftState] = useState(saved);
  // The newest text, also between renders (dictation's last words land right before it ends).
  const latest = useRef(saved);
  const [base, setBase] = useState(saved);
  const [editing, setEditing] = useState(false);
  useLayoutEffect(() => {
    latest.current = draft;
  }, [draft]);
  function setDraft(value: string) {
    latest.current = value;
    setDraftState(value);
  }
  // A newer save (or someone else's) arrives while the box isn't being edited: show it.
  if (saved !== base && !editing) {
    setBase(saved);
    setDraftState(saved);
  }
  const refs = task.commentRefs ?? EMPTY_REFS;

  function save(notes: string) {
    if (notes.trim() !== saved.trim()) run(patchedAction("notes", (screenOnly) => updateTask(task.id, { notes }, screenOnly)));
  }

  const talk = useDictation({
    onEnd: () => {
      if (document.activeElement?.id === "task-notes") return;
      setEditing(false);
      save(latest.current);
    },
  });

  function startTalk() {
    setEditing(true);
    // The box may be the chip view right now: start once it's the text box (next frame).
    requestAnimationFrame(() => talk.start());
  }

  const heading = (
    <div className="flex min-h-6 items-center justify-between gap-2">
      <h3 id="task-notes-heading" className={PANE_HEADING}>
        <label htmlFor="task-notes">Description</label>
      </h3>
      {canEdit ? (
        talk.listening ? (
          <DictationBar dictation={talk} compact />
        ) : (
          <TalkButton dictation={talk} onStart={startTalk} label="Dictate the description" />
        )
      ) : null}
    </div>
  );

  if (!canEdit) {
    return (
      <>
        {heading}
        {saved ? (
          <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-zinc-800">
            <MentionText body={saved} people={[]} refs={refs} />
          </p>
        ) : (
          <p className="mt-1 text-sm text-zinc-500">No description.</p>
        )}
      </>
    );
  }

  if (!editing && hasAppLinks(draft)) {
    return (
      <>
        {heading}
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
      </>
    );
  }

  return (
    <>
      {heading}
      <MentionTextarea
        id="task-notes"
        value={draft}
        onValueChange={setDraft}
        candidates={[]}
        people={false}
        links
        autoFocus={editing && !talk.listening}
        onFocus={() => setEditing(true)}
        linkRefs={refs}
        dictation={talk}
        onBlur={() => {
          // Dictating (Stop or Cancel was clicked, or focus left on purpose): the session's end saves.
          if (talk.listening) return;
          // The draft (the body with its links), not the box's own text, which shows links as chips.
          setEditing(false);
          save(latest.current);
        }}
        placeholder="What is this task about? Add details or context. Type # to link a task or project."
        // Borderless until hovered or focused, like Asana's description.
        className={EDIT_CLASS}
      />
    </>
  );
}
