"use server";
// Big move 1: what the app shell loads on demand (the search palette, the Settings modal, the Create
// menu's dialogs), thin wrappers around packages/core/src/api/shell/queries.ts. Each runs with the signed-in person's
// own context (never the service role); only what Next.js knows (the email switches, the reply domain, the
// time zone cookie) is read here and handed to the layer.
import { cookies } from "next/headers";
import type { MySettings } from "@alhc/core/api/me/model";
import * as shellApi from "@alhc/core/api/shell/queries";
import type { CalendarFeed } from "@alhc/core/calendar-feeds";
import { MY_TASKS_LAYOUT_COOKIE } from "@alhc/core/my-tasks";
import { isEmailConfigured } from "@/lib/email";
import { forwardingAddress, isInboundEmailConfigured } from "@/lib/email-reply";
import type { TemplateOutline } from "@alhc/core/project-roles";
import { actionContext } from "@/lib/server/context";
import type { EmailSetup, QuickResults, RecentItem, RecentRef, SearchKind } from "@alhc/core/shell";
import type { GalleryTemplate, TemplatePreview } from "@alhc/core/templates";
import { getViewerTimeZone } from "@/lib/timezone";

// The palette's live results. `only` narrows to one kind (a chip), with more rows.
export async function quickSearch(query: string, only: SearchKind | null = null): Promise<QuickResults> {
  return shellApi.quickSearch(await actionContext(), query, only);
}

// Recently opened tasks and projects, newest first, keeping only what the person can still read.
export async function resolveRecents(refs: RecentRef[]): Promise<RecentItem[]> {
  return shellApi.resolveRecents(await actionContext(), refs);
}

// The Settings modal (since Asana parity, batch 5). Forwarding needs inbound email set up here plus what
// /api/inbound/email needs to read the message and write the task (RESEND_API_KEY, the service-role key).
export async function loadSettings(): Promise<{ me: MySettings; email: EmailSetup } | null> {
  const inbound = isInboundEmailConfigured();
  return shellApi.loadSettings(
    await actionContext(),
    {
      sending: isEmailConfigured(),
      inbound,
      forwarding: inbound && Boolean(process.env.RESEND_API_KEY) && Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      forwardingAddress,
    },
    (await cookies()).get(MY_TASKS_LAYOUT_COOKIE)?.value,
  );
}

// Projects the person can post a message in, for Create → Message.
export async function loadMessageProjects(): Promise<{ id: string; name: string }[]> {
  return shellApi.loadMessageProjects(await actionContext());
}

// Projects the person can add tasks to, for Create → Task.
export async function loadTaskProjects(): Promise<{ id: string; name: string }[]> {
  return shellApi.loadTaskProjects(await actionContext());
}

// What the New goal dialog needs, for Create → Goal.
export async function loadGoalDialog() {
  const [ctx, timeZone] = await Promise.all([actionContext(), getViewerTimeZone()]);
  return shellApi.loadGoalDialog(ctx, timeZone);
}

// The New project gallery (Asana parity, batch 4).
export async function loadProjectGallery(): Promise<GalleryTemplate[] | null> {
  return shellApi.loadProjectGallery(await actionContext());
}

// What a template holds, for the gallery's preview.
export async function loadTemplatePreview(templateId: string): Promise<TemplatePreview | null> {
  return shellApi.loadTemplatePreview(await actionContext(), templateId);
}

// Nov 2 notes (batch 14, 95): what a template holds, for "Customize before creating".
export async function loadTemplateOutline(
  templateId: string,
): Promise<{ outline: TemplateOutline; people: { id: string; name: string }[] } | null> {
  return shellApi.loadTemplateOutline(await actionContext(), templateId);
}

// The "Sync to calendar" dialog (Real features 4).
export async function loadCalendarFeed(
  scope: string,
  targetId: string | null,
): Promise<{ available: boolean; feed: CalendarFeed | null; targetName: string | null } | null> {
  return shellApi.loadCalendarFeed(await actionContext(), scope, targetId);
}

// Settings → Calendar sync.
export async function loadCalendarFeeds(): Promise<CalendarFeed[] | null> {
  return shellApi.loadCalendarFeeds(await actionContext());
}

// Oct 26 notes (batch 4): a task the pane can't open may be in the Trash (null otherwise).
export async function loadTrashedTask(taskId: string): Promise<{ id: string; title: string; deletedAt: string } | null> {
  return shellApi.loadTrashedTask(await actionContext(), taskId);
}

// Whether invite emails can go out here (the shell's Invite uses Admin console → Users' dialog, which
// says so and offers the sign-up link when they can't).
export async function loadInviteEmailReady(): Promise<boolean> {
  await actionContext();
  return isEmailConfigured();
}
