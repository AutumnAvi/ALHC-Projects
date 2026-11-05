"use server";
// Big move 1: the public review page's Server Actions (Oct 26 notes, batch 3), thin wrappers around
// src/lib/api/reviews/mutations.ts. No sign-in: each one checks only the link's token, through the
// anon-callable database functions (review_check_*), with a cookie-less anon context — never the visitor's
// session. The service role (adminContext) is handed in for one thing only: a one-time upload link (and
// removing a refused upload) for exactly the storage path the database handed back for this token — the
// private bucket has no anon write path.

import type { DraftPin, ReviewProgress } from "@/lib/api/reviews/model";
import * as reviewsApi from "@/lib/api/reviews/mutations";
import type { ReviewFile, ReviewStatus } from "@/lib/review-checks";
import { adminContext, anonContext } from "@/lib/server/context";


// Nov 1 notes (batch 8): the answer goes with the reviewer's final progress (each file's approval and
// note), saved first and checked by the database (see the layer's submitReviewDecision).
export async function submitReviewDecision(
  token: string,
  decision: "approved" | "changes_requested",
  note: string,
  pins: DraftPin[],
  progress: ReviewProgress | null = null,
): Promise<{ error?: string; status?: ReviewStatus }> {
  return reviewsApi.submitReviewDecision(anonContext(), token, decision, note, pins, progress);
}

export async function startReviewUpload(
  token: string,
  file: { name: string; type: string; size: number },
): Promise<{ error?: string; fileId?: string; path?: string; uploadToken?: string }> {
  return reviewsApi.startReviewUpload(anonContext(), adminContext(), token, file);
}

export async function finishReviewUpload(token: string, fileId: string): Promise<{ error?: string; file?: ReviewFile }> {
  return reviewsApi.finishReviewUpload(anonContext(), adminContext(), token, fileId);
}

// Oct 27 notes (batch 5): the reviewer's progress, saved as they go; and / or "they closed the walkthrough".
export async function saveReviewProgress(
  token: string,
  progress: ReviewProgress | null,
  walkthroughSeen = false,
): Promise<{ error?: string; status?: string; savedAt?: string }> {
  return reviewsApi.saveReviewProgress(anonContext(), token, progress, walkthroughSeen);
}
