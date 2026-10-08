"use client";

import Link from "next/link";
import { useState } from "react";
import { Menu, X } from "lucide-react";

const NAV = [
  { href: "/sample", label: "Our reports" },
  { href: "/#how", label: "How it works" },
  { href: "/pricing", label: "Pricing" },
  { href: "/quality", label: "Accuracy" },
  { href: "/contact", label: "Support" },
];

export function MobileNav({ signedIn }: { signedIn: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="lg:hidden">
      <button onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Toggle navigation" className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg text-white hover:bg-white/10">
        {open ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
      </button>
      {open && (
        <nav aria-label="Mobile" className="absolute inset-x-0 top-full border-b border-white/10 bg-ink px-4 pb-4 shadow-2xl">
          {[...NAV, { href: signedIn ? "/dashboard" : "/signin", label: signedIn ? "My reports" : "Sign in" }].map((l) => (
            <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className="block border-b border-white/5 py-3 text-base font-medium text-slate-200">
              {l.label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
