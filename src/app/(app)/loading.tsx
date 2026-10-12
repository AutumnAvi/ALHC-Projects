"use client";

import { usePathname } from "next/navigation";
import { HomeSkeleton } from "@/components/home/home-skeleton";
import { PageSkeleton } from "@/components/ui";

// Shown inside the app shell (the sidebar stays) while a page's data loads. This boundary also covers
// pages without a loading file of their own, so only Home gets Home's skeleton.
export default function Loading() {
  return usePathname() === "/" ? <HomeSkeleton /> : <PageSkeleton />;
}
