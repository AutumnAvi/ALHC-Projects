"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { personHref } from "@alhc/core/people";
import { titleMentionSegments, type TitlePerson } from "@alhc/core/title-mentions";
import { titleAssetSegments, type TitleAsset } from "@alhc/core/title-assets";
import { previewKind } from "@alhc/core/attachment-preview";
import { FileTypeIcon } from "./file-type-icon";

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

// Nov 5 note 166: a file named in a task's name (a subtask made from feedback on it) is a chip that opens
// the file, drawn like the person chips.
export const TITLE_ASSET_CHIP =
  "inline-flex max-w-full items-baseline gap-1 rounded bg-zinc-100 px-1 font-medium text-zinc-800 decoration-zinc-400 hover:bg-zinc-200 hover:underline";

// Where a file chip goes: images and PDFs open in the browser's viewer, anything else downloads.
export function assetChipHref(asset: TitleAsset): string {
  return previewKind(asset.name, asset.contentType ?? null) ? `/attachments/${asset.id}?preview=1` : `/attachments/${asset.id}`;
}

type Segment =
  | { kind: "text"; text: string }
  | { kind: "person"; text: string; person: TitlePerson }
  | { kind: "asset"; text: string; asset: TitleAsset };

// The name cut into text, file chips, and person chips (files first: a file's name can hold an "@").
export function titleSegments(title: string, people: readonly TitlePerson[], assets: readonly TitleAsset[]): Segment[] {
  return titleAssetSegments(title, assets).flatMap((part): Segment[] =>
    part.kind === "asset" ? [part] : titleMentionSegments(part.text, people),
  );
}

export function titleHasChips(title: string, people: readonly TitlePerson[], assets: readonly TitleAsset[] = []): boolean {
  return titleSegments(title, people, assets).some((s) => s.kind !== "text");
}

// A task's name with its @mentions as person chips (and, given `assets`, the files it names as file
// chips). `nested` is for a name drawn inside a link or a button (rows, cards): a chip can't be a link
// there, so it's a span that opens the profile / file on click without opening the task. Elsewhere it's a
// real link.
export function TaskTitleText({
  title,
  nested = false,
  people,
  assets,
}: {
  title: string;
  nested?: boolean;
  people?: readonly TitlePerson[];
  assets?: readonly TitleAsset[];
}) {
  const directory = usePeopleDirectory();
  const list = people ?? directory;
  const segments = useMemo(() => titleSegments(title, list, assets ?? []), [title, list, assets]);
  if (segments.length === 1 && segments[0].kind === "text") return <>{title}</>;
  return (
    <>
      {segments.map((segment, i) => {
        if (segment.kind === "text") return <span key={i}>{segment.text}</span>;
        if (segment.kind === "asset") return <AssetChip key={i} asset={segment.asset} text={segment.text} nested={nested} />;
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

function AssetChip({ asset, text, nested }: { asset: TitleAsset; text: string; nested: boolean }) {
  const href = assetChipHref(asset);
  const label = `Open ${asset.name}`;
  const body = (
    <>
      <FileTypeIcon fileName={asset.name} contentType={asset.contentType ?? null} className="size-[0.9em] self-center" />
      <span className="truncate">{text}</span>
    </>
  );
  if (!nested) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" data-title-asset={asset.id} title={label} className={TITLE_ASSET_CHIP}>
        {body}
      </a>
    );
  }
  return (
    <span
      role="link"
      tabIndex={-1}
      data-title-asset={asset.id}
      title={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(href, "_blank", "noopener,noreferrer");
      }}
      className={`cursor-pointer ${TITLE_ASSET_CHIP}`}
    >
      {body}
    </span>
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
