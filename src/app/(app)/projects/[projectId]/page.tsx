import { redirect } from "next/navigation";

export default async function ProjectIndex({ params }: PageProps<"/projects/[projectId]">) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}/list`);
}
