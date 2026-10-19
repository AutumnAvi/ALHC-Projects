# Task numbering plan

Keep `request_sequences` and `tasks.req_number` / `req_project_id`. Add template, brackets, scope, subtask, reuse, reset, and per-field settings on the sequence, plus `req_subindex`, `req_path`, `req_period`, and `req_counter_key` on tasks. New `request_number_gaps` holds numbers freed after reuse is turned on.

Stop writing the prefix into `tasks.title`. One set-based update strips a leading `[label] ` from titles that already have a number. The app prepends the rendered label wherever the name is shown.

`format_request_label` and `task_request_label` become SECURITY INVOKER so RLS hides them from non-members. Suite 60's definer list drops those two. New definer RPCs check `has_project_role`: Editors+ save settings and number existing tasks; Admins run Renumber all.

The insert trigger still row-locks the sequence. Top-level tasks take the next number (lowest freed gap first when reuse is on). Subtasks get `parentPath + separator + sibling`, default on, separator `.`. Scope stays all tasks, forms only, or chosen sections / kinds. Turning numbering off stops new numbers and hides labels; stored numbers stay.

Labels render from a template (`Req #{n}` default): `{n}`, `{n:4}`, `{yyyy}` `{yy}` `{mm}`, `{field:Name}`, `{parent}`, `{project}`. Brackets default on. A yearly or monthly reset is refused unless the template has a date token. Uniqueness is (project, period, counter key, number) for top-level tasks and (parent, subindex) for subtasks. The old unique index is dropped in the TAIL.

Number existing tasks and Renumber all are one ordered UPDATE (`created_at`, `id`), not a client loop. Already-numbered tasks are skipped unless Renumber all. A task moved to another project keeps its original number.

Search matches the number, `#484`, `Req 484`, `req_path` (`484.2.1`), and the full label. Inbound subjects keep working because the label is still on the stored title only when it was already baked in; new mail matches the number in search.

UI: Project settings and Customize get a Task numbering switch. Turning it on asks "Number existing tasks too?" (default yes). Advanced stays collapsed: template with a 3-task preview, start number, reuse deleted (Trash after the switch, or fill gaps), reset, one single-select counter, subtasks, what gets numbered, and Renumber all with a typed confirm.

Migration `20261018010000_task_numbering.sql` with `-- TAIL`. Smoke suite `zz25_task_numbering_smoke.sql`. Do not apply it to the hosted database.

Oct 19 fixes (`20261019020000_oct19_notes.sql`, suite `zz28_oct19_notes_smoke.sql`): the bracket setting was saved but never read (every screen drew `[label]`). Labels stay bare in `req_label`; every surface now reads `{ label, wrap }` through `task_request_labels()` and shows it with `formatRequestLabel()` / `request_display_label()`, emails included (`email_design_context.values.request_wrap`). Also fixed: the ambiguous `ON CONFLICT` in `allocate_request_number` that broke task creation under a reset period or per-field counter, Number subtasks off/on taking effect on existing subtasks, `{parent}` current after one save, Duplicate project / templates keeping every setting, and the form no longer resending the start number on every save.
