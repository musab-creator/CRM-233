import { NextRequest, NextResponse, after } from "next/server";
import { requeue, runOrder } from "@/lib/pipeline";
import { safeEqual } from "@/lib/store";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const key = String(form.get("key") ?? "");
  const id = String(form.get("id") ?? "");
  const adminKey = process.env.XTRACT_ADMIN_KEY;
  if (!adminKey || !safeEqual(key, adminKey)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (await requeue(id)) after(() => runOrder(id));
  return NextResponse.redirect(new URL(`/admin?key=${encodeURIComponent(key)}`, req.url), 303);
}
