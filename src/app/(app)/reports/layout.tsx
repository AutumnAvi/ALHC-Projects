import type { ReactNode } from "react";
import { ChartColumn } from "lucide-react";
import { ReportsTabs } from "@/components/reports/report-chrome";
import { PageHeader } from "@/components/ui";

// Workspace Reports: charts and tables over every project the viewer can read. Projects they can't
// read are never named, only counted.
export default function ReportsLayout({ children }: { children: ReactNode }) {
  return (
    <main className="report-page flex min-h-0 flex-1 flex-col">
      <PageHeader icon={ChartColumn} title="Reports" description="Status, workload, and progress across every project you can open" />
      <ReportsTabs />
      <div className="report-scroll min-h-0 flex-1 overflow-y-auto">{children}</div>
    </main>
  );
}
