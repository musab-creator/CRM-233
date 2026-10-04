"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FileText, FolderOpen, LoaderCircle, Plus, Save, Search } from "lucide-react";
import { EDGE_LABEL, EDGE_ORDER } from "@/lib/edges";

export interface Row {
  id: string;
  kind: "auto" | "manual";
  address: string;
  created: string;
  status: string;
  area: number | null;
}

const STATUS: Record<string, [string, string]> = {
  delivered: ["Ready", "bg-emerald-100 text-emerald-800"],
  needs_review: ["In review", "bg-amber-100 text-amber-900"],
  failed: ["In review", "bg-amber-100 text-amber-900"],
  awaiting_payment: ["Awaiting payment", "bg-slate-100 text-slate-700"],
};

export function ReportList({ rows }: { rows: Row[] }) {
  const [q, setQ] = useState("");
  const shown = rows.filter((r) => r.address.toLowerCase().includes(q.toLowerCase()) || r.id.toLowerCase().includes(q.toLowerCase()));
  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-extrabold">Your reports</h2>
        <label className="flex h-11 items-center gap-2 rounded-lg border border-line bg-white px-3">
          <Search className="h-4 w-4 text-muted" aria-hidden="true" />
          <span className="sr-only">Search reports</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by address or order #" className="w-56 bg-transparent text-sm outline-none" />
        </label>
      </div>
      {rows.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-line bg-white p-10 text-center">
          <FolderOpen className="mx-auto h-10 w-10 text-muted" aria-hidden="true" />
          <h3 className="mt-3 font-bold">No reports yet</h3>
          <p className="mt-1 text-sm text-muted">Order a measured report, or build a manual one from quantities you already have.</p>
          <Link href="/order" className="mt-5 inline-flex h-11 items-center gap-2 rounded-xl bg-brand px-5 font-bold text-white hover:bg-brand-600">
            <Plus className="h-4 w-4" aria-hidden="true" /> Order a report
          </Link>
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-white">
          {shown.map((r) => {
            const [label, tone] = STATUS[r.status] ?? ["Processing", "bg-sky-100 text-sky-800"];
            return (
              <li key={r.id}>
                <Link href={`/order/${r.id}`} className="flex items-center gap-4 p-4 transition-colors hover:bg-panel">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-panel text-brand">
                    <FileText className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <b className="block truncate">{r.address}</b>
                    <small className="text-muted">
                      {r.id} · {new Date(r.created).toLocaleDateString()} · {r.area ? `${r.area.toLocaleString()} sqft` : "measurements pending"}
                      {r.kind === "manual" ? " · manual" : ""}
                    </small>
                  </span>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>{label}</span>
                </Link>
              </li>
            );
          })}
          {shown.length === 0 && <li className="p-6 text-center text-sm text-muted">No reports match “{q}”.</li>}
        </ul>
      )}
    </section>
  );
}

const field = "mt-1 block h-11 w-full rounded-lg border border-line bg-white px-3 text-base outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";

export function ManualReportForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = {
      address: f.get("address"),
      areaSqFt: f.get("areaSqFt"),
      facets: f.get("facets") || 0,
      pitch: f.get("pitch") || 0,
      lengths: Object.fromEntries(EDGE_ORDER.map((k) => [k, f.get(`len-${k}`) || 0])),
    };
    setBusy(true);
    setError("");
    const res = await fetch("/api/reports/manual", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const j = res ? await res.json() : { error: "Network error" };
    if (!res?.ok) {
      setBusy(false);
      return setError(j.errors?.address ?? j.error ?? "Couldn't create the report");
    }
    router.push(`/order/${j.id}`);
  }
  return (
    <form id="manual" onSubmit={submit} className="scroll-mt-28 rounded-2xl border border-line bg-white p-6">
      <h2 className="text-xl font-extrabold">Manual report</h2>
      <p className="mt-1 text-sm text-muted">Already have quantities? Build the summary, roof-age and brand materials pages from them — free.</p>
      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2 lg:col-span-4">
          <label htmlFor="m-address" className="text-sm font-semibold">Property address</label>
          <input id="m-address" name="address" required minLength={8} className={field} placeholder="Street, city, state, ZIP" />
        </div>
        <div>
          <label htmlFor="m-area" className="text-sm font-semibold">Total roof area (sqft)</label>
          <input id="m-area" name="areaSqFt" type="number" min={1} step="0.01" required className={field} />
        </div>
        <div>
          <label htmlFor="m-facets" className="text-sm font-semibold">Facets</label>
          <input id="m-facets" name="facets" type="number" min={0} step={1} className={field} />
        </div>
        <div>
          <label htmlFor="m-pitch" className="text-sm font-semibold">Predominant pitch (/12)</label>
          <input id="m-pitch" name="pitch" type="number" min={0} max={48} step="0.5" className={field} />
        </div>
      </div>
      <fieldset className="mt-5">
        <legend className="text-sm font-semibold">Edge lengths (linear feet)</legend>
        <div className="mt-2 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {EDGE_ORDER.map((k) => (
            <div key={k}>
              <label htmlFor={`len-${k}`} className="text-xs text-muted">{EDGE_LABEL[k]}</label>
              <input id={`len-${k}`} name={`len-${k}`} type="number" min={0} step="0.01" className={field} />
            </div>
          ))}
        </div>
      </fieldset>
      {error && <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <button disabled={busy} className="mt-5 inline-flex h-11 cursor-pointer items-center gap-2 rounded-xl bg-ink px-5 font-bold text-white hover:bg-ink-2 disabled:opacity-60">
        {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />} Create manual report
      </button>
    </form>
  );
}

export function ProfileForm({ company, phone }: { company: string; phone: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const res = await fetch("/api/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(e.currentTarget))) }).catch(() => null);
    setBusy(false);
    setMsg(res?.ok ? "Saved. New reports will use these details." : "Couldn't save");
  }
  return (
    <form onSubmit={submit} className="rounded-2xl border border-line bg-white p-6">
      <h2 className="text-xl font-extrabold">Report branding</h2>
      <p className="mt-1 text-sm text-muted">Printed as “Prepared by” on every page of new reports.</p>
      <label htmlFor="p-company" className="mt-4 block text-sm font-semibold">Company</label>
      <input id="p-company" name="company" defaultValue={company} maxLength={120} className={field} />
      <label htmlFor="p-phone" className="mt-3 block text-sm font-semibold">Phone</label>
      <input id="p-phone" name="phone" type="tel" defaultValue={phone} maxLength={40} className={field} />
      {msg && <p role="status" className="mt-3 text-sm text-emerald-700">{msg}</p>}
      <button disabled={busy} className="mt-4 inline-flex h-11 cursor-pointer items-center gap-2 rounded-xl bg-brand px-5 font-bold text-white hover:bg-brand-600 disabled:opacity-60">
        <Save className="h-4 w-4" aria-hidden="true" /> Save details
      </button>
    </form>
  );
}
