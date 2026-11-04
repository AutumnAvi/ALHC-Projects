// Big move 1: the workspace area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).
import type { DeliveryStatus } from "@/lib/email-schedules";

export type Workspace = {
  id: string;
  name: string;
  defaultTeamId: string | null;
  logoPath: string | null;
  // Public URL of the logo (the workspace-assets bucket is public), or null.
  logoUrl: string | null;
  emailSenderName: string | null;
};

export type MemberActivity = { signedInAt: string | null; activeAt: string | null };

export type InviteDelivery = {
  id: string;
  email: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
  // What Resend reported after sending (Real features 3).
  deliveryStatus: DeliveryStatus | null;
};

export type CommenterMember = {
  profileId: string;
  name: string;
  email: string;
  projectCount: number;
  // Only projects the viewer can open; the rest are a count.
  projects: { id: string; name: string }[];
};

// ---------------------------------------------------------------------------------------------
// Nov 1 notes, item 69: verified email domains and request email conversations
// ---------------------------------------------------------------------------------------------

export type VerifiedDomain = { id: string; domain: string; createdAt: string };
