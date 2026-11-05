"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

// Everyone's picture by profile id (listProfileAvatars), provided once by the app and admin layouts so
// any Avatar that knows whose it is can show the picture without each page loading it.
const AvatarDirectory = createContext<Record<string, string>>({});

export function AvatarDirectoryProvider({ avatars, children }: { avatars: Record<string, string>; children: ReactNode }) {
  return <AvatarDirectory.Provider value={avatars}>{children}</AvatarDirectory.Provider>;
}

// The picture (src, else the directory's for profileId), falling back to the initials when there's none
// or it fails to load.
export function AvatarFace({
  name,
  initials,
  src,
  profileId,
  className,
}: {
  name: string;
  initials: string;
  src?: string | null;
  profileId?: string | null;
  className: string;
}) {
  const directory = useContext(AvatarDirectory);
  const url = src ?? (profileId ? directory[profileId] : undefined) ?? null;
  const [failed, setFailed] = useState<string | null>(null);
  if (url && failed !== url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- public Storage or sign-in provider URL
      <img
        src={url}
        alt=""
        aria-hidden
        title={name}
        referrerPolicy="no-referrer"
        onError={() => setFailed(url)}
        className={`${className} shrink-0 rounded-full bg-zinc-100 object-cover`}
      />
    );
  }
  return (
    <span
      aria-hidden
      title={name}
      className={`${className} inline-flex shrink-0 items-center justify-center rounded-full bg-accent-100 font-medium text-accent-700`}
    >
      {initials}
    </span>
  );
}
