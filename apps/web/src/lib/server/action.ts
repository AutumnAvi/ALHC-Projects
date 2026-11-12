import "server-only";
// Big move 1: how a Server Action ("use server") calls the data-access layer. The action stays thin: it
// hands the layer a context of its own (src/lib/server/context.ts: the person's session, no memo), turns
// an ApiError into the { error, code } the browser shows, and does what only Next.js can do afterwards
// (deliver queued email after the response, re-render the page).
import { refresh, revalidatePath } from "next/cache";
import { after } from "next/server";
import type { ApiContext } from "@alhc/core/api/core/context";
import { isApiError } from "@alhc/core/api/core/errors";
import { actionError, type ActionResult } from "@alhc/core/api/core/result";
import { drainOutbox } from "@/lib/email";
import { drainIntegrationOutbox } from "@/lib/integrations";
import { actionContext } from "./context";
import { afterWritePlan, type RunOptions } from "./after-write";

export { SCREEN_ONLY, type RunOptions } from "./after-write";

// Any write can make rules queue email, Slack messages, or webhooks, so deliver the outboxes once the
// response is sent (a small integration batch keeps rule fires snappy between cron runs).
export function deliverQueuedEmail(before?: () => Promise<unknown>) {
  after(async () => {
    // Work the emails wait on (an approval round's thumbnails, Nov 4 notes batch 25, 160); best effort.
    if (before) await before().catch(() => undefined);
    try {
      await drainOutbox();
    } catch (error) {
      console.error("Email delivery failed", error);
    }
    try {
      await drainIntegrationOutbox({ max: 10 });
    } catch (error) {
      console.error("Integration delivery failed", error);
    }
  });
}

function afterWrite(options: RunOptions) {
  const plan = afterWritePlan(options);
  if (plan.deliver) deliverQueuedEmail(options.beforeEmail);
  for (const [path, type] of plan.revalidate) revalidatePath(path, type);
  if (plan.refresh) refresh();
}

// A write: the layer call's ApiError becomes { error, code }; anything else (a bug) still throws. On
// success the outboxes are delivered after the response and the page re-renders.
export async function run(write: (ctx: ApiContext) => Promise<unknown>, options: RunOptions = {}): Promise<ActionResult> {
  try {
    await write(await actionContext());
  } catch (error) {
    if (isApiError(error)) return actionError(error);
    throw error;
  }
  afterWrite(options);
  return {};
}

// A write that answers with more than success (a new id, a summary): its fields sit next to { error }.
export async function runWith<T extends object>(
  write: (ctx: ApiContext) => Promise<T>,
  options: RunOptions = {},
): Promise<ActionResult & Partial<T>> {
  let value: T;
  try {
    value = await write(await actionContext());
  } catch (error) {
    if (isApiError(error)) return actionError(error) as ActionResult & Partial<T>;
    throw error;
  }
  afterWrite(options);
  return { ...value };
}

// A read-only server call from the browser: same error handling, no refresh and no delivery.
export async function readAction<T>(load: (ctx: ApiContext) => Promise<T>): Promise<ActionResult & { data?: T }> {
  try {
    return { data: await load(await actionContext()) };
  } catch (error) {
    if (isApiError(error)) return actionError(error);
    throw error;
  }
}
