import { NextRequest, NextResponse } from "next/server";
import { sameOrigin } from "@/lib/auth";
import { accessOrder, json } from "@/lib/access";
import { regenerate } from "@/lib/pipeline";
import { deleteOrder, readFile, updateOrder } from "@/lib/store";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const a = await accessOrder(id, req.nextUrl.searchParams.get("t"));
  if (!a?.order.files?.pdf) return json({ error: "Not found" }, 404);
  const pdf = await readFile(a.order.files.pdf);
  const inline = req.nextUrl.searchParams.get("view") === "1";
  const name = `Roof Report - ${(a.order.location?.formattedAddress ?? a.order.address).replace(/[^\w ,.-]/g, "")}.pdf`;
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name}"`,
      "Cache-Control": "private, no-store",
    },
  });
}

const year = (v: unknown) => {
  if (v === "" || v === null || v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1900 || n > new Date().getFullYear()) throw new Error("Enter a valid permit year");
  return n;
};

/** Owner edits: branding on the report, last roof permit, notes. Re-renders the PDF. */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  if (!sameOrigin(req)) return json({ error: "Request rejected" }, 403);
  const { id } = await params;
  const a = await accessOrder(id, null);
  if (!a?.owner) return json({ error: "Sign in to edit this report" }, 401);
  const b = (await req.json()) as Record<string, unknown>;
  let permitYear: number | undefined;
  try {
    permitYear = year(b.lastRoofPermitYear);
  } catch (e) {
    return json({ error: (e as Error).message }, 422);
  }
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
  await updateOrder(id, (o) => ({
    ...o,
    customer: { ...o.customer, company: str(b.company, 120) ?? o.customer.company, phone: str(b.phone, 40) ?? o.customer.phone },
    notes: str(b.notes, 3000) ?? o.notes,
    property: {
      source: o.property?.source ?? "Entered by report owner",
      checkedAt: o.property?.checkedAt ?? new Date().toISOString(),
      ...o.property,
      lastRoofPermitYear: permitYear,
      permitsChecked: o.property?.permitsChecked ?? false,
    },
  }));
  const o = await regenerate(id);
  return json({ ok: true, updatedAt: o?.updatedAt });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!sameOrigin(req)) return json({ error: "Request rejected" }, 403);
  const { id } = await params;
  const a = await accessOrder(id, null);
  if (!a?.owner) return json({ error: "Sign in to delete this report" }, 401);
  await deleteOrder(id);
  return json({ ok: true });
}
