"use client";

import { useOptimistic } from "react";
import { Heart } from "lucide-react";
import { displayName } from "@/components/avatar";
import { useServerAction } from "@/components/toast";
import { setTaskLiked } from "@/lib/actions";
import type { Profile } from "@/lib/data";

// A heart with the like count; the title (and screen-reader text) lists who liked it. Commenters and
// above like (their own like only); everyone who can read the task sees the count.
export function TaskLike({
  taskId,
  likeProfileIds,
  profiles,
  memberId,
  canLike,
}: {
  taskId: string;
  likeProfileIds: string[];
  profiles: Profile[];
  memberId: string;
  canLike: boolean;
}) {
  const [, run] = useServerAction();
  const [likes, setLikes] = useOptimistic(likeProfileIds);
  const liked = likes.includes(memberId);
  const byId = new Map(profiles.map((p) => [p.id, p] as const));
  const names = likes.map((id) => (id === memberId ? "You" : byId.get(id) ? displayName(byId.get(id)!) : "Someone"));
  const who = names.length ? `Liked by ${names.join(", ")}` : "No likes yet";

  if (!canLike && likes.length === 0) return null;
  return (
    <button
      type="button"
      disabled={!canLike}
      aria-pressed={liked}
      aria-label={`${liked ? "Unlike" : "Like"} this task. ${who}`}
      title={who}
      onClick={() =>
        run(
          () => setTaskLiked(taskId, !liked),
          () => setLikes(liked ? likes.filter((id) => id !== memberId) : [...likes, memberId]),
        )
      }
      className={`btn-icon w-auto gap-1 px-1.5 tabular-nums disabled:cursor-default ${
        liked ? "text-red-600 hover:bg-red-50" : "text-zinc-500"
      }`}
    >
      <Heart className={`size-4 ${liked ? "fill-current" : ""}`} aria-hidden />
      {likes.length ? <span className="text-xs">{likes.length}</span> : null}
    </button>
  );
}
