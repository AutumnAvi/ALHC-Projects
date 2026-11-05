// Big move 1: what a call into the layer answers when the caller wants a value instead of an exception
// (ApiResult), and the shape a Next.js Server Action sends back to the browser (ActionResult).
import { ApiError, isApiError, type ApiErrorCode } from "./errors";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

// Runs a layer call; an ApiError becomes { ok: false }, anything else (a bug) still throws.
export async function attempt<T>(call: () => Promise<T>): Promise<ApiResult<T>> {
  try {
    return { ok: true, data: await call() };
  } catch (error) {
    if (isApiError(error)) return { ok: false, error };
    throw error;
  }
}

// A Server Action's answer: nothing on success, else the message to show and its code. Actions that hand
// back more (a new id, a summary) add their own fields next to these.
export type ActionResult = { error?: string; code?: ApiErrorCode };

export function actionError(error: ApiError): ActionResult {
  return { error: error.message, code: error.code };
}
