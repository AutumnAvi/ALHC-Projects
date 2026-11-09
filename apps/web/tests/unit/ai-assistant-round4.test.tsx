// AI builder round 4 (notes 173–176): the floating bubble's position rules, the key handlers' promise to
// leave paste / dictation / ⌘ / Ctrl / Fn / Space alone inside text fields, the assistant's layer above the
// rule canvas and the full-screen task, Tab then A there, "Edit with AI", the Expand view of an
// automation, Turn on & create, and the unsaved-canvas guard. Synthetic fixtures; no network, no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BUBBLE_MARGIN,
  BUBBLE_SIZE,
  BUBBLE_TOP_MIN,
  DRAG_THRESHOLD,
  bubbleXY,
  clampBubble,
  defaultBubblePos,
  isDrag,
  keyMove,
  panelPlacement,
  parseBubblePos,
  serializeBubblePos,
  snapBubble,
  storageKey,
  type BubblePos,
  type Viewport,
} from "@/lib/assistant-bubble";
import { LAYER_Z } from "@/lib/layers";
import { blockedByCanvas, UNSAVED_CANVAS } from "@/components/ai-assistant/assistant-store";
import { RuleReadOnly } from "@/components/rules/rule-readonly";
import type { RuleContext } from "@/components/rules/rule-shared";

