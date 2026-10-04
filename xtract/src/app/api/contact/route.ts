import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { currentUser, sameOrigin } from "@/lib/auth";
import { json } from "@/lib/access";
import { forwardMessage } from "@/lib/email";
import { addMessage } from "@/lib/store";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return json({ error: "Request rejected" }, 403);
  const user = await currentUser();
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = String(b.name ?? "").trim().slice(0, 120);
  const email = (user?.email ?? String(b.email ?? "")).trim().toLowerCase();
  const message = String(b.message ?? "").trim();
  const errors: Record<string, string> = {};
  if (!name) errors.name = "Enter your name";
  if (!EMAIL.test(email)) errors.email = "Enter a valid email so we can reply";
  if (message.length < 10 || message.length > 3000) errors.message = "Enter a message between 10 and 3,000 characters";
  if (Object.keys(errors).length) return json({ errors }, 422);
  const m = { id: crypto.randomUUID(), at: new Date().toISOString(), name, email, message, userId: user?.id };
  await addMessage(m);
  const emailed = await forwardMessage(m).catch(() => false);
  return json({ ok: true, ref: m.id.slice(0, 8).toUpperCase(), emailed });
}
