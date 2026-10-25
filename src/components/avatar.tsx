import { AvatarFace } from "@/components/avatar-face";
import type { Profile } from "@/lib/data";

export function displayName(profile: Pick<Profile, "full_name" | "email">) {
  return profile.full_name?.trim() || profile.email;
}

export function initials(name: string) {
  const parts = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

// lg: Home's widgets (the My tasks header, People tiles). xl: Settings → Profile and profile pages.
const SIZES = {
  sm: "size-5 text-[10px]",
  md: "size-7 text-xs",
  lg: "size-12 text-base",
  xl: "size-16 text-xl",
} as const;

// The one avatar: the person's picture when there is one (src, else looked up by profileId), else their
// initials. Decorative (aria-hidden): the name is always written next to it or in the control's label.
export function Avatar({
  name,
  src,
  profileId,
  size = "sm",
}: {
  name: string;
  src?: string | null;
  profileId?: string | null;
  size?: keyof typeof SIZES;
}) {
  return <AvatarFace name={name} initials={initials(name)} src={src} profileId={profileId} className={SIZES[size]} />;
}
