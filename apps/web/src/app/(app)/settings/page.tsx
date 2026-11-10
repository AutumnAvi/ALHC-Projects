import { redirect } from "next/navigation";
import { settingsHref } from "@alhc/core/shell";

// Nov 10 audit (G19): /settings on its own was a 404. Settings is a modal: open it on Profile.
export default function SettingsPage() {
  redirect(settingsHref("profile"));
}
