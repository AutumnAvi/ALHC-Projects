// Oct 26 notes (batch 4), teams: only a team's members (and workspace admins) see inside it. Everyone else
// gets "You're not part of this team" with Join team (the default team) or Request to join; the team's
// leads add or decline people who asked on its Members tab. Teams lost their Messages tab, and the Inbox
// leaves out team message items. The SQL side is pinned by supabase/tests/zz33_oct26_batch4_smoke.sql.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { ShellProvider } from "@/components/shell/shell-context";
import { NoTeamAccess } from "@/components/teams/no-team-access";
import { TeamHeader } from "@/components/teams/team-header";
import { TeamMembers, addMemberHelp } from "@/components/teams/team-members";
import { teamPickRows } from "@/components/teams/team-person-picker";
import { ToastProvider } from "@/components/toast";
import type { TeamPerson } from "@/lib/data";
import { withoutTeamMessages } from "@/lib/inbox";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";
import {
  TEAM_TABS,
  parseTeamAccessStatus,
  projectsToAddToTeam,
  teamMemberCandidates,
  type TeamJoinRequest,
} from "@/lib/teams";
import type { ProjectRole } from "@/lib/roles";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const member = { id: "me", email: "me@example.com", name: "Me", avatarUrl: null };

function render(node: ReactNode, { admin = false, pathname = "/teams/t1/members" } = {}) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value={pathname}>
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <ShellProvider
            member={member as never}
            isWorkspaceAdmin={admin}
            workspace={{ name: "ALHC", logoUrl: null }}
            initialSidebar={DEFAULT_SIDEBAR_PREFS}
          >
            <ToastProvider>{node}</ToastProvider>
          </ShellProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

const lead: TeamPerson = { profileId: "me", role: "lead", name: "Me", email: "me@example.com", addedAt: "2026-10-01T10:00:00Z" };
const plain: TeamPerson = { profileId: "p2", role: "member", name: "Pat", email: "pat@example.com", addedAt: "2026-10-02T10:00:00Z" };
const request: TeamJoinRequest = {
  id: "r1",
  profileId: "p9",
  name: "Oscar Asker",
  email: "oscar@example.com",
  requestedAt: "2026-10-26T09:00:00Z",
};

function membersTab(canManage: boolean, requests: TeamJoinRequest[] = [request]) {
  return (
    <TeamMembers
      teamId="t1"
      teamName="Design"
      members={canManage ? [lead, plain] : [{ ...lead, role: "member" }, { ...plain, role: "lead" }]}
      viewerId="me"
      canManage={canManage}
      isDefault={false}
      invites={[]}
      resendable
      candidates={[{ id: "p3", name: "Quinn", email: "quinn@example.com" }]}
      requests={requests}
    />
  );
}

test("parseTeamAccessStatus: anything unknown is a real Not found", () => {
  for (const status of ["member", "can_join", "can_request", "requested", "missing"] as const) {
    assert.equal(parseTeamAccessStatus(status), status);
  }
  assert.equal(parseTeamAccessStatus("lead"), "missing");
  assert.equal(parseTeamAccessStatus(""), "missing");
  assert.equal(parseTeamAccessStatus(null), "missing");
  assert.equal(parseTeamAccessStatus(undefined), "missing");
});

test("the not-part-of-this-team page: Join team for the default team", () => {
  const html = render(<NoTeamAccess teamId="t1" teamName="Autumn Lake" status="can_join" />);
  assert.match(html, /You’re not part of this team/);
  assert.match(html, /Autumn Lake/);
  assert.equal(html.match(/<button/g)?.length, 1);
  assert.match(html, />Join team</);
  assert.doesNotMatch(html, /Request to join/);
  assert.match(html, /href="\/teams"/);
});

test("the not-part-of-this-team page: Request to join for any other team", () => {
  const html = render(<NoTeamAccess teamId="t1" teamName="Design" status="can_request" />);
  assert.match(html, /You’re not part of this team/);
  assert.match(html, /Design/);
  assert.equal(html.match(/<button/g)?.length, 1);
  assert.match(html, />Request to join</);
  assert.doesNotMatch(html, /Join team/);
  assert.doesNotMatch(html, /Request sent/);
});

test("after asking, the page says the request was sent and offers no button", () => {
  const html = render(<NoTeamAccess teamId="t1" teamName="Design" status="requested" />);
  assert.match(html, /You’re not part of this team/);
  assert.match(html, /Request sent/);
  assert.doesNotMatch(html, /<button/);
  // Nothing about who is in the team.
  assert.doesNotMatch(html, /member(s)? ·|people/);
});

test("Members tab: a lead sees who asked to join, with Add and Decline", () => {
  const html = render(membersTab(true));
  assert.match(html, /Asked to join/);
  assert.match(html, /Oscar Asker/);
  assert.match(html, /oscar@example\.com/);
  assert.match(html, /aria-label="Decline Oscar Asker’s request"/);
  assert.match(html, /aria-label="Team role for Oscar Asker"/);
});

