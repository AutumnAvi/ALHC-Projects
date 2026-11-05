// Big move 1: the attachments area's writes to the private task-attachments bucket (Storage writes are
// data access too). Every function writes only through ctx.db: the person's own client (Storage's policies
// decide: Editors+ store a task's files), or — for the public review page only — the service role, for
// exactly the storage path the database returned for the link's token. No Next.js here.
import type { ApiContext } from "../core/context";
import { ATTACHMENTS_BUCKET } from "../../attachments";

// Stores one object; answers Storage's refusal message, or null when it was stored.
export async function uploadObject(
  ctx: ApiContext,
  objectPath: string,
  body: Blob | ArrayBuffer | Uint8Array,
  options: { contentType: string; upsert: boolean },
): Promise<string | null> {
  const upload = await ctx.db.storage.from(ATTACHMENTS_BUCKET).upload(objectPath, body, options);
  return upload.error ? upload.error.message : null;
}

// A one-time upload link's token for exactly this object (null when Storage refuses it).
export async function signedUploadToken(ctx: ApiContext, objectPath: string): Promise<string | null> {
  const signed = await ctx.db.storage.from(ATTACHMENTS_BUCKET).createSignedUploadUrl(objectPath);
  if (signed.error || !signed.data) return null;
  return signed.data.token;
}

// Removes these objects (best effort: the answer isn't read).
export async function removeObjects(ctx: ApiContext, objectPaths: string[]): Promise<void> {
  await ctx.db.storage.from(ATTACHMENTS_BUCKET).remove(objectPaths);
}
