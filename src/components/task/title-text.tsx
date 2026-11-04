"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { personHref } from "@/lib/people";
import { titleMentionSegments, type TitlePerson } from "@/lib/title-mentions";

// Nov 4 notes (batch 27, 162): everyone in the workspace by name, provided once by the app layout, so a
// task name's "@Dana Lee" can be drawn as a chip wherever the name shows (rows, cards, the pane).
const PeopleDirectory = createContext<readonly TitlePerson[]>([]);

export function PeopleDirectoryProvider({ people, children }: { people: readonly TitlePerson[]; children: ReactNode }) {
  return <PeopleDirectory.Provider value={people}>{children}</PeopleDirectory.Provider>;
}

export function usePeopleDirectory(): readonly TitlePerson[] {
  return useContext(PeopleDirectory);
}

export const TITLE_MENTION_CHIP = "rounded bg-accent-50 px-1 font-medium text-accent-700 decoration-accent-300 hover:bg-accent-100 hover:underline";

// A task's name with its @mentions as person chips. `nested` is for a name drawn inside a link or a
// button (rows, cards): the chip can't be a link there, so it's a span that opens the person's profile on
// click without opening the task. Elsewhere it's a real link.
export function TaskTitleText({ title, nested = false, people }: { title: string; nested?: boolean; people?: readonly TitlePerson[] }) {
  const directory = usePeopleDirectory();
  const list = people ?? directory;
  const segments = useMemo(() => titleMentionSegments(title, list), [title, list]);
  if (segments.length === 1 && segments[0].kind === "text") return <>{title}</>;
  return (
    <>
      {segments.map((segment, i) => {
        if (segment.kind === "text") return <span key={i}>{segment.text}</span>;
        const href = personHref(segment.person.id);
        const label = `${segment.person.name}’s profile`;
        if (!nested) {
          return (
            <Link key={i} href={href} data-title-mention={segment.person.id} title={label} className={TITLE_MENTION_CHIP}>
              {segment.text}
            </Link>
          );
        }
        return <NestedMention key={i} href={href} label={label} personId={segment.person.id} text={segment.text} />;
      })}
    </>
  );
}

// The chip inside a link or button: opening the profile mustn't also open (or rename) the task.
function NestedMention({ href, label, personId, text }: { href: string; label: string; personId: string; text: string }) {
  const router = useRouter();
  return (
    <span
      data-title-mention={personId}
      title={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        router.push(href);
      }}
      className={`cursor-pointer ${TITLE_MENTION_CHIP}`}
    >
      {text}
    </span>
  );
}
