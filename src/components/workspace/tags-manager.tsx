"use client";

import { useRef, useState } from "react";
import { Archive, ArchiveRestore, Pencil, Tag as TagIcon } from "lucide-react";
import { displayName } from "@/components/avatar";
import { TagChip } from "@/components/tags/tag-chip";
import { useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { createTag, updateTag } from "@/lib/actions";
import type { Profile } from "@/lib/data";
import { MAX_TAG_NAME, TAG_COLORS, canManageTag, type Tag } from "@/lib/tags";

// Settings → Workspace → Tags. Everyone allowlisted sees every tag and can create one; the creator or a
// workspace admin renames, recolours, and archives it. Tag names are workspace-wide; which tasks carry
// a tag is only visible inside the projects you can read.
export function TagsManager({
  tags,
  profiles,
  viewer,
}: {
  tags: Tag[];
  profiles: Profile[];
  viewer: { id: string; isWorkspaceAdmin: boolean };
}) {
  const [pending, run] = useServerAction();
  const nameRef = useRef<HTMLInputElement>(null);
  const [color, setColor] = useState<Tag["color"]>("zinc");
  const people = new Map(profiles.map((p) => [p.id, p]));
  const active = tags.filter((t) => !t.archivedAt);
  const archived = tags.filter((t) => t.archivedAt);

  return (
    <section className="rounded-lg border border-zinc-200" aria-labelledby="workspace-tags-heading">
      <div className="border-b border-zinc-200 px-5 py-4">
        <h2 id="workspace-tags-heading" className="text-sm font-semibold text-zinc-900">
          Tags <span className="font-normal text-zinc-500">· {active.length}</span>
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          Tags work across every project. Anyone can create one; its creator or a workspace admin can rename,
          recolour, or archive it. Archived tags stay on tasks but can’t be added again. A tag never opens a project:
          you only see tagged tasks in projects you’re a member of.
        </p>
      </div>

      <form
        className="flex flex-wrap items-end gap-3 border-b border-zinc-100 px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          const input = nameRef.current;
          const name = input?.value.trim();
          if (!input || !name) return;
          run(async () => {
            const result = await createTag(name, color);
            if (!result.error) input.value = "";
            return result;
          });
        }}
      >
        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600" htmlFor="new-tag-name">
          New tag
          <input id="new-tag-name" ref={nameRef} maxLength={MAX_TAG_NAME} required placeholder="e.g. Print" className="control w-56 font-normal" />
        </label>
        <ColorSelect id="new-tag-color" value={color} onChange={setColor} label="Colour" />
        <button type="submit" disabled={pending} className="btn-primary">
          Create tag
        </button>
      </form>

      {tags.length === 0 ? (
        <div className="px-5 py-6">
          <EmptyState icon={TagIcon} title="No tags yet" size="inline">
            Create one here, or type a new name in a task’s Tags row.
          </EmptyState>
        </div>
      ) : (
        <ul className="divide-y divide-zinc-100">
          {[...active, ...archived].map((tag) => {
            const creator = tag.createdBy ? people.get(tag.createdBy) : undefined;
            return (
              <TagRow
                key={tag.id}
                tag={tag}
                creatorName={creator ? displayName(creator) : "Someone"}
                canManage={canManageTag(tag, viewer)}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ColorSelect({
  id,
  value,
  onChange,
  label,
}: {
  id: string;
  value: Tag["color"];
  onChange: (color: Tag["color"]) => void;
  label: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600" htmlFor={id}>
      {label}
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value as Tag["color"])}
        className="control font-normal capitalize"
      >
        {TAG_COLORS.map((c) => (
          <option key={c} value={c}>
            {c === "zinc" ? "Grey" : c}
          </option>
        ))}
      </select>
    </label>
  );
}

function TagRow({ tag, creatorName, canManage }: { tag: Tag; creatorName: string; canManage: boolean }) {
  const [, run] = useServerAction();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState(tag.color);

  if (editing) {
    return (
      <li className="px-5 py-3">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setEditing(false);
            run(() => updateTag(tag.id, { name, color }));
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600" htmlFor={`tag-name-${tag.id}`}>
            Name
            <input
              id={`tag-name-${tag.id}`}
              value={name}
              maxLength={MAX_TAG_NAME}
              required
              autoFocus
              onChange={(e) => setName(e.currentTarget.value)}
              className="control w-56 font-normal"
            />
          </label>
          <ColorSelect id={`tag-color-${tag.id}`} value={color} onChange={setColor} label="Colour" />
          <button type="submit" className="btn-primary">
            Save
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              setEditing(false);
              setName(tag.name);
              setColor(tag.color);
            }}
          >
            Cancel
          </button>
        </form>
      </li>
    );
  }

  return (
    <li className="flex min-h-row items-center gap-3 px-5 py-2">
      <TagChip tag={tag} />
      <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">
        Created by {creatorName}
        {tag.archivedAt ? " · Archived" : ""}
      </span>
      {canManage ? (
        <span className="flex items-center gap-1">
          <button type="button" className="btn-icon" onClick={() => setEditing(true)} aria-label={`Rename or recolour ${tag.name}`}>
            <Pencil className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            className="btn-icon"
            onClick={() => run(() => updateTag(tag.id, { archived: !tag.archivedAt }))}
            aria-label={tag.archivedAt ? `Unarchive ${tag.name}` : `Archive ${tag.name}`}
            title={tag.archivedAt ? "Unarchive" : "Archive"}
          >
            {tag.archivedAt ? <ArchiveRestore className="size-3.5" aria-hidden /> : <Archive className="size-3.5" aria-hidden />}
          </button>
        </span>
      ) : null}
    </li>
  );
}
