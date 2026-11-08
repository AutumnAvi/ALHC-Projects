import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, ThumbsUp } from "lucide-react";
import { ApproverReviewPage } from "@/components/task/approver-review-page";
import { ReviewTaskDetails } from "@/components/task/review-task-details";
import { TaskLiveRefresh } from "@/components/task/task-live-refresh";
import { EmptyState, PageHeader } from "@/components/ui";
import { requireMember } from "@/lib/auth";
import { getTaskDetail } from "@/lib/data";
import { reviewTaskDetails } from "@alhc/core/approver-review";
import { isUuid } from "@alhc/core/ids";

export const metadata: Metadata = { title: "Review for approval" };

// Nov 2 notes (batch 15, 114): the approver's review of an approval round on its own page ("Open review
// page" in the task's approval card). Read with the person's own access (getTaskDetail: RLS); only the
// approver whose decision is open gets the review — anyone else is told there's nothing to review.
// Nov 4 notes (batch 25, 159): the one place an approver decides from a link (Inbox, reminders, emails):
// a round with only text is decided here too, and an older request on a task (no round) opens the task,
// whose Approvals list shows it with the task.
// Nov 8 note 167: the same read also fills a read-only details panel (name, project, assignee, due date,
// key fields, description). reviewTaskDetails keeps comments off that panel. No second query.
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
  if (!myRequest && task.approvals.some((a) => !a.roundId && a.approverId === member.id && a.status === "pending")) {
    redirect(backHref);
  }
  const details = reviewTaskDetails(task);
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <TaskLiveRefresh taskId={task.id} />
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
        {myRequest && latest ? (
          <ApproverReviewPage
            taskId={task.id}
            requestId={myRequest.id}
            round={latest}
            attachments={task.attachments}
            backHref={backHref}
            details={details}
          />
        ) : (
          <div className="mx-auto max-w-3xl space-y-4">
            <ReviewTaskDetails details={details} />
            <EmptyState icon={ThumbsUp} title="Nothing to review here" size="page">
              You aren’t asked to approve this task right now, or the decision was already made.
            </EmptyState>
          </div>
        )}
      </div>
    </main>
  );
}
