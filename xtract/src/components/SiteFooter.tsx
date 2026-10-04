import Link from "next/link";
import { BRAND } from "@/lib/config";
import { Logo } from "./Logo";

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-panel">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.5fr_1fr_1fr]">
        <div>
          <Logo />
          <p className="mt-3 max-w-sm text-sm leading-6 text-muted">
            Aerial roof measurement reports for contractors, generated from imagery and delivered to your inbox automatically.
          </p>
        </div>
        <div>
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate">Product</h2>
          <ul className="mt-3 space-y-2 text-sm">
            <li><Link className="text-muted hover:text-ink" href="/#report">Report contents</Link></li>
            <li><Link className="text-muted hover:text-ink" href="/#pricing">Pricing</Link></li>
            <li><a className="text-muted hover:text-ink" href="/api/sample?tier=full" target="_blank" rel="noopener">Sample report (PDF)</a></li>
            <li><Link className="text-muted hover:text-ink" href="/order">Order a report</Link></li>
          </ul>
        </div>
        <div>
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate">Support</h2>
          <ul className="mt-3 space-y-2 text-sm">
            <li><a className="text-muted hover:text-ink" href={BRAND.phoneHref}>{BRAND.phone}</a></li>
            <li><a className="text-muted hover:text-ink" href={`mailto:${BRAND.supportEmail}`}>{BRAND.supportEmail}</a></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-line">
        <p className="mx-auto max-w-6xl px-4 py-5 text-xs text-muted sm:px-6">
          © {new Date().getFullYear()} {BRAND.full}. Measurements are derived from aerial imagery — verify critical dimensions on site.
        </p>
      </div>
    </footer>
  );
}
