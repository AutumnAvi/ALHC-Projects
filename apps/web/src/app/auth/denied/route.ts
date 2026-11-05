import { NextResponse, type NextRequest } from "next/server";
import * as authApi from "@alhc/core/api/auth/mutations";
import { getViewer } from "@alhc/core/api/auth/queries";
import { routeContext } from "@/lib/server/context";

// Reached when a signed-in user is no longer (or was never) allowlisted. Clears the session so the
// user is fully signed out, then shows the denied screen.
export async function GET(request: NextRequest) {
  const { origin } = request.nextUrl;
  const ctx = await routeContext();
  const { user, allowlisted } = await getViewer(ctx);

  if (user && allowlisted) return NextResponse.redirect(new URL("/", origin));

  const url = new URL("/denied", origin);
  if (user) {
    if (user.email) url.searchParams.set("email", user.email);
    await authApi.signOut(ctx);
  }
  return NextResponse.redirect(url);
}
