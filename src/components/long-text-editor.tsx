"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type Ref, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useConfirm } from "@/components/confirm";
import { initialDraft, isSaveShortcut, lengthCounter, longTextDraft, textLength, type LongTextDraft } from "@/lib/long-text";

// Oct 29 notes, batch 7, item 48: the pop-out editor for a text custom field, opened from a List cell and
// from the task pane's field row. A large box that grows with the text (then scrolls), a character count
// against the 10,000 limit, Save / Cancel. ⌘/Ctrl+Enter saves, a plain Enter is a new line, Escape (or
// a click outside, or ✕) cancels — and asks first when something was typed. People who can't edit the
// field get the same window with the whole text to read.
//
// It is drawn on <body> (a List row hides off-screen content, and the full-screen pane sits at z-50), and
// keeps its clicks, keys, and drags from reaching the row or the page it was opened from.
export function LongTextEditor({
  fieldName,
  taskTitle,
  value,
  readOnly = false,
  onSave,
  onClose,
}: {
  fieldName: string;
  taskTitle: string;
  // The stored value (a string, or nothing) when the editor opens.
  value: unknown;
  readOnly?: boolean;
  // Only called when Save changes the value: the trimmed text, or null to clear the field.
  onSave: (next: string | null) => void;
  onClose: () => void;
}) {
  const confirm = useConfirm();
  // The value as it was when the editor opened: what "changed" means, even if a refresh brings someone
  // else's edit meanwhile (an untouched draft then saves nothing and leaves their edit alone).
  const [opened] = useState(() => value);
  const [draft, setDraft] = useState(() => initialDraft(value));
  const state = longTextDraft(draft, opened);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  // While the "Discard your changes?" question is open, the editor ignores its own Escape and outside clicks.
  const asking = useRef(false);
  const openedAt = useRef(0);

  const dismiss = async () => {
    if (asking.current) return;
    if (readOnly || !state.dirty) {
      onClose();
      return;
    }
    asking.current = true;
    const discard = await confirm({
      title: "Discard your changes?",
      message: `What you typed in ${fieldName} won’t be saved.`,
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      tone: "danger",
    });
    asking.current = false;
    if (discard) onClose();
    else textareaRef.current?.focus();
  };
  const save = () => {
    if (readOnly || !state.canSave) return;
    onClose();
    if (state.changed) onSave(state.next);
  };

  // The window listener below always calls the latest dismiss.
  const dismissRef = useRef(dismiss);
  useEffect(() => {
    dismissRef.current = dismiss;
  });

  useEffect(() => {
    openedAt.current = performance.now();
    const returnFocus = document.activeElement as HTMLElement | null;
    const box = textareaRef.current;
    if (box) {
      // The caret goes after the text (select-all would let one keystroke wipe a long value).
      const end = box.value.length;
      box.focus();
      box.setSelectionRange(end, end);
    } else {
      // Reading: the text itself takes the focus, so the arrow keys scroll it.
      textRef.current?.focus();
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
      // The confirm question answers its own Escape.
      if (document.querySelector("[data-confirm-dialog]")) return;
      // Escape belongs to this window only, not to the pane or the List under it.
      e.preventDefault();
      e.stopImmediatePropagation();
      void dismissRef.current();
    }
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      returnFocus?.focus?.();
    };
  }, []);

  return createPortal(
    <LongTextEditorView
      fieldName={fieldName}
      taskTitle={taskTitle}
      readOnly={readOnly}
      draft={draft}
      state={state}
      textareaRef={textareaRef}
      textRef={textRef}
      onDraftChange={setDraft}
      onSave={save}
      onCancel={onClose}
      onDismiss={() => {
        // The second click of a double-click that opened the editor lands outside it: ignore it.
        if (performance.now() - openedAt.current < 350) return;
        void dismiss();
      }}
      onCloseButton={() => void dismiss()}
    />,
    document.body,
  );
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

