"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Keyboard, X } from "lucide-react";
import { isMac, isTypingTarget } from "./keyboard";

type Shortcut = { keys: string[]; label: string };

function groups(mod: string): { title: string; note?: string; items: Shortcut[] }[] {
  return [
    {
      title: "Anywhere",
      items: [
        { keys: ["?"], label: "Show or hide these shortcuts" },
        { keys: ["/"], label: "Search tasks" },
      ],
    },
    {
      title: "List views and My Tasks",
      items: [
        { keys: ["↑", "↓"], label: "Move to the previous or next task" },
        { keys: ["click"], label: "Open a task (the checkbox on the left selects it)" },
        { keys: ["Shift", "checkbox"], label: "Select a range" },
        { keys: ["Enter"], label: "Open the task under the cursor" },
        { keys: ["Esc"], label: "Close the task, or clear the selection" },
        { keys: [mod, "Enter"], label: "Complete the selected tasks, else the open or cursor task" },
        { keys: ["Tab", "then", "Q"], label: "Quick-add a task in the current section (List)" },
        { keys: ["Tab", "then", "M"], label: "Assign the selected tasks to me" },
      ],
    },
  ];
}

// Global shortcuts: `?` toggles the help overlay and `/` jumps to search. Neither fires while typing.
export function KeyboardShortcuts() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mod, setMod] = useState("Ctrl");
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.key === "?") {
        e.preventDefault();
        setMod(isMac() ? "⌘" : "Ctrl");
        setOpen((o) => {
          if (!o) returnFocus.current = document.activeElement as HTMLElement | null;
          return !o;
        });
      } else if (e.key === "/" && !document.querySelector("[role='dialog'], [role='alertdialog']")) {
        e.preventDefault();
        const input = document.getElementById("sidebar-search") as HTMLInputElement | null;
        if (input && input.offsetParent !== null) {
          input.focus();
          input.select();
        } else {
          router.push("/search");
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      returnFocus.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/30 p-4" onMouseDown={() => setOpen(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onMouseDown={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-zinc-200 bg-white p-5 text-sm shadow-xl"
      >
        <div className="flex items-center gap-2">
          <Keyboard className="size-5 text-accent-600" aria-hidden />
          <h2 id="shortcuts-title" className="flex-1 font-semibold text-zinc-900">
            Keyboard shortcuts
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close shortcuts"
            className="btn-icon"
          >
            <X className="size-4" />
          </button>
        </div>
        <p className="mt-1 text-xs text-zinc-500">Shortcuts don’t fire while you’re typing in a field.</p>
        {groups(mod).map((group) => (
          <section key={group.title} className="mt-4">
            <h3 className="text-2xs font-semibold uppercase tracking-wider text-zinc-400">{group.title}</h3>
            <dl className="mt-1.5 divide-y divide-zinc-100">
              {group.items.map((item) => (
                <div key={item.label} className="flex items-center justify-between gap-4 py-1.5">
                  <dt className="text-zinc-700">{item.label}</dt>
                  <dd className="flex shrink-0 items-center gap-1">
                    {item.keys.map((key) =>
                      key === "then" || key === "click" ? (
                        <span key={key} className="text-xs text-zinc-500">
                          {key}
                        </span>
                      ) : (
                        <kbd
                          key={key}
                          className="rounded border border-zinc-300 bg-zinc-50 px-1.5 py-0.5 font-sans text-xs text-zinc-700"
                        >
                          {key}
                        </kbd>
                      ),
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}
