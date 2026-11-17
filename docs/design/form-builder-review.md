# Form builder and branching review (Nov 17, 2026)

**Review only. Nothing here is built.** Checked against `main` at **c9cba23**. `feat/ai-builder` (a146782) has the
same form files (a two-dot diff of `components/forms`, `app/forms`, `core/src/forms.ts`, and `core/src/api/forms`
is empty). The AI builder's tools create, rename, and turn forms on or off, but they don't edit questions.

Sources: the code, the migrations under `supabase/migrations`, `docs/design/form-branching.md` (note 143), and
Asana's public help on forms. One claim comes from the first-pass draft and wasn't re-checked here: it counted
10 forms in the hosted database, all test or demo forms, and found none that use branching. This review made no
database reads.

---

## 1. The short version

- **The builder is solid. Branching works, but you can't see it.** You build a branch one question at a time,
  and nothing on screen shows "path A, path B, then back to the main flow". That gap is note 143.
- **The design doc's model is right.** Keep the flat question list with `show_if` (the database already checks
  it at submit time), and add path labels on top so the builder can draw blocks.
- **There's one trap the doc misses: saving strips keys the code doesn't know.** `parseQuestions` copies only
  the known keys. Every save, load, and public read goes through it, so `paths` and `show_if.path_id` would
  vanish on the first save until it learns them.
- **Phase 1 doesn't need a migration.** `validate_form` ignores keys it doesn't know, and `submit_form` reads only
  `show_if.question_id` and `option_ids`. Path rules can be checked in the save layer (`cleanQuestions`). That
  keeps batch 43 away from the anon-facing definer functions.
- **Fix the builder's branch bugs first.** Today a branch can disappear silently: the preview hides the question
  while the live form shows it, with no warning. Paths make that worse.
- **Recommended batch 43:** path blocks in the builder, plus the fixes paths depend on: no silent branch loss,
  errors shown on the right card, honest draft and Live behavior, mapping warnings, and an embed that sizes
  itself. App only, no migration. Conditions on any answer and "end the form early" come later, and those do
  need one.

---

## 2. How it works today

### 2.1 Where things live

| What | Path |
| --- | --- |
| Forms list | `apps/web/src/app/(app)/projects/[projectId]/forms/page.tsx` → `components/forms/forms-list.tsx` |
| Editor (a large modal over the list) | `…/forms/[formId]/page.tsx` → `components/forms/form-editor.tsx` (1,821 lines) |
| Live / Off switch | `components/forms/form-status.tsx` |
| Public form and embed | `apps/web/src/app/forms/[formId]/page.tsx`, `…/embed/page.tsx` → `public-form-page.tsx` → `public-form.tsx` |
| Server actions | `apps/web/src/lib/actions/forms.ts` |
| Typed API | `packages/core/src/api/forms/{model,queries,mutations}.ts` (`cleanQuestions` at mutations.ts:23) |
| Shared logic | `packages/core/src/forms.ts` (types :78, `parseQuestions` :163, `visibleQuestionIds` :207, `validateSubmission` :233, `normalizeQuestions` :356, branch helpers :540) |
| Database | `validate_form()` (trigger `forms_validate`), `ensure_form_requester_name()` (`forms_04_requester_name`), `get_public_form`, `submit_form`, `normalize_form_answer` |
| Framing | `apps/web/security-headers.ts`: any site can frame the two public form pages |

### 2.2 The editor

The preview is on the left. It's interactive: answer a choice question and its branch opens. Hidden questions
stay on screen at 60% opacity with a "Shown if … is …" caption. On the right are the **Questions** and
**Settings** tabs. The header has Live / Off (it saves at once), View form, Share form (the link and an embed
code), Copy link, and Save. Below 1024 px a Preview / Edit button swaps the two sides. Below Editor you get the
preview only.

