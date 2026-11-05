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

// Absolute origin for links built outside a request (email and webhook deliveries): NEXT_PUBLIC_APP_URL,
// else the Vercel production domain; null when neither is set.
export function backgroundOrigin(): string | null {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return vercel ? `https://${vercel}` : null;
}
