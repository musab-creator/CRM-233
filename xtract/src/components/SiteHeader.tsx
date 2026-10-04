import Link from "next/link";
import { Logo } from "./Logo";

const links = [
  { href: "/#how", label: "How it works" },
  { href: "/#report", label: "The report" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/#faq", label: "FAQ" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-ink/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" aria-label="Xtract Roof Reports home" className="[&_.text-muted]:text-slate-400">
          <Logo dark />
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-7 md:flex">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="text-sm font-medium text-slate-300 transition-colors duration-200 hover:text-white">
              {l.label}
            </Link>
          ))}
        </nav>
        <Link
          href="/order"
          className="inline-flex h-10 items-center whitespace-nowrap rounded-lg bg-amber px-4 text-sm font-bold text-ink shadow-sm transition-colors duration-200 hover:bg-amber-400"
        >
          Order a report
        </Link>
      </div>
    </header>
  );
}
