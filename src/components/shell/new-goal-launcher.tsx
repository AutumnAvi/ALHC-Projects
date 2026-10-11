"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@/components/dialog";
import { NewGoalDialog } from "@/components/goals/new-goal-dialog";
import { loadGoalDialog } from "@/lib/shell-actions";

type GoalDialogData = NonNullable<Awaited<ReturnType<typeof loadGoalDialog>>>;

// Create → Goal: loads what the Goals page's New goal dialog needs (people, teams, goals, today), then
// shows that same dialog. Creating opens the new goal.
export function NewGoalLauncher({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<GoalDialogData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    loadGoalDialog()
      .then((loaded) => {
        if (!live) return;
        if (loaded) setData(loaded);
        else setFailed(true);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  if (data) return <NewGoalDialog {...data} onClose={onClose} />;
  return (
    <Dialog title="New goal" onClose={onClose}>
      {failed ? (
        <p className="text-sm text-red-600">Couldn’t load the goal form. Try again.</p>
      ) : (
        <p role="status" className="text-sm text-zinc-500">
          Loading…
        </p>
      )}
    </Dialog>
  );
}
