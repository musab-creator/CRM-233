"use client";

import { useState } from "react";
import { LoaderCircle, Send } from "lucide-react";

export function ContactForm({ email }: { email?: string }) {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setErrors({});
    const res = await fetch("/api/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) }).catch(() => null);
    const j = res ? await res.json() : { error: "Network error" };
    setBusy(false);
    if (!res?.ok) return setErrors(j.errors ?? { form: j.error ?? "Something went wrong" });
    form.reset();
    setDone(`Message received — reference ${j.ref}. ${j.emailed ? "Our team has it now." : "It's saved for our team."} We reply by email.`);
  }
  const field = "mt-1.5 block w-full rounded-lg border bg-white px-3.5 text-base outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";
  return (
    <form onSubmit={submit} noValidate className="space-y-4 rounded-2xl border border-line bg-white p-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="c-name" className="text-sm font-semibold">Name</label>
          <input id="c-name" name="name" autoComplete="name" className={`${field} h-12 ${errors.name ? "border-red-500" : "border-line"}`} />
          {errors.name && <p className="mt-1 text-sm text-red-600">{errors.name}</p>}
        </div>
        <div>
          <label htmlFor="c-email" className="text-sm font-semibold">Email</label>
          <input id="c-email" name="email" type="email" autoComplete="email" defaultValue={email} readOnly={Boolean(email)} className={`${field} h-12 ${errors.email ? "border-red-500" : "border-line"}`} />
          {errors.email && <p className="mt-1 text-sm text-red-600">{errors.email}</p>}
        </div>
      </div>
      <div>
        <label htmlFor="c-msg" className="text-sm font-semibold">Message</label>
        <textarea id="c-msg" name="message" rows={6} placeholder="For a report question, include the order number and the quantity you're checking." className={`${field} py-3 ${errors.message ? "border-red-500" : "border-line"}`} />
        {errors.message && <p className="mt-1 text-sm text-red-600">{errors.message}</p>}
      </div>
      {errors.form && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{errors.form}</p>}
      {done && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{done}</p>}
      <button disabled={busy} className="inline-flex h-12 cursor-pointer items-center gap-2 rounded-xl bg-brand px-6 font-bold text-white hover:bg-brand-600 disabled:opacity-70">
        {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />} Send message
      </button>
    </form>
  );
}
