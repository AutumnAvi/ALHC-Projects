"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Archive, Check, Lock } from "lucide-react";
import { useNotify, useServerAction } from "@/components/toast";
import { requestProjectAccess } from "@/lib/actions";
import type { ProjectAccessStatus } from "@/lib/access-requests";

// Oct 26 notes (batch 3): a project link someone isn't part of (/project-access/<id>, where the project
// layout sends them). Instead of "Not found" they can ask the project's owners to add them; the owners
// get an Inbox item (and see it in Share). A deleted or unknown project still gets the real Not found.
export function NoProjectAccess({
  projectId,
  status,
}: {
  projectId: string;
  status: Exclude<ProjectAccessStatus, "missing" | "member">;
}) {
  const [pending, run] = useServerAction();
  const notify = useNotify();
  const router = useRouter();
  const [requested, setRequested] = useState(status === "requested");
  const archived = status === "archived";

  function ask() {
    run(async () => {
      const result = await requestProjectAccess(projectId);
      if (!result.error) {
        setRequested(true);
        // Already added meanwhile: the project opens.
        if (result.status === "member") router.push(`/projects/${projectId}`);
        else notify("Request sent to the project’s owners");
      }
      return result;
    });
  }

  return (
    <div className="flex flex-1 items-start justify-center px-gutter py-16">
      <div className="flex w-full max-w-md flex-col items-center rounded-xl border border-zinc-200 bg-white px-6 py-10 text-center shadow-sm">
        <span aria-hidden className="flex size-12 items-center justify-center rounded-full bg-zinc-100 text-zinc-500">
          {archived ? <Archive className="size-6" /> : <Lock className="size-6" />}
        </span>
        <h1 className="mt-4 text-lg font-semibold text-zinc-900">You’re not part of this project</h1>
        {archived ? (
          <p className="mt-2 text-sm text-zinc-600">
            This project is archived, so nobody can be added to it right now. Ask one of its owners if you need it.
          </p>
        ) : requested ? (
          <>
            <p className="mt-2 text-sm text-zinc-600">
              Your request was sent to the project’s owners. You’ll get a notification in your Inbox once they add you.
            </p>
            <p className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-green-50 px-3 py-1.5 text-sm font-medium text-green-800">
              <Check className="size-4" aria-hidden />
              Request sent
            </p>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm text-zinc-600">
              Only the people in this project can open it. Ask its owners to add you, and you’ll get a notification when
              they do.
            </p>
            <button type="button" onClick={ask} disabled={pending} className="btn-primary mt-5 h-9 px-4">
              {pending ? "Sending…" : "Request to be added to this project"}
            </button>
          </>
        )}
        <Link href="/" className="mt-6 text-sm text-accent-700 hover:underline">
          Back to Home
        </Link>
      </div>
    </div>
  );
}
