# ALHC Projects: Asana parity spec

Source: a read-only walk-through of real Asana (NEW workspace) and of ALHC Projects on 2026-10-11, screen by screen. The screenshots stay private on Grok Bot's computer because the repo is public and they show real company tasks. Everything a builder needs is written out here.

The goal is for a person who uses Asana daily to sit down in ALHC Projects and feel at home. Same places, same names, same clicks, same density.

## 1. Visual system (biggest gap)

| | Asana | ALHC today | Change to |
|---|---|---|---|
| Shell | Dark charcoal top bar (~44px) across the full width, plus a dark left sidebar | Light grey sidebar, no top bar | Dark top bar and dark sidebar (#1e1f21-ish, light grey text, lighter active row) |
| Global create | Red/coral "+ Create" pill at the top left of the top bar. Menu: Task, Project, Message, Team, Portfolio, Goal, then a divider and Invite | None (only sidebar "+") | Add it with that exact menu |
| Search | Centered pill in the top bar, "Search <workspace>", Ctrl/Cmd+K. Dropdown has type chips (Tasks, Projects, People), Recents and Saved searches, and results update as you type | Small sidebar box, no dropdown | Top-bar pill plus command-palette dropdown with live results |
| Primary color | Blue (#4573d2-ish) for primary buttons, active tab underline, links and Share | Near-black buttons, teal accents | Blue primary; keep teal only for project colors |
| Content background | White, full width | Narrow centered columns with lots of empty space | Full-width content, no narrow max-width on list pages |
| Type | Inter-like; body 13px, meta 11-12px, page title ~20px semibold, task pane title ~24px bold | Body 12-13px, page title ~14px (too small) | Bigger page and pane titles |
| Rows | ~36px list rows (dense), 1px very light dividers, only horizontal lines in the body, faint vertical dividers in the header | Similar lines, but sparse | Match, and make the inline add-task row lighter |
| Radius | Buttons and inputs ~6px, cards 8px, pills fully round | Inputs boxy | Soft inputs: 6px, light border, soft blue focus ring |
| Field values | Colored pastel pills with dark text (red High, green New, yellow, orange) | Plain text | Colored pills for select fields everywhere (list, board cards, pane) |
| Empty cells | Dashed person icon (assignee) and dashed calendar icon (date) show on hover | Blank | Match |
| Icons | Thin outline 16px | Lucide outline (fine) | Keep Lucide |

## 2. Sidebar

Asana's order is: Home, My tasks, Inbox, then Projects, Portfolios and Goals (top-level links), then a collapsible "Starred" section, then a collapsible "Projects" (or team) section with a "+" button. Projects show a small rounded-square colored icon, and long names get an ellipsis. "Invite" is pinned at the bottom, and the profile avatar menu sits at the bottom or top right.

- Rename "My Tasks" to "My tasks" (Asana uses sentence case everywhere).
- Add Starred (with a star toggle on the project header).
- Use project icons as colored rounded squares, not dots.
- Move Reports, Teams and Templates under a "More" area or the Insights group; keep the top list short like Asana.
- Profile avatar menu: Profile, Settings, Admin console (admins only), Invite, Log out.

## 3. Project header and tabs

Asana layout: project icon, name, chevron (menu), star, "Set status" (dropdown with On track, At risk, Off track, On hold, Complete). On the right: member avatars, a blue **Share** button and **Customize**.
- The status pill opens a dropdown in place. Picking a value opens a small "status update" panel (title, summary) in a right panel, not the settings page.
- Add a **Share** dialog (modal): "Invite with email" (people, emails or teams) with a role dropdown and an Invite button, a "Notify when tasks are added" checkbox, an access setting (workspace, team or private), a "Who has access" list with role dropdowns, and "Copy project link". Members settings stay too, but Share is the main entry.
- Tabs: **Overview**, List, Board, Timeline, Calendar, Dashboard, Messages, Workload, Files, "+". Overview has the project description, Project roles (owner and members), connected goals, and on the right "What's the status?" plus a project activity timeline.
- Toolbar on one line: a blue split "Add task" button (with a dropdown for Add section / Add milestone) on the left; Filter, Sort, Group, Options and a search icon on the right (search expands when clicked). Move "Show completed", "Show subtasks", "Columns" and "Export CSV" into **Options**.

## 4. List view

- Columns: Name (wide, sticky), then all project fields. Header cells get a chevron menu on hover (sort, hide, move left/right, edit field), drag-to-resize borders, and a "+" at the far right to add a field.
- Section header: chevron, name (editable), and on hover a "+" and "..." menu.
- Row hover: grey fill, a 6-dot drag handle at the far left, the title gets an edit outline, and a ">" details arrow at the end of the name cell. The complete circle is always visible. Comment and attachment counts show next to the title.
- Clicking the row or the ">" opens the task pane. Clicking the title edits it inline.
- The inline "Add task" row is grey text, indented to the name column, with no icon.
- Overdue dates are red, today and tomorrow are green.

## 5. Task pane

- Opens on the right at about 45% of the content width; the list narrows to fit.
- Header actions: "✓ Mark complete" (outlined button that turns green), assignee avatar, attachments, subtask, copy link, expand to full screen, "...", and close (→|).
- Title ~24px bold, edited inline.
- Field rows are a two-column grid (label ~120px grey, then value): Assignee, Due date (one date field with optional start date and time inside the picker, not two inputs), Projects (project chip + section dropdown, "Add to projects"), Dependencies, then custom fields as pills. "Show N more" collapses extra fields.
- Then Description (borderless until focused), Subtasks (with "Add subtask"), Attachments as cards.
- Comments area: tabs "Comments" and "All activity", oldest first.
- Footer: comment box "Add a comment" with icons, plus a collaborators row: "Collaborators" avatars, "+" and "Leave task". Make it compact; ours takes too much height.
- Move Repeats, Type and Approvals into the date picker or the "..." menu, the way Asana does, so the top of the pane stays clean.
- Full screen (expand): a centered wide card with the sidebar hidden and the same layout.

## 6. Board, Timeline, Calendar

- Board columns are ~280px wide on light grey, with white cards that have a soft shadow and 8px radius. Cards show field pills, an assignee avatar, a due date, and subtask and comment counts. "+ Add task" sits at the top of each column (and at the bottom on hover). There's an "Add section" column at the end.
- Timeline: zoom presets (Days, Weeks, Months, Quarters), "Today", and a "No date (N)" drawer. Bars use project colors and show the task name inside or next to the bar.
- Calendar: a "Weeks"/"Months" dropdown, "Today", and today shown as a blue circle.

## 7. Customize panel

The right panel (~320px) shows a list of bordered rounded card rows, each with an icon, a label with a count, and a ">":
- Automations (rules)
- Fields
- Forms
- Emails
- Apps (Slack, webhooks, inbound)
- Task types and templates
- Status templates (optional)

Each row opens its own sub-view inside the panel, with a back arrow. Our Members, General, Import and Trash entries move to the project "..." menu or Share.

## 8. Forms, Rules, Fields

- **Edit form** is a large modal. The left side is a live preview of the form (banner, title, description, questions). The right side has "Questions" and "Settings" tabs and a "+ New question" button with types (field-based questions, Email, Attachment, Heading, text, single and multi select, date). Questions can branch: "if answer is X, show". The header shows who can submit, plus View form, Share form and Copy link.
- **Rule builder** is a full-page canvas. The header has the name, an Active toggle, Cancel and Save, and Build / Activity tabs. The flow reads: scope, then "Trigger", then optional "Check if / Else if" branches, then action cards, with "+ Add branch".
- **Fields** list: type icon, name, option preview. The **Edit field** modal has a title, type, description, options with color dots, "Add to field library" and "Notify collaborators when changed".

## 9. Create flows

- **New project** is a full-screen "Template gallery": Import and "Blank project" buttons at the top right, category pills, "Your templates", and template cards. "Blank project" shows a form on the left (Project name, Team, Privacy) and a live preview on the right, then Continue. Remove the inline "Start a project" form from Home.
- **New portfolio** and **New goal** open modals. Remove the inline name boxes from those pages.
- **Browse projects** is a table with search, filter pills (Owner, Members, Teams, Status), columns Name, Members, Last modified, and a "Joined" or "Join" button per row. It also needs a blue "+ Create project" button.

## 10. Inbox

Tabs: Activity, Bookmarks, Archive, @Mentioned. The toolbar has Filter, Sort and Density, plus a "Manage notifications" link. Notifications are cards grouped by day with an unread dot. Clicking one opens the task in the right pane. Use a centered column ~600px wide.

## 11. Teams and people

- Team page tabs: Overview, Members, All work, Messages, Calendar. The Overview has a description, a "Curated work" list, a Members card and a Goals card.
- The **Admin console** is a separate full page for workspace admins, with a left nav: Users (tabs All, Members, Invited, Removed; columns Name, Role, Status, Last activity, Invited by, Invited date; Invite users), Teams, Security (sign-in methods, allowlist), Organization (name, logo, default team), Email (sender, Deliveries) and Tags.
- **Settings** is a modal dialog with tabs: Profile, Notifications, Email forwarding (later), Account, Display. It replaces the profile settings page.

## 12. Home

Greeting ("Good afternoon, <name>"), then widgets: My tasks (Upcoming / Overdue / Completed tabs), Projects (recent, with "Create project"), and People (later). The page is full width with a 2-column widget grid.

## Build order (each one is a Claude Code batch)

1. **Shell and visual system:** dark top bar with Create and search, dark sidebar, blue primary color, type scale, soft inputs, colored pills, the Settings modal and avatar menu. This alone changes the feel the most.
2. **Project page:** header (status dropdown, Share dialog, star, Overview tab), toolbar with Options, the List view details (header menus, row hover, counts, dashed placeholders) and the board card polish.
3. **Task pane:** the layout above, compact footer, full screen view.
4. **Create flows and Customize:** the template-gallery new project, modals for portfolio and goal, Browse projects table, Customize sub-views, the form editor and the rule canvas restyle.
5. **Inbox, Home, Teams, Admin console.**
