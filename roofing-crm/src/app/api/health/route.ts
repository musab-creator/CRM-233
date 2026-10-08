import { NextResponse } from 'next/server';

/**
 * Unauthenticated readiness probe.
 *
 * Two jobs: give the host something to health-check that does not need the
 * shared secret, and answer "is this deployment actually configured?" without
 * anyone having to read the server's environment.
 *
 * It reports booleans only. The licence number and the automation key are
 * never echoed — knowing that a variable is set is not the same as knowing
 * what it is.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  const automationKeySet = Boolean(process.env.SOCIAL_AUTOMATION_KEY);
  const licenseNumberSet = Boolean(process.env.DR_LICENSE_NUMBER?.trim());
  const licensePlacement =
    process.env.DR_LICENSE_PLACEMENT === 'profile' ? 'profile' : 'caption';
  const licenseInProfiles = process.env.DR_LICENSE_IN_PROFILES === 'true';

  // `profile` placement without the attestation is a configuration mistake, not
  // an instruction — the gate falls back to appending the licence to every
  // caption. Surface it here so it is visible before a year of posts carry it.
  const placementAttested = licensePlacement === 'caption' || licenseInProfiles;

  const problems: string[] = [];
  if (!automationKeySet) {
    problems.push(
      'SOCIAL_AUTOMATION_KEY is unset — in production the automation endpoints return 503.',
    );
  }
  if (!licenseNumberSet) {
    problems.push(
      'DR_LICENSE_NUMBER is unset — the compliance gate blocks every post.',
    );
  }
  if (!placementAttested) {
    problems.push(
      'DR_LICENSE_PLACEMENT is "profile" but DR_LICENSE_IN_PROFILES is not "true" — the licence will be appended to every caption instead.',
    );
  }

  return NextResponse.json({
    ok: problems.length === 0,
    service: 'roofing-crm',
    environment: process.env.NODE_ENV ?? 'unknown',
    social: {
      automationKeySet,
      licenseNumberSet,
      licensePlacement,
      licenseInProfiles,
    },
    problems,
  });
}
