import { notFound } from "next/navigation";
import { Sparkles } from "lucide-react";
import { getAiBuilderAccess, listAiRuns } from "@alhc/core/api/ai-builder/queries";
import { AiRunHistory } from "@/components/ai-builder/ai-run-history";
import { PageHeader } from "@/components/ui";
import { getViewer } from "@/lib/auth";
import { bind } from "@/lib/server/context";

// AI builder pilot (experimental, feat/ai-builder): the Testing data pilot's run log (who, when, status,
// model, tokens, what each run created) with Undo for your own applied runs. A 404 for everyone but the
// pilot workspace's admins (RLS returns nothing to them either).
const access = bind(getAiBuilderAccess);
const runs = bind(listAiRuns);

export default async function AiBuilderHistoryPage() {
  const state = await access();
  if (state.status !== "ready") notFound();
  const { user } = await getViewer();
  const list = await runs(state.workspaceId, user?.id ?? null);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PageHeader
        icon={Sparkles}
        title="AI builder history"
        description={`Experimental pilot · ${state.workspaceName} workspace only · the latest 50 runs`}
      />
      <div className="px-gutter py-4">
        <AiRunHistory runs={list} />
      </div>
    </div>
  );
}
