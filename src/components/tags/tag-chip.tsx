import { Tag as TagIcon, X } from "lucide-react";
import { tagClass, tagsFor, type Tag } from "@/lib/tags";

// A tag as a small colored chip (server-safe). Archived tags read muted.
export function TagChip({ tag, onRemove, removeDisabled }: { tag: Tag; onRemove?: () => void; removeDisabled?: boolean }) {
  return (
    <span
      className={`inline-flex h-5 max-w-40 shrink-0 items-center gap-1 rounded px-1.5 text-2xs font-medium ${tagClass(tag.color)} ${tag.archivedAt ? "opacity-60" : ""}`}
      title={tag.archivedAt ? `${tag.name} (archived)` : tag.name}
    >
      <span className="truncate">{tag.name}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          disabled={removeDisabled}
          aria-label={`Remove tag ${tag.name}`}
          className="-mr-0.5 rounded hover:bg-black/10 disabled:hidden"
        >
          <X className="size-3" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}

// The tags of a row or card: up to `max` chips, then "+N".
export function TagChips({ ids, byId, max = 3 }: { ids: readonly string[]; byId: ReadonlyMap<string, Tag>; max?: number }) {
  const tags = tagsFor(ids, byId);
  if (tags.length === 0) return null;
  const shown = tags.slice(0, max);
  const rest = tags.length - shown.length;
  return (
    <span className="inline-flex min-w-0 items-center gap-1" aria-label={`Tags: ${tags.map((t) => t.name).join(", ")}`}>
      {shown.map((t) => (
        <TagChip key={t.id} tag={t} />
      ))}
      {rest > 0 ? (
        <span className="chip shrink-0" title={tags.slice(max).map((t) => t.name).join(", ")}>
          +{rest}
        </span>
      ) : null}
    </span>
  );
}

export function TagGlyph({ className = "size-3.5" }: { className?: string }) {
  return <TagIcon className={className} aria-hidden />;
}
