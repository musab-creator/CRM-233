import Link from "next/link";
import { BRAND } from "@/lib/config";
import { Logo } from "./Logo";

const cols: [string, [string, string][]][] = [
  ["Reports", [["/sample", "Explore the sample"], ["/api/sample", "Sample PDF (8 pages)"], ["/pricing", "Pricing"], ["/order", "Order a report"]]],
  ["Workspace", [["/dashboard", "My reports"], ["/dashboard#manual", "Manual report"], ["/quality", "Reporting standards"]]],
  ["Company", [["/contact", "Contact & support"], ["/privacy", "Privacy"], ["/terms", "Terms"]]],
];

export function SiteFooter() {
  return (
    <footer className="bg-ink text-slate-300">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div>
          <Logo dark />
          <p className="mt-4 max-w-xs text-sm leading-6 text-slate-400">Clear roof information and a consistent estimating workflow — measured, drawn and delivered automatically.</p>
          <p className="mt-4 text-sm">
            <a className="hover:text-white" href={BRAND.phoneHref}>{BRAND.phone}</a>
            <br />
            <a className="hover:text-white" href={`mailto:${BRAND.supportEmail}`}>{BRAND.supportEmail}</a>
            <br />
            <span className="text-slate-500">{BRAND.city}</span>
          </p>
        </div>
        {cols.map(([h, links]) => (
          <div key={h}>
            <h2 className="text-xs font-bold uppercase tracking-wider text-sky">{h}</h2>
            <ul className="mt-4 space-y-2.5 text-sm">
              {links.map(([href, label]) => (
                <li key={href}>
                  <Link className="text-slate-400 transition-colors hover:text-white" href={href}>{label}</Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-white/10">
        <p className="mx-auto flex max-w-6xl flex-wrap justify-between gap-2 px-4 py-5 text-xs text-slate-500 sm:px-6">
          <span>© {new Date().getFullYear()} {BRAND.full}. All rights reserved.</span>
          <span>Measurements derived from aerial imagery — verify critical dimensions on site.</span>
        </p>
      </div>
    </footer>
  );
}
