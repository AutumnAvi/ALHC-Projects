import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DeliveryLog } from "@/components/project/delivery-log";
import { ReadOnlyNotice } from "@/components/project/project-access";
import { getProject, getProjectRole, listIntegrationDeliveries } from "@/lib/data";
import { hasRole } from "@/lib/roles";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/settings/deliveries">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Deliveries` : "Deliveries" };
}

// Slack and webhook deliveries queued by this project's rules. Admin+ only: the log RPC refuses anyone
// else, so the page doesn't ask below Admin.
export default async function ProjectDeliveriesPage({
  params,
}: PageProps<"/projects/[projectId]/settings/deliveries">) {
  const { projectId } = await params;
  const [project, role] = await Promise.all([getProject(projectId), getProjectRole(projectId)]);
  if (!project || !role) notFound();

  if (!hasRole(role, "admin")) {
    return (
      <div className="mx-auto max-w-3xl px-gutter py-5">
        <ReadOnlyNotice need="admin" what="the delivery log (Slack and webhook deliveries)" />
      </div>
    );
  }

  const deliveries = await listIntegrationDeliveries(projectId);
  if (!deliveries) notFound();
  return <DeliveryLog projectId={projectId} deliveries={deliveries} />;
}
