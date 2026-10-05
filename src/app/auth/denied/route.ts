import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

// Reached when a signed-in user is no longer (or was never) allowlisted. Clears the session so the
// user is fully signed out, then shows the denied screen.
export async function GET(request: NextRequest) {
  const { origin } = request.nextUrl;
  const { user, allowlisted } = await getViewer();

  if (user && allowlisted) return NextResponse.redirect(new URL("/", origin));

  const url = new URL("/denied", origin);
  if (user) {
    if (user.email) url.searchParams.set("email", user.email);
    const supabase = await createClient();
    await supabase.auth.signOut();
  }
  return NextResponse.redirect(url);
}
