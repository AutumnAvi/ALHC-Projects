"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, Lock, Users } from "lucide-react";
import { useNotify, useServerAction } from "@/components/toast";
import { requestTeamJoin } from "@/lib/actions";
import type { TeamAccessStatus } from "@/lib/teams";

// Oct 26 notes (batch 4): a team link someone isn't part of (/team-access/<id>, where the team layout
// sends them, e.g. after they left). Only a team's members (and workspace admins) see its members, work,
// and calendar; the team's name is public in the directory. The workspace's default team can be joined
// at once; any other team gets a request its leads decide on the team's Members tab. A deleted or unknown
// team is still the real Not found.
export function NoTeamAccess({
  teamId,
  teamName,
  status,
}: {
  teamId: string;
  teamName: string;
  status: Exclude<TeamAccessStatus, "missing" | "member">;
}) {
  const [pending, run] = useServerAction();
  const notify = useNotify();
  const router = useRouter();
  const [requested, setRequested] = useState(status === "requested");
  const joinable = status === "can_join";

  function ask() {
    run(async () => {
      const result = await requestTeamJoin(teamId);
      if (!result.error) {
        if (result.status === "member") {
          // Joined the default team (or someone added them meanwhile): the team opens.
          notify(`You joined ${teamName}`);
          router.push(`/teams/${teamId}`);
        } else {
          setRequested(true);
          notify("Request sent to the team’s leads");
        }
      }
      return result;
    });
  }

  return (
    <div className="flex flex-1 items-start justify-center px-gutter py-16">
      <div className="flex w-full max-w-md flex-col items-center rounded-xl border border-zinc-200 bg-white px-6 py-10 text-center shadow-sm">
        <span aria-hidden className="flex size-12 items-center justify-center rounded-full bg-zinc-100 text-zinc-500">
          {joinable ? <Users className="size-6" /> : <Lock className="size-6" />}
        </span>
        <h1 className="mt-4 text-lg font-semibold text-zinc-900">You’re not part of this team</h1>
        <p className="mt-1 text-sm font-medium text-zinc-700">{teamName}</p>
        {requested ? (
          <>
            <p className="mt-2 text-sm text-zinc-600">
              Your request was sent. Once one of the team’s leads adds you, the team opens for you here.
            </p>
            <p className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-green-50 px-3 py-1.5 text-sm font-medium text-green-800">
              <Check className="size-4" aria-hidden />
              Request sent
            </p>
          </>
        ) : joinable ? (
          <>
            <p className="mt-2 text-sm text-zinc-600">
              This is the workspace’s default team, so anyone can join it. Join to see its members, work, and calendar.
            </p>
            <button type="button" onClick={ask} disabled={pending} className="btn-primary mt-5 h-9 px-4">
              {pending ? "Joining…" : "Join team"}
            </button>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm text-zinc-600">
              Only the people on this team can see its members, work, and calendar. Ask to join, and one of its leads
              will add you.
            </p>
            <button type="button" onClick={ask} disabled={pending} className="btn-primary mt-5 h-9 px-4">
              {pending ? "Sending…" : "Request to join"}
            </button>
          </>
        )}
        <Link href="/teams" className="mt-6 text-sm text-accent-700 hover:underline">
          Back to Teams
        </Link>
      </div>
    </div>
  );
}
