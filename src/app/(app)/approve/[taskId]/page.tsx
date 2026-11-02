import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ThumbsUp } from "lucide-react";
import { ApproverReviewPage } from "@/components/task/approver-review-page";
import { EmptyState, PageHeader } from "@/components/ui";
import { requireMember } from "@/lib/auth";
import { approverReviewFiles } from "@/lib/approver-review";
import { getTaskDetail } from "@/lib/data";
import { isUuid } from "@/lib/ids";

export const metadata: Metadata = { title: "Review for approval" };

// Nov 2 notes (batch 15, 114): the approver's review of an approval round on its own page ("Open review
// page" in the task's approval card). Read with the person's own access (getTaskDetail: RLS); only the
// approver whose decision is open gets the review — anyone else is told there's nothing to review.
export default async function ApproveTaskPage({ params }: PageProps<"/approve/[taskId]">) {
  const { taskId } = await params;
  if (!isUuid(taskId)) notFound();
  const [member, task] = await Promise.all([requireMember(), getTaskDetail(taskId)]);
  if (!task) notFound();
  const projectId = task.memberships[0]?.projectId ?? null;
  const backHref = projectId ? `/projects/${projectId}?task=${task.id}` : `/my-tasks?task=${task.id}`;
  const latest = task.approval?.rounds[0] ?? null;
  const myRequest =
    latest?.status === "pending" ? (latest.requests.find((r) => r.approverId === member.id && r.status === "pending") ?? null) : null;
  const files = latest ? approverReviewFiles(latest, task.attachments) : [];
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={ThumbsUp}
        title={task.title}
        description={latest ? `Approval · Round ${latest.number}` : "Approval"}
        actions={
          <Link href={backHref} className="btn-secondary">
            <ArrowLeft className="size-4" aria-hidden />
            Back to the task
          </Link>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-gutter py-5">
        {myRequest && latest && files.length ? (
          <ApproverReviewPage taskId={task.id} requestId={myRequest.id} round={latest} attachments={task.attachments} backHref={backHref} />
        ) : (
          <EmptyState icon={ThumbsUp} title="Nothing to review here" size="page">
            {myRequest
              ? "This round has no files. Decide from the task’s approval card."
              : "You aren’t asked to approve this task right now, or the decision was already made."}
          </EmptyState>
        )}
      </div>
    </main>
  );
}
