"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type Ref, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { Lock, X } from "lucide-react";
import { useConfirm } from "@/components/confirm";
import { LOCKED_FIELD_NOTE } from "@/lib/fields";
import { FOCUSABLE_SELECTOR, trappedTabTarget } from "@/lib/focus-trap";
import {
  initialDraft,
  isSaveShortcut,
  lengthCounter,
  longTextDraft,
  saveLongText,
  textLength,
  type LongTextDraft,
} from "@/lib/long-text";

// Oct 29 notes, batch 7, item 48: the pop-out editor for a text custom field, opened from a List cell and
// from the task pane's field row. A large box that grows with the text (then scrolls), a character count
// against the 10,000 limit, Save / Cancel. ⌘/Ctrl+Enter saves, a plain Enter is a new line, Escape (or
// a click outside, or ✕) cancels — and asks first when something was typed. People who can't edit the
// field get the same window with the whole text to read (with the lock's note when the field is locked —
// item 51).
//
// It is drawn on <body> (a List row hides off-screen content, and the full-screen pane sits at z-50), and
// keeps its clicks, keys, and drags from reaching the row or the page it was opened from. Tab and
// Shift+Tab stay inside it (the page behind can't be reached while it's open).
//
// Save waits for the server: the window stays open ("Saving…") until the value is stored, and a save
// that's refused or fails (the field was locked meanwhile, a role change, a dropped connection) keeps
// everything typed, with the reason above the buttons.
export function LongTextEditor({
  fieldName,
  taskTitle,
  value,
  readOnly = false,
  locked = false,
  onSave,
  onClose,
}: {
  fieldName: string;
  taskTitle: string;
  // The stored value (a string, or nothing) when the editor opens.
  value: unknown;
  readOnly?: boolean;
  // The field is locked (item 51): a read-only view says why.
  locked?: boolean;
  // Only called when Save changes the value: the trimmed text, or null to clear the field. Its result
  // (useServerAction's run) decides whether the window closes: an error keeps it open with the draft.
  onSave: (next: string | null) => void | Promise<{ error?: string } | void>;
  onClose: () => void;
}) {
  const confirm = useConfirm();
  // The value as it was when the editor opened: what "changed" means, even if a refresh brings someone
  // else's edit meanwhile (an untouched draft then saves nothing and leaves their edit alone).
  const [opened] = useState(() => value);
  const [draft, setDraft] = useState(() => initialDraft(value));
  const state = longTextDraft(draft, opened);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // While the "Discard your changes?" question is open, the editor ignores its own Escape and outside clicks.
  const asking = useRef(false);
  const openedAt = useRef(0);

  const dismiss = async () => {
    // While a save is on its way the window waits for it (it closes itself, or shows why it couldn't).
    if (asking.current || saving) return;
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
  const save = async () => {
    if (readOnly || !state.canSave || saving) return;
    setSaving(true);
    setSaveError(null);
    const outcome = await saveLongText(state, onSave);
    if (outcome.close) {
      onClose();
      return;
    }
    // Refused or failed: everything typed is still here, with the reason.
    setSaving(false);
    setSaveError(outcome.error);
    textareaRef.current?.focus();
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
      if (e.isComposing || e.defaultPrevented) return;
      // The confirm question answers its own keys.
      if (document.querySelector("[data-confirm-dialog]")) return;
      if (e.key === "Tab") {
        // Tab stays in this window: from the last control back to the first, and into it from behind.
        const dialog = dialogRef.current;
        if (!dialog) return;
        const controls = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
        const target = trappedTabTarget(controls.length, controls.indexOf(document.activeElement as HTMLElement), e.shiftKey);
        if (target === null) return;
        e.preventDefault();
        controls[target].focus();
        return;
      }
      if (e.key !== "Escape") return;
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
      locked={locked}
      draft={draft}
      state={state}
      saving={saving}
      saveError={saveError}
      dialogRef={dialogRef}
      textareaRef={textareaRef}
      textRef={textRef}
      onDraftChange={(next) => {
        setDraft(next);
        setSaveError(null);
      }}
      onSave={() => void save()}
      onCancel={() => {
        if (!saving) onClose();
      }}
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
  locked = false,
  draft,
  state,
  saving = false,
  saveError = null,
  dialogRef,
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
  locked?: boolean;
  draft: string;
  state: LongTextDraft;
  // The save is on its way: Save reads "Saving…", nothing can be changed or closed until it's back.
  saving?: boolean;
  // Why the last save didn't go through (the draft is kept).
  saveError?: string | null;
  dialogRef?: Ref<HTMLDivElement>;
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
  const errorId = useId();
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
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={taskId}
        aria-busy={saving || undefined}
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
            {readOnly && locked ? (
              <p data-locked-note="" className="mt-1 flex items-center gap-1 text-xs text-zinc-500">
                <Lock className="size-3 shrink-0 text-zinc-400" aria-hidden />
                {LOCKED_FIELD_NOTE}.
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onCloseButton}
            disabled={saving}
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
              readOnly={saving}
              aria-labelledby={titleId}
              aria-describedby={`${taskId} ${countId} ${hintId}${saveError ? ` ${errorId}` : ""}`}
              aria-invalid={state.over > 0 ? true : undefined}
              onChange={(e) => onDraftChange(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              className={`field field-sizing-content block h-auto max-h-[60vh] min-h-40 w-full resize-none py-2 leading-relaxed ${
                state.over > 0 ? "border-red-300 focus:border-red-400" : ""
              }`}
            />
          )}
        </div>

        {saveError && !readOnly ? (
          <p
            id={errorId}
            role="alert"
            data-save-error=""
            className="mx-5 mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800"
          >
            {saveError} Your text is still here.
          </p>
        ) : null}

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
                <button type="button" onClick={onCancel} disabled={saving} className="btn-secondary">
                  Cancel
                </button>
                <button type="button" onClick={onSave} disabled={!state.canSave || saving} className="btn-primary">
                  {saving ? "Saving…" : "Save"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
