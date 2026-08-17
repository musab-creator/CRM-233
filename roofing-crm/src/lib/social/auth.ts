import { NextResponse, type NextRequest } from 'next/server';

/**
 * Shared-secret check for the automation endpoints.
 *
 * n8n sends `x-automation-key`.
 *
 * With SOCIAL_AUTOMATION_KEY unset the routes stay open in development, so the
 * app runs out of the box like the rest of the CRM. In production they close
 * instead: this repo deploys automatically, and an unset variable there means
 * an anonymous caller could read the content calendar or push a post into the
 * publishing queue. Convenient defaults are for localhost only.
 */
export function authorizeAutomation(request: NextRequest): NextResponse | null {
  const expected = process.env.SOCIAL_AUTOMATION_KEY;

  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        {
          error:
            'Automation endpoints are disabled: SOCIAL_AUTOMATION_KEY is not configured on this deployment.',
        },
        { status: 503 },
      );
    }
    return null;
  }

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