// The window itself (no state of its own; LongTextEditor drives it).
export function LongTextEditorView({
  fieldName,
  taskTitle,
  readOnly,
  draft,
  state,
  textareaRef,
  textRef,
  onDraftChange,
  onSave,
  onCancel,
  onDismiss,
  onCloseButton,
}: {
  fieldName: string;
  taskTitle: string;
  readOnly: boolean;
  draft: string;
  state: LongTextDraft;
  textareaRef?: Ref<HTMLTextAreaElement>;
  textRef?: Ref<HTMLDivElement>;
  onDraftChange: (draft: string) => void;
  onSave: () => void;
  // Cancel: closes without asking (the button says what it does).
  onCancel: () => void;
  // A click outside: closes, asking first when something was typed.
  onDismiss: () => void;
  // ✕: the same as a click outside.
  onCloseButton: () => void;
}) {
  const titleId = useId();
  const taskId = useId();
  const countId = useId();
  const hintId = useId();
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (isSaveShortcut(e)) {
      e.preventDefault();
      onSave();
    }
  };
  return (
    <div
      data-long-text-editor=""
      className="fixed inset-0 z-[70] flex items-center justify-center bg-zinc-900/30 p-4"
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onDismiss();
      }}
      // Nothing in here belongs to the row or page that opened it (React passes events up through portals).
      onClick={stop}
      onDoubleClick={stop}
      onKeyDown={stop}
      onDragStart={stop}
      onDragEnter={stop}
      onDragOver={stop}
      onDragLeave={stop}
      onDrop={stop}
      onDragEnd={stop}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={taskId}
        className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-zinc-200 bg-white text-sm shadow-xl"
      >
        <div className="flex items-start gap-2 px-5 pt-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-base font-semibold text-zinc-900">
              {fieldName}
            </h2>
            <p id={taskId} className="mt-0.5 truncate text-xs text-zinc-500">
              {readOnly ? "View only · " : ""}“{taskTitle}”
            </p>
          </div>
          <button
            type="button"
            onClick={onCloseButton}
            aria-label="Close"
            data-tooltip="Close"
            className="btn-icon -mr-1 -mt-0.5"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 px-5 pt-3">
          {readOnly ? (
            <div
              ref={textRef}
              role="region"
              aria-label={`${fieldName} text`}
              tabIndex={0}
              className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm leading-relaxed text-zinc-800 focus-visible:outline-2 focus-visible:outline-accent-500"
            >
              {draft}
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              value={draft}
              rows={8}
              spellCheck
              aria-labelledby={titleId}
              aria-describedby={`${taskId} ${countId} ${hintId}`}
              aria-invalid={state.over > 0 ? true : undefined}
              onChange={(e) => onDraftChange(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              className={`field field-sizing-content block h-auto max-h-[60vh] min-h-40 w-full resize-none py-2 leading-relaxed ${
                state.over > 0 ? "border-red-300 focus:border-red-400" : ""
              }`}
            />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 pb-4 pt-3">
          {readOnly ? (
            <p className="text-xs tabular-nums text-zinc-500">
              {textLength(draft).toLocaleString("en-US")} {textLength(draft) === 1 ? "character" : "characters"}
            </p>
          ) : (
            <>
              <p
                id={countId}
                data-over={state.over > 0 ? "" : undefined}
                className={`text-xs tabular-nums ${state.over > 0 ? "font-medium text-red-700" : "text-zinc-500"}`}
              >
                {lengthCounter(state.count)} characters
              </p>
              <p id={hintId} aria-live="polite" className={`text-xs ${state.over > 0 ? "text-red-700" : "text-zinc-400"}`}>
                {state.over > 0
                  ? `Shorten it by ${state.over.toLocaleString("en-US")} ${state.over === 1 ? "character" : "characters"} to save.`
                  : "⌘/Ctrl+Enter to save"}
              </p>
            </>
          )}
          <div className="ml-auto flex gap-2">
            {readOnly ? (
              <button type="button" onClick={onCancel} className="btn-secondary">
                Close
              </button>
            ) : (
              <>
                <button type="button" onClick={onCancel} className="btn-secondary">
                  Cancel
                </button>
                <button type="button" onClick={onSave} disabled={!state.canSave} className="btn-primary">
                  Save
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