A **question card** (`QuestionCard`, :908) opens like an accordion. It has Type, Required, the question text,
help text, **Options** (choice questions), **Fills in** (mapping), **Branching** ("If the answer is X, show …"),
**Shown only if …** (with Always show), and Move, Duplicate, and Delete. The header's **Branch** button picks an
answer, then picks a later question or makes a new one. **+ New question** (`NewQuestionMenu`, :795) offers
project fields (a field that's already asked shows as "Asked" and can't be picked) and the question types.
Email isn't offered, because every form already asks for the submitter's email.

### 2.3 Data and checks

- A question looks like `{ id, type, label, help?, required?, options?[{id,label}], maps_to?{target, field_id?},
  show_if?{question_id, option_ids[]}, role?: "name" }`.
- `validate_form` allows at most **100** questions. It checks for unique ids, known types, and 1–200 options with
  unique ids, and checks the mapping rules. `show_if` must point at options of an **earlier** choice or checkbox
  question, with at least one option. **It doesn't reject unknown keys, at the top level or inside `show_if`.**
- `ensure_form_requester_name` keeps exactly one required "Your name" short text with no mapping or branch. It
  keeps every other key on every question.
- `get_public_form` returns each question with only `maps_to` removed. So anything else stored on a question,
  future path names included, reaches the public page.

### 2.4 From submit to task

1. The browser walks `visibleQuestionIds` and renders only the visible questions. An answer to a question that
   becomes hidden stays in the browser, so switching back restores it, but it's never sent.
2. `validateSubmission` checks required only on visible questions and drops hidden answers. The `submitForm`
   action runs a honeypot check, reads `get_public_form` again, and repeats the validation.
3. `submit_form` (definer, granted to anon) **walks the list again on the server**. It's the trust boundary.
   Then it maps answers:
   - `title`: answers are joined with spaces (two shown title questions get glued together).
   - `notes`: answers are joined with blank lines.
   - `due_on`, `section`, and fields: the last answer wins.
   - Unchecked checkboxes are stored as no answer (`normalize_form_answer` returns null for false).

   It then creates the task, the submission row, the story, the confirmation email, and the `form_submitted`
   rules. The task's description lists only the answers that were shown.
4. Rules see `form_submitted` (filtered by form) and `form_answer_contains` (a text match). No rule condition
   reads "question X's answer is option Y". To route a request by its answer, map the question to a field.

### 2.5 The embed

The Share snippet is `<iframe … height="900" style="border:0">` (form-editor.tsx:174). The embed page has no
`postMessage` or `ResizeObserver`, so a form that grows when a branch opens scrolls inside a fixed 900 px box,
and a short form leaves a gap.

---

## 3. UX critique

### 3.1 What's good

- The live preview sits next to the editor, and you can branch by answering in it.
- "From a field" questions take one click, and the mapping only offers targets the question type can fill.
- Drag, Alt+↑/↓, Duplicate, and Undo after deleting a question or changing its type.
- Renaming an option never breaks a branch, because branches point at option ids, not labels.
- The browser and the database check with the same rules, and non-editors get a read-only view.

### 3.2 Friction compared with Asana

Asana shows a branched question nested under the answer that opens it, and it carries forms in project templates
and duplicates. ALHC does the second (forms ride along in project copies). The gaps:

| Area | Today | Gap |
| --- | --- | --- |
| Seeing branches | Branches are scattered chips in each source card. The list is flat, and only the preview shows "Shown if". | **Big.** You can't see the flow. Note 143. |
| "Any other answer" | Every option has to be ticked by hand. A checkbox can only branch on "Checked". | No Otherwise. "Not checked" can't be a branch (it's stored as no answer). |
| Adding into a branch | **+ New question** goes after the selected card with no branch, even when that card sits inside a branch. | It splits the branch visually, and with paths it splits a path. |
| Options | Add, rename, remove. "Copy options from" replaces every option and its id. | No reorder, no pasting a list. A field question's options are copied once and never pick up new field options. |
| Asking a field twice | "From a field" refuses a field that's already asked. | That blocks the most common paths case: the same field asked in different paths. |
| Preview | Inline and live. View form opens the **saved** public page. | No "Reset answers". You can't see the draft as a submitter would. |
| Duplicate form / starters | Neither exists. Every new form starts with the same three questions. | Missing. |
| Long choice lists | Always shown as radio buttons or checkboxes. | A question with many sections makes a long list. Later. |

