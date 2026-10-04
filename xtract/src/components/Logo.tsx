export function LogoMark({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#0369a1" />
      <path d="M6 17.5 16 8l10 9.5" fill="none" stroke="#fff" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.5 23h13" stroke="#f59e0b" strokeWidth="2.8" strokeLinecap="round" />
      <path d="M9.5 21v4M22.5 21v4" stroke="#f59e0b" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ dark = false }: { dark?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark />
      <span className={`text-lg font-extrabold tracking-tight ${dark ? "text-white" : "text-ink"}`}>
        Xtract<span className="ml-1.5 hidden font-semibold text-muted sm:inline">Roof Reports</span>
      </span>
    </span>
  );
}
