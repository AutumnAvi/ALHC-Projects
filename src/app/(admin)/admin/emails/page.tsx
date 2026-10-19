import type { Metadata } from "next";
import { AdminPage } from "@/components/admin/admin-chrome";
import { EmailDesignEditor } from "@/components/email-designs/email-design-editor";
import { requireWorkspaceAdmin } from "@/lib/admin-guard";
import { listEmailDesigns } from "@/lib/data";
import { EMAIL_DESIGN_KINDS, EMAIL_DESIGN_KIND_DESCRIPTIONS, EMAIL_DESIGN_KIND_LABELS } from "@/lib/email-design";

export const metadata: Metadata = { title: "Emails · Admin console" };

// Admin console → Emails: the workspace's default design of each kind of email. Projects (and, for
// requester emails, forms) can override any setting from their own Settings → Emails page.
export default async function AdminEmailsPage() {
  await requireWorkspaceAdmin();
  const scopes = await listEmailDesigns(null);
  return (
    <AdminPage
      title="Emails"
      description="How the workspace’s emails look. Project admins can override these for their project and its forms."
    >
      {scopes ? (
        EMAIL_DESIGN_KINDS.map((kind) => (
          <EmailDesignEditor
            key={kind}
            scope={{ kind, projectId: null, formId: null }}
            workspaceId={scopes.workspaceId}
            own={scopes.workspace[kind]?.settings ?? null}
            inherited={null}
            canEdit
            title={EMAIL_DESIGN_KIND_LABELS[kind]}
            description={EMAIL_DESIGN_KIND_DESCRIPTIONS[kind]}
          />
        ))
      ) : (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Email designs need this release’s database update.
        </p>
      )}
    </AdminPage>
  );
}
