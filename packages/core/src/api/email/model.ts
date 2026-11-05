// Big move 1: the email area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).
import type { DeliveryStatus } from "../../email-schedules";

export type WorkspaceEmailDelivery = {
  id: string;
  kind: string;
  recipient: string;
  inWorkspace: boolean;
  status: string;
  deliveryStatus: DeliveryStatus | null;
  deliveryDetail: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  deliveryEventAt: string | null;
  suppressed: boolean;
};

export type WorkspaceEmailSummary = {
  sent: number;
  delivered: number;
  delayed: number;
  bounced: number;
  complained: number;
  failed: number;
  waiting: number;
  suppressedAddresses: number;
};

export type EmailSuppression = {
  id: string;
  email: string;
  inWorkspace: boolean;
  reason: string;
  detail: string | null;
  emailKind: string | null;
  createdAt: string;
};
