import { redirect } from "next/navigation";

// Nov 1 notes (batch 11): emails are hard-coded in the app's templates, so the Admin console has no email
// design editor any more. Old links land on Email delivery.
export default function AdminEmailsPage() {
  redirect("/admin/email");
}
