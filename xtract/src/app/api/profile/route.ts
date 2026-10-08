import { NextRequest } from "next/server";
import { currentUser, sameOrigin } from "@/lib/auth";
import { json } from "@/lib/access";
import { upsertUser } from "@/lib/store";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return json({ error: "Request rejected" }, 403);
  const user = await currentUser();
  if (!user) return json({ error: "Sign in to continue" }, 401);
  const b = (await req.json()) as Record<string, unknown>;
  const u = await upsertUser(user.email, {
    company: String(b.company ?? "").trim().slice(0, 120) || undefined,
    phone: String(b.phone ?? "").trim().slice(0, 40) || undefined,
  });
  return json({ ok: true, company: u.company ?? "", phone: u.phone ?? "" });
}
