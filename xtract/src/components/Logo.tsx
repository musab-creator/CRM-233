export function LogoMark({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 36 36" className={className} aria-hidden="true">
      <rect x="1" y="1" width="34" height="34" rx="8" fill="#0b66a3" />
      <path d="M7 19.5 18 9l11 10.5" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m12 17 12 11M24 17 12 28" stroke="#8fd3ff" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M8 31h20" stroke="#f59e0b" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ dark = false }: { dark?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark />
      <span className="leading-none">
        <span className={`block text-lg font-extrabold tracking-[0.12em] ${dark ? "text-white" : "text-ink"}`}>XTRACT</span>
        <span className={`block text-[9px] font-bold tracking-[0.28em] ${dark ? "text-sky/80" : "text-muted"}`}>ROOF REPORTS</span>
      </span>
    </span>
  );
}
