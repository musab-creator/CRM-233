import { NextRequest, NextResponse } from 'next/server';

// This API route simulates analyzing an uploaded insurance policy PDF
// In production, this would use an AI service (e.g., OpenAI, Claude) to extract policy details
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // Simulate processing delay
    await new Promise(resolve => setTimeout(resolve, 2000));

    // In production, you would:
    // 1. Upload PDF to a processing service
    // 2. Use OCR/AI to extract policy details
    // 3. Parse out key fields (ACV/RCV, deductible, coverage amounts, etc.)

    // Return simulated analysis results
    const analysis = {
      carrier: 'State Farm',
      policyNumber: `SF-${new Date().getFullYear()}-${Math.floor(Math.random() * 99999)}`,
      policyType: Math.random() > 0.4 ? 'RCV' : 'ACV',
      deductible: [1000, 1500, 2000, 2500, 3000, 5000][Math.floor(Math.random() * 6)],
      deductibleType: 'flat',
      effectiveDate: '2025-06-01',
      expirationDate: '2026-06-01',
      dwellingCoverage: 250000 + Math.floor(Math.random() * 200000),
      otherStructuresCoverage: 25000 + Math.floor(Math.random() * 25000),
      personalPropertyCoverage: 125000 + Math.floor(Math.random() * 100000),
      lossOfUseCoverage: 50000 + Math.floor(Math.random() * 50000),
      hasWindCoverage: true,
      hasHailCoverage: true,
      windHailDeductible: null,
      confidence: 0.92,
    };

    return NextResponse.json({ success: true, analysis });
  } catch {
    return NextResponse.json({ error: 'Failed to analyze policy' }, { status: 500 });
  }
}
