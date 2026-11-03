# Form branching: paths that split and come back (note 143)

**Status: design only, waiting for Avi's approval. Nothing here is built.**

Avi's note: forms should branch like Zapier's paths. A question can lead to different follow-up questions
depending on its answer, and the paths can come back together into the main flow.

## 1. What we have today

A form is an ordered list of questions (`forms.questions`, validated by `validate_form`, walked by
`submit_form` and by `visibleQuestionIds()` in `src/lib/forms.ts`). Branching is one rule per question:

```json
{ "id": "q4", "label": "Print size", "show_if": { "question_id": "q2", "option_ids": ["print"] } }
```

The walk goes top to bottom. A question is shown when it has no `show_if`, or when its `show_if` question
is shown **and** that question's answer includes one of `option_ids`. Hidden answers are dropped on the
server. The editor's **Branch** button (Nov 1 notes, item 68) picks an answer and then a later question, or
**Create new question**, which adds a short answer right after the branch and shows it only for that
answer.

This already does more than it looks like:

- **Paths come back by themselves.** Every question without `show_if` is on the main flow, so the first
  one after a branch is where the paths meet again.
- **Paths can nest.** A question inside a path can be a choice question with its own branches; the walk
  handles chains (a question shows only if its parent shows).

What's missing is mostly the **builder**: today a path is a scattered set of questions that each carry the
same rule, nobody can see "path A, path B, then back to the main flow", and moving a question can break a
branch (we already warn and clear it, `brokenBranches`).

A few things the model can't express at all:

1. **"Otherwise"** (every answer not on another path) without listing each option by hand.
2. **Conditions on more than one question** ("Request type is Print **and** Budget is over 5,000").
3. **Non-choice conditions** (a number over / under, a date before / after, an answer filled in or not).
4. **Ending the form early** ("No, I don't need anything" → submit now).

## 2. Proposal

Keep one source of truth that the database already walks: the flat, ordered `questions` list with
`show_if`. Add **path metadata** so the builder can draw and edit paths as blocks, plus two small,
backward-compatible extensions to `show_if` for the gaps above. The release still on `main` keeps
working on every form, because a path is still made of ordinary `show_if` rules.

### 2.1 Data model

```jsonc
// forms.questions (unchanged shape, two optional keys)
[
  { "id": "q1", "type": "short_text", "label": "Your name", "role": "name" },
  { "id": "q2", "type": "single_select", "label": "What do you need?",
    "options": [{ "id": "print", "label": "Print" }, { "id": "web", "label": "Web" }, { "id": "video", "label": "Video" }],
    // NEW: this question splits into paths (builder metadata; the walk doesn't read it)
    "paths": [
      { "id": "p_print", "name": "Print", "option_ids": ["print"] },
      { "id": "p_web",   "name": "Web",   "option_ids": ["web"] },
      { "id": "p_other", "name": "Otherwise", "otherwise": true }
    ]
  },
  // Path "Print": every question carries the same rule, plus which path it belongs to
  { "id": "q3", "type": "single_select", "label": "Print size",
    "show_if": { "question_id": "q2", "option_ids": ["print"], "path_id": "p_print" } },
  { "id": "q4", "type": "number", "label": "How many copies?",
    "show_if": { "question_id": "q2", "option_ids": ["print"], "path_id": "p_print" } },
  // Path "Web"
  { "id": "q5", "type": "short_text", "label": "Page URL",
    "show_if": { "question_id": "q2", "option_ids": ["web"], "path_id": "p_web" } },
  // Path "Otherwise": option_ids are filled in by the editor and by validate_form (every option not on
  // another path), so the walk stays the same
  { "id": "q6", "type": "long_text", "label": "Tell us more",
    "show_if": { "question_id": "q2", "option_ids": ["video"], "path_id": "p_other" } },
  // Back on the main flow (no show_if): every path ends here
  { "id": "q7", "type": "date", "label": "When do you need it?" }
]
```

Rules the database keeps (`validate_form`, asserted patch):

- `paths` only on single choice, multiple choice, and checkbox questions; 2–6 paths; path ids unique on
  the form; an option on at most one path; at most one `otherwise` path.
- A question's `show_if.path_id` must name a path of its `show_if.question_id`, and its `option_ids` must
  equal that path's (for `otherwise`: every option not on another path, recomputed on every save, so
  adding an option to the source question puts it on the Otherwise path).
- **Paths are contiguous:** a path's questions sit together, right after their source question (or after
  the previous path's questions); nested paths sit inside their path. This keeps "where the paths meet"
  well defined: the first question after the last path's block.
- Nesting up to 3 levels (a path inside a path inside a path), 200 questions in all (today's limit).

Phase 2, only if Avi wants them (§7):

- `show_if.all: [{ question_id, op, value }]`: extra conditions that must also hold (`op`: `is`,
  `is_not`, `includes`, `gt`, `lt`, `before`, `after`, `filled`, `empty`). The walk checks them after the
  parent rule.
- `ends_form: true` on a path: picking it submits after that path's questions (everything after it is
  hidden, required questions included).

### 2.2 Builder UX

The question list on the right of the form editor becomes a flow. A question with paths shows them as
indented, colored blocks under it; each block lists its questions and ends with **+ Add question to this
path**. After the last block a small "↳ Paths meet here" line leads into the next main question.

