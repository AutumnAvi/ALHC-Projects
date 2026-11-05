import type { Metadata } from "next";
import { LayoutTemplate } from "lucide-react";
import { TemplateGallery } from "@/components/templates/template-gallery";
import { PageHeader } from "@/components/ui";
import { listAllTaskTemplates, listProjectTemplates } from "@/lib/data";

export const metadata: Metadata = { title: "Templates" };

export default async function TemplatesPage() {
  const [templates, taskTemplates] = await Promise.all([listProjectTemplates(), listAllTaskTemplates()]);
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={LayoutTemplate}
        title="Templates"
        description="Start a project from a template, or reuse task templates from quick-add"
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <TemplateGallery templates={templates} taskTemplates={taskTemplates} />
      </div>
    </main>
  );
}
