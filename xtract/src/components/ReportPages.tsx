"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { REPORT_PAGES } from "@/lib/config";

/** Browse the eight real pages of the sample report. */
export function ReportPages() {
  const [i, setI] = useState(0);
  const go = (d: number) => setI((x) => (x + d + REPORT_PAGES.length) % REPORT_PAGES.length);
  return (
    <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
      <ol className="flex gap-2 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0" aria-label="Report pages">
        {REPORT_PAGES.map(([title, desc], k) => (
          <li key={title} className="shrink-0">
            <button
              onClick={() => setI(k)}
              aria-current={i === k}
              className={`flex w-60 cursor-pointer items-start gap-3 rounded-xl border p-3 text-left transition-colors duration-150 lg:w-full ${
                i === k ? "border-brand bg-sky-50" : "border-line bg-white hover:border-slate-300"
              }`}
            >
              <span className={`font-mono text-sm font-semibold ${i === k ? "text-brand" : "text-muted"}`}>{String(k + 1).padStart(2, "0")}</span>
              <span>
                <b className="block text-sm">{title}</b>
                <small className="text-xs leading-5 text-muted">{desc}</small>
              </span>
            </button>
          </li>
        ))}
        <li className="shrink-0 lg:mt-2">
          <a href="/api/sample" target="_blank" rel="noopener" className="inline-flex h-12 w-60 items-center justify-center gap-2 rounded-xl bg-brand font-bold text-white transition-colors duration-200 hover:bg-brand-600 lg:w-full">
            <Download className="h-4 w-4" aria-hidden="true" /> Full 8-page PDF
          </a>
        </li>
      </ol>
      <div className="relative">
        <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-xl shadow-ink/10">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/report/page-${i + 1}.webp`} alt={`Sample report page ${i + 1}: ${REPORT_PAGES[i][0]}`} width={935} height={1210} className="h-auto w-full" />
        </div>
        <div className="absolute inset-y-0 -left-3 -right-3 flex items-center justify-between pointer-events-none">
          <button onClick={() => go(-1)} aria-label="Previous page" className="pointer-events-auto flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-ink text-white shadow-lg hover:bg-ink-2">
            <ChevronLeft className="h-5 w-5" aria-hidden="true" />
          </button>
          <button onClick={() => go(1)} aria-label="Next page" className="pointer-events-auto flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-ink text-white shadow-lg hover:bg-ink-2">
            <ChevronRight className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <p className="mt-3 text-center font-mono text-xs text-muted">
          Page {i + 1} of {REPORT_PAGES.length} · rendered by the same code that produces paid reports
        </p>
      </div>
    </div>
  );
}
