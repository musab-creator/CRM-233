import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { appUrl } from "@/lib/config";
import { consumeLoginToken, listOrders, upsertUser } from "@/lib/store";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const next = req.nextUrl.searchParams.get("next") ?? "/dashboard";
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
  const email = token ? await consumeLoginToken(token) : null;
  if (!email) return NextResponse.redirect(new URL("/signin?expired=1", appUrl()), 303);
  let user = await upsertUser(email);
  if (!user.company) {
    // First sign-in: adopt branding from the most recent order.
    const last = (await listOrders((o) => o.customer.email === email && Boolean(o.customer.company)))[0];
    if (last) user = await upsertUser(email, { company: last.customer.company, phone: last.customer.phone });
  }
  const { value, maxAge } = await signSession(user.id);
  const res = NextResponse.redirect(new URL(safeNext, appUrl()), 303);
  res.cookies.set(SESSION_COOKIE, value, sessionCookieOptions(maxAge));
  return res;
}
