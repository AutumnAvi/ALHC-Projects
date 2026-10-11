# Asana parity notes (Avi, from hands-on use)

Running list. Each note becomes part of the "Exactly like Asana" phase(s).

## 2026-10-08

1. **Project header = views only.** The top tab bar should hold only the ways to view tasks (List, Board, Timeline, Calendar, etc.) plus Files. Rules, Forms, Fields, and similar move behind a **Customize** button at the top right, as in Asana. Its panel holds Fields, Forms, Rules/automations, Emails, Apps, Task types and templates, Bundles, Status templates, and so on.
2. **Clicking a task row opens the task.** Clicking anywhere on a row should open a compact task pane on the right, with a button to expand it to full size. The bottom "1 selected" bulk bar should appear only when you use the checkboxes on the left (multi-select).
3. **Workspace settings are too thin.** They need real depth, using Asana's admin and workspace settings as the model.
4. **Allowlist has no UI.** Adding a member failed with "not on the workspace allowlist ... managed in SQL (allowed_emails)". Workspace admins need a screen to add and remove allowed emails, including inviting new people. (admin@autumnlakemarketing.com was added by hand on 2026-10-08.)
5. **Tags in workspace settings are confusing.** It's unclear what they are for. The British spelling "Colour" should be "Color" everywhere. The color picker shows only words, so it needs a color swatch next to each name.
6. **List view columns.** The Task column takes up too much space, and only Assignee and Due are shown. It needs more default columns (custom fields too), tighter widths, horizontal scrolling, and drag-to-resize columns, like Asana's List view.
7. **Overall: a true replica, not "similar features, arranged differently".** Layout, placement, naming, and interaction patterns should match Asana. Plan: do a screen-by-screen comparison against real Asana before building.
8. **Login page.** One email field with both Sign in and Sign up buttons is confusing. Split them into separate Sign in and Sign up screens.
9. **Sign-up confirmation is a dead end.** New email/password accounts get "Email not confirmed", and no confirmation email arrives, because Supabase Auth SMTP isn't set up (that needs Chief). Fix this with Resend SMTP for Auth, or by auto-confirming allowlisted emails. (admin@ was confirmed by hand on 2026-10-08.)
10. **Sidebar "+" for projects and portfolios.** It opens an inline name box with a big Create button that doesn't close when you click away, and it feels off. Match Asana: "+" opens a proper New project flow (blank, template, or import), and New portfolio opens a modal.
11. **Adding tasks.** The add-task control is just a thin bar. In My Tasks, an empty list puts Add task at the top, but the new task then shows up in the normal sections. Match Asana's inline add-task row inside each section, with the "+ Add task" button in the toolbar.
12. **Teams are optional, and membership isn't visible.** The workspace has 0 teams, so "adding to the team" did nothing visible. In Asana every project belongs to a team. Require a team, create a default team for the workspace, put new members in it, and show who joined.
13. **Admin visibility.** A user named "admin" isn't a workspace admin and isn't on any project, so they see nothing. The roles need to be clearer: show each person's role in settings, and let admins browse every project they're allowed to see (Asana's "Browse projects"). Workspace settings look different for the two accounts because only one of them is a workspace admin. That should be obvious from the screen itself.
14. **Bulk bar Assign popover gets cut off** at the right edge of the screen. The assignee search only lists project members, so a workspace member who isn't on the project can't be found. Match Asana: search the whole workspace, and assigning someone adds them to the project (with a confirmation).
15. **Text inputs feel rigid.** Inputs and text boxes look square and boxy. Avi wants softer, nicer-looking inputs (Asana-style).
16. **Full UI redesign, later.** When the time is right, study how Asana is actually designed (spacing, type, inputs, panels, colors) and do a full redesign with Claude Code based on that study.
17. **Branding.** Make the notification emails look nicer with an ALHC logo and branded layout, and add the logo to the website too. (Later.)
