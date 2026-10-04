export function PageHero({ eyebrow, title, text }: { eyebrow: string; title: string; text?: string }) {
  return (
    <section className="blueprint text-white">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <p className="text-sm font-bold uppercase tracking-wider text-sky">{eyebrow}</p>
        <h1 className="mt-2 max-w-3xl text-3xl font-extrabold tracking-tight sm:text-5xl">{title}</h1>
        {text && <p className="mt-4 max-w-2xl text-lg leading-8 text-slate-300">{text}</p>}
      </div>
    </section>
  );
}

export function Notice({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "warn" }) {
  return (
    <div role={tone === "warn" ? "alert" : "status"} className={`rounded-xl border p-4 text-sm leading-6 ${tone === "warn" ? "border-amber/40 bg-amber-soft text-amber-900" : "border-sky/40 bg-sky-50 text-slate"}`}>
      {children}
    </div>
  );
}