### 3.3 Bugs and rough edges (all checked in the code)

1. **A branch can vanish silently when you change options.** Removing an option, or using "Copy options from"
   (it gives new ids), goes through `updateQuestion` → `changeQuestions`. That path has **no Undo toast**: only a
   type change or a delete uses `commitWithUndo`. While you edit, `normalizeQuestions` keeps a branch whose
   options are all gone, so **the preview hides that question forever**. On save,
   `normalizeQuestions(…, forSave = true)` drops the empty branch, so **the live form always shows it**. The
   preview and the live form disagree, and nothing says so.
2. **Save errors don't name the card.** A question made with Branch → Create new question starts with an empty
   label. Save then fails with "Question can't be empty" (`text()` in `cleanQuestions`) and doesn't say which
   card. Database refusals come back as a toast too, though some of them do name the question.
3. **Live and Save don't agree on what's published.**
   - Live / Off saves only `accepting_responses`. Turning a form live with unsaved edits publishes the last saved
     questions, with no warning.
   - View form shows the saved version too.
   - **Save also sends the editor's own copy of Live / Off** (`acceptingResponses: accepting`), so a Save can undo
     a Live / Off change someone else made in another tab.
4. **Two people saving overwrite each other.** `updateForm` writes the whole question list with no version check,
   so the last save wins.
5. **Files in questions that become hidden** aren't sent, and they still count toward the 10 files a response can
   take. The message does say "including ones you removed". With paths, someone who switches paths can run out
   of uploads sooner. This is minor.
6. **Small things:**
   - The editor opens with the first question (usually "Your name") selected.
   - `BranchEditor`'s empty-state text (`later.length === 0 && options.length === 0`) almost never shows, because
     choice questions always keep at least one option.
   - Duplicating a branched question keeps its branch, which is fine. Duplicating a source question gives new
     option ids, so the copy has no branches.

---

## 4. The branching design (`form-branching.md`) against the code

### 4.1 Where it fits

- **One source of truth:** the flat ordered list plus `show_if` is exactly what `visibleQuestionIds` (TS) and
  `submit_form` (SQL) walk. Path labels on top leave runtime behavior unchanged.
- **Paths come back by themselves and nest already.** A question shows only when its parent shows, and the first
  question after the blocks without a `show_if` is where the paths meet.
- **Hidden required questions** are skipped in both walks, and hidden answers are dropped in both.
- **Multiple choice shows every matching path, in order.** The walk already does this, so doc §7 Q2 is answered.
  Showing only the first match would need a database change.
- **Contiguous blocks with no "jump to question N"** is the right call. It's readable and easy to check.

### 4.2 What the doc misses or gets wrong

1. **Saving strips unknown keys** (see §1). `parseQuestions` rebuilds `show_if` as `{question_id, option_ids}`,
   and `cleanQuestions`, `toFormDef`, and `getPublicForm` all use it. `FormQuestion`, `parseQuestions`, and
   `cleanQuestions` must learn `paths` and `path_id` first, with a test that saves and loads a form and gets the
   same questions back.
2. **There's no need to patch `validate_form` for Phase 1.** The database already accepts the keys, and the
   walk ignores them. The path rules can be checked in core and again in `cleanQuestions`, which every editor
   save goes through:
   - 2–6 paths
   - an option on one path only
   - each path's questions together in one block
   - Otherwise recomputed
   - at most 3 levels of nesting

   The doc's build plan, step 2, can go.
