// Big move 1: one add-by-email call, shared by project, portfolio, and team members.
import type { ApiContext, Db } from "../core/context";
import { check, type QueryResult } from "../core/db";

// pending: they haven't signed in yet — the membership waits for their first sign-in. emailed: this call
// queued an invite email with a sign-up link and an email provider is set up (Real features 1; never
// before this release's database update, for a re-invite, or past the per-address cap). alreadyInvited:
// they had an invite here already (only its role changed). joinedWorkspace: a workspace admin's invite
// also added the address to the workspace.
export type InviteOutcome = { pending?: boolean; emailed?: boolean; alreadyInvited?: boolean; joinedWorkspace?: boolean };

// add_project_member / add_portfolio_member / add_team_member: the database decides (a pending invite and
// its email for someone who hasn't signed in; a new address only from a workspace admin); this reports
// what happened. `emailConfigured`: whether this deployment can send email (the caller's to know).
export async function inviteByEmail(
  ctx: ApiContext,
  address: string,
  target: { column: "project_id" | "portfolio_id" | "team_id"; id: string },
  call: (db: Db) => PromiseLike<QueryResult<unknown>>,
  options: { notAllowed?: string; emailConfigured: boolean },
): Promise<InviteOutcome> {
  const supabase = ctx.db;
  // The invite emails to this address the caller can see (RLS: the ones for invites they manage).
  const inviteEmails = async () => {
    const { count } = await supabase
      .from("email_outbox")
      .select("id", { count: "exact", head: true })
      .eq("to_email", address)
      .is("task_id", null)
      .eq("payload->>kind", "invite");
    return count ?? 0;
  };
  const [allowed, invited, emailsBefore] = await Promise.all([
    supabase.from("allowed_emails").select("email").eq("email", address).is("removed_at", null).maybeSingle(),
    supabase
      .from("pending_memberships")
      .select("id")
      .eq(target.column, target.id)
      .eq("email", address)
      .is("applied_at", null)
      .is("deleted_at", null)
      .maybeSingle(),
    inviteEmails(),
  ]);
  const added = await call(supabase);
  check(added, options.notAllowed);
  const pending = added.data === null;
  return {
    pending,
    emailed: pending && options.emailConfigured && (await inviteEmails()) > emailsBefore,
    alreadyInvited: pending && Boolean(invited.data),
    joinedWorkspace: !allowed.error && !allowed.data,
  };
}
