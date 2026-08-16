// Executable spec for the Florida advertising rules.
//
//   npm run check:compliance
//
// No test framework — this runs on bare Node via type stripping so it works in
// CI without adding a dependency to a repo that currently has none for tests.
// Each case asserts the *status* the gate must return, because that is the
// thing that decides whether a post reaches a homeowner's feed.

import {
  checkCompliance,
  FL_489_147_DISCLOSURES,
  type ComplianceConfig,
  type ComplianceStatus,
  type SocialPlatform,
} from '../src/lib/social/compliance.ts';

// A placeholder number — the real one lives only in gitignored .env files.
const config: ComplianceConfig = {
  licenseNumber: 'CCC1234567',
  companyPhone: '(904) 979-0556',
  approvedPhrases: ["We Fight for Your Home So You Don't Have To"],
  requireHumanReviewForClaimTopics: true,
  licensePlacement: 'caption',
  licenseInProfiles: false,
};

/** License carried in the account bios instead of every caption. */
const profileConfig: ComplianceConfig = {
  ...config,
  licensePlacement: 'profile',
  licenseInProfiles: true,
};

interface Case {
  name: string;
  caption: string;
  platform?: SocialPlatform;
  hasImage?: boolean;
  expect: ComplianceStatus;
  expectCode?: string;
  config?: ComplianceConfig;
}

const CASES: Case[] = [
  // --- The happy path
  {
    name: 'clean maintenance post passes',
    caption:
      'Four things you can see from the ground in Jacksonville that mean it is worth getting someone on the roof: lifted shingle edges, granules piling up at the downspout, a soft soffit, and daylight in the attic. Call (904) 979-0556 and we will take a look.',
    expect: 'pass',
  },

  // --- Deductible language: the expensive mistake
  {
    name: 'offering to waive the deductible is blocked',
    caption: 'Storm damage in Orange Park? We waive your deductible on every approved job. (904) 979-0556',
    expect: 'blocked',
    expectCode: 'DEDUCTIBLE_WAIVER',
  },
  {
    name: '"we cover your deductible" is blocked',
    caption: 'New roof in Middleburg with no hassle — we cover the deductible for you. (904) 979-0556',
    expect: 'blocked',
    expectCode: 'DEDUCTIBLE_WAIVER',
  },
  {
    name: '"deductible taken care of" is blocked from the other direction',
    caption: 'Nocatee homeowners: your deductible is taken care of when you sign this month. (904) 979-0556',
    expect: 'blocked',
    expectCode: 'DEDUCTIBLE_WAIVER_INVERTED',
  },
  {
    name: 'zero out of pocket is blocked',
    caption: 'Ponte Vedra roof replacement with zero out of pocket. Call (904) 979-0556',
    expect: 'blocked',
    expectCode: 'NO_OUT_OF_POCKET',
  },
  {
    name: 'free roof advertising is blocked',
    caption: 'You may qualify for a free new roof in Fleming Island. Call (904) 979-0556 today.',
    expect: 'blocked',
    expectCode: 'FREE_ROOF',
  },
  {
    name: 'gift card inducement is blocked',
    caption: 'Book a St. Augustine inspection this week and get a $100 gift card. (904) 979-0556',
    expect: 'blocked',
    expectCode: 'INDUCEMENT',
  },

  // --- Scope of practice
  {
    name: 'claiming to negotiate the claim is blocked',
    caption: 'We negotiate your claim with the carrier so you get every dollar. Jacksonville. (904) 979-0556',
    expect: 'blocked',
    expectCode: 'PUBLIC_ADJUSTER_IMPLICATION',
  },
  {
    name: 'maximising the payout is blocked',
    caption: 'Our team will maximize your claim payout in Duval County. (904) 979-0556',
    expect: 'blocked',
    expectCode: 'PUBLIC_ADJUSTER_IMPLICATION',
  },
  {
    name: 'guaranteeing approval is blocked',
    caption: 'Call us in Jacksonville and we guarantee your claim will be approved. (904) 979-0556',
    expect: 'blocked',
    expectCode: 'CLAIM_OUTCOME_GUARANTEE',
  },
  {
    name: 'offering to interpret the policy is blocked',
    caption: 'We review your policy and explain your coverage. Orange Park. (904) 979-0556',
    expect: 'blocked',
    expectCode: 'POLICY_INTERPRETATION',
  },

  // --- The approved tagline must survive the "we fight" scan
  {
    name: 'approved tagline does not trip any rule',
    caption:
      "We Fight for Your Home So You Don't Have To. Serving Jacksonville and Orange Park since day one. (904) 979-0556",
    expect: 'pass',
  },

  // --- Insurance topic handling
  {
    name: 'insurance-claim post is held for review, not blocked',
    caption:
      'A Middleburg homeowner has one year from the date of loss to file a claim under Florida law. We document the damage and meet the adjuster on the roof. (904) 979-0556',
    expect: 'needs_review',
    expectCode: 'INSURANCE_TOPIC',
  },

  // --- License requirement
  {
    name: 'no license number configured blocks everything',
    caption: 'Roof inspections across Jacksonville. Call (904) 979-0556',
    expect: 'blocked',
    expectCode: 'LICENSE_MISSING',
    config: { ...config, licenseNumber: null },
  },

  // --- Platform mechanics
  {
    name: 'Instagram post with no media is blocked',
    caption: 'Crew day in Jacksonville. Call (904) 979-0556',
    platform: 'instagram',
    hasImage: false,
    expect: 'blocked',
    expectCode: 'MEDIA_REQUIRED',
  },
  {
    name: 'over 30 hashtags is blocked on Instagram',
    caption:
      'Jacksonville roof work. Call (904) 979-0556 ' +
      Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' '),
    platform: 'instagram',
    hasImage: true,
    expect: 'blocked',
    expectCode: 'TOO_MANY_HASHTAGS',
  },
  {
    name: 'a Google post that cannot fit its disclosures is blocked, not truncated',
    caption: `${'Jacksonville storm claim help. '.repeat(40)}(904) 979-0556`,
    platform: 'google_business',
    expect: 'blocked',
    expectCode: 'OVER_CHARACTER_LIMIT',
  },
];

