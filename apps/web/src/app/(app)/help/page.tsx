import { redirect } from "next/navigation";

// Nov 10 audit (G19): /help on its own was a 404. The roles page is the only help page.
export default function HelpPage() {
  redirect("/help/roles");
}
