"use client";

import { useState } from "react";
import { LoaderCircle, Mail } from "lucide-react";

export function SignInForm({ next, expired }: { next: string; expired: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(expired ? "That sign-in link has expired or was already used. Request a new one." : "");
  const [sent, setSent] = useState<string | null>(null);
  const [demoLink, setDemoLink] = useState<string | null>(null);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email") ?? "");
    setBusy(true);
    setError("");
    const res = await fetch("/api/auth/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, next }) }).catch(() => null);
    const j = res ? await res.json() : { error: "Network error" };
    setBusy(false);
    if (!res?.ok) return setError(j.errors?.email ?? j.error ?? "Couldn't send the link");
    setSent(email);
    setDemoLink(j.demoLink ?? null);
  }
  if (sent)
    return (
      <div role="status" className="rounded-2xl border border-line bg-white p-6">
        <Mail className="h-8 w-8 text-brand" aria-hidden="true" />
        <h2 className="mt-3 text-xl font-bold">{demoLink ? "Demo mode: email isn't configured" : "Check your email"}</h2>
        {demoLink ? (
          <p className="mt-2 text-slate">
            On a live server we&apos;d email this link to {sent}.{" "}
            <a href={demoLink} className="font-bold text-brand underline">
              Continue signing in
            </a>
          </p>
        ) : (
          <p className="mt-2 text-slate">We sent a sign-in link to <b>{sent}</b>. It works once and expires in 20 minutes.</p>
        )}
      </div>
    );
  return (
    <form onSubmit={submit} noValidate className="rounded-2xl border border-line bg-white p-6">
      <label htmlFor="si-email" className="text-sm font-semibold">Email</label>
      <input id="si-email" name="email" type="email" required autoComplete="email" inputMode="email" placeholder="you@company.com" className="mt-1.5 block h-12 w-full rounded-lg border border-line px-3.5 text-base outline-none focus:border-brand focus:ring-2 focus:ring-brand/20" />
      {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
      <button disabled={busy} className="mt-4 inline-flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-brand font-bold text-white hover:bg-brand-600 disabled:opacity-70">
        {busy && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />} Email me a sign-in link
      </button>
      <p className="mt-3 text-center text-xs text-muted">No password. Use the email you order reports with to see them all.</p>
    </form>
  );
}