```
┌ Questions ────────────────────────────────────────── Settings ┐
│ 1  Your name                              Short answer   ⋯     │
│ 2  What do you need?                      Single choice  ⋯     │
│    ⑂ Split into paths                                          │
│    ┃ ● Print      (answer is “Print”)                  ⋯        │
│    ┃   3  Print size                      Single choice  ⋯     │
│    ┃   4  How many copies?                Number         ⋯     │
│    ┃   + Add question to this path                             │
│    ┃ ● Web        (answer is “Web”)                    ⋯        │
│    ┃   5  Page URL                        Short answer   ⋯     │
│    ┃   + Add question to this path                             │
│    ┃ ● Otherwise  (any other answer: “Video”)          ⋯        │
│    ┃   6  Tell us more                    Paragraph      ⋯     │
│    ┃   + Add question to this path                             │
│    ┃ + Add path                                                │
│    ↳ Paths meet here                                           │
│ 7  When do you need it?                   Date           ⋯     │
│ + New question                                                 │
└────────────────────────────────────────────────────────────────┘
```

- **Split into paths** (in a choice question's "⋯" and in its card): makes one path per option (named
  after the option) plus Otherwise; the person deletes or merges the ones they don't need. "Add path" picks
  the answers that lead to it.
- A path's "⋯": Rename, Change answers, Move up / down (among paths), Delete path (its questions move to
  the main flow or are deleted: asked), and in Phase 2 "End the form after this path".
- Dragging (and Move up / down, Alt+↑/↓) keeps questions inside their block: moving a question out of a
  path asks "Move it to the main flow?" instead of silently clearing its branch.
- Each path has a color (the option palette) used on its block's left bar and on its questions in the
  preview, so long forms stay readable.
- **Preview** (left side): a path picker above the preview ("Preview as: Print / Web / Otherwise") walks
  that path; clicking a question in the preview selects it in the list, as today.
- Below Admin the flow is read-only (Nov 1 notes, batch 11, item 74).

### 2.3 The public form at runtime

Same as today, because a path is still `show_if`: the form walks the list in order and shows a question
when its rule passes (`visibleQuestionIds`), answers on hidden questions are dropped, `submit_form`
re-walks on the server (the trust boundary) and refuses missing required answers only for shown
questions. Changing an earlier answer hides the questions of the old path and shows the new path's at
once; what was typed in a hidden question is kept in the browser in case they switch back, and never sent.
With several selected options (multiple choice), each matching path shows, in path order.

Phase 2 conditions are evaluated in the same walk (TS and SQL share test vectors, like
`tests/unit/workdays.test.ts` and suite zz29). `ends_form` hides everything after its path once the walk
reaches it.

### 2.4 How paths come back together

Every path ends where its block ends. The first question after the source's last path block has no rule
from that split, so it shows whatever path was taken: that's the meeting point ("↳ Paths meet here" in the
builder). A form can split again later; a path can split inside itself (its own meeting point is the end
of the outer path's block). There is no "jump to question N" by design: jumps make forms hard to read and
to check; contiguous blocks give the same forms without loops.

## 3. Validation summary

| Where | Checks |
| --- | --- |
| Editor (`src/lib/forms.ts`) | Same rules as below, live; Save stays disabled with the reason on the card. |
| `validate_form` (database) | §2.1's rules; a path's questions contiguous; Otherwise recomputed; nesting ≤ 3; ids unique; `show_if` names an earlier question (as today). |
| `submit_form` | Unchanged walk (Phase 1); Phase 2 conditions and `ends_form` added to the walk. |

## 4. Moving forms over from the Branch button

Nothing has to move: every existing branch is already a valid "path" without metadata. When a form
opens in the new editor:

1. Questions sharing the same `show_if` (same source question and option set) are grouped into a path named
   after the options ("Print", "Print or Web").
2. If a group's questions aren't contiguous, the editor shows them where they are, marked "Out of order",
   with one button: **Put this path together** (moves them right after their source). Nothing changes until
   someone saves.
3. The first save writes `paths` / `path_id`. Forms nobody edits keep working as they are.

The Branch button stays as the quick path for one question ("Show this question only if …"); it creates or
joins a path behind the scenes.

## 5. Build plan (after approval)

1. `src/lib/forms.ts`: path types, `groupIntoPaths()`, contiguity / Otherwise helpers, walk unchanged;
   unit tests with shared vectors.
2. Migration (additive, no tail): asserted patch of `validate_form` for `paths` / `path_id`; suite
   `zzNN_` with forms built through the editor's JSON.
3. Form editor: flow list with path blocks, Split into paths, Add path, path menus, block-aware moves,
   the preview's path picker.
4. Phase 2 (if wanted): `show_if.all` and `ends_form` in `validate_form`, `submit_form`, the walk, and the
   builder.

Rough size: Phase 1 is one batch (most of it is the editor); Phase 2 another.

## 6. What doesn't change

Mapping (`maps_to`), the requester's name question (always on the main flow, never in a path), Email /
Heading / Attachment questions, the verified-domains rule, confirmation emails, and the task a submission
makes. Headings can sit inside a path (a path's title). Attachment questions inside a path drop their files
when hidden, as today.

## 7. Open questions for Avi

1. **Phase 2 now or later?** Do you need conditions on more than one question, number / date comparisons,
   or "end the form after this path" for the forms you have in mind? (The proposal works without them.)
2. **Multiple choice:** when someone ticks two options that are on different paths, show both paths (in
   order), or only the first?
3. **Otherwise path:** add it automatically when splitting (our proposal), or only when asked?
4. **Jumping:** confirm we don't need "go to question N" / loops (Typeform-style jumps). Paths that meet
   again cover the cases we've seen.
5. **Limits:** 6 paths per split and 3 levels of nesting enough?
6. **Reporting:** should a submission record which path it took (e.g. a "Path" field on the task), so
   automations can use "Task came from path Print"?
