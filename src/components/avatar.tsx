import type { Profile } from "@/lib/data";

export function displayName(profile: Pick<Profile, "full_name" | "email">) {
  return profile.full_name?.trim() || profile.email;
}

function initials(name: string) {
  const parts = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

const SIZES = { sm: "size-5 text-[10px]", md: "size-7 text-xs" } as const;

export function Avatar({ name, size = "sm" }: { name: string; size?: keyof typeof SIZES }) {
  return (
    <span
      aria-hidden
      title={name}
      className={`${SIZES[size]} inline-flex shrink-0 items-center justify-center rounded-full bg-accent-100 font-medium text-accent-700`}
    >
      {initials(name)}
    </span>
  );
}
