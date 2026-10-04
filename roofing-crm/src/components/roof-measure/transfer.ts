'use client';

import { create } from 'zustand';
import { useSearchParams } from 'next/navigation';
import { useCRMStore } from '@/store';
import { generateId } from '@/lib/utils';
import { SOURCE_LABELS, squares } from '@/lib/roof-report';
import { toRoofMeasurements } from '@/lib/roof-measure/measure';
import { parseLatLngInput } from '@/lib/roof-measure/geocode';
import type { CommercialModel } from '@/lib/roof-measure/commercial';
import type { Project } from '@/lib/roof-measure/model';
import type { RoofMeasurements, RoofReport } from '@/types';
import { useBuildEstimate, type EstimateTarget } from '@/components/useBuildEstimate';
import { useRM, type Mode } from './store';
import { useTotals } from './hooks';
import { splitAddress } from './address';
import { commercialMeasurements } from './commercial-measurements';

// Roof Measure -> CRM roof report -> estimate / proposal. Shared by the action
// bar, the report panel and the report viewer, so every "Create estimate"
// button saves the same report once and never makes a duplicate.

interface Saved { report: RoofReport; project: Project; comModel: CommercialModel | null; mode: Mode }
interface TransferState {
  saved: Saved | null;
  error: { msg: string; project: Project; mode: Mode } | null;
  panel: boolean;
}
export const useTransferState = create<TransferState>()(() => ({ saved: null, error: null, panel: false }));

export function useRoofReportTransfer() {
  const leadId = useSearchParams().get('leadId');
  const { leads, homeowners, currentUser, addRoofReport, addActivity } = useCRMStore();
  const project = useRM((s) => s.project);
  const mode = useRM((s) => s.mode);
  const comModel = useRM((s) => s.comModel);
  const comOpts = useRM((s) => s.comOpts);
  const t = useTotals();
  const { saved, error: errorState, panel } = useTransferState();
  const build = useBuildEstimate();

  const lead = leadId ? leads.find((l) => l.id === leadId) : undefined;
  const owner = lead ? homeowners.find((h) => h.id === lead.homeownerId) : undefined;
  // An error belongs to the roof it was about: any change to the roof (or the mode) clears it.
  const error = errorState && errorState.project === project && errorState.mode === mode ? errorState.msg : '';
  const setError = (msg: string) => useTransferState.setState({ error: msg ? { msg, project, mode } : null });
  const setPanel = (open: boolean) => useTransferState.setState({ panel: open });
  const upToDate = !!saved && saved.mode === mode && (mode === 'com' ? saved.comModel === comModel : saved.project === project);

  // Saves the current roof as a CRM roof report, or returns the one already
  // saved for this exact roof. Null (with the reason in `error`) when it can't.
  const saveReport = (): RoofReport | null => {
    setError('');
    if (upToDate && saved) return useCRMStore.getState().roofReports.find((r) => r.id === saved.report.id) || saved.report;
    let measurements: RoofMeasurements;
    if (mode === 'com') {
      if (!comModel) { setError('Measure the commercial roof first (Commercial roof → Measure commercial roof).'); return null; }
      measurements = commercialMeasurements(comModel, comOpts);
    } else {
      if (!project.facets.length) { setError('No roof traced yet. Use "Get roof data" then "Auto-trace roof", or trace facets by hand, first.'); return null; }
      if (!(t.sloped > 0)) { setError('The traced roof has no area yet.'); return null; }
      measurements = toRoofMeasurements(t, project.defaultPitch);
    }
    // The lead's own address record wins; otherwise the address the map locked in.
    let parts: { address: string; city: string; state: string; zip: string };
    if (owner) parts = { address: owner.address, city: owner.city, state: owner.state, zip: owner.zip };
    else if (project.address && !parseLatLngInput(project.address)) parts = splitAddress(project.address);
    else if (project.address) parts = { address: project.address, city: '', state: 'FL', zip: '' };
    else { setError('Enter the property address first (1. Property).'); return null; }

    // Same roof saved before (e.g. on an earlier visit): reuse that report, so
    // its estimates stay attached and the list doesn't fill with duplicates.
    const same = useCRMStore.getState().roofReports.find((r) =>
      r.source === 'roof_measure' &&
      (r.leadId || null) === (lead?.id || null) &&
      r.address === parts.address &&
      JSON.stringify(r.measurements) === JSON.stringify(measurements));
    if (same) {
      useTransferState.setState({ saved: { report: same, project, comModel, mode } });
      return same;
    }

    const report: RoofReport = {
      id: generateId(),
      leadId: lead?.id,
      homeownerId: lead?.homeownerId,
      ...parts,
      source: 'roof_measure',
      measurements,
      createdAt: new Date().toISOString(),
      createdBy: currentUser?.id || '',
      estimates: [],
    };
    addRoofReport(report);
    addActivity({
      id: generateId(),
      leadId: report.leadId,
      userId: currentUser?.id || '',
      type: 'document',
      description: `Roof report (${SOURCE_LABELS[report.source]}${mode === 'com' ? ', commercial' : ''}) added for ${report.address} — ${squares(report.measurements)} sq`,
      createdAt: report.createdAt,
    });
    useTransferState.setState({ saved: { report, project, comModel, mode } });
    return report;
  };

  // "Use these measurements": save, then show the next steps.
  const use = () => {
    if (saveReport()) setPanel(true);
  };

  // Save (if needed) and go straight to a new estimate or its proposal.
  const transfer = (target: EstimateTarget) => {
    const report = saveReport();
    if (!report) { setPanel(false); return false; }
    build(report, target);
    return true;
  };

  return { lead, owner, saved, upToDate, error, setError, panel, setPanel, use, transfer };
}
