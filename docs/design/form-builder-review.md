# Form builder and branching review (Nov 17, 2026)

**Review only. Nothing here is built.** Checked against `main` at **c9cba23**. `feat/ai-builder` (a146782) has the
same form files (a two-dot diff of `components/forms`, `app/forms`, `core/src/forms.ts`, and `core/src/api/forms`
is empty). The AI builder's tools create, rename, delete, and turn forms on or off, but they don't edit questions.

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
- **There's one trap the doc misses: the app strips keys it doesn't know.** `parseQuestions`, which every load,
  save, and public read goes through, copies only the known keys and rebuilds `show_if` from two keys, so it drops both a question's `paths` list and
  its `show_if.path_id`. `normalizeQuestions` (run on every edit and before Save) and `showInBranch` keep the rest of
  a question but rebuild `show_if` the same way, so `path_id` is also dropped on every edit. All of
  them have to learn the new keys first.
- **Phase 1 doesn't need a migration.** `validate_form` ignores keys it doesn't know, and `submit_form` reads only
  `show_if.question_id` and `option_ids`. Path rules can be checked in the save layer (`cleanQuestions`), as long
  as it rebuilds each path question's answer list from its path on every save, so the stored rules can't drift
  from what the builder draws. Branches that aren't in a path are saved as they are. That keeps batch 43 away from the anon-facing definer functions.
- **Fix the builder's branch bugs first.** Today a branch can disappear silently. The preview keeps the question
  dimmed as if it were branched, while the saved form shows it to everyone, with no warning. Paths make that
  worse.
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
- `get_public_form` (anon) returns each question with only `maps_to` removed. While a form is live and its project isn't
  archived (or to members of its project), anyone with its link can read every other key through it; a stranger gets no questions for a
  form that's off. The public page then runs `parseQuestions`, so today the browser only receives the known keys.

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
- The browser and the database walk the branches the same way and share the 100-question limit. Non-editors get
  a read-only view.

### 3.2 Friction compared with Asana

Asana shows a branched question nested under the answer that opens it, and it carries forms in project templates
and duplicates. ALHC does the second (forms ride along in project copies). The gaps:

| Area | Today | Gap |
| --- | --- | --- |
| Seeing branches | Branches are scattered chips in each source card. The list is flat, and only the preview shows "Shown if". | **Big.** You can't see the flow. Note 143. |
| "Any other answer" | Every option has to be ticked by hand. A checkbox can only branch on "Checked". | No Otherwise. "Not checked" can't be a branch (it's stored as no answer). |
| Adding into a branch | **+ New question** goes after the selected card with no branch, even when that card sits inside a branch. | It splits the branch visually, and with paths it splits a path. |
| Options | Add, rename, remove. "Copy options from" replaces the whole list with the source's own options and ids (a section list or a field). | No reorder, no pasting a list. A field question's options are copied once and never pick up new field options. |
| Asking a field twice | + New question → "From a field" refuses a field that's already asked. The **Fills in** picker still lets a second question fill it. | The menu blocks the most common paths case (the same field asked in different paths), and Fills in allows the risky case with no warning. |
| Preview | Inline and live. View form opens the **saved** public page. | No "Reset answers". You can't see the draft as a submitter would. |
| Duplicate form / starters | Neither exists. Every new form starts with the same three questions. | Missing. |
| Long choice lists | Always shown as radio buttons or checkboxes. | A question with many sections makes a long list. Later. |

### 3.3 Bugs and rough edges (all checked in the code)

1. **A branch can vanish silently when you change options.** Removing an option, or using "Copy options from"
   with a source whose ids don't match the old ones, goes through `updateQuestion` → `changeQuestions`. That path
   has **no Undo toast**: only a type change or a delete uses `commitWithUndo`. Removing some of a branch's
   options narrows the branch silently. Removing all of them is worse:
   - While you edit, `normalizeQuestions` keeps a branch whose options are all gone. That question can never
     show, so the preview keeps it dimmed for good.
   - On save, `normalizeQuestions(…, forSave = true)` drops the empty branch (and `cleanQuestions` would too), so
     the saved form always shows the question.

   Save doesn't write the stripped list back into the editor, so the preview stays dimmed even after saving.
   Nothing says the preview and the live form now disagree. Routing these edits through `commitWithUndo` wouldn't
   be enough: `lostBranches` only notices a branch that disappeared, not one that is kept with no answers.
