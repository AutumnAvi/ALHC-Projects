import type { Metadata } from "next";
import { PublicFormPage, loadPublicForm } from "@/components/forms/public-form-page";

export async function generateMetadata({ params }: PageProps<"/forms/[formId]/embed">): Promise<Metadata> {
  const { formId } = await params;
  const form = await loadPublicForm(formId);
  // Nov 10 audit (G16): public pages carry the company's name, not the app's.
  return { title: { absolute: `${form?.title ?? "Form"} · Autumn Lake Marketing` }, robots: { index: false } };
}

export default async function EmbeddedFormPage({ params }: PageProps<"/forms/[formId]/embed">) {
  const { formId } = await params;
  return <PublicFormPage formId={formId} embed />;
}
