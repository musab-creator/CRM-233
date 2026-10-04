"use client";

import { useState } from "react";
import { ArrowRight, Check, LoaderCircle, Lock } from "lucide-react";
import type { Product } from "@/lib/config";
import type { ReportTier } from "@/lib/types";

interface Props {
  products: Product[];
  initialTier: ReportTier;
  initialAddress: string;
  liveStripe: boolean;
  canceled: boolean;
}

type Errors = Partial<Record<"tier" | "address" | "name" | "email" | "form", string>>;

const fmt = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

export function OrderForm({ products, initialTier, initialAddress, liveStripe, canceled }: Props) {
  const [tier, setTier] = useState<ReportTier>(initialTier);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Errors>(canceled ? { form: "Checkout was canceled — your order wasn't charged." } : {});
  const product = products.find((p) => p.tier === tier)!;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    const data = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, tier }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrors(json.errors ?? { form: json.error ?? "Something went wrong. Try again." });
        setBusy(false);
        return;
      }
      window.location.href = json.redirectUrl;
    } catch {
      setErrors({ form: "Network error — check your connection and try again." });
      setBusy(false);
    }
  }

  const field = "mt-1.5 block h-12 w-full rounded-lg border bg-white px-3.5 text-base text-ink outline-none transition-colors duration-150 placeholder:text-slate-400 focus:border-brand focus:ring-2 focus:ring-brand/20";
  const border = (k: keyof Errors) => (errors[k] ? "border-red-500" : "border-line");

  return (
    <form onSubmit={submit} noValidate className="grid gap-8 lg:grid-cols-[1fr_340px]">
      <div className="space-y-8">
        <fieldset>
          <legend className="text-sm font-bold uppercase tracking-wider text-muted">1 · Report type</legend>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {products.map((p) => {
              const sel = p.tier === tier;
              return (
                <label
                  key={p.tier}
                  className={`relative flex cursor-pointer flex-col rounded-xl border-2 p-4 transition-colors duration-150 ${
                    sel ? "border-brand bg-sky-50" : "border-line bg-white hover:border-slate-300"
                  }`}
                >
                  <input type="radio" name="tierChoice" value={p.tier} checked={sel} onChange={() => setTier(p.tier)} className="sr-only" />
                  <span className="flex items-center justify-between">
                    <span className="font-bold">{p.name}</span>
                    <span className={`flex h-5 w-5 items-center justify-center rounded-full ${sel ? "bg-brand text-white" : "border border-slate-300"}`}>
                      {sel && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                    </span>
                  </span>
                  <span className="mt-1 font-mono text-2xl font-semibold">{fmt(p.priceCents)}</span>
                  <span className="mt-1 text-xs leading-5 text-muted">{p.tagline}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-sm font-bold uppercase tracking-wider text-muted">2 · Property</legend>
          <label htmlFor="address" className="mt-3 block text-sm font-semibold">
            Street address
          </label>
          <input
            id="address"
            name="address"
            defaultValue={initialAddress}
            required
            autoComplete="street-address"
            placeholder="123 Main St, Jacksonville, FL 32256"
            aria-invalid={Boolean(errors.address)}
            aria-describedby={errors.address ? "address-err" : "address-help"}
            className={`${field} ${border("address")}`}
          />
          {errors.address ? (
            <p id="address-err" className="mt-1.5 text-sm text-red-600">{errors.address}</p>
          ) : (
            <p id="address-help" className="mt-1.5 text-sm text-muted">Include city, state and ZIP for the best match.</p>
          )}
          <label htmlFor="notes" className="mt-5 block text-sm font-semibold">
            Notes <span className="font-normal text-muted">(optional)</span>
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={3}
            placeholder="e.g. measure the detached garage too"
            className="mt-1.5 block w-full rounded-lg border border-line bg-white px-3.5 py-3 text-base outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
          />
        </fieldset>

        <fieldset>
          <legend className="text-sm font-bold uppercase tracking-wider text-muted">3 · Delivery</legend>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="name" className="block text-sm font-semibold">Your name</label>
              <input id="name" name="name" required autoComplete="name" aria-invalid={Boolean(errors.name)} className={`${field} ${border("name")}`} />
              {errors.name && <p className="mt-1.5 text-sm text-red-600">{errors.name}</p>}
            </div>
            <div>
              <label htmlFor="email" className="block text-sm font-semibold">Email for the report</label>
              <input id="email" name="email" type="email" required autoComplete="email" inputMode="email" aria-invalid={Boolean(errors.email)} className={`${field} ${border("email")}`} />
              {errors.email && <p className="mt-1.5 text-sm text-red-600">{errors.email}</p>}
            </div>
            <div>
              <label htmlFor="company" className="block text-sm font-semibold">Company <span className="font-normal text-muted">(shown on report)</span></label>
              <input id="company" name="company" autoComplete="organization" className={`${field} border-line`} />
            </div>
            <div>
              <label htmlFor="phone" className="block text-sm font-semibold">Phone <span className="font-normal text-muted">(optional)</span></label>
              <input id="phone" name="phone" type="tel" autoComplete="tel" inputMode="tel" className={`${field} border-line`} />
            </div>
          </div>
        </fieldset>
      </div>

      <aside className="lg:sticky lg:top-24 lg:self-start">
        <div className="rounded-2xl border border-line bg-white p-6 shadow-sm">
          <h2 className="text-sm font-bold uppercase tracking-wider text-muted">Order summary</h2>
          <div className="mt-4 flex items-baseline justify-between">
            <span className="font-bold">{product.name}</span>
            <span className="font-mono text-xl font-semibold">{fmt(product.priceCents)}</span>
          </div>
          <ul className="mt-4 space-y-2 border-t border-line pt-4 text-sm">
            {product.includes.map((i) => (
              <li key={i} className="flex gap-2 text-slate">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden="true" /> {i}
              </li>
            ))}
          </ul>
          {errors.form && (
            <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{errors.form}</p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="mt-6 inline-flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-brand font-bold text-white transition-colors duration-200 hover:bg-brand-600 disabled:cursor-wait disabled:opacity-70"
          >
            {busy ? (
              <>
                <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" /> {liveStripe ? "Opening checkout…" : "Placing order…"}
              </>
            ) : (
              <>
                {liveStripe ? `Pay ${fmt(product.priceCents)}` : "Place demo order"} <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </>
            )}
          </button>
          <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted">
            {liveStripe ? (
              <>
                <Lock className="h-3.5 w-3.5" aria-hidden="true" /> Secure checkout by Stripe
              </>
            ) : (
              "Demo mode: no payment is taken"
            )}
          </p>
        </div>
      </aside>
    </form>
  );
}
