import { NextResponse, type NextRequest } from "next/server";
import * as authApi from "@/lib/api/auth/mutations";
import { routeContext } from "@/lib/server/context";

export async function POST(request: NextRequest) {
  await authApi.signOut(await routeContext());
  return NextResponse.redirect(new URL("/login", request.nextUrl.origin), { status: 303 });
}
