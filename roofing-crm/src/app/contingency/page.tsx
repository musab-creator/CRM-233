'use client';

import AppShell from '@/components/AppShell';
import StatusBadge from '@/components/StatusBadge';
import { useCRMStore } from '@/store';
import {
  formatCurrency, formatDate, getPolicyTypeLabel,
  getPolicyTypeBadge, getClaimTypeLabel, generateId
} from '@/lib/utils';
import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  FileSignature, CheckCircle, ChevronRight, Shield,
  User, MapPin, FileText, Send, AlertTriangle, Building2,
  X, Clock, Pen
} from 'lucide-react';
import type { ClaimType, ContingencyAgreement } from '@/types';

function ContingencyContent() {
  const searchParams = useSearchParams();
  const policyIdParam = searchParams.get('policyId');

  const {
    policies, homeowners, leads, currentUser,
    contingencies, addContingency, updateContingency, addActivity
  } = useCRMStore();

  const [step, setStep] = useState(1);
  const [selectedPolicyId, setSelectedPolicyId] = useState(policyIdParam || '');
  const [formData, setFormData] = useState({
    hasInteriorLeaks: false,
    isHailOrWindClaim: 'hail' as ClaimType,
    hasOutsideStructures: false,
    outsideStructuresDescription: '',
    adminNotes: '',
  });
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [recipientEmail, setRecipientEmail] = useState('');

  const selectedPolicy = policies.find(p => p.id === selectedPolicyId);
  const homeowner = selectedPolicy ? homeowners.find(h => h.id === selectedPolicy.homeownerId) : null;
  const lead = selectedPolicy ? leads.find(l => l.policyId === selectedPolicy.id) : null;

  useEffect(() => {
    if (homeowner) {
      setRecipientEmail(homeowner.email);
    }
  }, [homeowner]);

  const steps = [
    { num: 1, label: 'Select Policy' },
    { num: 2, label: 'Sales Rep Questions' },
    { num: 3, label: 'Admin Notes' },
    { num: 4, label: 'Preview' },
    { num: 5, label: 'Send via DocuSign' },
  ];

  const canProceed = () => {
    if (step === 1) return !!selectedPolicyId && !!selectedPolicy;
    if (step === 2) return true;
    if (step === 3) return true;
    if (step === 4) return true;
    return false;
  };

  const handleSendDocuSign = async () => {
    if (!homeowner || !selectedPolicy || !lead) return;
    setSending(true);

    await new Promise(resolve => setTimeout(resolve, 2000));

    const contingency: ContingencyAgreement = {
      id: generateId(),
      leadId: lead.id,
      homeownerId: homeowner.id,
      policyId: selectedPolicy.id,
      homeownerName: `${homeowner.firstName} ${homeowner.lastName}`,
      homeownerAddress: homeowner.address,
      homeownerCity: homeowner.city,
      homeownerState: homeowner.state,
      homeownerZip: homeowner.zip,
      homeownerPhone: homeowner.phone,
      homeownerEmail: homeowner.email,
      insuranceCarrier: selectedPolicy.carrier,
      policyNumber: selectedPolicy.policyNumber,
      policyType: selectedPolicy.policyType,
      deductible: selectedPolicy.deductible,
      dateOfLoss: selectedPolicy.bestDateOfLoss,
      claimType: formData.isHailOrWindClaim,
      hasInteriorLeaks: formData.hasInteriorLeaks,
      isHailOrWindClaim: formData.isHailOrWindClaim,
      hasOutsideStructures: formData.hasOutsideStructures,
      outsideStructuresDescription: formData.outsideStructuresDescription,
      adminNotes: formData.adminNotes,
      salesRepId: currentUser?.id || '',
      salesRepName: currentUser?.name || '',
      status: 'pending_signature',
      generatedAt: new Date().toISOString(),
      sentAt: new Date().toISOString(),
      docusignEnvelopeId: `ds-env-${Date.now().toString(36)}`,
    };

    addContingency(contingency);
    addActivity({
      id: generateId(),
      leadId: lead.id,
      userId: currentUser?.id || '',
      type: 'document',
      description: `Contingency agreement sent to ${homeowner.firstName} ${homeowner.lastName} via DocuSign`,
      createdAt: new Date().toISOString(),
    });

    setSending(false);
    setSent(true);
  };

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Contingency Agreement Generator</h1>
        <p className="text-sm text-gray-500 mt-1">Generate and send contingency agreements for insurance jobs</p>
      </div>

      {/* Stepper */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-6">
        <div className="flex items-center justify-between">
          {steps.map((s, i) => (
            <div key={s.num} className="flex items-center">
              <div className="flex items-center gap-2">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                  step > s.num ? 'bg-green-500 text-white' :
                  step === s.num ? 'bg-orange-600 text-white' :
                  'bg-gray-200 text-gray-500'
                }`}>
                  {step > s.num ? <CheckCircle className="w-4 h-4" /> : s.num}
                </div>
                <span className={`text-sm font-medium ${
                  step >= s.num ? 'text-gray-900' : 'text-gray-400'
                }`}>
                  {s.label}
                </span>
              </div>
              {i < steps.length - 1 && (
                <div className={`w-12 h-0.5 mx-3 ${step > s.num ? 'bg-green-500' : 'bg-gray-200'}`} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Step 1 - Select Policy */}
      {step === 1 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Shield className="w-5 h-5 text-orange-600" /> Select Insurance Policy
          </h2>
          <select
            value={selectedPolicyId}
            onChange={(e) => setSelectedPolicyId(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          >
            <option value="">Choose a policy...</option>
            {policies.map(p => {
              const ho = homeowners.find(h => h.id === p.homeownerId);
              return (
                <option key={p.id} value={p.id}>
                  {ho ? `${ho.firstName} ${ho.lastName}` : 'Unknown'} - {p.carrier} - {p.policyNumber} ({p.policyType})
                </option>
              );
            })}
          </select>

          {selectedPolicy && homeowner && (
            <div className="mt-6 p-4 bg-gray-50 rounded-lg">
              <h3 className="font-semibold text-sm text-gray-700 mb-3">Auto-Populated Data</h3>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="space-y-2">
                  <h4 className="font-medium text-gray-600 flex items-center gap-1"><User className="w-3 h-3" /> Homeowner</h4>
                  <p>{homeowner.firstName} {homeowner.lastName}</p>
                  <p className="flex items-center gap-1"><MapPin className="w-3 h-3 text-gray-400" /> {homeowner.address}</p>
                  <p>{homeowner.city}, {homeowner.state} {homeowner.zip}</p>
                  <p>{homeowner.phone}</p>
                  <p>{homeowner.email}</p>
                </div>
                <div className="space-y-2">
                  <h4 className="font-medium text-gray-600 flex items-center gap-1"><Shield className="w-3 h-3" /> Policy</h4>
                  <p><span className="text-gray-500">Carrier:</span> {selectedPolicy.carrier}</p>
                  <p><span className="text-gray-500">Policy #:</span> {selectedPolicy.policyNumber}</p>
                  <p>
                    <span className="text-gray-500">Type: </span>
                    <StatusBadge label={selectedPolicy.policyType} colorClass={getPolicyTypeBadge(selectedPolicy.policyType)} />
                  </p>
                  <p><span className="text-gray-500">Deductible:</span> {selectedPolicy.deductibleType === 'flat' ? formatCurrency(selectedPolicy.deductible) : `${selectedPolicy.deductible}%`}</p>
                  <p><span className="text-gray-500">Date of Loss:</span> {formatDate(selectedPolicy.bestDateOfLoss)}</p>
                  <p><span className="text-gray-500">Dwelling:</span> {formatCurrency(selectedPolicy.dwellingCoverage)}</p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 2 - Sales Rep Questions */}
      {step === 2 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold mb-2 flex items-center gap-2">
            <FileText className="w-5 h-5 text-orange-600" /> Sales Rep Questions
          </h2>
          <p className="text-sm text-gray-500 mb-6">Answer these three questions before generating the contingency agreement.</p>

          <div className="space-y-6">
            {/* Question 1 */}
            <div className="p-4 border border-gray-200 rounded-lg">
              <h3 className="font-semibold text-gray-800 mb-3">1. Are there any interior leaks?</h3>
              <div className="flex gap-4">
                <label className={`flex-1 p-3 border-2 rounded-lg cursor-pointer text-center transition-colors ${
                  formData.hasInteriorLeaks ? 'border-orange-500 bg-orange-50' : 'border-gray-200 hover:border-gray-300'
                }`}>
                  <input
                    type="radio"
                    name="interiorLeaks"
                    checked={formData.hasInteriorLeaks}
                    onChange={() => setFormData(prev => ({ ...prev, hasInteriorLeaks: true }))}
                    className="sr-only"
                  />
                  <span className="font-medium">Yes</span>
                  <p className="text-xs text-gray-500 mt-1">Interior water damage present</p>
                </label>
                <label className={`flex-1 p-3 border-2 rounded-lg cursor-pointer text-center transition-colors ${
                  !formData.hasInteriorLeaks ? 'border-orange-500 bg-orange-50' : 'border-gray-200 hover:border-gray-300'
                }`}>
                  <input
                    type="radio"
                    name="interiorLeaks"
                    checked={!formData.hasInteriorLeaks}
                    onChange={() => setFormData(prev => ({ ...prev, hasInteriorLeaks: false }))}
                    className="sr-only"
                  />
                  <span className="font-medium">No</span>
                  <p className="text-xs text-gray-500 mt-1">No interior damage</p>
                </label>
              </div>
            </div>

            {/* Question 2 */}
            <div className="p-4 border border-gray-200 rounded-lg">
              <h3 className="font-semibold text-gray-800 mb-3">2. Is this a hail or wind claim?</h3>
              <div className="flex gap-3">
                {[
                  { value: 'hail' as ClaimType, label: 'Hail', desc: 'Hail impact damage' },
                  { value: 'wind' as ClaimType, label: 'Wind', desc: 'Wind-related damage' },
                  { value: 'hail_and_wind' as ClaimType, label: 'Both', desc: 'Hail and wind damage' },
                ].map(option => (
                  <label key={option.value} className={`flex-1 p-3 border-2 rounded-lg cursor-pointer text-center transition-colors ${
                    formData.isHailOrWindClaim === option.value ? 'border-orange-500 bg-orange-50' : 'border-gray-200 hover:border-gray-300'
                  }`}>
                    <input
                      type="radio"
                      name="claimType"
                      checked={formData.isHailOrWindClaim === option.value}
                      onChange={() => setFormData(prev => ({ ...prev, isHailOrWindClaim: option.value }))}
                      className="sr-only"
                    />
                    <span className="font-medium">{option.label}</span>
                    <p className="text-xs text-gray-500 mt-1">{option.desc}</p>
                  </label>
                ))}
              </div>
            </div>

            {/* Question 3 */}
            <div className="p-4 border border-gray-200 rounded-lg">
              <h3 className="font-semibold text-gray-800 mb-3">3. Are there any outside structures other than the main structure involved?</h3>
              <div className="flex gap-4 mb-3">
                <label className={`flex-1 p-3 border-2 rounded-lg cursor-pointer text-center transition-colors ${
                  formData.hasOutsideStructures ? 'border-orange-500 bg-orange-50' : 'border-gray-200 hover:border-gray-300'
                }`}>
                  <input
                    type="radio"
                    name="outsideStructures"
                    checked={formData.hasOutsideStructures}
                    onChange={() => setFormData(prev => ({ ...prev, hasOutsideStructures: true }))}
                    className="sr-only"
                  />
                  <span className="font-medium">Yes</span>
                </label>
                <label className={`flex-1 p-3 border-2 rounded-lg cursor-pointer text-center transition-colors ${
                  !formData.hasOutsideStructures ? 'border-orange-500 bg-orange-50' : 'border-gray-200 hover:border-gray-300'
                }`}>
                  <input
                    type="radio"
                    name="outsideStructures"
                    checked={!formData.hasOutsideStructures}
                    onChange={() => setFormData(prev => ({ ...prev, hasOutsideStructures: false }))}
                    className="sr-only"
                  />
                  <span className="font-medium">No</span>
                </label>
              </div>
              {formData.hasOutsideStructures && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Describe outside structures</label>
                  <input
                    type="text"
                    value={formData.outsideStructuresDescription}
                    onChange={(e) => setFormData(prev => ({ ...prev, outsideStructuresDescription: e.target.value }))}
                    placeholder="e.g., Detached garage, shed, fence, pergola"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Step 3 - Admin Notes */}
      {step === 3 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold mb-2 flex items-center gap-2">
            <Pen className="w-5 h-5 text-orange-600" /> Administrative Use Only
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            These notes will appear in the &quot;Administrative Use Only&quot; box on the top right of the contingency agreement.
          </p>
          <div className="border-2 border-dashed border-orange-300 rounded-lg p-4 bg-orange-50/50">
            <div className="flex items-center gap-2 mb-2">
              <Building2 className="w-4 h-4 text-orange-600" />
              <span className="text-sm font-semibold text-orange-800">ADMINISTRATIVE USE ONLY</span>
            </div>
            <textarea
              value={formData.adminNotes}
              onChange={(e) => setFormData(prev => ({ ...prev, adminNotes: e.target.value }))}
              rows={6}
              placeholder="Enter internal notes, special instructions, pricing notes, etc."
              className="w-full px-3 py-2 border border-orange-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 bg-white"
            />
          </div>
        </div>
      )}

      {/* Step 4 - Preview */}
      {step === 4 && homeowner && selectedPolicy && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          {/* Document Preview */}
          <div className="relative">
            {/* Admin Notes Box - top right */}
            {formData.adminNotes && (
              <div className="absolute top-4 right-4 w-64 border-2 border-gray-400 bg-gray-50 p-3 z-10">
                <p className="text-[10px] font-bold text-gray-600 border-b border-gray-300 pb-1 mb-2">ADMINISTRATIVE USE ONLY</p>
                <p className="text-xs text-gray-600 whitespace-pre-wrap">{formData.adminNotes}</p>
              </div>
            )}

            <div className="p-8 max-w-3xl mx-auto">
              {/* Company Header */}
              <div className="text-center mb-8 border-b-2 border-gray-800 pb-4">
                <div className="flex items-center justify-center gap-3 mb-2">
                  <div className="w-10 h-10 bg-gradient-to-br from-orange-500 to-red-600 rounded-lg flex items-center justify-center">
                    <Building2 className="w-6 h-6 text-white" />
                  </div>
                  <h1 className="text-2xl font-bold text-gray-900">STORMSHIELD ROOFING</h1>
                </div>
                <p className="text-sm text-gray-500">Licensed &amp; Insured | TX-ROF-2024-12345</p>
              </div>

              <h2 className="text-xl font-bold text-center mb-6 text-gray-900">
                CONTINGENCY AGREEMENT / AUTHORIZATION TO REPAIR
              </h2>

              {/* Homeowner Section */}
              <div className="mb-6">
                <h3 className="font-bold text-sm text-gray-800 bg-gray-100 px-3 py-1.5 mb-3">HOMEOWNER INFORMATION</h3>
                <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm px-3">
                  <div><span className="text-gray-500">Name:</span> <span className="font-medium border-b border-gray-300 pb-0.5">{homeowner.firstName} {homeowner.lastName}</span></div>
                  <div><span className="text-gray-500">Phone:</span> <span className="font-medium border-b border-gray-300 pb-0.5">{homeowner.phone}</span></div>
                  <div><span className="text-gray-500">Address:</span> <span className="font-medium border-b border-gray-300 pb-0.5">{homeowner.address}</span></div>
                  <div><span className="text-gray-500">Email:</span> <span className="font-medium border-b border-gray-300 pb-0.5">{homeowner.email}</span></div>
                  <div><span className="text-gray-500">City/State/Zip:</span> <span className="font-medium border-b border-gray-300 pb-0.5">{homeowner.city}, {homeowner.state} {homeowner.zip}</span></div>
                </div>
              </div>

              {/* Insurance Section */}
              <div className="mb-6">
                <h3 className="font-bold text-sm text-gray-800 bg-gray-100 px-3 py-1.5 mb-3">INSURANCE INFORMATION</h3>
                <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm px-3">
                  <div><span className="text-gray-500">Insurance Carrier:</span> <span className="font-medium border-b border-gray-300 pb-0.5">{selectedPolicy.carrier}</span></div>
                  <div><span className="text-gray-500">Policy Number:</span> <span className="font-medium border-b border-gray-300 pb-0.5">{selectedPolicy.policyNumber}</span></div>
                  <div>
                    <span className="text-gray-500">Policy Type:</span>{' '}
                    <span className={`font-bold ${selectedPolicy.policyType === 'RCV' ? 'text-green-700' : 'text-amber-700'}`}>
                      {getPolicyTypeLabel(selectedPolicy.policyType)}
                    </span>
                  </div>
                  <div><span className="text-gray-500">Deductible:</span> <span className="font-medium border-b border-gray-300 pb-0.5">{selectedPolicy.deductibleType === 'flat' ? formatCurrency(selectedPolicy.deductible) : `${selectedPolicy.deductible}% of Dwelling`}</span></div>
                  <div><span className="text-gray-500">Date of Loss:</span> <span className="font-medium border-b border-gray-300 pb-0.5">{formatDate(selectedPolicy.bestDateOfLoss)}</span></div>
                  <div><span className="text-gray-500">Claim Type:</span> <span className="font-medium border-b border-gray-300 pb-0.5">{getClaimTypeLabel(formData.isHailOrWindClaim)}</span></div>
                  <div><span className="text-gray-500">Dwelling Coverage:</span> <span className="font-medium border-b border-gray-300 pb-0.5">{formatCurrency(selectedPolicy.dwellingCoverage)}</span></div>
                </div>
              </div>

              {/* Scope Section */}
              <div className="mb-6">
                <h3 className="font-bold text-sm text-gray-800 bg-gray-100 px-3 py-1.5 mb-3">SCOPE OF WORK</h3>
                <div className="text-sm px-3 space-y-2">
                  <p>This agreement authorizes StormShield Roofing to perform repairs/replacement of the roof and related components at the above-referenced property due to <strong>{getClaimTypeLabel(formData.isHailOrWindClaim).toLowerCase()} damage</strong> sustained on or about <strong>{formatDate(selectedPolicy.bestDateOfLoss)}</strong>.</p>
                  <ul className="list-disc pl-5 space-y-1">
                    <li>Roof repair/replacement as approved by insurance carrier</li>
                    {formData.hasInteriorLeaks && <li><strong>Interior leak remediation</strong> - Water damage noted inside the property</li>}
                    {formData.hasOutsideStructures && (
                      <li><strong>Outside structures:</strong> {formData.outsideStructuresDescription || 'Additional structures on property'}</li>
                    )}
                    <li>All work performed in accordance with local building codes and manufacturer specifications</li>
                  </ul>
                </div>
              </div>

              {/* Terms */}
              <div className="mb-6">
                <h3 className="font-bold text-sm text-gray-800 bg-gray-100 px-3 py-1.5 mb-3">TERMS AND CONDITIONS</h3>
                <div className="text-xs px-3 space-y-2 text-gray-600">
                  <p>1. The Homeowner hereby authorizes StormShield Roofing (&quot;Contractor&quot;) to act as their representative in meeting with the insurance company adjuster to discuss the scope of repairs needed for the property.</p>
                  <p>2. The Contractor agrees to perform all work as outlined in the insurance company&apos;s approved scope of repairs at the price approved by the insurance company.</p>
                  <p>3. The Homeowner is responsible for paying the insurance deductible of <strong>{selectedPolicy.deductibleType === 'flat' ? formatCurrency(selectedPolicy.deductible) : `${selectedPolicy.deductible}% of dwelling coverage`}</strong> directly to the Contractor upon commencement of work.</p>
                  <p>4. If the insurance claim is denied, the Homeowner shall owe nothing to the Contractor for the inspection, estimate, or claim filing services.</p>
                  <p>5. The Contractor warrants all workmanship for a period of five (5) years from the date of completion and all manufacturer warranties will be registered on behalf of the Homeowner.</p>
                  <p>6. This agreement may be cancelled by the Homeowner within three (3) business days of signing without penalty.</p>
                </div>
              </div>

              {/* Signatures */}
              <div className="grid grid-cols-2 gap-8 mt-10">
                <div>
                  <div className="border-b border-gray-400 mb-1 h-10" />
                  <p className="text-sm text-gray-600">Homeowner Signature</p>
                  <div className="border-b border-gray-400 mb-1 mt-4 h-6" />
                  <p className="text-sm text-gray-600">Date</p>
                </div>
                <div>
                  <div className="border-b border-gray-400 mb-1 h-10" />
                  <p className="text-sm text-gray-600">Company Representative</p>
                  <div className="border-b border-gray-400 mb-1 mt-4 h-6" />
                  <p className="text-sm text-gray-600">Date</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Step 5 - Send via DocuSign */}
      {step === 5 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          {sent ? (
            <div className="text-center py-8">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle className="w-8 h-8 text-green-600" />
              </div>
              <h2 className="text-xl font-bold text-gray-900 mb-2">Contingency Agreement Sent!</h2>
              <p className="text-gray-500 mb-4">
                The agreement has been sent to <strong>{recipientEmail}</strong> via DocuSign.
              </p>
              <div className="inline-flex items-center gap-2 px-4 py-2 bg-gray-50 rounded-lg text-sm text-gray-600">
                <Clock className="w-4 h-4" />
                Waiting for homeowner signature...
              </div>
              <div className="mt-6">
                <button
                  onClick={() => { setStep(1); setSelectedPolicyId(''); setSent(false); }}
                  className="px-4 py-2 bg-orange-600 text-white rounded-lg text-sm font-medium hover:bg-orange-700"
                >
                  Generate Another Agreement
                </button>
              </div>
            </div>
          ) : (
            <>
              <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Send className="w-5 h-5 text-orange-600" /> Send via DocuSign
              </h2>
              <div className="space-y-4 max-w-md">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Homeowner Email</label>
                  <input
                    type="email"
                    value={recipientEmail}
                    onChange={(e) => setRecipientEmail(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Subject</label>
                  <input
                    type="text"
                    value={`Contingency Agreement - StormShield Roofing - ${homeowner?.firstName} ${homeowner?.lastName}`}
                    readOnly
                    className="w-full px-3 py-2 border border-gray-200 bg-gray-50 rounded-lg text-sm"
                  />
                </div>
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
                  <p className="text-xs text-blue-700">
                    The contingency agreement will be sent as a DocuSign envelope. The homeowner will receive an email with a link to review and electronically sign the document.
                  </p>
                </div>
                <button
                  onClick={handleSendDocuSign}
                  disabled={sending || !recipientEmail}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-orange-600 text-white rounded-lg font-medium hover:bg-orange-700 disabled:opacity-50"
                >
                  {sending ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Sending to DocuSign...
                    </>
                  ) : (
                    <>
                      <FileSignature className="w-5 h-5" />
                      Send for Signature via DocuSign
                    </>
                  )}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Navigation Buttons */}
      {!sent && (
        <div className="flex justify-between mt-6">
          <button
            onClick={() => setStep(s => Math.max(1, s - 1))}
            disabled={step === 1}
            className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            Back
          </button>
          {step < 5 && (
            <button
              onClick={() => setStep(s => s + 1)}
              disabled={!canProceed()}
              className="flex items-center gap-2 px-4 py-2 bg-orange-600 text-white rounded-lg text-sm font-medium hover:bg-orange-700 disabled:opacity-50"
            >
              Next <ChevronRight className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      {/* Existing Contingencies */}
      <div className="mt-10">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Existing Contingency Agreements</h2>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          {contingencies.length === 0 ? (
            <div className="p-8 text-center text-gray-400">
              <FileSignature className="w-10 h-10 mx-auto mb-2 opacity-50" />
              <p>No contingency agreements generated yet</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left">
                <tr>
                  <th className="px-4 py-3 font-medium text-gray-600">Homeowner</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Carrier</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Policy Type</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Claim Type</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Status</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Generated</th>
                  <th className="px-4 py-3 font-medium text-gray-600">Signed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {contingencies.map(c => (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{c.homeownerName}</td>
                    <td className="px-4 py-3">{c.insuranceCarrier}</td>
                    <td className="px-4 py-3">
                      <StatusBadge label={c.policyType} colorClass={getPolicyTypeBadge(c.policyType)} />
                    </td>
                    <td className="px-4 py-3">{getClaimTypeLabel(c.claimType)}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        c.status === 'signed' ? 'bg-green-100 text-green-700' :
                        c.status === 'pending_signature' ? 'bg-amber-100 text-amber-700' :
                        c.status === 'draft' ? 'bg-gray-100 text-gray-600' :
                        'bg-red-100 text-red-700'
                      }`}>
                        {c.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500">{formatDate(c.generatedAt)}</td>
                    <td className="px-4 py-3 text-gray-500">{c.signedAt ? formatDate(c.signedAt) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ContingencyPage() {
  return (
    <AppShell>
      <Suspense fallback={<div className="text-gray-400 text-center py-10">Loading...</div>}>
        <ContingencyContent />
      </Suspense>
    </AppShell>
  );
}
