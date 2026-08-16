import { NextResponse, type NextRequest } from 'next/server';

/**
 * Shared-secret check for the automation endpoints.
 *
 * n8n sends `x-automation-key`. If SOCIAL_AUTOMATION_KEY is unset the routes
 * stay open so the app runs out of the box like the rest of the CRM — but the
 * response carries a warning so it is obvious in dev, and the README calls out
 * that the key is mandatory before pointing a real n8n instance at this.
 */
export function authorizeAutomation(request: NextRequest): NextResponse | null {
  const expected = process.env.SOCIAL_AUTOMATION_KEY;
  if (!expected) return null;

  const provided = request.headers.get('x-automation-key');
  if (provided !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export function automationWarnings(): string[] {
  const warnings: string[] = [];
  if (!process.env.SOCIAL_AUTOMATION_KEY) {
    warnings.push('SOCIAL_AUTOMATION_KEY is unset — automation endpoints are unauthenticated.');
  }
  if (!process.env.DR_LICENSE_NUMBER) {
    warnings.push('DR_LICENSE_NUMBER is unset — every post will be blocked by the compliance gate.');
  }
  return warnings;
}
