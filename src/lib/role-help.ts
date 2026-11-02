// Nov 2 notes (batch 15, 109): the "Roles & permissions" help page (/help/roles) in plain words. One
// table per kind of role. It mirrors what the database enforces (RLS and the role checks in the RPCs; see
// "Teams & permissions model" in AGENTS.md) — the database stays the trust boundary, this only explains.

export const ROLES_HELP_HREF = "/help/roles";

export type RoleColumn = { key: string; label: string; note?: string };
export type CapabilityRow = { label: string; detail?: string; allowed: Record<string, boolean> };
export type RoleTable = { id: string; title: string; intro: string; columns: RoleColumn[]; rows: CapabilityRow[] };

const row = (label: string, keys: string[], allowed: string[], detail?: string): CapabilityRow => ({
  label,
  detail,
  allowed: Object.fromEntries(keys.map((k) => [k, allowed.includes(k)])),
});

const WORKSPACE = ["admin", "member"];
const PROJECT = ["owner", "editor", "commenter", "viewer"];
const PORTFOLIO = ["owner", "admin", "editor", "viewer"];
const TEAM = ["lead", "member"];

export const ROLE_TABLES: RoleTable[] = [
  {
    id: "workspace-roles",
    title: "Workspace roles",
    intro:
      "Everyone in the workspace is a Member or an Admin. A workspace role decides what you manage in the app — it never opens a project. Project access always comes from your project role.",
    columns: [
      { key: "admin", label: "Admin" },
      { key: "member", label: "Member" },
    ],
    rows: [
      row("Sign in, create projects, portfolios, teams, and goals", WORKSPACE, ["admin", "member"]),
      row("See the teams directory and browse public-to-team projects of your teams", WORKSPACE, ["admin", "member"]),
      row("Invite new people to the workspace, remove them, add them back", WORKSPACE, ["admin"]),
      row("Make people workspace admins", WORKSPACE, ["admin"]),
      row("Set each person's role when they're added to new projects", WORKSPACE, ["admin"]),
      row("Workspace settings: name, logo, default team, tags, goals, Commenter role, verified domains, Slack", WORKSPACE, ["admin"]),
      row("Open the Admin console", WORKSPACE, ["admin"]),
      row("Manage every team and every project template", WORKSPACE, ["admin"]),
      row(
        "Open a private project they aren't a member of",
        WORKSPACE,
        [],
        "Nobody can — not even workspace admins. Ask the project's Owner to add you.",
      ),
    ],
  },
  {
    id: "project-roles",
    title: "Project roles",
    intro:
      "Your role in one project. Each project gives each person one of these; you can have a different role in every project. A task in several projects uses your best role among them.",
    columns: [
      { key: "owner", label: "Owner" },
      { key: "editor", label: "Editor" },
      { key: "commenter", label: "Commenter", note: "Only when the workspace has the Commenter role turned on" },
      { key: "viewer", label: "Viewer" },
    ],
    rows: [
      row("See the project, its tasks, views, files, dashboard, and activity; export CSV", PROJECT, ["owner", "editor", "commenter", "viewer"]),
      row("Be assigned tasks and get notified", PROJECT, ["owner", "editor", "commenter", "viewer"]),
      row("Comment, react, follow tasks, and approve when you're the approver", PROJECT, ["owner", "editor", "commenter"]),
      row("Create, edit, complete, and move tasks and subtasks", PROJECT, ["owner", "editor"]),
      row("Delete tasks (to the Trash) and restore them", PROJECT, ["owner", "editor"]),
      row("Add files, tags, dependencies, and custom field values", PROJECT, ["owner", "editor"]),
      row("Add, rename, and remove sections and fields; add views and dashboard widgets", PROJECT, ["owner", "editor"]),
      row("Hide or show project tabs", PROJECT, ["owner", "editor"]),
      row("Save your own version of a view", PROJECT, ["owner", "editor", "commenter", "viewer"]),
      row("Save a view as the default for everyone; change the default view", PROJECT, ["owner"]),
      row("Fill project roles (Approver, Designer, …) and link them to tasks", PROJECT, ["owner", "editor"]),
      row("Automations, forms, task numbering, integrations, project settings, Asana import", PROJECT, ["owner"]),
      row("Invite people, change their roles, remove them", PROJECT, ["owner"]),
      row("Lock section order; archive, transfer, or delete the project", PROJECT, ["owner"]),
    ],
  },
  {
    id: "portfolio-roles",
    title: "Portfolio roles",
    intro:
      "A portfolio groups projects. Its role never opens a project: you only see the projects in it that you can open yourself.",
    columns: PORTFOLIO.map((key) => ({ key, label: key[0].toUpperCase() + key.slice(1) })),
    rows: [
      row("See the portfolio and the projects in it you can open", PORTFOLIO, PORTFOLIO),
      row("Rename it, edit notes, add, remove, and reorder projects", PORTFOLIO, ["owner", "admin", "editor"]),
      row("Invite people and change their roles", PORTFOLIO, ["owner", "admin"]),
      row("Transfer ownership or delete the portfolio", PORTFOLIO, ["owner"]),
    ],
  },
  {
    id: "team-roles",
    title: "Team roles",
    intro: "Teams are groups of people. Being on a team never opens a project; it lets you find and join the team's public projects.",
    columns: [
      { key: "lead", label: "Lead" },
      { key: "member", label: "Member" },
    ],
    rows: [
      row("See the team's members, work, and calendar", TEAM, TEAM),
      row("Join the team's public-to-team projects (as Editor)", TEAM, TEAM),
      row("Pin curated work", TEAM, TEAM),
      row("Rename the team, add and remove members, decide join requests", TEAM, ["lead"]),
    ],
  },
];

// Project roles from batch 14 (Approver, Designer, …) are names for "who does what", not permissions.
export const NAMED_ROLES_NOTE =
  "Named project roles (Approver, Designer, Lead, …, on a project's Overview) say who does what — they fill in assignees, approvers, and followers. They don't change what anyone can do: that's always the person's project role above.";
