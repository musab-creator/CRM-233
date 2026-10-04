import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { appUrl } from "@/lib/config";

export async function POST() {
  const res = NextResponse.redirect(new URL("/", appUrl()), 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
