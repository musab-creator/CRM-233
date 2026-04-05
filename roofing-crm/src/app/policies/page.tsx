'use client';

import { useState, useMemo, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { useRouter } from 'next/navigation';
import AppShell from '@/components/AppShell';
import StatusBadge from '@/components/StatusBadge';
import { useCRMStore } from '@/store';
import {
  formatCurrency,
  formatDate,
  getPolicyTypeLabel,
  getPolicyTypeBadge,
  getClaimTypeLabel,
  generateId,
} from '@/lib/utils';
import type { InsurancePolicy, StormEvent } from '@/types';
import {
  Upload,
  FileText,
  Shield,
  AlertTriangle,
  CheckCircle,
  CloudRain,
  Wind,
  Zap,
} from 'lucide-react';

type AnalysisState = 'idle' | 'uploading' | 'analyzing' | 'complete';

export default function PoliciesPage() {
  const router = useRouter();
  const policies = useCRMStore((s) => s.policies);
  const homeowners = useCRMStore((s) => s.homeowners);
  const stormEvents = useCRMStore((s) => s.stormEvents);

  const [showUpload, setShowUpload] = useState(false);
  const [analysisState, setAnalysisState] = useState<AnalysisState>('idle');
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analyzedPolicy, setAnalyzedPolicy] = useState<InsurancePolicy | null>(null);
  const [matchingStorms, setMatchingStorms] = useState<StormEvent[]>([]);
  const [droppedFileName, setDroppedFileName] = useState('');

  const homeownerMap = useMemo(() => {
    const map = new Map<string, (typeof homeowners)[number]>();
    for (const h of homeowners) map.set(h.id, h);
    return map;
  }, [homeowners]);

  const simulateAnalysis = useCallback(
    (fileName: string) => {
      setDroppedFileName(fileName);
      setAnalysisState('uploading');
      setAnalysisProgress(0);

      // Simulate upload progress
      const uploadInterval = setInterval(() => {
        setAnalysisProgress((prev) => {
          if (prev >= 30) {
            clearInterval(uploadInterval);
            return 30;
          }
          return prev + 6;
        });
      }, 100);

      setTimeout(() => {
        setAnalysisState('analyzing');

        // Simulate analysis progress
        const analyzeInterval = setInterval(() => {
          setAnalysisProgress((prev) => {
            if (prev >= 95) {
              clearInterval(analyzeInterval);
              return 95;
            }
            return prev + 5;
          });
        }, 120);

        setTimeout(() => {
          clearInterval(analyzeInterval);
          setAnalysisProgress(100);

          // Pick a random policy from the store as the "analyzed" result
          const randomPolicy = policies[Math.floor(Math.random() * policies.length)];
          if (randomPolicy) {
            setAnalyzedPolicy(randomPolicy);
            const ho = homeownerMap.get(randomPolicy.homeownerId);
            if (ho) {
              const storms = stormEvents.filter((se) => se.zipCodes.includes(ho.zip));
              setMatchingStorms(storms);
            }
          }
          setAnalysisState('complete');
        }, 2000);
      }, 600);
    },
    [policies, homeownerMap, stormEvents],
  );

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      if (acceptedFiles.length > 0) {
        simulateAnalysis(acceptedFiles[0].name);
      }
    },
    [simulateAnalysis],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'] },
    multiple: false,
  });

  const getRecommendation = (storms: StormEvent[]) => {
    const hailStorms = storms.filter((s) => s.type === 'hail' || s.type === 'hail_and_wind');
    const windStorms = storms.filter((s) => s.type === 'wind' || s.type === 'hail_and_wind');
    const severeHail = hailStorms.some((s) => s.severity === 'severe' || s.severity === 'catastrophic');
    const severeWind = windStorms.some((s) => s.severity === 'severe' || s.severity === 'catastrophic');

    if (severeHail) {
      return {
        type: 'hail' as const,
        reason:
          'Hail claim recommended. Severe hail events documented in this area provide strong evidence for roof damage. Hail claims typically have higher approval rates and are easier to prove with visible impact marks.',
      };
    }
    if (severeWind) {
      return {
        type: 'wind' as const,
        reason:
          'Wind claim recommended. Significant wind events recorded with speeds capable of causing shingle lift and structural damage. Combine with inspection photos of lifted or missing shingles for strongest case.',
      };
    }
    if (hailStorms.length > 0) {
      return {
        type: 'hail' as const,
        reason:
          'Hail claim recommended based on documented hail activity in the area. Even moderate hail can cause granule loss and hidden damage that reduces roof lifespan.',
      };
    }
    return {
      type: 'wind' as const,
      reason:
        'Wind claim is the best available option based on documented storm activity. Ensure inspection photos clearly show wind-related damage patterns.',
    };
  };

  const getStormIcon = (type: string) => {
    switch (type) {
      case 'hail':
        return <CloudRain className="h-4 w-4 text-blue-600" />;
      case 'wind':
        return <Wind className="h-4 w-4 text-teal-600" />;
      case 'hail_and_wind':
        return <Zap className="h-4 w-4 text-purple-600" />;
      default:
        return <CloudRain className="h-4 w-4 text-gray-500" />;
    }
  };

  return (
    <AppShell>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Shield className="h-7 w-7 text-orange-500" />
            <h1 className="text-2xl font-bold text-gray-900">Insurance Policies</h1>
          </div>
          <button
            onClick={() => {
              setShowUpload(!showUpload);
              if (showUpload) {
                setAnalysisState('idle');
                setAnalyzedPolicy(null);
                setMatchingStorms([]);
                setAnalysisProgress(0);
              }
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-orange-700 transition-colors"
          >
            <Upload className="h-4 w-4" />
            Upload Policy
          </button>
        </div>

        {/* Upload Area */}
        {showUpload && (
          <div className="space-y-6">
            {/* Drop Zone */}
            {analysisState === 'idle' && (
              <div
                {...getRootProps()}
                className={`relative cursor-pointer rounded-xl border-3 border-dashed p-12 text-center transition-all ${
                  isDragActive
                    ? 'border-orange-500 bg-orange-50 ring-4 ring-orange-100'
                    : 'border-gray-300 bg-gray-50 hover:border-orange-400 hover:bg-orange-50/50'
                }`}
              >
                <input {...getInputProps()} />
                <div className="flex flex-col items-center gap-4">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-orange-100">
                    <Upload className="h-8 w-8 text-orange-600" />
                  </div>
                  <div>
                    <p className="text-lg font-semibold text-gray-700">
                      {isDragActive ? 'Drop the policy PDF here...' : 'Drag & drop a homeowner insurance policy PDF'}
                    </p>
                    <p className="mt-1 text-sm text-gray-500">
                      or click to browse. We will automatically extract policy details, coverage amounts, and match storm events.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 rounded-full bg-white px-4 py-2 text-xs text-gray-400 shadow-sm">
                    <FileText className="h-3.5 w-3.5" />
                    PDF files only
                  </div>
                </div>
              </div>
            )}

            {/* Progress Bar */}
            {(analysisState === 'uploading' || analysisState === 'analyzing') && (
              <div className="rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
                <div className="flex flex-col items-center gap-4">
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-orange-100 animate-pulse">
                    <FileText className="h-7 w-7 text-orange-600" />
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-medium text-gray-700">{droppedFileName}</p>
                    <p className="mt-1 text-sm text-gray-500">
                      {analysisState === 'uploading'
                        ? 'Uploading document...'
                        : 'Analyzing policy... Extracting coverage details, deductibles, and matching storm events.'}
                    </p>
                  </div>
                  <div className="w-full max-w-md">
                    <div className="h-3 w-full overflow-hidden rounded-full bg-gray-100">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-orange-500 to-orange-600 transition-all duration-300"
                        style={{ width: `${analysisProgress}%` }}
                      />
                    </div>
                    <p className="mt-2 text-center text-xs text-gray-400">{analysisProgress}% complete</p>
                  </div>
                </div>
              </div>
            )}

            {/* Analysis Results */}
            {analysisState === 'complete' && analyzedPolicy && (
              <div className="space-y-6">
                <div className="flex items-center gap-2 text-green-700">
                  <CheckCircle className="h-5 w-5" />
                  <span className="text-sm font-medium">Policy analysis complete</span>
                </div>

                {/* Policy Type - PROMINENT */}
                <div
                  className={`rounded-xl border-2 p-6 shadow-sm ${
                    analyzedPolicy.policyType === 'RCV'
                      ? 'border-green-300 bg-green-50'
                      : 'border-amber-300 bg-amber-50'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Policy Type</p>
                      <div className="mt-2 flex items-center gap-3">
                        <span
                          className={`inline-flex items-center rounded-lg px-4 py-2 text-xl font-bold ${
                            analyzedPolicy.policyType === 'RCV'
                              ? 'bg-green-600 text-white'
                              : 'bg-amber-500 text-white'
                          }`}
                        >
                          {analyzedPolicy.policyType}
                        </span>
                        <div>
                          <p className="text-base font-semibold text-gray-900">
                            {analyzedPolicy.policyType === 'RCV'
                              ? 'Replacement Cost Value'
                              : 'Actual Cash Value'}
                          </p>
                          <p className="text-sm text-gray-600">
                            {analyzedPolicy.policyType === 'RCV'
                              ? 'Full replacement covered - no depreciation deducted from claim payout'
                              : 'Depreciation applies - homeowner receives depreciated value, recoverable after work completed'}
                          </p>
                        </div>
                      </div>
                    </div>
                    {analyzedPolicy.policyType === 'RCV' ? (
                      <CheckCircle className="h-8 w-8 text-green-500 shrink-0" />
                    ) : (
                      <AlertTriangle className="h-8 w-8 text-amber-500 shrink-0" />
                    )}
                  </div>
                </div>

                {/* Policy Details Card */}
                <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                  <h3 className="mb-4 text-lg font-semibold text-gray-900 flex items-center gap-2">
                    <FileText className="h-5 w-5 text-orange-500" />
                    Policy Details
                  </h3>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wider text-gray-400">Carrier</p>
                      <p className="mt-1 text-sm font-semibold text-gray-900">{analyzedPolicy.carrier}</p>
                    </div>
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wider text-gray-400">Policy Number</p>
                      <p className="mt-1 text-sm font-semibold text-gray-900">{analyzedPolicy.policyNumber}</p>
                    </div>
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wider text-gray-400">Deductible</p>
                      <p className="mt-1 text-sm font-semibold text-gray-900">
                        {analyzedPolicy.deductibleType === 'flat'
                          ? formatCurrency(analyzedPolicy.deductible)
                          : `${analyzedPolicy.deductible}% of Dwelling`}
                      </p>
                    </div>
                    {analyzedPolicy.windHailDeductible != null && (
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wider text-gray-400">
                          Wind/Hail Deductible
                        </p>
                        <p className="mt-1 text-sm font-semibold text-gray-900">
                          {formatCurrency(analyzedPolicy.windHailDeductible)}
                        </p>
                      </div>
                    )}
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wider text-gray-400">Effective Date</p>
                      <p className="mt-1 text-sm font-semibold text-gray-900">
                        {formatDate(analyzedPolicy.effectiveDate)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wider text-gray-400">Expiration Date</p>
                      <p className="mt-1 text-sm font-semibold text-gray-900">
                        {formatDate(analyzedPolicy.expirationDate)}
                      </p>
                    </div>
                  </div>

                  {/* Coverage Amounts */}
                  <div className="mt-6 border-t border-gray-100 pt-4">
                    <h4 className="mb-3 text-sm font-semibold text-gray-700">Coverage Amounts</h4>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <div className="rounded-lg bg-gray-50 p-3">
                        <p className="text-xs text-gray-500">Dwelling</p>
                        <p className="text-base font-bold text-gray-900">
                          {formatCurrency(analyzedPolicy.dwellingCoverage)}
                        </p>
                      </div>
                      <div className="rounded-lg bg-gray-50 p-3">
                        <p className="text-xs text-gray-500">Other Structures</p>
                        <p className="text-base font-bold text-gray-900">
                          {formatCurrency(analyzedPolicy.otherStructuresCoverage)}
                        </p>
                      </div>
                      <div className="rounded-lg bg-gray-50 p-3">
                        <p className="text-xs text-gray-500">Personal Property</p>
                        <p className="text-base font-bold text-gray-900">
                          {formatCurrency(analyzedPolicy.personalPropertyCoverage)}
                        </p>
                      </div>
                      <div className="rounded-lg bg-gray-50 p-3">
                        <p className="text-xs text-gray-500">Loss of Use</p>
                        <p className="text-base font-bold text-gray-900">
                          {formatCurrency(analyzedPolicy.lossOfUseCoverage)}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Best Date of Loss & Storm Events */}
                <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                  <h3 className="mb-4 text-lg font-semibold text-gray-900 flex items-center gap-2">
                    <CloudRain className="h-5 w-5 text-orange-500" />
                    Storm Events & Date of Loss
                  </h3>

                  <div className="mb-4 rounded-lg bg-orange-50 border border-orange-200 p-4">
                    <div className="flex items-center gap-2">
                      <Zap className="h-5 w-5 text-orange-600" />
                      <p className="text-sm font-semibold text-orange-800">Best Date of Loss</p>
                    </div>
                    <p className="mt-1 text-lg font-bold text-orange-900">
                      {formatDate(analyzedPolicy.bestDateOfLoss)}
                    </p>
                    <p className="mt-0.5 text-xs text-orange-700">
                      Based on the most impactful storm event within the policy coverage period
                    </p>
                  </div>

                  {/* Storm Events List */}
                  {matchingStorms.length > 0 ? (
                    <div className="space-y-3">
                      <p className="text-sm font-medium text-gray-700">
                        Matching storms for property zip code:
                      </p>
                      {matchingStorms.map((storm) => {
                        const isRecommended = storm.date === analyzedPolicy.bestDateOfLoss;
                        return (
                          <div
                            key={storm.id}
                            className={`rounded-lg border p-4 ${
                              isRecommended
                                ? 'border-orange-300 bg-orange-50/50 ring-1 ring-orange-200'
                                : 'border-gray-150 bg-gray-50'
                            }`}
                          >
                            <div className="flex items-start justify-between">
                              <div className="flex items-start gap-3">
                                <div className="mt-0.5">{getStormIcon(storm.type)}</div>
                                <div>
                                  <div className="flex items-center gap-2">
                                    <p className="text-sm font-semibold text-gray-900">
                                      {formatDate(storm.date)}
                                    </p>
                                    <StatusBadge
                                      label={getClaimTypeLabel(storm.type)}
                                      colorClass={
                                        storm.type === 'hail'
                                          ? 'bg-blue-100 text-blue-800'
                                          : storm.type === 'wind'
                                            ? 'bg-teal-100 text-teal-800'
                                            : 'bg-purple-100 text-purple-800'
                                      }
                                    />
                                    <StatusBadge
                                      label={storm.severity}
                                      colorClass={
                                        storm.severity === 'severe' || storm.severity === 'catastrophic'
                                          ? 'bg-red-100 text-red-800'
                                          : storm.severity === 'moderate'
                                            ? 'bg-amber-100 text-amber-800'
                                            : 'bg-gray-100 text-gray-700'
                                      }
                                    />
                                    {isRecommended && (
                                      <span className="inline-flex items-center gap-1 rounded-full bg-orange-600 px-2 py-0.5 text-xs font-bold text-white">
                                        <CheckCircle className="h-3 w-3" />
                                        Recommended
                                      </span>
                                    )}
                                  </div>
                                  <p className="mt-1 text-xs text-gray-600">{storm.description}</p>
                                  <div className="mt-1 flex gap-4 text-xs text-gray-500">
                                    {storm.hailSize && <span>Hail: {storm.hailSize}</span>}
                                    {storm.windSpeed && <span>Wind: {storm.windSpeed}</span>}
                                    <span>Source: {storm.source}</span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500">No matching storm events found for this property area.</p>
                  )}
                </div>

                {/* Recommendation Box */}
                {matchingStorms.length > 0 && (
                  <div className="rounded-xl border-2 border-orange-300 bg-gradient-to-br from-orange-50 to-amber-50 p-6 shadow-sm">
                    <div className="flex items-start gap-3">
                      {getRecommendation(matchingStorms).type === 'hail' ? (
                        <CloudRain className="h-6 w-6 text-orange-600 mt-0.5 shrink-0" />
                      ) : (
                        <Wind className="h-6 w-6 text-orange-600 mt-0.5 shrink-0" />
                      )}
                      <div>
                        <p className="text-sm font-bold text-orange-900 uppercase tracking-wide">
                          Claim Recommendation
                        </p>
                        <p className="mt-1 flex items-center gap-2 text-lg font-bold text-gray-900">
                          File as{' '}
                          <StatusBadge
                            label={getClaimTypeLabel(getRecommendation(matchingStorms).type)}
                            colorClass={
                              getRecommendation(matchingStorms).type === 'hail'
                                ? 'bg-blue-100 text-blue-800'
                                : 'bg-teal-100 text-teal-800'
                            }
                            size="md"
                          />{' '}
                          claim
                        </p>
                        <p className="mt-2 text-sm text-gray-700">
                          {getRecommendation(matchingStorms).reason}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Generate Contingency Button */}
                <div className="flex justify-end">
                  <button
                    onClick={() =>
                      router.push(`/contingency?policyId=${analyzedPolicy.id}`)
                    }
                    className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-6 py-3 text-sm font-semibold text-white shadow-sm hover:bg-orange-700 transition-colors"
                  >
                    <FileText className="h-4 w-4" />
                    Generate Contingency Agreement
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Existing Policies Table */}
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-100 px-6 py-4">
            <h2 className="text-lg font-semibold text-gray-900">All Policies</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/50">
                  <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Homeowner
                  </th>
                  <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Carrier
                  </th>
                  <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Policy #
                  </th>
                  <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Type
                  </th>
                  <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Deductible
                  </th>
                  <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Date of Loss
                  </th>
                  <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Dwelling Coverage
                  </th>
                  <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {policies.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-6 py-12 text-center text-gray-400">
                      No policies uploaded yet. Click "Upload Policy" to get started.
                    </td>
                  </tr>
                ) : (
                  policies.map((policy) => {
                    const ho = homeownerMap.get(policy.homeownerId);
                    return (
                      <tr key={policy.id} className="hover:bg-gray-50/50 transition-colors">
                        <td className="px-6 py-4">
                          <p className="font-medium text-gray-900">
                            {ho ? `${ho.firstName} ${ho.lastName}` : 'Unknown'}
                          </p>
                          {ho && (
                            <p className="text-xs text-gray-500">
                              {ho.address}, {ho.city}
                            </p>
                          )}
                        </td>
                        <td className="px-6 py-4 text-gray-700">{policy.carrier}</td>
                        <td className="px-6 py-4 font-mono text-xs text-gray-600">{policy.policyNumber}</td>
                        <td className="px-6 py-4">
                          <StatusBadge
                            label={policy.policyType}
                            colorClass={getPolicyTypeBadge(policy.policyType)}
                            size="md"
                          />
                        </td>
                        <td className="px-6 py-4 text-gray-700">
                          {policy.deductibleType === 'flat'
                            ? formatCurrency(policy.deductible)
                            : `${policy.deductible}%`}
                        </td>
                        <td className="px-6 py-4 text-gray-700">{formatDate(policy.bestDateOfLoss)}</td>
                        <td className="px-6 py-4 font-semibold text-gray-900">
                          {formatCurrency(policy.dwellingCoverage)}
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => {
                                setShowUpload(true);
                                setAnalyzedPolicy(policy);
                                setAnalysisState('complete');
                                const ownerData = homeownerMap.get(policy.homeownerId);
                                if (ownerData) {
                                  setMatchingStorms(
                                    stormEvents.filter((se) => se.zipCodes.includes(ownerData.zip)),
                                  );
                                }
                              }}
                              className="rounded-md px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-50 transition-colors"
                            >
                              View
                            </button>
                            <button
                              onClick={() => router.push(`/contingency?policyId=${policy.id}`)}
                              className="rounded-md bg-orange-50 px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100 transition-colors"
                            >
                              Generate Contingency
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
