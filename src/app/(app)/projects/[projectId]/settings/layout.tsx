import { SettingsNav } from "@/components/project/settings-nav";

export default async function ProjectSettingsLayout({
  children,
  params,
}: LayoutProps<"/projects/[projectId]/settings">) {
  const { projectId } = await params;
  return (
    <main className="min-h-0 flex-1 overflow-auto">
      <SettingsNav projectId={projectId} />
      {children}
    </main>
  );
}
