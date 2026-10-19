import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FileText } from "lucide-react";
import { EmailDesignEditor } from "@/components/email-designs/email-design-editor";
import { EmptyState } from "@/components/ui";
import { getProject, getProjectRole, listEmailDesigns, listProjectForms } from "@/lib/data";
import {
  EMAIL_DESIGN_KINDS,
  EMAIL_DESIGN_KIND_DESCRIPTIONS,
  EMAIL_DESIGN_KIND_LABELS,
  resolveEmailDesign,
} from "@/lib/email-design";
import { hasRole } from "@/lib/roles";

export async function generateMetadata({ params }: PageProps<"/projects/[projectId]/settings/emails">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Emails` : "Emails" };
}

// Settings → Emails: this project's overrides of the workspace's email designs, and — for requester
// emails — each form's. Every setting inherits until it's set here. Admins+ edit; everyone else reads.
export default async function ProjectEmailsPage({ params }: PageProps<"/projects/[projectId]/settings/emails">) {
  const { projectId } = await params;
  const [project, role] = await Promise.all([getProject(projectId), getProjectRole(projectId)]);
  if (!project || !role) notFound();
  const [scopes, forms] = await Promise.all([listEmailDesigns(projectId), listProjectForms(projectId)]);
  const canEdit = hasRole(role, "admin");

  if (!scopes) {
    return (
      <div className="mx-auto max-w-5xl px-gutter py-5">
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Email designs need this release’s database update.
        </p>
      </div>
    );
  }

  const workspaceLayer = (kind: (typeof EMAIL_DESIGN_KINDS)[number]) => scopes.workspace[kind]?.settings ?? null;
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-gutter py-5">
      <div>
        <h1 className="text-base font-semibold text-zinc-900">Emails</h1>
        <p className="mt-1 text-sm text-zinc-600">
          Override the workspace’s email designs for this project. A form’s settings win over the project’s, and the
          project’s over the workspace’s.
          {canEdit ? "" : " Only project admins can change them."}
        </p>
      </div>
      {EMAIL_DESIGN_KINDS.map((kind) => (
        <EmailDesignEditor
          key={kind}
          scope={{ kind, projectId, formId: null }}
          workspaceId={scopes.workspaceId}
          own={scopes.project[kind]?.settings ?? null}
          inherited={resolveEmailDesign(kind, { workspace: workspaceLayer(kind) })}
          canEdit={canEdit}
          title={`${EMAIL_DESIGN_KIND_LABELS[kind]} in this project`}
          description={EMAIL_DESIGN_KIND_DESCRIPTIONS[kind]}
        />
      ))}

      <section aria-labelledby="form-designs-heading" className="space-y-3">
        <div>
          <h2 id="form-designs-heading" className="text-sm font-semibold text-zinc-900">
            Requester emails per form
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            Confirmations and responses about a form’s requests can look different from the project’s.
          </p>
        </div>
        {forms.length === 0 ? (
          <EmptyState icon={FileText} title="No forms yet" size="inline">
            Forms you add in Customize → Forms can each have their own requester email design.
          </EmptyState>
        ) : (
          forms.map((form) => (
            <details key={form.id} className="group rounded-lg" open={Boolean(scopes.forms[form.id])}>
              <summary className="cursor-pointer rounded-md px-1 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50">
                {form.title}
                <span className="ml-2 text-xs font-normal text-zinc-500">
                  {scopes.forms[form.id] ? "Has its own design" : "Uses the project’s design"}
                </span>
              </summary>
              <div className="mt-2">
                <EmailDesignEditor
                  scope={{ kind: "requester", projectId, formId: form.id }}
                  workspaceId={scopes.workspaceId}
                  own={scopes.forms[form.id]?.settings ?? null}
                  inherited={resolveEmailDesign("requester", {
                    project: scopes.project.requester?.settings ?? null,
                    workspace: workspaceLayer("requester"),
                  })}
                  canEdit={canEdit}
                  title={`Requester emails for “${form.title}”`}
                />
              </div>
            </details>
          ))
        )}
      </section>
    </div>
  );
}
