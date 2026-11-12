import "server-only";
import { headers } from "next/headers";
import { authEmailOrigin, requestLinkOrigin } from "@/lib/app-origin";

// Absolute origin for share links (public form URLs, embed snippets, calendar links) and the review email.
// NEXT_PUBLIC_APP_URL wins so links stay on the production domain even when viewed from a preview
// deployment. Security audit 2 (Nov 12, batch 41): otherwise the request's host only when it is one of this
// app's own addresses (src/lib/app-origin.ts), else the app's own address — never a forged Host.
export async function requestOrigin() {
  const h = await headers();
  return requestLinkOrigin(h.get("x-forwarded-host") ?? h.get("host"), h.get("x-forwarded-proto"), process.env);
}

// The origin of the sign-up confirmation and password-reset links: the browser's Origin when it is one of
// this app's own addresses (so the link returns to the site that started it), else NEXT_PUBLIC_APP_URL,
// else the app's own address. Never the Host header.
export async function authLinkOrigin() {
  return authEmailOrigin((await headers()).get("origin"), process.env);
}

// Absolute origin for links built outside a request (email and webhook deliveries): NEXT_PUBLIC_APP_URL,
// else the Vercel production domain; null when neither is set.
export function backgroundOrigin(): string | null {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return vercel ? `https://${vercel}` : null;
}
