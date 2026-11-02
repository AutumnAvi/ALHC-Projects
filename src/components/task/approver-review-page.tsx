"use client";

import { useRouter } from "next/navigation";
import type { ApprovalRound, TaskAttachment } from "@/lib/data";
import { ApproverReview } from "./approver-review";

// The /approve/<task> page's client part: the full review; once sent, back to the task.
export function ApproverReviewPage(props: {
  taskId: string;
  requestId: string;
  round: ApprovalRound;
  attachments: TaskAttachment[];
  backHref: string;
}) {
  const router = useRouter();
  const { backHref, ...rest } = props;
  return (
    <div className="mx-auto max-w-6xl">
      <ApproverReview {...rest} variant="full" onDone={() => router.push(backHref)} />
    </div>
  );
}
