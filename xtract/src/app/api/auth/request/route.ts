import { NextRequest } from "next/server";
import { sameOrigin } from "@/lib/auth";
import { json } from "@/lib/access";
import { appUrl, demoSignInAllowed } from "@/lib/config";
import { sendSignInLink } from "@/lib/email";
import { createLoginToken } from "@/lib/store";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return json({ error: "Request rejected" }, 403);
  const { email, next } = (await req.json().catch(() => ({}))) as { email?: string; next?: string };
  const e = String(email ?? "").trim().toLowerCase();
  if (!EMAIL.test(e)) return json({ errors: { email: "Enter a valid email address" } }, 422);
  const dest = typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
  const token = await createLoginToken(e);
  const link = `${appUrl()}/api/auth/verify?token=${token}&next=${encodeURIComponent(dest)}`;
  if (await sendSignInLink(e, link)) return json({ sent: true });
  if (demoSignInAllowed()) return json({ sent: false, demoLink: link });
  return json({ error: "Sign-in email isn't configured on this server yet." }, 503);
}
