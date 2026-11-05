// Nov 1 notes, item 69: verified email domains (Admin console → Security). Only a form submitter whose
// address is on one of them gets the reply-by-email conversation on their request (unless the
// workspace's switch is off, or a workspace admin allowed it for the request or the submitter); a form
// can also take submissions only from them. Mirrors guard_verified_email_domain() and
// submitter_conversation_info() in 20261101020000_nov1_batch9a_a.sql. Pure and server-safe.

export const SEEDED_VERIFIED_DOMAINS = ["autumnhc.net", "autumnlakemarketing.com"] as const;

const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

// "@Example.com " → "example.com"; also takes a whole address ("ana@example.com") or a URL's host.
// Null when it isn't a domain.
export function normalizeDomainInput(value: string): string | null {
  let v = (value ?? "").trim().toLowerCase();
  v = v.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (v.includes("@")) v = v.slice(v.lastIndexOf("@") + 1);
  v = v.replace(/^\.+|\.+$/g, "");
  if (v.length < 3 || v.length > 253 || !DOMAIN.test(v)) return null;
  return v;
}

export type ConversationReason = "override_request" | "override_submitter" | "setting_off" | "verified" | "unverified";

// What the task's composer says about the request's email conversation (null = nothing to say: it's on
// for the usual reason).
export function conversationNote(input: { allowed: boolean; reason: ConversationReason; email: string; domain: string }): string | null {
  if (input.allowed) {
    if (input.reason === "override_request") return `A workspace admin turned on email for this request (${input.domain} isn’t a verified domain).`;
    if (input.reason === "override_submitter") return `A workspace admin turned on email for every request from ${input.email}.`;
    return null;
  }
  if (input.reason === "override_request") return "A workspace admin turned off email for this request.";
  if (input.reason === "override_submitter") return `A workspace admin turned off email for requests from ${input.email}.`;
  return `Email conversation is off: ${input.email} isn’t on a verified domain. They submitted the form, but they don’t get emails from this task and their replies aren’t posted. Comment here as usual.`;
}