let failures = 0;

for (const testCase of CASES) {
  const result = checkCompliance(
    {
      caption: testCase.caption,
      platform: testCase.platform ?? 'facebook',
      hasImage: testCase.hasImage ?? true,
    },
    testCase.config ?? config,
  );

  const codes = result.findings.map((f) => f.code);
  const statusOk = result.status === testCase.expect;
  const codeOk = !testCase.expectCode || codes.includes(testCase.expectCode);

  if (statusOk && codeOk) {
    console.log(`  ok    ${testCase.name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${testCase.name}`);
    if (!statusOk) console.error(`          expected status "${testCase.expect}", got "${result.status}"`);
    if (!codeOk) console.error(`          expected finding ${testCase.expectCode}, got [${codes.join(', ')}]`);
  }
}

// ---------------------------------------------------------------------------
// License placement. The number is public record, but it does not have to be
// stapled to every caption — as long as it is genuinely somewhere.
// ---------------------------------------------------------------------------

const routinePost = {
  caption: 'Tear-off day in Middleburg. The crew was done and the drive swept by dark. (904) 979-0556',
  platform: 'facebook' as const,
  hasImage: true,
};

const inCaption = checkCompliance(routinePost, config);
if (!inCaption.licenseInCaption || !inCaption.caption.includes('FL Lic. #CCC1234567')) {
  failures += 1;
  console.error('  FAIL  caption placement should append the license to a routine post');
} else {
  console.log('  ok    caption placement appends the license');
}

const inProfile = checkCompliance(routinePost, profileConfig);
if (inProfile.licenseInCaption || inProfile.caption.includes('CCC1234567')) {
  failures += 1;
  console.error('  FAIL  profile placement should keep the license out of a routine caption');
} else if (inProfile.status !== 'pass') {
  failures += 1;
  console.error(`  FAIL  profile placement should still pass, got "${inProfile.status}"`);
} else {
  console.log('  ok    profile placement keeps routine captions clean');
}

// A claim-topic post carries the number inline regardless of placement — those
// are the posts a regulator reads first.
const claimUnderProfilePlacement = checkCompliance(
  {
    caption:
      'We document hail damage and meet your adjuster on the roof in Jacksonville. (904) 979-0556',
    platform: 'facebook',
    hasImage: true,
  },
  profileConfig,
);
if (!claimUnderProfilePlacement.licenseInCaption || !claimUnderProfilePlacement.caption.includes('FL Lic. #CCC1234567')) {
  failures += 1;
  console.error('  FAIL  a claim-topic post must carry the license inline even under profile placement');
} else {
  console.log('  ok    claim-topic posts carry the license inline under either placement');
}

// A typo in the attestation must not silently strip the number.
const unattested = checkCompliance(routinePost, {
  ...profileConfig,
  licenseInProfiles: false,
});
if (!unattested.licenseInCaption || !unattested.caption.includes('FL Lic. #CCC1234567')) {
  failures += 1;
  console.error('  FAIL  profile placement without the attestation must fall back to appending');
} else if (!unattested.findings.some((f) => f.code === 'LICENSE_PLACEMENT_UNVERIFIED')) {
  failures += 1;
  console.error('  FAIL  unattested profile placement should say so in the findings');
} else {
  console.log('  ok    unattested profile placement falls back to appending');
}

// Placement never rescues a missing number.
const profileNoNumber = checkCompliance(routinePost, {
  ...profileConfig,
  licenseNumber: null,
});
if (profileNoNumber.status !== 'blocked') {
  failures += 1;
  console.error('  FAIL  profile placement must not bypass the missing-license block');
} else {
  console.log('  ok    profile placement does not bypass the missing-license block');
}

// --- The disclosures must actually be appended, verbatim.
const claimPost = checkCompliance(
  {
    caption: 'We document hail damage and meet your adjuster on the roof in Jacksonville. (904) 979-0556',
    platform: 'facebook',
    hasImage: true,
  },
  config,
);

for (const disclosure of FL_489_147_DISCLOSURES) {
  if (!claimPost.caption.includes(disclosure)) {
    failures += 1;
    console.error(`  FAIL  missing 489.147 disclosure: "${disclosure.slice(0, 60)}..."`);
  }
}
if (!claimPost.caption.includes('FL Lic. #CCC1234567')) {
  failures += 1;
  console.error('  FAIL  license number was not appended to the published caption');
}
if (failures === 0) console.log('  ok    disclosures and license appended verbatim');

// --- Appending must be idempotent: running the gate twice must not duplicate.
const twice = checkCompliance(
  { caption: claimPost.caption, platform: 'facebook', hasImage: true },
  config,
);
const licenseOccurrences = twice.caption.split('FL Lic. #CCC1234567').length - 1;
if (licenseOccurrences !== 1) {
  failures += 1;
  console.error(`  FAIL  license appears ${licenseOccurrences} times after a second pass — must be idempotent`);
} else {
  console.log('  ok    second pass does not duplicate the license or disclosures');
}

console.log('');
if (failures > 0) {
  console.error(`${failures} compliance check(s) failed.`);
  process.exit(1);
}
console.log(`All ${CASES.length + 7} compliance checks passed.`);
