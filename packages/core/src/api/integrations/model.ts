// Big move 1: the integrations area's types (no database access; safe to import anywhere, the browser
// included).

// An inbound webhook endpoint's settings as Settings → Inbound sends them.
export type InboundEndpointInput = {
  name: string;
  sectionId: string | null;
  assigneeId: string | null;
  tagIds: string[];
};
