"use client";

import { useState, useCallback } from "react";
import { useCRMStore } from "@/lib/store";
import { formatCurrency, generateId } from "@/lib/utils";
import type { InsurancePolicy, PolicyType, ClaimType } from "@/types";
import {
  Upload,
  FileText,
  CheckCircle,
  AlertTriangle,
  Shield,
  DollarSign,
  Calendar,
  Cloud,
  ArrowRight,
  FileSignature,
  Info,
  X,
  Loader2,
} from "lucide-react";

interface ParsedPolicyData {
  carrier: string;
  policyNumber: string;
  policyType: PolicyType;
  deductible: number;
  deductibleType: "flat" | "percentage";
  effectiveDate: string;
  expirationDate: string;
  roofAge: number;
  rcvAmount: number;
  acvAmount: number;
  depreciationAmount: number;
  bestDateOfLoss: string;
  recommendedClaimType: ClaimType;
  stormEvents: { date: string; type: string; severity: string }[];
  warnings: string[];
  recommendations: string[];
}

export function PolicyAnalyzer() {
  const { addPolicy, setCurrentView, stormEvents, contacts } = useCRMStore();
  const [isDragging, setIsDragging] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisComplete, setAnalysisComplete] = useState(false);
  const [parsedData, setParsedData] = useState<ParsedPolicyData | null>(null);
  const [selectedContact, setSelectedContact] = useState("");
  const [fileName, setFileName] = useState("");

  const simulateAnalysis = useCallback((file: File) => {
    setFileName(file.name);
    setIsAnalyzing(true);
    setAnalysisComplete(false);

    // Simulate PDF parsing with realistic data
    setTimeout(() => {
      const mockParsed: ParsedPolicyData = {
        carrier: "State Farm",
        policyNumber: "SF-2024-78901",
        policyType: "RCV",
        deductible: 2500,
        deductibleType: "flat",
        effectiveDate: "2024-01-15",
        expirationDate: "2025-01-15",
        roofAge: 8,
        rcvAmount: 18500,
        acvAmount: 12800,
        depreciationAmount: 5700,
        bestDateOfLoss: "2024-03-10",
        recommendedClaimType: "hail",
        stormEvents: [
          { date: "2024-03-10", type: "Hail (1.75\")", severity: "Severe" },
          { date: "2024-01-22", type: "Wind (75 mph)", severity: "Severe" },
          { date: "2023-06-15", type: "Hail + Wind", severity: "Catastrophic" },
        ],
        warnings: [
          "Policy is RCV - depreciation holdback will be released after work completion",
          "Roof age (8 years) is within standard coverage window",
          "$2,500 flat deductible applies - homeowner responsibility",
        ],
        recommendations: [
          "Best date of loss: March 10, 2024 - Severe hail event (1.75\" diameter)",
          "File as HAIL claim - stronger documentation available from NOAA reports",
          "RCV policy ensures full replacement cost coverage after depreciation release",
          "Estimated contractor payment: $16,000 after deductible",
          "Recommend filing within 30 days of storm for strongest claim",
        ],
      };

      setParsedData(mockParsed);
      setIsAnalyzing(false);
      setAnalysisComplete(true);
    }, 3000);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      const pdf = files.find((f) => f.type === "application/pdf");
      if (pdf) simulateAnalysis(pdf);
    },
    [simulateAnalysis]
  );

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) simulateAnalysis(file);
  };

  const handleSavePolicy = () => {
    if (!parsedData || !selectedContact) return;
    const policy: InsurancePolicy = {
      id: generateId(),
      contactId: selectedContact,
      carrier: parsedData.carrier,
      policyNumber: parsedData.policyNumber,
      policyType: parsedData.policyType,
      deductible: parsedData.deductible,
      deductibleType: parsedData.deductibleType,
      effectiveDate: parsedData.effectiveDate,
      expirationDate: parsedData.expirationDate,
      dateOfLoss: parsedData.bestDateOfLoss,
      roofAge: parsedData.roofAge,
      rcvAmount: parsedData.rcvAmount,
      acvAmount: parsedData.acvAmount,
      depreciationAmount: parsedData.depreciationAmount,
      claimType: parsedData.recommendedClaimType,
      createdAt: new Date().toISOString(),
    };
    addPolicy(policy);
    setCurrentView("contingency");
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-bold text-gray-900">Insurance Policy Analyzer</h2>
        <p className="text-sm text-gray-500 mt-1">
          Drag and drop a homeowner&apos;s insurance policy PDF to automatically extract ACV/RCV type,
          deductible, coverage dates, and find the best date of loss for their claim.
        </p>
      </div>

      {/* Contact selector */}
      <div className="card card-body">
        <label className="label">Link to Homeowner</label>
        <select
          value={selectedContact}
          onChange={(e) => setSelectedContact(e.target.value)}
          className="input"
        >
          <option value="">Select a homeowner...</option>
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.firstName} {c.lastName} - {c.address}, {c.city}
            </option>
          ))}
        </select>
      </div>

      {/* Drop Zone */}
      {!analysisComplete && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={`dropzone ${isDragging ? "dropzone-active" : ""} ${isAnalyzing ? "pointer-events-none" : ""}`}
        >
          {isAnalyzing ? (
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="h-12 w-12 text-brand-500 animate-spin" />
              <div>
                <p className="text-lg font-medium text-gray-900">Analyzing Policy...</p>
                <p className="text-sm text-gray-500 mt-1">Reading {fileName}</p>
              </div>
              <div className="w-64 h-2 bg-gray-200 rounded-full overflow-hidden">
                <div className="h-full bg-brand-500 rounded-full animate-pulse" style={{ width: "60%" }} />
              </div>
              <div className="text-xs text-gray-400 space-y-1">
                <p>Extracting policy type (ACV/RCV)...</p>
                <p>Reading deductible information...</p>
                <p>Identifying coverage dates...</p>
                <p>Looking up storm history for best date of loss...</p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4">
              <Upload className="h-12 w-12 text-gray-400" />
              <div>
                <p className="text-lg font-medium text-gray-900">
                  Drop Insurance Policy PDF Here
                </p>
                <p className="text-sm text-gray-500 mt-1">
                  or click to browse files
                </p>
              </div>
              <input
                type="file"
                accept=".pdf"
                onChange={handleFileSelect}
                className="absolute inset-0 opacity-0 cursor-pointer"
                style={{ position: "absolute" }}
              />
              <label className="btn-primary cursor-pointer relative">
                <Upload className="h-4 w-4" />
                Browse Files
                <input
                  type="file"
                  accept=".pdf"
                  onChange={handleFileSelect}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
              </label>
              <p className="text-xs text-gray-400">Supports PDF files up to 25MB</p>
            </div>
          )}
        </div>
      )}

      {/* Analysis Results */}
      {analysisComplete && parsedData && (
        <div className="space-y-6">
          {/* Success Banner */}
          <div className="rounded-lg bg-green-50 border border-green-200 p-4 flex items-center gap-3">
            <CheckCircle className="h-5 w-5 text-green-600 shrink-0" />
            <div>
              <p className="text-sm font-medium text-green-800">Policy Analysis Complete</p>
              <p className="text-xs text-green-600">Successfully parsed {fileName}</p>
            </div>
            <button
              onClick={() => {
                setAnalysisComplete(false);
                setParsedData(null);
              }}
              className="ml-auto text-green-600 hover:text-green-800"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Key Findings Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Policy Type */}
            <div className={`card card-body border-l-4 ${parsedData.policyType === "RCV" ? "border-l-green-500" : "border-l-amber-500"}`}>
              <div className="flex items-center gap-2 mb-2">
                <Shield className={`h-5 w-5 ${parsedData.policyType === "RCV" ? "text-green-600" : "text-amber-600"}`} />
                <span className="text-xs font-medium text-gray-500">Policy Type</span>
              </div>
              <p className={`text-2xl font-bold ${parsedData.policyType === "RCV" ? "text-green-600" : "text-amber-600"}`}>
                {parsedData.policyType}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                {parsedData.policyType === "RCV"
                  ? "Replacement Cost Value - Full coverage"
                  : "Actual Cash Value - Depreciation not recoverable"}
              </p>
            </div>

            {/* Deductible */}
            <div className="card card-body border-l-4 border-l-blue-500">
              <div className="flex items-center gap-2 mb-2">
                <DollarSign className="h-5 w-5 text-blue-600" />
                <span className="text-xs font-medium text-gray-500">Deductible</span>
              </div>
              <p className="text-2xl font-bold text-blue-600">
                {formatCurrency(parsedData.deductible)}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                {parsedData.deductibleType === "flat" ? "Flat deductible" : "Percentage-based"}
              </p>
            </div>

            {/* Best Date of Loss */}
            <div className="card card-body border-l-4 border-l-purple-500">
              <div className="flex items-center gap-2 mb-2">
                <Calendar className="h-5 w-5 text-purple-600" />
                <span className="text-xs font-medium text-gray-500">Best Date of Loss</span>
              </div>
              <p className="text-2xl font-bold text-purple-600">
                {new Date(parsedData.bestDateOfLoss).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </p>
              <p className="text-xs text-gray-500 mt-1">Recommended storm event</p>
            </div>

            {/* Claim Type */}
            <div className="card card-body border-l-4 border-l-indigo-500">
              <div className="flex items-center gap-2 mb-2">
                <Cloud className="h-5 w-5 text-indigo-600" />
                <span className="text-xs font-medium text-gray-500">Recommended Claim</span>
              </div>
              <p className="text-2xl font-bold text-indigo-600 uppercase">
                {parsedData.recommendedClaimType}
              </p>
              <p className="text-xs text-gray-500 mt-1">Best claim type for this loss</p>
            </div>
          </div>

          {/* Financial Breakdown */}
          <div className="card">
            <div className="card-header">
              <h3 className="text-sm font-semibold">Financial Breakdown</h3>
            </div>
            <div className="card-body">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="text-center p-4 rounded-lg bg-green-50">
                  <p className="text-sm text-gray-500">RCV (Full Replacement)</p>
                  <p className="text-3xl font-bold text-green-600 mt-1">{formatCurrency(parsedData.rcvAmount)}</p>
                </div>
                <div className="text-center p-4 rounded-lg bg-amber-50">
                  <p className="text-sm text-gray-500">ACV (Initial Payment)</p>
                  <p className="text-3xl font-bold text-amber-600 mt-1">{formatCurrency(parsedData.acvAmount)}</p>
                </div>
                <div className="text-center p-4 rounded-lg bg-red-50">
                  <p className="text-sm text-gray-500">Depreciation Holdback</p>
                  <p className="text-3xl font-bold text-red-500 mt-1">{formatCurrency(parsedData.depreciationAmount)}</p>
                </div>
              </div>
              <div className="mt-4 p-4 rounded-lg bg-gray-50">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">RCV Amount</span>
                  <span className="font-medium">{formatCurrency(parsedData.rcvAmount)}</span>
                </div>
                <div className="flex justify-between text-sm mt-2">
                  <span className="text-gray-600">Less: Deductible</span>
                  <span className="font-medium text-red-600">-{formatCurrency(parsedData.deductible)}</span>
                </div>
                <div className="flex justify-between text-sm mt-2">
                  <span className="text-gray-600">Less: Depreciation</span>
                  <span className="font-medium text-red-600">-{formatCurrency(parsedData.depreciationAmount)}</span>
                </div>
                <div className="border-t border-gray-200 mt-3 pt-3 flex justify-between">
                  <span className="font-medium text-gray-900">Initial ACV Check</span>
                  <span className="font-bold text-green-600">{formatCurrency(parsedData.acvAmount - parsedData.deductible)}</span>
                </div>
                <div className="flex justify-between text-sm mt-2">
                  <span className="text-gray-600">Depreciation Released After Completion</span>
                  <span className="font-medium text-green-600">+{formatCurrency(parsedData.depreciationAmount)}</span>
                </div>
                <div className="border-t border-gray-200 mt-3 pt-3 flex justify-between">
                  <span className="font-medium text-gray-900">Total Contractor Payment</span>
                  <span className="font-bold text-gray-900">{formatCurrency(parsedData.rcvAmount - parsedData.deductible)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Storm History */}
          <div className="card">
            <div className="card-header">
              <h3 className="text-sm font-semibold">Storm History for Property Area</h3>
            </div>
            <div className="card-body">
              <div className="space-y-3">
                {parsedData.stormEvents.map((event, i) => (
                  <div
                    key={i}
                    className={`flex items-center gap-4 p-3 rounded-lg border ${
                      i === 0 ? "border-purple-200 bg-purple-50" : "border-gray-200"
                    }`}
                  >
                    <Cloud className={`h-5 w-5 shrink-0 ${i === 0 ? "text-purple-600" : "text-gray-400"}`} />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-900">{event.type}</p>
                      <p className="text-xs text-gray-500">{new Date(event.date).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</p>
                    </div>
                    <span className={`badge ${
                      event.severity === "Catastrophic" ? "bg-red-100 text-red-700" :
                      event.severity === "Severe" ? "bg-orange-100 text-orange-700" :
                      "bg-yellow-100 text-yellow-700"
                    }`}>
                      {event.severity}
                    </span>
                    {i === 0 && (
                      <span className="badge bg-purple-100 text-purple-700">Recommended</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Warnings & Recommendations */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="card">
              <div className="card-header">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  Warnings
                </h3>
              </div>
              <div className="card-body space-y-2">
                {parsedData.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-2 p-2 rounded bg-amber-50">
                    <Info className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                    <p className="text-sm text-gray-700">{w}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="card">
              <div className="card-header">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 text-green-500" />
                  Recommendations
                </h3>
              </div>
              <div className="card-body space-y-2">
                {parsedData.recommendations.map((r, i) => (
                  <div key={i} className="flex items-start gap-2 p-2 rounded bg-green-50">
                    <ArrowRight className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
                    <p className="text-sm text-gray-700">{r}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Policy Details */}
          <div className="card">
            <div className="card-header">
              <h3 className="text-sm font-semibold">Policy Details</h3>
            </div>
            <div className="card-body">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <p className="text-xs text-gray-500">Carrier</p>
                  <p className="text-sm font-medium text-gray-900">{parsedData.carrier}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Policy Number</p>
                  <p className="text-sm font-medium text-gray-900">{parsedData.policyNumber}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Effective Date</p>
                  <p className="text-sm font-medium text-gray-900">{new Date(parsedData.effectiveDate).toLocaleDateString()}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Expiration Date</p>
                  <p className="text-sm font-medium text-gray-900">{new Date(parsedData.expirationDate).toLocaleDateString()}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Roof Age</p>
                  <p className="text-sm font-medium text-gray-900">{parsedData.roofAge} years</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Deductible Type</p>
                  <p className="text-sm font-medium text-gray-900 capitalize">{parsedData.deductibleType}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-3 justify-end">
            <button
              onClick={() => {
                setAnalysisComplete(false);
                setParsedData(null);
              }}
              className="btn-secondary"
            >
              Analyze Another Policy
            </button>
            <button
              onClick={handleSavePolicy}
              className="btn-primary"
              disabled={!selectedContact}
            >
              <FileSignature className="h-4 w-4" />
              Generate Contingency Agreement
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
