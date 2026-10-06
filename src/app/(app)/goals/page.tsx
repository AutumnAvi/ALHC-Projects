import type { Metadata } from "next";
import { Target } from "lucide-react";
import { displayName } from "@/components/avatar";
import { GoalsView } from "@/components/goals/goals-view";
import { PageHeader } from "@/components/ui";
import { getGoalViewer, listGoalProgress, listGoals, listProfiles, listTeams } from "@/lib/data";
import { getViewerTimeZone } from "@/lib/timezone";
import { todayIn } from "@/lib/workload";

export const metadata: Metadata = { title: "Goals" };

// Workspace goals as a tree. Everyone allowlisted reads every goal; progress is computed per viewer
// and never counts projects they can't open.
export default async function GoalsPage({ searchParams }: PageProps<"/goals">) {
  const { team, period } = await searchParams;
  const [goals, progress, viewer, profiles, teams, timeZone] = await Promise.all([
    listGoals(),
    listGoalProgress(),
    getGoalViewer(),
    listProfiles(),
    listTeams(),
    getViewerTimeZone(),
  ]);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader icon={Target} title="Goals" description="What the department is working toward, and how far along it is" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <GoalsView
          goals={goals}
          progress={Object.fromEntries(progress)}
          viewer={viewer}
          people={profiles.map((p) => ({ id: p.id, name: displayName(p) }))}
          teams={teams.map((t) => ({ id: t.id, name: t.name }))}
          today={todayIn(timeZone)}
          filters={{
            team: typeof team === "string" ? team : "",
            period: typeof period === "string" ? period : "",
          }}
        />
      </div>
    </main>
  );
}
