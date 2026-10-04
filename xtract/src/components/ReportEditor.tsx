"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LoaderCircle, Save, Trash2, Upload } from "lucide-react";

interface Props {
  id: string;
  initial: { company?: string; phone?: string; notes?: string; lastRoofPermitYear?: number };
  onSaved: () => void;
}

/** Owner-only: change what's printed on the report and regenerate the PDF. */
export function ReportEditor({ id, initial, onSaved }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<"save" | "photo" | "delete" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy("save");
    setMsg(null);
    const res = await fetch(`/api/reports/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(e.currentTarget))),
    }).catch(() => null);
    const j = res ? await res.json() : { error: "Network error" };
    setBusy(null);
    setMsg(res?.ok ? { ok: true, text: "Saved — the PDF has been regenerated." } : { ok: false, text: j.error ?? "Couldn't save" });
    if (res?.ok) onSaved();
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy("photo");
    setMsg(null);
    const fd = new FormData();
    fd.set("file", file);
    const res = await fetch(`/api/reports/${id}/photo`, { method: "POST", body: fd }).catch(() => null);
    const j = res ? await res.json() : { error: "Network error" };
    setBusy(null);
    setMsg(res?.ok ? { ok: true, text: "Cover photo attached — the PDF has been regenerated." } : { ok: false, text: j.error ?? "Upload failed" });
    if (res?.ok) onSaved();
  }

  async function remove() {
    if (!confirm("Delete this report, its PDF and photos? This can't be undone.")) return;
    setBusy("delete");
    const res = await fetch(`/api/reports/${id}`, { method: "DELETE" }).catch(() => null);
    if (res?.ok) router.push("/dashboard");
    else {
      setBusy(null);
      setMsg({ ok: false, text: "Couldn't delete the report" });
    }
  }

  const field = "mt-1.5 block h-11 w-full rounded-lg border border-line bg-white px-3 text-base outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";
  return (
    <section className="rounded-2xl border border-line bg-white p-6">
      <h2 className="text-xl font-extrabold">Edit this report</h2>
      <p className="mt-1 text-sm text-muted">Changes are printed on every page. The PDF regenerates instantly — no new charge.</p>
      <form onSubmit={save} className="mt-5 grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="e-company" className="text-sm font-semibold">Prepared by (company)</label>
          <input id="e-company" name="company" defaultValue={initial.company} maxLength={120} className={field} />
        </div>
        <div>
          <label htmlFor="e-phone" className="text-sm font-semibold">Phone</label>
          <input id="e-phone" name="phone" type="tel" defaultValue={initial.phone} maxLength={40} className={field} />
        </div>
        <div>
          <label htmlFor="e-permit" className="text-sm font-semibold">Last roof permit year</label>
          <input id="e-permit" name="lastRoofPermitYear" type="number" min={1900} max={new Date().getFullYear()} defaultValue={initial.lastRoofPermitYear} placeholder="e.g. 2019" className={field} />
          <p className="mt-1 text-xs text-muted">From the county permit portal. Updates the roof-age page.</p>
        </div>
        <div>
          <label htmlFor="e-photo" className="text-sm font-semibold">Cover photo (PNG/JPEG, ≤ 8 MB)</label>
          <input id="e-photo" type="file" accept="image/png,image/jpeg" disabled={busy !== null} onChange={(e) => upload(e.target.files?.[0])} className="mt-1.5 block w-full text-sm file:mr-3 file:h-11 file:cursor-pointer file:rounded-lg file:border-0 file:bg-panel file:px-4 file:font-semibold" />
          <p className="mt-1 text-xs text-muted">Replaces the aerial on page 1 — e.g. a drone shot.</p>
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="e-notes" className="text-sm font-semibold">Internal notes</label>
          <textarea id="e-notes" name="notes" rows={3} defaultValue={initial.notes} maxLength={3000} className="mt-1.5 block w-full rounded-lg border border-line px-3 py-2.5 text-base outline-none focus:border-brand focus:ring-2 focus:ring-brand/20" />
        </div>
        {msg && (
          <p role={msg.ok ? "status" : "alert"} className={`sm:col-span-2 rounded-lg p-3 text-sm ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>
            {msg.text}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 sm:col-span-2">
          <button disabled={busy !== null} className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-xl bg-brand px-5 font-bold text-white hover:bg-brand-600 disabled:opacity-60">
            {busy === "save" || busy === "photo" ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : busy === null ? <Save className="h-4 w-4" aria-hidden="true" /> : <Upload className="h-4 w-4" aria-hidden="true" />} Save & regenerate
          </button>
          <button type="button" onClick={remove} disabled={busy !== null} className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-xl px-4 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60">
            <Trash2 className="h-4 w-4" aria-hidden="true" /> Delete report
          </button>
        </div>
      </form>
    </section>
  );
}