3. **Facts in the doc are out of date.**
   - The limit is **100** questions, not 200.
   - `src/lib/forms.ts` is now `packages/core/src/forms.ts`.
   - `tests/unit/workdays.test.ts` moved in the monorepo split.
4. **An Otherwise path can be left with no answers.** If every option is already on another path, Otherwise has
   no options. `validate_form` refuses a `show_if` with an empty option list, so the form won't save. The
   builder must treat an empty Otherwise as an error on that path (say "no answers left", and say how to fix it).
   It must never store an empty rule.
5. **An optional split question left blank shows no path**, Otherwise included, because the walk needs a picked
   answer. That's correct, but the builder should say "Otherwise: any other answer".
6. **Checkbox sources.** "Otherwise" can't mean "not checked", because unchecked is stored as no answer. The doc
   allows paths on checkboxes. Instead, don't offer Split into paths on a checkbox: suggest a Yes / No single
   choice. The existing single "Checked" branch keeps working.
7. **Mapping inside paths needs builder rules.** At runtime nothing changes, but:
   - The same field asked once in each path of one split is fine, and needed. "From a field" should allow it,
     labeled "Asked in Print".
   - If two questions that can both show fill the same field, due date, or section, the last one wins. If they
     both fill the task name, the answers are glued together. Warn.
   - Mapping the split question to a field (say "Request type") gives rules and reports the path taken, with no
     new "path" concept. That answers doc §7 Q6.
8. **Path names are public.** `get_public_form` sends everything but `maps_to`, so a path name reaches the
   submitter's browser. That's fine, because names default to option labels. The builder should still say paths
   are visible on the form, so nobody writes internal notes there.
9. **Edits that break paths and aren't in the doc:**
   - removing or replacing options (bug 1)
   - + New question landing inside a block
   - duplicating a split question (its copy has no paths)
   - changing a split question's type (it already warns, with Undo)
10. **Moving forms over is cheap.** Per the draft's database count, no form branches today. Keep
    `groupIntoPaths` for any branched form made before release, and make "Put this path together" one button,
    not a feature.
11. **The doc's preview path picker** ("Preview as: Print / Web") is optional. Answering the split question in
    the inline preview already walks that path. A "Reset answers" button is the cheaper win.

### 4.3 How paths should sit in the builder

Follow the doc's flow list. Under a choice question, its paths show as indented, colored blocks: a header
("● Print — answer is Print" with a ⋯ menu), the path's questions, and "+ Add question to this path". After the
last block comes a "↳ Paths meet here" line. The preview uses the same path colors on its left edge.

The rules for the model:

- Each path question stores `show_if = {question_id, option_ids, path_id}`, with `option_ids` always equal to the
  path's options.
- The Branch button stays as the quick way in. It joins a path, or makes one.
- A required question inside a path is captioned "Required when this path shows". A path that can never show is a
  blocking error on its card, never something Save drops quietly.

New code goes in new files so the 1,821-line editor doesn't grow: `packages/core/src/form-paths.ts` (pure helpers)
and `apps/web/src/components/forms/form-flow.tsx` (the list and blocks).

---

## 5. Recommended batch 43

Sizes: **S** is a few hours, **M** about a day, **L** 2–3 days. **No migration for anything in batch 43.**

### Must have

