import Link from "next/link";
import { UserPlus, UsersRound } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { OpenDialogButton } from "@/components/shell/open-dialog-button";
import { EmptyState } from "@/components/ui";
import { Widget, WidgetTitle } from "@/components/home/widget";
import type { Collaborator } from "@/lib/data";
import { plural } from "@/lib/home";
import { quickPersonHref } from "@/lib/shell";

// Home → People (Asana parity, batch 5): the people who share the most projects with the viewer
// (listFrequentCollaborators: only projects the viewer can open), plus an Invite tile. A tile opens the
// person's profile page (Real features 2), like the search palette.
export function PeopleWidget({ collaborators }: { collaborators: Collaborator[] }) {
  return (
    <Widget
      labelledBy="home-people"
      className="max-h-108 @4xl:col-span-2"
      header={
        <div className="flex h-12 items-baseline gap-2 pt-3">
          <WidgetTitle id="home-people">People</WidgetTitle>
          <span className="text-sm text-zinc-500">Frequent collaborators</span>
        </div>
      }
    >
      {collaborators.length === 0 ? (
        <div className="pb-4">
          <EmptyState
            size="inline"
            icon={UsersRound}
            title="No collaborators yet"
            action={
              <OpenDialogButton dialog={{ kind: "invite" }} className="btn-secondary">
                <UserPlus className="size-4" aria-hidden />
                Invite
              </OpenDialogButton>
            }
          >
            People who share a project with you show up here. Invite teammates to the workspace, or add people to a
            project from its Share button.
          </EmptyState>
        </div>
      ) : (
        <ul
          aria-label="Frequent collaborators"
          className="grid grid-cols-2 gap-1 px-3 pb-4 pt-1 @md:grid-cols-3 @xl:grid-cols-4 @3xl:grid-cols-5 @4xl:grid-cols-6"
        >
          <li>
            <OpenDialogButton
              dialog={{ kind: "invite" }}
              className="group flex h-full w-full flex-col items-center gap-2 rounded-lg px-2 py-3 text-center text-sm text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"
            >
              <span
                aria-hidden
                className="flex size-12 items-center justify-center rounded-full border border-dashed border-zinc-300 text-zinc-500 group-hover:border-zinc-400 group-hover:text-zinc-700"
              >
                <UserPlus className="size-5" />
              </span>
              <span className="font-medium">Invite</span>
            </OpenDialogButton>
          </li>
          {collaborators.map((person) => (
            <li key={person.id} className="min-w-0">
              <Link
                href={quickPersonHref(person)}
                data-tooltip={`${person.name}’s profile`}
                className="flex h-full flex-col items-center gap-2 rounded-lg px-2 py-3 text-center hover:bg-zinc-50 focus-visible:bg-zinc-50"
              >
                <Avatar name={person.name || person.email} profileId={person.id} size="lg" />
                <span className="w-full min-w-0">
                  <span className="block truncate text-sm font-medium text-zinc-900" title={person.email}>
                    {person.name || person.email}
                  </span>
                  <span className="block truncate text-xs text-zinc-500">{plural(person.sharedProjects, "shared project")}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}