const read = (rel: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../..", rel), "utf8");
const LAPTOP: Viewport = { width: 1440, height: 900 };
const PHONE: Viewport = { width: 390, height: 700 };

// ---- The bubble (note 176) ---------------------------------------------------------------------------

test("the bubble starts bottom-right, above the bulk bar and the pane's comment box, and is always on screen", () => {
  const pos = defaultBubblePos(LAPTOP);
  const xy = bubbleXY(pos, LAPTOP);
  assert.equal(pos.edge, "right");
  assert.equal(xy.x, LAPTOP.width - BUBBLE_SIZE - BUBBLE_MARGIN);
  assert.ok(LAPTOP.height - (xy.y + BUBBLE_SIZE) >= 140, "clear of the bottom 140px (bulk bar, comment box, Send)");
  for (const v of [LAPTOP, PHONE, { width: 200, height: 150 }]) {
    for (const p of [defaultBubblePos(v), { edge: "left", offset: -500 } as BubblePos, { edge: "bottom", offset: 99999 } as BubblePos, { edge: "top", offset: 40 } as BubblePos]) {
      const { x, y } = bubbleXY(p, v);
      assert.ok(x >= 0 && y >= 0 && x + BUBBLE_SIZE <= Math.max(v.width, BUBBLE_SIZE + 2 * BUBBLE_MARGIN), `${JSON.stringify(p)} in ${v.width}×${v.height}`);
      assert.ok(y >= BUBBLE_TOP_MIN || v.height < BUBBLE_TOP_MIN + BUBBLE_SIZE, "never over the top bar");
    }
  }
});

test("click vs drag: a press that moves less than the threshold is a click", () => {
  const start = { x: 100, y: 100 };
  assert.equal(isDrag(start, { x: 103, y: 102 }), false);
  assert.equal(isDrag(start, { x: 100 + DRAG_THRESHOLD, y: 100 }), true);
});

test("a drop snaps to the nearest edge; a resize re-clamps it on the same edge", () => {
  assert.equal(snapBubble({ x: 10, y: 400 }, LAPTOP).edge, "left");
  assert.equal(snapBubble({ x: 1380, y: 400 }, LAPTOP).edge, "right");
  assert.equal(snapBubble({ x: 700, y: 60 }, LAPTOP).edge, "top");
  assert.equal(snapBubble({ x: 700, y: 840 }, LAPTOP).edge, "bottom");
  const low = snapBubble({ x: 1380, y: 830 }, LAPTOP);
  const small = { width: 800, height: 500 };
  const clamped = clampBubble(low, small);
  assert.equal(clamped.edge, "right");
  const { y } = bubbleXY(clamped, small);
  assert.ok(y + BUBBLE_SIZE <= small.height - BUBBLE_MARGIN, "back inside the smaller window");
});

test("the position is remembered per person, and damaged values fall back to the default", () => {
  assert.notEqual(storageKey("a"), storageKey("b"));
  const pos: BubblePos = { edge: "left", offset: 321 };
  assert.deepEqual(parseBubblePos(serializeBubblePos(pos)), pos);
  for (const bad of [null, "", "nope", '{"edge":"middle","offset":1}', '{"edge":"left","offset":"x"}']) assert.equal(parseBubblePos(bad), null);
});

test("keyboard moves: arrows along the edge move it, across move it to that edge, Home resets; combos are never taken", () => {
  const start: BubblePos = { edge: "right", offset: 400 };
  const k = (key: string, extra: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) =>
    keyMove(start, { key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...extra }, LAPTOP);
  assert.deepEqual(k("ArrowUp"), { edge: "right", offset: 376 });
  assert.deepEqual(k("ArrowDown", { shiftKey: true }), { edge: "right", offset: 496 });
  assert.equal(k("ArrowLeft")?.edge, "left");
  assert.deepEqual(k("Home"), defaultBubblePos(LAPTOP));
  for (const key of ["Enter", " ", "a", "v", "Escape", "Tab"]) assert.equal(k(key), null, key);
  assert.equal(k("ArrowUp", { metaKey: true }), null);
  assert.equal(k("ArrowUp", { ctrlKey: true }), null);
  assert.equal(k("ArrowUp", { altKey: true }), null);
});

test("the panel opens next to the bubble and stays on screen (flips when there's no room above)", () => {
  for (const v of [LAPTOP, PHONE]) {
    for (const pos of [defaultBubblePos(v), { edge: "left", offset: 70 } as BubblePos, { edge: "top", offset: 300 } as BubblePos, { edge: "bottom", offset: 10 } as BubblePos]) {
      const p = panelPlacement(pos, v);
      assert.ok(p.left >= 0 && p.left + p.width <= v.width, `x ${JSON.stringify(pos)}`);
      const top = "top" in p ? p.top : v.height - p.bottom - p.maxHeight;
      assert.ok(top >= 0 && top + p.maxHeight <= v.height + 1, `y ${JSON.stringify(pos)} in ${v.width}`);
    }
  }
  const right = panelPlacement(defaultBubblePos(LAPTOP), LAPTOP);
  assert.ok(right.left + right.width <= bubbleXY(defaultBubblePos(LAPTOP), LAPTOP).x, "beside it, to its left");
  assert.ok("top" in panelPlacement({ edge: "right", offset: BUBBLE_TOP_MIN }, LAPTOP), "near the top it opens downward");
});

// ---- Layers and the shortcut (note 174) ---------------------------------------------------------------

test("the assistant's layer is above modals (the rule canvas, the full-screen task) and below menus, alerts, toasts", () => {
  assert.ok(LAYER_Z.assistant > LAYER_Z.modal);
  assert.ok(LAYER_Z.assistantModal > LAYER_Z.assistant);
  assert.ok(LAYER_Z.popover > LAYER_Z.assistantModal && LAYER_Z.alert > LAYER_Z.assistant && LAYER_Z.toast > LAYER_Z.assistant);
  const ui = read("src/components/ai-assistant/ai-assistant.tsx");
  assert.ok(ui.includes("LAYER.assistant}") && !ui.includes("LAYER.panel"), "bubble and panel on the assistant layer");
  assert.ok(ui.includes("print:hidden"));
  assert.ok(read("src/components/rules/rule-canvas.tsx").includes("data-assistant-allowed"), "Tab then A over the rule canvas");
  assert.ok(read("src/components/task/task-pane-frame.tsx").includes('data-assistant-allowed={expanded ? "" : undefined}'), "and over the full-screen task");
  // Only in the authenticated app shell: never on public pages (forms, review portal, login).
  for (const file of ["src/app/forms/[formId]/page.tsx", "src/app/login/page.tsx"]) {
    if (fs.existsSync(path.resolve(import.meta.dirname, "../..", file))) assert.ok(!read(file).includes("AiAssistant"), file);
  }
});

// Minimal DOM stand-ins so the real handlers run in Node.
class FakeElement {
  isContentEditable = false;
  value = "";
  attrs: Record<string, string> = {};
  constructor(public tag: string, public type = "text") {}
  closest() {
    return null;
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  matches(sel: string) {
    return sel === "[data-assistant-allowed]" ? "data-assistant-allowed" in this.attrs : sel === "[data-task-pane]" ? "data-task-pane" in this.attrs : false;
  }
  contains(other: unknown) {
    return other === this;
  }
}
class FakeTextArea extends FakeElement {}
class FakeInput extends FakeElement {}
class FakeSelect extends FakeElement {}

function withDom<T>(dialogs: FakeElement[], active: unknown, run: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const saved = { HTMLElement: g.HTMLElement, HTMLTextAreaElement: g.HTMLTextAreaElement, HTMLInputElement: g.HTMLInputElement, HTMLSelectElement: g.HTMLSelectElement, document: g.document };
  Object.assign(g, {
    HTMLElement: FakeElement,
    HTMLTextAreaElement: FakeTextArea,
    HTMLInputElement: FakeInput,
    HTMLSelectElement: FakeSelect,
    document: { activeElement: active, querySelectorAll: () => dialogs },
  });
  try {
    return run();
  } finally {
    Object.assign(g, saved);
  }
}

function keyEvent(key: string, target: unknown, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) {
  const e = { key, target, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false, prevented: 0, stopped: 0, isComposing: false, ...mods } as unknown as {
    key: string;
    target: unknown;
    defaultPrevented: boolean;
    prevented: number;
    stopped: number;
    isComposing: boolean;
    preventDefault: () => void;
    stopPropagation: () => void;
  } & Record<string, unknown>;
  e.preventDefault = () => {
    e.prevented += 1;
    e.defaultPrevented = true;
  };
  e.stopPropagation = () => {
    e.stopped += 1;
  };
  return e;
}

// Keys a dictation tool (Wispr Flow: Fn, then text insertion, Escape to cancel) or a paste sends.
const TEXT_KEYS: [string, Partial<{ metaKey: boolean; ctrlKey: boolean }>][] = [
  ["v", { metaKey: true }],
  ["v", { ctrlKey: true }],
  ["Fn", {}],
  [" ", {}],
  ["a", {}],
  ["A", {}],
  ["Process", {}],
  ["Unidentified", {}],
  ["Enter", {}],
];

test("shared key handlers never prevent paste, ⌘ / Ctrl+V, Fn, Space, or text input inside a field", async () => {
  const { tabChordHandler, dialogOpen } = await import("@/components/shortcuts/keyboard");
  const { assistantKeyHandler } = await import("@/components/ai-assistant/assistant-keys");
  for (const field of [new FakeTextArea("textarea"), new FakeInput("input", "text"), new FakeInput("input", "search")]) {
    field.value = "dictated words";
    withDom([], field, () => {
      let now = 1000;
      let fired = 0;
      const chord = tabChordHandler("a", () => fired++, { now: () => now });
      let closed = 0;
      const esc = assistantKeyHandler(() => closed++);
      for (const [key, mods] of TEXT_KEYS) {
        for (const handler of [chord, esc]) {
          const e = keyEvent(key, field, mods);
          handler(e as never);
          assert.equal(e.prevented, 0, `${key} ${JSON.stringify(mods)} in ${field.tag}`);
        }
      }
      // Tab then A typed in a field is just text.
      chord(keyEvent("Tab", field) as never);
      now += 100;
      const a = keyEvent("a", field);
      chord(a as never);
      assert.equal(a.prevented, 0);
      assert.equal(fired, 0);
      // Escape in a field with text never closes the panel (a dictation tool's cancel), and stops there.
      const e = keyEvent("Escape", field);
      esc(e as never);
      assert.equal(closed, 0);
      assert.equal(e.prevented, 0);
      assert.equal(e.stopped, 1, "the canvas or pane behind doesn't see it either");
      // During an IME composition, nothing.
      const composing = keyEvent("Escape", field);
      composing.isComposing = true;
      esc(composing as never);
      assert.equal(composing.stopped + composing.prevented + closed, 0);
      assert.equal(dialogOpen(), false);
    });
  }
  // Escape with an empty box, or focus elsewhere in the panel, closes it.
  const empty = new FakeTextArea("textarea");
  withDom([], empty, () => {
    let closed = 0;
    const e = keyEvent("Escape", empty);
    assistantKeyHandler(() => closed++)(e as never);
    assert.equal(closed, 1);
    const button = new FakeElement("button");
    const e2 = keyEvent("Escape", button);
    assistantKeyHandler(() => closed++)(e2 as never);
    assert.equal(closed, 2);
  });
});

test("Tab then A works over the rule canvas / full-screen task (and the assistant itself) but not over other dialogs", async () => {
  const { tabChordHandler, dialogOpen, ASSISTANT_ALLOWED } = await import("@/components/shortcuts/keyboard");
  const body = new FakeElement("body");
  const canvas = Object.assign(new FakeElement("div"), { attrs: { role: "dialog", "aria-modal": "true", "data-assistant-allowed": "" } });
  const assistant = Object.assign(new FakeElement("div"), { attrs: { role: "dialog", "aria-modal": "false", "data-assistant-allowed": "" } });
  const share = Object.assign(new FakeElement("div"), { attrs: { role: "dialog", "aria-modal": "true" } });
  const chordWith = (dialogs: FakeElement[]) =>
    withDom(dialogs, body, () => {
      let now = 0;
      let fired = 0;
      const h = tabChordHandler("a", () => fired++, { allowOver: ASSISTANT_ALLOWED, now: () => now });
      h(keyEvent("Tab", body) as never);
      now = 300;
      const e = keyEvent("a", body);
      h(e as never);
      return { fired, prevented: e.prevented };
    });
  assert.deepEqual(chordWith([]), { fired: 1, prevented: 1 });
  assert.deepEqual(chordWith([canvas]), { fired: 1, prevented: 1 }, "over the rule canvas");
  assert.deepEqual(chordWith([canvas, assistant]), { fired: 1, prevented: 1 }, "and to close it again");
  assert.deepEqual(chordWith([share]), { fired: 0, prevented: 0 }, "never over another dialog");
  // The non-modal assistant doesn't make the page's shortcuts stand down unless it has focus.
  withDom([assistant], body, () => assert.equal(dialogOpen(), false));
  withDom([assistant], assistant, () => assert.equal(dialogOpen(), true));
});

test("the box stays enabled while the AI thinks (only Ask is disabled); dictation landing meanwhile is kept", () => {
  const ui = read("src/components/ai-assistant/ai-assistant.tsx");
  assert.ok(ui.includes("disabled={!configured}\n            aria-busy={busy || undefined}"), "the textarea isn't disabled while busy");
  assert.ok(ui.includes('<button type="submit" className="btn-primary h-8 px-3" disabled={busy || !text.trim() || !configured}>'));
  assert.ok(ui.includes("setText((current) => (current === asked.current ? \"\" : current))"), "cleared only when untouched since the request");
  assert.ok(!/onPaste|beforeinput|addEventListener\("paste"/.test(ui), "no paste interception");
});

// ---- Automations (notes 173, 174) --------------------------------------------------------------------

const S1 = "44444444-4444-4444-8444-444444444441";
const S2 = "44444444-4444-4444-8444-444444444442";
const ctx: RuleContext = {
  sections: [
    { id: S1, name: "Review" },
    { id: S2, name: "Done" },
  ],
  fields: [],
  people: [{ id: "p1", name: "Dana" }],
  forms: [],
  integrations: null,
  inboundEndpoints: [],
};

test("Expand shows every step of a multi-branch automation, read-only, in the builder's layout", () => {
  const html = renderToStaticMarkup(
    <RuleReadOnly
      rule={{
        name: "Router",
        triggerType: "task_created",
        triggerConfig: {},
        conditions: [
          { type: "section_is", section_id: S1 },
          { type: "is_complete", group: 1 },
          { type: "section_is", section_id: S2, branch: 1 },
        ] as never,
        actions: [
          { type: "move_section", section_id: S2 },
          { type: "set_assignee", assignee: "p1" },
          { type: "move_section", section_id: S1, branch: 1 },
          { type: "set_assignee", assignee: null, branch: 2 },
        ] as never,
      }}
      ctx={ctx}
      also={["Starts off"]}
    />,
  );
  for (const word of ["Summary", "When", "Check if", "Else if", "Otherwise", "Then", "Also", "Starts off", "Review", "Done", "Dana"]) assert.ok(html.includes(word), word);
  assert.equal((html.match(/<li class="flex items-start gap-2">/g) ?? []).length, 4, "every action, in order");
  assert.ok(html.includes(">or<"), "Or groups");
  assert.ok(!/<input|<button|<select|<textarea/.test(html), "read-only");
});

test("Edit with AI on every automation row and in the canvas header; Turn on & create next to Create", () => {
  const list = read("src/components/rules/rules-view.tsx");
  assert.ok(list.includes("{canEdit ? <EditWithAiButton projectId={projectId} ruleId={rule.id} ruleName={rule.name} /> : null}"), "Owners / Admins, like Edit");
  const canvas = read("src/components/rules/rule-canvas.tsx");
  assert.ok(canvas.includes("{rule && canEdit ? <EditWithAiButton projectId={projectId} ruleId={rule.id} compact /> : null}"));
  assert.ok(canvas.includes("Turn on &amp; create") && canvas.includes("onClick={() => save(true)}"));
  assert.ok(canvas.includes("const [enabled, setEnabled] = useState(rule ? rule.enabled : !initial);"), "a new AI draft still starts off");
  const button = read("src/components/ai-assistant/edit-with-ai.tsx");
  assert.ok(button.includes('openAssistant({ page: { kind: "rule", projectId, taskId: null, ruleId }'), "the automation is the assistant's page");
  assert.ok(button.includes("if (!access?.ready) return null;"), "only where the server says the assistant may be used");
  assert.ok(read("src/app/(app)/projects/[projectId]/rules/[ruleId]/page.tsx").includes("key={`${rule.id}:${savedVersion(rule)}`}"), "the canvas reloads an applied AI edit");
});

test("the assistant never applies over the canvas's unsaved edits of that automation", () => {
  const ops = [{ op: "update_rule", ruleId: "r1" }, { op: "rename_task" }];
  assert.equal(blockedByCanvas(ops, { ruleId: "r1", dirty: true }), true);
  assert.equal(blockedByCanvas(ops, { ruleId: "r1", dirty: false }), false);
  assert.equal(blockedByCanvas(ops, { ruleId: "r2", dirty: true }), false, "another automation is fine");
  assert.equal(blockedByCanvas(ops, null), false);
  assert.match(UNSAVED_CANVAS, /Save or discard your changes/);
  const ui = read("src/components/ai-assistant/ai-assistant.tsx");
  assert.ok(ui.includes("disabled={phase.kind === \"applying\" || phase.selected.size === 0 || canvasBlocked}"), "Confirm waits");
});

test("the proposal offers Expand, Turn on after creating, and Turn on & Finish after Confirm", () => {
  const ui = read("src/components/ai-assistant/ai-assistant.tsx");
  assert.ok(ui.includes('op.op === "create_rule" || op.op === "update_rule" ? ('));
  assert.ok(ui.includes("Turn on after creating"));
  assert.ok(ui.includes("Turn on &amp; Finish") && ui.includes("turnOnAssistantRules(phase.proposal.runId, [...phase.turnOn])"));
  assert.ok(ui.includes("createPortal("), "Expand is a modal on the same page (no navigation)");
});
