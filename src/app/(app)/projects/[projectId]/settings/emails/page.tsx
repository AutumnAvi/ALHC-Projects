import { redirect } from "next/navigation";

// Nov 1 notes (batch 11): emails are hard-coded in the app's templates, so projects have no email design
// overrides any more. Old links land on the project's settings.
export default async function ProjectEmailsPage({ params }: PageProps<"/projects/[projectId]/settings/emails">) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}/settings`);
}
