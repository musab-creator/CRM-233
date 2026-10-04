import { NextRequest } from "next/server";
import { sameOrigin } from "@/lib/auth";
import { accessOrder, json } from "@/lib/access";
import { regenerate } from "@/lib/pipeline";
import { saveFile, updateOrder } from "@/lib/store";

/** Owner uploads a cover photo (PNG/JPEG ≤ 8 MB); the PDF is re-rendered with it. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(req)) return json({ error: "Request rejected" }, 403);
  const { id } = await params;
  const a = await accessOrder(id, null);
  if (!a?.owner) return json({ error: "Sign in to edit this report" }, 401);
  const file = (await req.formData()).get("file");
  if (!(file instanceof File) || file.size === 0 || file.size > 8 * 1024 * 1024) return json({ error: "Upload a PNG or JPEG under 8 MB." }, 422);
  const v = new Uint8Array(await file.arrayBuffer());
  const jpg = v[0] === 0xff && v[1] === 0xd8 && v[2] === 0xff;
  const png = v[0] === 0x89 && v[1] === 0x50 && v[2] === 0x4e && v[3] === 0x47;
  if (!jpg && !png) return json({ error: "Only PNG and JPEG images are supported." }, 422);
  const kind = jpg ? "jpg" : "png";
  const name = await saveFile(`${id}-photo.${kind}`, v);
  await updateOrder(id, (o) => ({ ...o, files: { ...o.files, photo: name, photoKind: kind } }));
  await regenerate(id);
  return json({ ok: true });
}
