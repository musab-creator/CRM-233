'use client';

import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { Download, Printer, X } from 'lucide-react';
import type { BuiltReport } from './actions';
import { download } from './actions';
import { Btn } from './ui';

// Shows a built report in a full-screen sheet (an iframe with the report's own
// document) and prints it from there: printing the iframe prints only the
// report, works the same on phones, and the preview stays open afterwards.

interface ViewerState { report: BuiltReport | null; printOnLoad: boolean }
export const useReportViewer = create<ViewerState>()(() => ({ report: null, printOnLoad: false }));
export const openReport = (report: BuiltReport, print: boolean) => useReportViewer.setState({ report, printOnLoad: print });
const close = () => useReportViewer.setState({ report: null, printOnLoad: false });

// On screen the letter-size pages are scaled to the viewer's width (phones); print is untouched. The report's own
// floating Print button is hidden: the viewer has one.
function fitToWidth(frame: HTMLIFrameElement | null) {
  const doc = frame?.contentDocument;
  if (!frame || !doc || !doc.head) return;
  const page = doc.querySelector('.rp-page') as HTMLElement | null;
  const scale = page && page.offsetWidth ? Math.min(1, (frame.clientWidth - 16) / (page.offsetWidth + 32)) : 1;
  let style = doc.getElementById('rm-viewer') as HTMLStyleElement | null;
  if (!style) { style = doc.createElement('style'); style.id = 'rm-viewer'; doc.head.appendChild(style); }
  style.textContent = `.rp-print { display: none !important; } @media screen { .rp { zoom: ${scale.toFixed(3)}; } }`;
}

async function printFrame(frame: HTMLIFrameElement | null) {
  const w = frame?.contentWindow;
  const doc = frame?.contentDocument;
  if (!w || !doc) return;
  const imgs = [...doc.querySelectorAll('img')].filter((i) => !i.complete);
  await Promise.race([
    Promise.all(imgs.map((i) => new Promise((r) => { i.onload = i.onerror = r; }))),
    new Promise((r) => setTimeout(r, 4000)),
  ]);
  w.focus();
  w.print();
}

export default function ReportViewer() {
  const report = useReportViewer((s) => s.report);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!report) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [report]);

  if (!report) return null;
  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-gray-900/95" role="dialog" aria-modal="true" aria-label={report.title} data-testid="report-viewer">
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-700 bg-gray-900 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] text-white">
        <div className="min-w-0 flex-1 truncate text-sm font-semibold">{report.title}</div>
        <Btn variant="primary" small onClick={() => void printFrame(frame.current)}><Printer className="h-3.5 w-3.5" />Print / PDF</Btn>
        <Btn small onClick={() => download(report.fileName, report.downloadDoc, 'text/html')}><Download className="h-3.5 w-3.5" />Download</Btn>
        <Btn small variant="ghost" className="text-white hover:bg-gray-800" onClick={close} aria-label="Close report"><X className="h-4 w-4" />Close</Btn>
      </div>
      <iframe
        ref={frame} title={report.title} srcDoc={report.printDoc} className="min-h-0 w-full flex-1 bg-gray-600"
        onLoad={() => { fitToWidth(frame.current); if (useReportViewer.getState().printOnLoad) { useReportViewer.setState({ printOnLoad: false }); void printFrame(frame.current); } }}
      />
    </div>
  );
}
