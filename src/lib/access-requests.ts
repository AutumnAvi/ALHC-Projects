// Oct 26 notes (batch 3): asking to be added to a project. Mirrors 20261026010000_oct26_batch3_a.sql:
// project_access_status() says what the not-a-member page shows, request_project_access() asks, and the
// project's owners decide from the Inbox or Share (decide_project_access_request()).

// "missing" = deleted or never existed: a real Not found. Everything else is the not-a-member page.
export const ACCESS_STATUSES = ["member", "can_request", "requested", "archived", "missing"] as const;
export type ProjectAccessStatus = (typeof ACCESS_STATUSES)[number];

export function parseAccessStatus(value: unknown): ProjectAccessStatus {
  return typeof value === "string" && (ACCESS_STATUSES as readonly string[]).includes(value)
    ? (value as ProjectAccessStatus)
    : "missing";
}

// A role an owner can give when approving ("default" = the person's own default project role).
export const ACCESS_GRANT_ROLES = ["default", "editor", "commenter", "viewer"] as const;
export type AccessGrantRole = (typeof ACCESS_GRANT_ROLES)[number];
export function isAccessGrantRole(value: unknown): value is AccessGrantRole {
  return typeof value === "string" && (ACCESS_GRANT_ROLES as readonly string[]).includes(value);
}

// An open request, as Share lists it for the project's owners.
export type ProjectAccessRequest = {
  id: string;
  profileId: string;
  name: string;
  email: string;
  requestedAt: string;
};

export type AccessRequestState = "pending" | "approved" | "declined";

// What an Inbox item says about a request: the owners' "asked to be added" items carry
// data.access_request (+ the request's current state, kept up to date by the database), the requester's
// "added you" item data.access_granted.
export type InboxAccessRequest = {
  requestId: string;
  requesterName: string;
  requesterEmail: string | null;
  status: AccessRequestState;
  grantedRole: string | null;
};

function record(data: unknown): Record<string, unknown> | null {
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
}

export function accessRequestOf(data: unknown): InboxAccessRequest | null {
  const d = record(data);
  if (!d || d.access_request !== true || typeof d.access_request_id !== "string") return null;
  const status = d.access_request_status;
  return {
    requestId: d.access_request_id,
    requesterName: typeof d.requester_name === "string" && d.requester_name ? d.requester_name : "Someone",
    requesterEmail: typeof d.requester_email === "string" ? d.requester_email : null,
    status: status === "approved" || status === "declined" ? status : "pending",
    grantedRole: typeof d.granted_role === "string" ? d.granted_role : null,
  };
}

export function isAccessGranted(data: unknown): boolean {
  return record(data)?.access_granted === true;
}
