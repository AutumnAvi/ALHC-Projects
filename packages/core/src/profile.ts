// Your own name and picture (Oct 25 notes, note 1). Mirrors 20261025010000_oct25_notes_a.sql:
// profiles.full_name is null or 1–100 characters once trimmed; pictures live in the public avatars
// bucket at <your user id>/<random>.<ext> (supabase/manual/20261025010000_avatar_policies.sql).

export const AVATARS_BUCKET = "avatars";
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const MAX_PROFILE_NAME = 100;

// The bucket's allowed types and the extension each is stored with.
export const AVATAR_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export const AVATAR_ACCEPT = Object.keys(AVATAR_TYPES).join(",");

// What's wrong with a name, or null when it can be saved.
export function profileNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter your name";
  if (trimmed.length > MAX_PROFILE_NAME) return `Keep your name to ${MAX_PROFILE_NAME} characters`;
  return null;
}

// What's wrong with a picture file, or null when it can be uploaded.
export function avatarFileProblem(file: { type: string; size: number }): string | null {
  if (!AVATAR_TYPES[file.type]) return "Choose a PNG, JPEG, WebP, or GIF image";
  if (file.size <= 0) return "That file is empty";
  if (file.size > AVATAR_MAX_BYTES) return "The picture must be 2 MB or smaller";
  return null;
}

// The object path of a picture in the avatars bucket from its public URL, when it is the person's own
// file (<their id>/<file>); null for anything else (a sign-in provider's picture, someone else's file).
export function ownAvatarPath(url: string | null | undefined, userId: string): string | null {
  if (!url) return null;
  const marker = `/storage/v1/object/public/${AVATARS_BUCKET}/`;
  const at = url.indexOf(marker);
  if (at < 0) return null;
  const path = decodeURIComponent(url.slice(at + marker.length).split(/[?#]/)[0]);
  const parts = path.split("/");
  return parts.length === 2 && parts[0] === userId && parts[1] && !parts[1].startsWith(".") ? path : null;
}