2. **Save errors don't name the card.** Every new question picked by type (except a heading
   or an attachment) starts with an empty label, including one made with Branch → Create new question. Save then fails with
   "Question can't be empty" (`text()` in `cleanQuestions`) and doesn't say which card. Database refusals come
   back as a toast too, though some of them do name the question.
3. **Live and Save don't agree on what's published.**
   - Live / Off saves only `accepting_responses`. Turning a form live with unsaved edits publishes the last saved
     questions, with no warning.
   - View form shows the saved version too.
   - **Save also sends the editor's own copy of Live / Off** (`acceptingResponses: accepting`), so a Save can undo
     a Live / Off change someone else made in another tab.
4. **Two people saving overwrite each other.** `updateForm` writes the whole question list with no version
   check, so the last save wins. It also uses `check()` rather than `checkUpdated`, so a save that changed no row
   still reports "Form saved". The UI hides Save from people who can't edit, which covers that today.
5. **Files in questions that become hidden** aren't sent, and they still count toward the 10 files a response can
   take. The message does say "including ones you removed". With paths, someone who switches paths can run out
   of uploads sooner. This is minor.
6. **Small things:**
   - The editor opens with the first question (usually "Your name") selected. Because **+ New question** inserts
     after the selected card, the first new question lands at position 2, not at the end.
   - `BranchEditor`'s empty-state text (`later.length === 0 && options.length === 0`) almost never shows, because
     choice questions always keep at least one option.
   - Duplicating a question puts the copy right after it, in the same branch, and drops its field mapping ("a copy
     never fills in the same field twice"). That's right for the same branch, where both would show. With paths,
     the common next step is moving the copy into a sibling path, and the mapping is already gone by then.

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

1. **The app strips unknown keys** (see §1). Two kinds of fix:
   - `FormQuestion` and `parseQuestions` (used by `cleanQuestions`, `toFormDef`, and `getPublicForm`) must keep
     `paths` **and** `show_if.path_id`. It's the only place `paths` is dropped today.
   - `normalizeQuestions` and `showInBranch` must keep `show_if.path_id` when they rebuild `show_if`.
     `insertBranchQuestion` makes a new question, so it must set `path_id` to the path it inserts into.

   Other places keep the keys already, but need path rules:
   - `ensureNameQuestion` must never leave the name question in a path.
   - `duplicateQuestion` copies `paths` along with the question, so it must drop them from a copy (its option ids
     are new).

   One `show_if` builder that all of them use is safest. The test must go through the editor's real save path:
   `normalizeQuestions(…, true)` → `cleanQuestions` → `parseQuestions`, getting the same questions back. A test of
   `cleanQuestions` alone would pass while the editor still drops `path_id`.
2. **There's no need to patch `validate_form` for Phase 1.** The database already accepts the keys, and the
   walk ignores them. The path rules can be checked in core and again in `cleanQuestions`, which every editor
   save goes through:
   - 2–6 paths, counting Otherwise
   - an option on one path only
   - each path's questions together in one block
   - Otherwise recomputed
   - at most 3 levels of nesting
   - "Your name" never inside a path (both `ensureNameQuestion` and the database strip its `show_if`)

   One condition is what makes this safe: **`paths` is the source, and `cleanQuestions` recomputes every path
   question's `show_if.option_ids` from it on each save.** Otherwise the stored rules and the drawn paths could
   drift apart (§6). The doc's build plan, step 2, can go.
3. **Facts in the doc are out of date.**
   - The limit is **100** questions, not 200.
   - `src/lib/forms.ts` is now `packages/core/src/forms.ts`.
   - `tests/unit/workdays.test.ts` moved in the monorepo split.
   - "Below Admin the flow is read-only" is now "below Editor": since batch 36, Editors build forms (`canBuild`).
4. **An Otherwise path can be left with no answers.** If every option is already on another path, Otherwise has
   no options. The database would refuse that empty rule, but it never sees it: `normalizeQuestions(…, true)`
   and `cleanQuestions` both delete an empty `show_if` before saving. So the save succeeds and the Otherwise
   questions show to everyone, the same silent loss as bug 1. Both drop sites have to become a blocking error on
   the path ("no answers left").
5. **An optional split question left blank shows no path**, Otherwise included, because the walk needs a picked
   answer. That's correct. The builder should say "Otherwise: any other answer (skipped if left blank)", and
   suggest making a split question required.
6. **Checkbox sources.** "Otherwise" can't mean "not checked", because unchecked is stored as no answer. The doc
   allows paths on checkboxes. Instead, don't offer Split into paths on a checkbox: suggest a Yes / No single
   choice. The existing single "Checked" branch keeps working.
7. **Mapping inside paths needs builder rules.** At runtime nothing changes, but:
   - In a **single-choice** split, the same field asked once in each path is fine, and needed: only one path
     shows. "From a field" should allow it, labeled "Asked in Print".
   - In a **multiple-choice** split, sibling paths can show together. So do any two questions that both show.
     Then the last answer wins for a field, the due date, or the section, and two task-name answers are joined.
     Warn in both cases.
   - Mapping the split question to a field (say "Request type") gives rules and reports the path taken, with no
     new "path" concept. That answers doc §7 Q6.
8. **Path names will be public data.** The anon `get_public_form` already returns any extra key. Once
   `parseQuestions` keeps `paths`, the public page will send them to the browser too, unless `getPublicForm`
   leaves them out (it should). The form never draws path names, but while a form is live anyone can read them through
   the function.
   The builder should say path names aren't private, so nobody writes internal notes there.
9. **Edits that break paths and aren't in the doc:**
   - removing or replacing options (bug 1)
   - + New question landing inside a block
   - duplicating a split question (the copy keeps `paths` pointing at the old option ids unless it's dropped)
   - duplicating a question into a sibling path (it loses its field mapping)
   - changing a split question's type (it already warns, with Undo)
10. **Existing branches don't all fit paths.** `showInBranch` lets one question show on A or B and another on B
    or C, and nesting isn't limited today. Overlapping answer sets can't become separate paths without changing
    who sees what. So the builder groups only branches that fit (identical answer sets, nesting within the
    limit). Everything else keeps working as a plain "Shown if" rule on the main list, unchanged until someone
    edits it. Nothing is converted automatically. (Per the draft's unverified database count, no form branches
    today, so this is about safety, not volume.)
11. **The doc's preview path picker** ("Preview as: Print / Web") is optional. Answering the split question in
    the inline preview already walks that path. A "Reset answers" button is the cheaper win.

### 4.3 How paths should sit in the builder

Follow the doc's flow list. Under a choice question, its paths show as indented, colored blocks: a header
("● Print — answer is Print" with a ⋯ menu), the path's questions, and "+ Add question to this path". After the
last block comes a "↳ Paths meet here" line. The preview uses the same path colors on its left edge.

The rules for the model:

- Each path question stores `show_if = {question_id, option_ids, path_id}`, with `option_ids` always recomputed
  from its path on save. A branch that isn't in a path keeps its `show_if` as stored.
- **Split into paths never starts in an error state.** It's offered only on a choice question with at least 2
  answers. The 6-path limit counts Otherwise. With 6 answers or fewer, each answer gets its own path and there's
  no Otherwise. With more, the person picks up to 5 answers for their own paths, and the rest go to Otherwise.
  Otherwise exists only while some answer isn't on another path. If the last such answer is given its own path,
  Otherwise is removed, and the builder asks where Otherwise's questions go.
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
| 1 | **Path model in core.** `paths` and `show_if.path_id` kept everywhere a question is rebuilt (§4.2 #1). `form-paths.ts` holds `groupIntoPaths` (only branches that fit), contiguity checks, recomputing path questions' `show_if` from `paths`, Otherwise (an empty one is an error), the limits, "Your name" kept on the main flow, and block-aware moves. Unit tests, including a round trip through the editor's real save path. | M |
| 2 | **Path blocks in the builder** (`form-flow.tsx`). Split into paths (2 answers or more; at most 6 paths counting Otherwise, which holds only leftover answers). Add path. A path ⋯ menu: Rename, Change answers, Move up / down, Delete (asks whether its questions move to the main flow or are deleted; leaving fewer than 2 paths dissolves the split, and the remaining questions stay a plain branch). "+ Add question to this path". "Paths meet here". Drag and Alt+↑/↓ that ask "Move to the main flow?" instead of clearing the branch. + New question never lands inside a block by accident. Moving a duplicated question into a sibling path offers to restore its field mapping. Checkboxes suggest a Yes / No choice instead of paths. | L |
| 3 | **No silent branch loss.** Changing options in a way that narrows or empties a branch gets the Undo toast, with a new check (`lostBranches` doesn't catch it). A branch or path with no answers left is a blocking error on its card, not dropped by `normalizeQuestions` or `cleanQuestions`, so the preview and the saved form agree. Save errors open and focus the card at fault. A new question opens with its label focused. | M |
| 4 | **Honest draft and Live.** Live with unsaved edits asks "Save and go live?". View form says it shows the saved version while there are unsaved edits. Save stops sending Live / Off. The preview gets Reset answers. | S |
| 5 | **Mapping guards.** In a single-choice split, the same field may be asked once per path ("Asked in Print"). Warn when two questions that can both show fill the same field, due date, section, or task name, including sibling paths of a multiple-choice split. A hint to map the split question to a field for rules. | S |
| 6 | **Embed sizes itself.** The embed page measures its content (not the full-height page wrapper, so it can shrink as well as grow) and posts `{ type, formId, height }` to the parent. The Share snippet's short listener accepts a message only from the app's origin **and** from its own iframe (`event.source`), and clamps the height. Old snippets keep working at 900 px. | S |

That's about **6–8 days** of author time in one PR. Land the core work and its tests as the first commits so
reviewers see clear pieces.

### Should have (in batch 43 if review has room, otherwise 44)

| # | Item | Size |
| --- | --- | --- |
| 7 | **Options editor:** reorder (drag, Alt+↑/↓) and paste a list (one option per line). | S |
| 8 | **Edit-conflict check.** `FormDef` gains `updatedAt`. Save **and** the Live / Off switch write only when `updated_at` still matches (`checkUpdated`, since `check()` treats zero rows as success), and refuse with "Someone else changed this form. Reload." The editor adopts a new `updated_at` only from its own write that matched. A Live / Off change in another tab also counts as a change; that's intended. | S–M |
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

- **The key-stripping trap.** If item 1 misses one site, path membership is lost while editing, or the paths list on
  load or save, with no error. Its round-trip test through the real save path must land first.
- **Old code drops path data.** A Vercel rollback, or an editor tab still running the old JavaScript, reads
  questions through the old `parseQuestions`. Its next save drops `paths`, the custom path names, and the
  Otherwise marker. `show_if` survives, so submissions stay correct, but Otherwise is no longer kept up to date.
  Recovery: the new builder regroups identical branches with `groupIntoPaths`, and path names fall back to the
  answer labels.
- **The checks live only in the app layer.** With no database patch, a writer that skips `cleanQuestions` (for
  example a future AI-builder tool that edits questions) could store `show_if` rules that no longer match the
  drawn paths. Then submissions follow the stored rules, not the paths people see, and could skip a required
  question someone expects. "Put this path together" can't fix that. Mitigations:
  - Every writer goes through `cleanQuestions`, which recomputes each path question's `show_if` from its path (other branches are kept as stored).
  - The builder flags a path whose stored rules disagree with it when the form opens.
  - The database check comes with Phase 2.
- **Review size.** This is a large UI batch. Keeping it in new files and landing core first keeps the diff easy to
  review.
- **The embed.** Sizing itself needs the new snippet pasted into the Marketing Request Forms hub. If the hub is a
  tool that strips scripts (Notion and some site builders do), the snippet can't run there, and forms stay at a
  fixed 900 px as today.
- **The AI-builder port.** The form files are the same on both branches today, so it should apply cleanly.

---

## 7. Decisions for Avi

1. **Approve batch 43 as in §5:** paths plus the builder fixes, with no database change. Phase 2 (conditions on
   any answer, ending the form early) waits. *Recommended: yes.*
2. **Does any real form need Phase 2?** That means a question that depends on a number, a date, or two answers
   together, or a path that ends the form early. If none comes to mind, Phase 2 stays parked.

**Defaults this review picks.** These were the open questions in `form-branching.md` §7. Each stands unless Avi
says otherwise:

- Multiple choice shows every matching path. That's what the walk does today.
- Otherwise is added when splitting, as long as some answers are left over.
- There's no "jump to question N".
- Limits are 6 paths and 3 levels.
- Checkboxes don't split into paths.
- "Path taken" is covered by mapping the split question to a field.

**One action, not a decision:** once batch 43 ships, paste the new embed snippet into the Marketing Request Forms
hub so embedded forms size themselves.