test("Members tab: a member who doesn't manage the team never sees requests or the add row", () => {
  const html = render(membersTab(false));
  assert.doesNotMatch(html, /Asked to join/);
  assert.doesNotMatch(html, /Oscar Asker/);
  assert.doesNotMatch(html, /id="team-member-person"/);
  assert.match(html, /Pat/);
});

test("Members tab: no requests, no section", () => {
  const html = render(membersTab(true, []));
  assert.doesNotMatch(html, /Asked to join/);
});

test("Members tab: people are added from a picker (no typed email box)", () => {
  const html = render(membersTab(true));
  assert.match(html, /id="team-member-person"/);
  assert.match(html, /Search by name or email/);
  assert.doesNotMatch(html, /type="email"/);
  assert.match(html, /Pick someone in the workspace\. To add someone new to the workspace, ask a workspace admin\./);
  const admin = render(membersTab(true), { admin: true });
  assert.match(admin, /type a new email address/);
  assert.notEqual(addMemberHelp(true), addMemberHelp(false));
});

test("the add-member picker: people by name or email; only admins can invite a new address", () => {
  const people = [
    { id: "a", name: "Alex Doe", email: "alex@example.com" },
    { id: "b", name: "Blair Roe", email: "blair@example.com" },
  ];
  assert.deepEqual(
    teamPickRows(people, "roe", { allowNewEmail: false }).map((r) => (r.kind === "person" ? r.person.id : r.email)),
    ["b"],
  );
  assert.deepEqual(
    teamPickRows(people, "ALEX@example", { allowNewEmail: false }).map((r) => (r.kind === "person" ? r.person.id : r.email)),
    ["a"],
  );
  assert.equal(teamPickRows(people, "", { allowNewEmail: false }).length, 2);
  // A brand-new address: workspace admins only.
  assert.deepEqual(teamPickRows(people, "new@example.com", { allowNewEmail: false }), []);
  assert.deepEqual(teamPickRows(people, " New@Example.com ", { allowNewEmail: true }), [{ kind: "email", email: "new@example.com" }]);
  // Never for someone listed, already on the team, or invited.
  assert.deepEqual(
    teamPickRows(people, "alex@example.com", { allowNewEmail: true }).map((r) => r.kind),
    ["person"],
  );
  assert.deepEqual(teamPickRows(people, "pat@example.com", { allowNewEmail: true, takenEmails: ["Pat@example.com"] }), []);
  assert.deepEqual(teamPickRows(people, "not-an-email", { allowNewEmail: true }), []);
});

test("teamMemberCandidates: everyone not on the team yet, by name", () => {
  const people = [
    { id: "z", name: "Zed", email: "z@example.com" },
    { id: "me", name: "Me", email: "me@example.com" },
    { id: "a", name: "Ann", email: "a@example.com" },
  ];
  assert.deepEqual(
    teamMemberCandidates(people, ["me"]).map((p) => p.id),
    ["a", "z"],
  );
});

test("projectsToAddToTeam: live projects in other teams that the viewer owns or is an admin of", () => {
  const projects = [
    { id: "own", archived_at: null, team_id: "other" },
    { id: "admin", archived_at: null, team_id: "other" },
    { id: "editor", archived_at: null, team_id: "other" },
    { id: "here", archived_at: null, team_id: "t1" },
    { id: "archived", archived_at: "2026-10-01T00:00:00Z", team_id: "other" },
    { id: "stranger", archived_at: null, team_id: "other" },
  ];
  const roles = new Map<string, ProjectRole>([
    ["own", "owner"],
    ["admin", "admin"],
    ["editor", "editor"],
    ["here", "owner"],
    ["archived", "owner"],
  ]);
  assert.deepEqual(
    projectsToAddToTeam(projects, roles, "t1").map((p) => p.id),
    ["own", "admin"],
  );
});

test("teams have no Messages tab any more", () => {
  assert.deepEqual(
    TEAM_TABS.map((t) => t.key),
    ["overview", "members", "work", "calendar"],
  );
  const html = render(
    <TeamHeader teamId="t1" name="Design" members={[{ profileId: "me", name: "Me" }]} canManage isDefault={false} />,
    { pathname: "/teams/t1" },
  );
  assert.doesNotMatch(html, /\/teams\/t1\/messages/);
  assert.doesNotMatch(html, />Messages</);
});

test("the team header shows a count of requests on Members for the people who decide", () => {
  const html = render(
    <TeamHeader teamId="t1" name="Design" members={[{ profileId: "me", name: "Me" }]} canManage isDefault={false} requestCount={2} />,
    { pathname: "/teams/t1" },
  );
  assert.match(html, /2 people asked to join/);
  const none = render(
    <TeamHeader teamId="t1" name="Design" members={[]} canManage={false} isDefault={false} />,
    { pathname: "/teams/t1" },
  );
  assert.doesNotMatch(none, /asked to join/);
});

test("the Inbox leaves out team message items (they'd link to the removed tab)", () => {
  const items = [
    { id: "task", teamMessage: null },
    { id: "team", teamMessage: { id: "m1", threadId: "m1", teamId: "t1", teamName: "Design" } },
    { id: "project-message", teamMessage: null },
  ];
  assert.deepEqual(
    withoutTeamMessages(items).map((i) => i.id),
    ["task", "project-message"],
  );
});
