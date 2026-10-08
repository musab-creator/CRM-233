import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { BRAND } from "@/lib/config";
import { Logo } from "./Logo";
import { MobileNav } from "./MobileNav";

export const NAV = [
  { href: "/sample", label: "Our reports" },
  { href: "/#how", label: "How it works" },
  { href: "/pricing", label: "Pricing" },
  { href: "/quality", label: "Accuracy" },
  { href: "/contact", label: "Support" },
];

export async function SiteHeader() {
  const user = await currentUser();
  return (
    <header className="sticky top-0 z-40">
      <div className="hidden bg-[#0a1c2a] text-[12px] text-slate-400 md:block">
        <div className="mx-auto flex h-8 max-w-6xl items-center justify-between px-4 sm:px-6">
          <span>Aerial roof measurement reports · delivered automatically</span>
          <span className="flex gap-5">
            <a href={BRAND.phoneHref} className="hover:text-white">{BRAND.phone}</a>
            <Link href="/quality" className="hover:text-white">Reporting standards</Link>
          </span>
        </div>
      </div>
      <div className="border-b border-white/10 bg-ink/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/" aria-label="Xtract Roof Reports home">
            <Logo dark />
          </Link>
          <nav aria-label="Main" className="hidden items-center gap-6 lg:flex">
            {NAV.map((l) => (
              <Link key={l.href} href={l.href} className="text-sm font-medium text-slate-300 transition-colors duration-200 hover:text-white">
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <Link href={user ? "/dashboard" : "/signin"} className="hidden h-10 items-center rounded-lg px-3 text-sm font-semibold text-slate-200 hover:bg-white/10 sm:inline-flex">
              {user ? "My reports" : "Sign in"}
            </Link>
            <Link href="/order" className="inline-flex h-10 items-center whitespace-nowrap rounded-lg bg-amber px-4 text-sm font-bold text-ink shadow-sm transition-colors duration-200 hover:bg-amber-400">
              Order a report
            </Link>
            <MobileNav signedIn={Boolean(user)} />
          </div>
        </div>
      </div>
    </header>
  );
}
