"use client";

import { useState } from "react";
import { useCRMStore } from "@/lib/store";
import { formatCurrency, generateId, formatDate } from "@/lib/utils";
import type { ContingencyAgreement, ClaimType } from "@/types";
import {
  FileSignature,
  Send,
  Download,
  Eye,
  CheckCircle,
  AlertCircle,
  User,
  Home,
  Shield,
  MessageSquare,
  PenTool,
} from "lucide-react";

export function ContingencyGenerator() {
  const { contacts, policies, addContingency, contingencies, currentUser, setCurrentView } = useCRMStore();
  const [step, setStep] = useState<"select" | "questions" | "preview" | "send">("select");
  const [selectedContactId, setSelectedContactId] = useState("");
  const [adminNotes, setAdminNotes] = useState("");
  const [formData, setFormData] = useState({
    hasInteriorLeaks: false,
    claimType: "hail" as ClaimType,
    hasOutsideStructures: false,
    outsideStructuresDescription: "",
  });

  const selectedContact = contacts.find((c) => c.id === selectedContactId);
  const linkedPolicy = policies.find((p) => p.contactId === selectedContactId);

  const handleGenerateContingency = () => {
    if (!selectedContact) return;

    const contingency: ContingencyAgreement = {
      id: generateId(),
      jobId: "",
      contactId: selectedContact.id,
      homeownerName: `${selectedContact.firstName} ${selectedContact.lastName}`,
      propertyAddress: `${selectedContact.address}, ${selectedContact.city}, ${selectedContact.state} ${selectedContact.zip}`,
      homeownerPhone: selectedContact.phone,
      homeownerEmail: selectedContact.email,
      insuranceCompany: selectedContact.insuranceCompany || linkedPolicy?.carrier || "",
      policyNumber: selectedContact.policyNumber || linkedPolicy?.policyNumber || "",
      claimNumber: selectedContact.claimNumber || "",
      dateOfLoss: linkedPolicy?.dateOfLoss || "",
      deductible: linkedPolicy?.deductible || 0,
      policyType: linkedPolicy?.policyType || "RCV",
      hasInteriorLeaks: formData.hasInteriorLeaks,
      claimType: formData.claimType,
      hasOutsideStructures: formData.hasOutsideStructures,
      outsideStructuresDescription: formData.outsideStructuresDescription,
      adminNotes,
      salesRepId: currentUser.id,
      salesRepName: currentUser.name,
      status: "draft",
      createdAt: new Date().toISOString(),
    };

    addContingency(contingency);
    setStep("send");
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Contingency Agreement Generator</h2>
        <p className="text-sm text-gray-500 mt-1">
          Generate a contingency agreement pre-filled with insurance policy data.
          Answer a few questions, then send via DocuSign for e-signature.
        </p>
      </div>

      {/* Progress Steps */}
      <div className="flex items-center gap-2">
        {["Select Homeowner", "Sales Rep Questions", "Preview & Admin", "Send for Signature"].map((s, i) => {
          const stepKeys = ["select", "questions", "preview", "send"];
          const currentIdx = stepKeys.indexOf(step);
          const isActive = i === currentIdx;
          const isComplete = i < currentIdx;
          return (
            <div key={s} className="flex items-center gap-2 flex-1">
              <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium ${
                isComplete ? "bg-green-500 text-white" : isActive ? "bg-brand-500 text-white" : "bg-gray-200 text-gray-500"
              }`}>
                {isComplete ? <CheckCircle className="h-4 w-4" /> : i + 1}
              </div>
              <span className={`text-xs font-medium hidden sm:block ${isActive ? "text-brand-600" : "text-gray-500"}`}>{s}</span>
              {i < 3 && <div className={`flex-1 h-0.5 ${isComplete ? "bg-green-400" : "bg-gray-200"}`} />}
            </div>
          );
        })}
      </div>

      {/* Step 1: Select Homeowner */}
      {step === "select" && (
        <div className="card card-body space-y-4">
          <div>
            <label className="label">Select Homeowner</label>
            <select
              value={selectedContactId}
              onChange={(e) => setSelectedContactId(e.target.value)}
              className="input"
            >
              <option value="">Choose a homeowner...</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.firstName} {c.lastName} - {c.address}, {c.city}, {c.state}
                </option>
              ))}
            </select>
          </div>

          {selectedContact && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 bg-gray-50 rounded-lg">
              <div>
                <h4 className="text-sm font-medium text-gray-900 flex items-center gap-2">
                  <User className="h-4 w-4" /> Homeowner Info
                </h4>
                <div className="mt-2 space-y-1 text-sm text-gray-600">
                  <p>{selectedContact.firstName} {selectedContact.lastName}</p>
                  <p>{selectedContact.email}</p>
                  <p>{selectedContact.phone}</p>
                </div>
              </div>
              <div>
                <h4 className="text-sm font-medium text-gray-900 flex items-center gap-2">
                  <Home className="h-4 w-4" /> Property
                </h4>
                <div className="mt-2 space-y-1 text-sm text-gray-600">
                  <p>{selectedContact.address}</p>
                  <p>{selectedContact.city}, {selectedContact.state} {selectedContact.zip}</p>
                </div>
              </div>
              {(selectedContact.insuranceCompany || linkedPolicy) && (
                <div className="md:col-span-2">
                  <h4 className="text-sm font-medium text-gray-900 flex items-center gap-2">
                    <Shield className="h-4 w-4" /> Insurance Info
                  </h4>
                  <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                    <div>
                      <p className="text-gray-500">Carrier</p>
                      <p className="font-medium">{selectedContact.insuranceCompany || linkedPolicy?.carrier || "N/A"}</p>
                    </div>
                    <div>
                      <p className="text-gray-500">Policy #</p>
                      <p className="font-medium">{selectedContact.policyNumber || linkedPolicy?.policyNumber || "N/A"}</p>
                    </div>
                    {linkedPolicy && (
                      <>
                        <div>
                          <p className="text-gray-500">Type</p>
                          <p className={`font-medium ${linkedPolicy.policyType === "RCV" ? "text-green-600" : "text-amber-600"}`}>
                            {linkedPolicy.policyType}
                          </p>
                        </div>
                        <div>
                          <p className="text-gray-500">Deductible</p>
                          <p className="font-medium">{formatCurrency(linkedPolicy.deductible)}</p>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end">
            <button
              onClick={() => setStep("questions")}
              disabled={!selectedContactId}
              className="btn-primary"
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Sales Rep Questions */}
      {step === "questions" && (
        <div className="card card-body space-y-6">
          <div className="flex items-center gap-2 mb-2">
            <MessageSquare className="h-5 w-5 text-brand-500" />
            <h3 className="text-lg font-semibold">Sales Rep Questions</h3>
          </div>

          {/* Question 1: Interior Leaks */}
          <div className="p-4 rounded-lg border border-gray-200">
            <label className="text-sm font-medium text-gray-900">
              1. Are there any interior leaks at the property?
            </label>
            <div className="flex gap-4 mt-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  checked={formData.hasInteriorLeaks}
                  onChange={() => setFormData({ ...formData, hasInteriorLeaks: true })}
                  className="h-4 w-4 text-brand-500"
                />
                <span className="text-sm">Yes, there are interior leaks</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  checked={!formData.hasInteriorLeaks}
                  onChange={() => setFormData({ ...formData, hasInteriorLeaks: false })}
                  className="h-4 w-4 text-brand-500"
                />
                <span className="text-sm">No interior leaks</span>
              </label>
            </div>
          </div>

          {/* Question 2: Claim Type */}
          <div className="p-4 rounded-lg border border-gray-200">
            <label className="text-sm font-medium text-gray-900">
              2. Is this a hail or wind claim?
            </label>
            <div className="flex gap-4 mt-3">
              {[
                { value: "hail", label: "Hail Claim" },
                { value: "wind", label: "Wind Claim" },
                { value: "hail_and_wind", label: "Both Hail & Wind" },
              ].map((opt) => (
                <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={formData.claimType === opt.value}
                    onChange={() => setFormData({ ...formData, claimType: opt.value as ClaimType })}
                    className="h-4 w-4 text-brand-500"
                  />
                  <span className="text-sm">{opt.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Question 3: Outside Structures */}
          <div className="p-4 rounded-lg border border-gray-200">
            <label className="text-sm font-medium text-gray-900">
              3. Are there any outside structures (other than the main structure) involved?
            </label>
            <div className="flex gap-4 mt-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  checked={formData.hasOutsideStructures}
                  onChange={() => setFormData({ ...formData, hasOutsideStructures: true })}
                  className="h-4 w-4 text-brand-500"
                />
                <span className="text-sm">Yes</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  checked={!formData.hasOutsideStructures}
                  onChange={() => setFormData({ ...formData, hasOutsideStructures: false })}
                  className="h-4 w-4 text-brand-500"
                />
                <span className="text-sm">No</span>
              </label>
            </div>
            {formData.hasOutsideStructures && (
              <div className="mt-3">
                <label className="label">Describe the outside structures:</label>
                <textarea
                  value={formData.outsideStructuresDescription}
                  onChange={(e) => setFormData({ ...formData, outsideStructuresDescription: e.target.value })}
                  className="input"
                  rows={2}
                  placeholder="e.g., Detached garage, shed, pergola..."
                />
              </div>
            )}
          </div>

          <div className="flex gap-3 justify-end">
            <button onClick={() => setStep("select")} className="btn-secondary">Back</button>
            <button onClick={() => setStep("preview")} className="btn-primary">Continue to Preview</button>
          </div>
        </div>
      )}

      {/* Step 3: Preview */}
      {step === "preview" && selectedContact && (
        <div className="space-y-6">
          {/* Admin Notes (top right of contingency) */}
          <div className="card">
            <div className="card-header bg-amber-50 border-amber-200">
              <h3 className="text-sm font-semibold text-amber-800">Administrative Use Only</h3>
            </div>
            <div className="card-body">
              <textarea
                value={adminNotes}
                onChange={(e) => setAdminNotes(e.target.value)}
                className="input"
                rows={3}
                placeholder="Internal notes for administrative use (not visible to homeowner)..."
              />
            </div>
          </div>

          {/* Contingency Preview */}
          <div className="card">
            <div className="card-header flex items-center justify-between">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Eye className="h-4 w-4" />
                Contingency Agreement Preview
              </h3>
              <span className="badge bg-amber-100 text-amber-700">DRAFT</span>
            </div>
            <div className="card-body">
              {/* Simulated Contingency Document */}
              <div className="border border-gray-300 rounded-lg p-8 bg-white max-w-2xl mx-auto space-y-6">
                {/* Header */}
                <div className="text-center border-b border-gray-200 pb-4">
                  <div className="flex justify-between items-start">
                    <div className="text-left">
                      <h2 className="text-xl font-bold text-gray-900">APEX ROOFING SOLUTIONS</h2>
                      <p className="text-xs text-gray-500">Licensed & Insured Roofing Contractor</p>
                    </div>
                    <div className="text-right p-2 border border-amber-300 bg-amber-50 rounded text-xs">
                      <p className="font-bold text-amber-800">ADMIN USE ONLY</p>
                      <p className="text-amber-700 mt-1 max-w-[200px]">{adminNotes || "No admin notes"}</p>
                    </div>
                  </div>
                  <h3 className="text-lg font-bold mt-4 text-gray-800">CONTINGENCY / INSURANCE RECOVERY AGREEMENT</h3>
                </div>

                {/* Homeowner Info */}
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-gray-500">Homeowner Name:</p>
                    <p className="font-medium border-b border-gray-300 pb-1">
                      {selectedContact.firstName} {selectedContact.lastName}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-500">Phone:</p>
                    <p className="font-medium border-b border-gray-300 pb-1">{selectedContact.phone}</p>
                  </div>
                  <div className="col-span-2">
                    <p className="text-gray-500">Property Address:</p>
                    <p className="font-medium border-b border-gray-300 pb-1">
                      {selectedContact.address}, {selectedContact.city}, {selectedContact.state} {selectedContact.zip}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-500">Email:</p>
                    <p className="font-medium border-b border-gray-300 pb-1">{selectedContact.email}</p>
                  </div>
                </div>

                {/* Insurance Info */}
                <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                  <h4 className="font-semibold text-gray-800">Insurance Information</h4>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-gray-500">Insurance Company:</p>
                      <p className="font-medium">{selectedContact.insuranceCompany || linkedPolicy?.carrier || "_______________"}</p>
                    </div>
                    <div>
                      <p className="text-gray-500">Policy Number:</p>
                      <p className="font-medium">{selectedContact.policyNumber || linkedPolicy?.policyNumber || "_______________"}</p>
                    </div>
                    <div>
                      <p className="text-gray-500">Claim Number:</p>
                      <p className="font-medium">{selectedContact.claimNumber || "Pending"}</p>
                    </div>
                    <div>
                      <p className="text-gray-500">Date of Loss:</p>
                      <p className="font-medium">{linkedPolicy?.dateOfLoss ? formatDate(linkedPolicy.dateOfLoss) : "_______________"}</p>
                    </div>
                    <div>
                      <p className="text-gray-500">Policy Type:</p>
                      <p className={`font-medium ${linkedPolicy?.policyType === "RCV" ? "text-green-600" : "text-amber-600"}`}>
                        {linkedPolicy?.policyType || "_______________"}
                      </p>
                    </div>
                    <div>
                      <p className="text-gray-500">Deductible:</p>
                      <p className="font-medium">{linkedPolicy ? formatCurrency(linkedPolicy.deductible) : "_______________"}</p>
                    </div>
                  </div>
                </div>

                {/* Claim Details */}
                <div className="space-y-3 text-sm">
                  <h4 className="font-semibold text-gray-800">Claim Details</h4>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-gray-500">Type of Damage:</p>
                      <p className="font-medium capitalize">{formData.claimType.replace("_", " & ")}</p>
                    </div>
                    <div>
                      <p className="text-gray-500">Interior Leaks:</p>
                      <p className="font-medium">{formData.hasInteriorLeaks ? "Yes" : "No"}</p>
                    </div>
                    <div>
                      <p className="text-gray-500">Outside Structures:</p>
                      <p className="font-medium">
                        {formData.hasOutsideStructures ? formData.outsideStructuresDescription || "Yes" : "No"}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Terms */}
                <div className="text-xs text-gray-600 space-y-2 border-t border-gray-200 pt-4">
                  <p>This agreement authorizes Apex Roofing Solutions to act on behalf of the property owner in negotiations with the insurance company regarding the above-referenced claim. The contractor is authorized to meet with the insurance adjuster, communicate with the insurance carrier, and perform all necessary work as approved by the insurance company.</p>
                  <p>The homeowner agrees that the deductible amount ({linkedPolicy ? formatCurrency(linkedPolicy.deductible) : "$_____"}) is the homeowner&apos;s responsibility and will be collected at the start of the project.</p>
                  <p>This contract is contingent upon insurance approval of the claim. If the claim is denied, neither party has any further obligation.</p>
                </div>

                {/* Signature Lines */}
                <div className="grid grid-cols-2 gap-8 pt-6 border-t border-gray-200">
                  <div>
                    <div className="border-b border-gray-400 h-12 flex items-end pb-1">
                      <PenTool className="h-4 w-4 text-gray-300" />
                    </div>
                    <p className="text-xs text-gray-500 mt-1">Homeowner Signature</p>
                    <p className="text-xs text-gray-400">Date: _______________</p>
                  </div>
                  <div>
                    <div className="border-b border-gray-400 h-12 flex items-end pb-1">
                      <span className="text-sm text-gray-400 italic">{currentUser.name}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">Contractor Representative</p>
                    <p className="text-xs text-gray-400">Date: {new Date().toLocaleDateString()}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="flex gap-3 justify-end">
            <button onClick={() => setStep("questions")} className="btn-secondary">Back</button>
            <button className="btn-secondary">
              <Download className="h-4 w-4" /> Download PDF
            </button>
            <button onClick={handleGenerateContingency} className="btn-primary">
              <Send className="h-4 w-4" /> Send via DocuSign
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Send */}
      {step === "send" && (
        <div className="card card-body text-center py-12">
          <div className="flex flex-col items-center gap-4">
            <div className="rounded-full bg-green-100 p-4">
              <CheckCircle className="h-12 w-12 text-green-600" />
            </div>
            <h3 className="text-xl font-bold text-gray-900">Contingency Agreement Generated!</h3>
            <p className="text-sm text-gray-500 max-w-md">
              The contingency agreement has been created and is ready to send.
              Enter the homeowner&apos;s email to send it via DocuSign for e-signature.
            </p>

            <div className="w-full max-w-md mt-4 space-y-3">
              <div>
                <label className="label">Homeowner Email</label>
                <input
                  type="email"
                  className="input"
                  defaultValue={selectedContact?.email}
                  placeholder="homeowner@email.com"
                />
              </div>
              <button className="btn-primary w-full justify-center">
                <PenTool className="h-4 w-4" />
                Send for DocuSign Signature
              </button>
            </div>

            <div className="flex gap-3 mt-4">
              <button onClick={() => setCurrentView("pipeline")} className="btn-secondary">
                Go to Pipeline
              </button>
              <button
                onClick={() => {
                  setStep("select");
                  setSelectedContactId("");
                  setAdminNotes("");
                }}
                className="btn-secondary"
              >
                Create Another
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Existing Contingencies */}
      {contingencies.length > 0 && step === "select" && (
        <div className="card">
          <div className="card-header">
            <h3 className="text-sm font-semibold">Recent Contingency Agreements</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="table-header px-6 py-3">Homeowner</th>
                  <th className="table-header px-6 py-3">Address</th>
                  <th className="table-header px-6 py-3">Carrier</th>
                  <th className="table-header px-6 py-3">Status</th>
                  <th className="table-header px-6 py-3">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {contingencies.map((c) => (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="table-cell font-medium">{c.homeownerName}</td>
                    <td className="table-cell text-gray-600">{c.propertyAddress}</td>
                    <td className="table-cell text-gray-600">{c.insuranceCompany}</td>
                    <td className="table-cell">
                      <span className={`badge ${
                        c.status === "signed" ? "bg-green-100 text-green-700" :
                        c.status === "sent" ? "bg-blue-100 text-blue-700" :
                        "bg-gray-100 text-gray-700"
                      }`}>{c.status}</span>
                    </td>
                    <td className="table-cell text-gray-500">{formatDate(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