| # | Item | Size |
| --- | --- | --- |
| 1 | **Path model in core.** `paths` and `show_if.path_id` in `FormQuestion`, `parseQuestions`, and `cleanQuestions`. `form-paths.ts` holds `groupIntoPaths`, contiguity checks, Otherwise recompute (an empty Otherwise is an error), limits, and block-aware moves. Unit tests, including a save-and-load round trip. | M |
| 2 | **Path blocks in the builder** (`form-flow.tsx`). Split into paths (one per option, plus Otherwise). Add path. A path ⋯ menu: Rename, Change answers, Move up / down, Delete (asks whether its questions move to the main flow or are deleted). "+ Add question to this path". "Paths meet here". Drag and Alt+↑/↓ that ask "Move to the main flow?" instead of clearing the branch. + New question never lands inside a block by accident. Checkboxes suggest a Yes / No choice instead of paths. | L |
| 3 | **No silent branch loss.** Removing or replacing options gets the Undo toast. A branch or path with no answers left is a blocking error on its card, and the preview and Save agree. Save errors open and focus the card at fault. A new branch question opens with its label focused. | M |
| 4 | **Honest draft and Live.** Live with unsaved edits asks "Save and go live?". View form says it shows the saved version while there are unsaved edits. Save stops sending Live / Off. The preview gets Reset answers. | S |
| 5 | **Mapping guards.** The same field may be asked once per path of one split ("Asked in Print"). Warn when questions that can both show fill the same field, due date, section, or task name. A hint to map the split question to a field for rules. | S |
| 6 | **Embed sizes itself.** The embed page posts its height to the parent page (`postMessage` from a `ResizeObserver`; only a number is sent). The Share snippet adds a short listener that checks the message comes from the app's origin. Old snippets keep working at 900 px. | S |

That's about **6–8 days** of author time in one PR. Land the core work and its tests as the first commits so
reviewers see clear pieces.

### Should have (in batch 43 if review has room, otherwise 44)

| # | Item | Size |
| --- | --- | --- |
| 7 | **Options editor:** reorder (drag, Alt+↑/↓) and paste a list (one option per line). | S |
| 8 | **Edit-conflict check:** Save sends the `updated_at` it loaded, and refuses with "Someone else changed this form. Reload." | S |
| 9 | **Duplicate form.** The copy starts off, with " (copy)" added to its name. It's an RLS insert, with no migration. | S |

### Later

- **Phase 2 conditions:** conditions on any earlier answer (is / isn't / contains / more or less than / before or
  after / filled / empty), AND across questions, and "End the form after this path". This needs an **additive
  migration** that replaces `submit_form` (anon, definer) and patches `validate_form`, with test vectors shared
  between TS and SQL. That puts it in security review. Size L.
- Starter forms. Field-linked options that stay in sync. Multi-page forms. A dropdown for long choice lists.
  Number, date, and length limits. A cover image per form.

---

## 6. Risks

- **The key-stripping trap.** If item 1 slips, paths disappear on save without an error. Its round-trip test
  must land first.
- **The checks live only in the app layer.** With no database patch, a future writer that skips `cleanQuestions`
  (for example an AI-builder tool that edits questions) could save paths that aren't contiguous. Submissions stay
  correct, because `show_if` is still checked by the database. Only the builder's drawing suffers, and "Put this
  path together" fixes it. Add the database check with Phase 2.
- **Review size.** This is a large UI batch. Keeping it in new files and landing core first keeps the diff easy to
  review.
- **The embed.** Sizing itself needs the new snippet pasted into the Marketing Request Forms hub. Until then
  nothing changes there.
- **The AI-builder port.** The form files are the same on both branches today, so it should apply cleanly.

---

## 7. Decisions for Avi

1. **Approve batch 43 as in §5:** paths plus the builder fixes, with no database change. Phase 2 (conditions on
   any answer, ending the form early) waits. *Recommended: yes.*
2. **Does any real form need Phase 2?** That means a question that depends on a number, a date, or two answers
   together, or a path that ends the form early. If none comes to mind, Phase 2 stays parked.

Settled by this review, not decisions:

- Multiple choice shows every matching path.
- Otherwise is added automatically when splitting.
- There's no "jump to question N".
- Limits are 6 paths and 3 levels.
- Checkboxes don't split into paths.
- "Path taken" is covered by mapping the split question to a field.

**One action, not a decision:** once batch 43 ships, paste the new embed snippet into the Marketing Request Forms
hub so embedded forms size themselves.
