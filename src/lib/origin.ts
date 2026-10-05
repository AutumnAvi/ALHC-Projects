import "server-only";
import { headers } from "next/headers";

// Absolute origin for share links (public form URLs, embed snippets). NEXT_PUBLIC_APP_URL wins so
// links stay on the production domain even when viewed from a preview deployment.
export async function requestOrigin() {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
