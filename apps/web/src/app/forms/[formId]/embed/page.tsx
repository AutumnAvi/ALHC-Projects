import type { Metadata } from "next";
import { PublicFormPage, loadPublicForm } from "@/components/forms/public-form-page";

export async function generateMetadata({ params }: PageProps<"/forms/[formId]/embed">): Promise<Metadata> {
  const { formId } = await params;
  const form = await loadPublicForm(formId);
  return { title: form?.title ?? "Form", robots: { index: false } };
}

export default async function EmbeddedFormPage({ params }: PageProps<"/forms/[formId]/embed">) {
  const { formId } = await params;
  return <PublicFormPage formId={formId} embed />;
}
