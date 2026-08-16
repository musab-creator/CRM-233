// Florida advertising-compliance gate for automated social posts.
//
// Every caption that leaves the automation pipeline passes through checkCompliance().
// The rules encode the constraints in BUSINESS_FACTS.md:
//
//   - FL Admin Code 61G4-12.011 — license number required in ALL advertising
//   - Fla. Stat. 489.147      — three verbatim disclosures on anything mentioning
//                               insurance claims; $10,000 per violation
//   - Scope of practice       — Diversity Roofing is NOT a public adjuster and may
//                               not imply it interprets policy or negotiates claims
//   - Deductible rules        — no offer to waive/absorb/cover a deductible, and no
//                               gift cards / cash / rebates in exchange for an
//                               inspection or claim
//
// Deadlines and statutes change. Re-verify against the current statute before
// relying on this in production.

export type SocialPlatform = 'facebook' | 'instagram' | 'google_business';

export type ComplianceStatus = 'pass' | 'needs_review' | 'blocked';

export type FindingSeverity = 'blocker' | 'review' | 'warning';

export interface ComplianceFinding {
  code: string;
  severity: FindingSeverity;
  message: string;
  /** The offending snippet, when a pattern matched. */
  excerpt?: string;
}

export interface ComplianceConfig {
  /** FL contractor license number. Required — posts are blocked without it. */
  licenseNumber: string | null;
  companyPhone: string;
  /** Phrases that look risky but are the company's approved wording. */
  approvedPhrases: string[];
  /**
   * When true, any post mentioning insurance claims is held for a human even
   * after the 489.147 disclosures are appended. Recommended: true.
   */
  requireHumanReviewForClaimTopics: boolean;
}

export interface ComplianceResult {
  status: ComplianceStatus;
  platform: SocialPlatform;
  findings: ComplianceFinding[];
  /** Caption as it should actually be published (license + disclosures appended). */
  caption: string;
  characterCount: number;
  characterLimit: number;
  mentionsInsuranceClaim: boolean;
  disclosuresApplied: boolean;
}

// ---------------------------------------------------------------------------
// Statutory text — do not paraphrase. Fla. Stat. 489.147(2).
// ---------------------------------------------------------------------------

export const FL_489_147_DISCLOSURES: readonly string[] = [
  'The consumer is responsible for payment of any insurance deductible.',
  'It is insurance fraud punishable as a felony of the third degree for a contractor to knowingly or willfully, and with intent to injure, defraud, or deceive, pay, waive, or rebate all or part of an insurance deductible applicable to payment to the contractor for repairs to a property covered by a property insurance policy.',
  'It is insurance fraud punishable as a felony of the third degree to intentionally file an insurance claim containing any false, incomplete, or misleading information.',
];

// ---------------------------------------------------------------------------
// Platform constraints
// ---------------------------------------------------------------------------

export const PLATFORM_LIMITS: Record<SocialPlatform, { characters: number; hashtags: number; requiresImage: boolean }> = {
  // Graph API caps a page post at 63,206 characters.
  facebook: { characters: 63206, hashtags: 60, requiresImage: false },
  // Instagram Graph API: 2,200-char caption, 30 hashtags, media is mandatory.
  instagram: { characters: 2200, hashtags: 30, requiresImage: true },
  // Google Business Profile local post summary caps at 1,500 characters.
  google_business: { characters: 1500, hashtags: 10, requiresImage: false },
};

// ---------------------------------------------------------------------------
// Rule tables
// ---------------------------------------------------------------------------

interface PatternRule {
  code: string;
  pattern: RegExp;
  message: string;
}

/** Hard stops. A match means the post never publishes. */
const BLOCKING_RULES: PatternRule[] = [
  {
    code: 'DEDUCTIBLE_WAIVER',
    pattern:
      /\b(waiv\w*|absorb\w*|cover\w*|eat\w*|pay\w*|handl\w*|forgiv\w*|rebat\w*|discount\w*)\b[^.!?]{0,40}\bdeductible\b/i,
    message:
      'Offering to waive, absorb, cover, or handle a deductible is insurance fraud under Fla. Stat. 489.147 — a third-degree felony.',
  },
  {
    code: 'DEDUCTIBLE_WAIVER_INVERTED',
    pattern: /\bdeductible\b[^.!?]{0,40}\b(waiv\w*|on us|covered|free|forgiven|taken care of)\b/i,
    message: 'Implies the deductible is waived or covered by the contractor. Prohibited under Fla. Stat. 489.147.',
  },
  {
    code: 'NO_OUT_OF_POCKET',
    pattern: /\b(no|zero|\$0|0)\s*(dollars?\s*)?(out[- ]of[- ]pocket|money down|cost to you)\b/i,
    message: 'Claiming zero out-of-pocket implies the deductible is being waived.',
  },
  {
    code: 'FREE_ROOF',
    pattern: /\b(free|complimentary|no[- ]cost)\s+(new\s+)?(roof|roof replacement|re-?roof)\b/i,
    message: '"Free roof" advertising implies deductible waiver and is a standing FL enforcement target.',
  },
  {
    code: 'INDUCEMENT',
    pattern:
      /\b(gift card|amazon card|visa card|cash back|kickback|rebate|free (tv|iphone|ipad|tablet|drone|grill|yeti))\b/i,
    message:
      'Offering anything of value in exchange for an inspection or claim is a prohibited inducement.',
  },
  {
    code: 'PUBLIC_ADJUSTER_IMPLICATION',
    pattern:
      /\b(public adjust\w*|we (negotiate|will negotiate|handle|will handle|manage|file|settle)\b[^.!?]{0,25}\b(your )?(claim|policy)|negotiat\w+ (with|your) (the )?(insurance|carrier|adjuster|claim)|maximiz\w+ your (claim|payout|settlement)|get you (more|the most) (money|from your insurance))\b/i,
    message:
      'Diversity Roofing is not a public adjuster. Copy may not imply it interprets policy, negotiates, or settles claims.',
  },
  {
    code: 'CLAIM_OUTCOME_GUARANTEE',
    pattern:
      /\b(guarantee\w*|promise\w*|ensure\w*)\b[^.!?]{0,40}\b(approv\w+|paid|payout|coverage|claim)\b|\byour claim will be (approved|paid|covered)\b/i,
    message: 'Guaranteeing a claim outcome is a misrepresentation and outside the company scope of practice.',
  },
  {
    code: 'POLICY_INTERPRETATION',
    pattern: /\b(we|our team)\b[^.!?]{0,30}\b(read|interpret|review|explain)\b[^.!?]{0,20}\byour (policy|coverage)\b/i,
    message: 'Interpreting a homeowner policy is public-adjuster scope. Not permitted.',
  },
];

/** Softer signals: publish is allowed, but a human should look first. */
const REVIEW_RULES: PatternRule[] = [
  {
    code: 'PRICING_CLAIM',
    pattern: /\b(cheapest|lowest price|beat any (price|quote)|price match)\b/i,
    message: 'Comparative pricing claims need to be substantiated before publishing.',
  },
  {
    code: 'URGENCY_DEADLINE',
    pattern: /\b(deadline|last chance|expires (today|tomorrow)|only \d+ (spots?|slots?) left)\b/i,
    message: 'Artificial urgency around claim deadlines can be read as misleading. Verify the stated deadline is the real statutory one.',
  },
  {
    code: 'STORM_CHASING_TONE',
    pattern: /\b(knock\w* on your door|we'?re in your neighborhood right now|door[- ]knock\w*)\b/i,
    message: 'Door-knock language in paid/organic social invites storm-chaser comparisons. Manager review recommended.',
  },
];

/** Anything here means the post is "about" an insurance claim. */
const INSURANCE_TOPIC_PATTERN =
  /\b(insurance|insurer|claim|claims|adjuster|carrier|deductible|policy|policyholder|coverage|denied|denial|supplement|restoration claim|act of god|storm damage claim)\b/i;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function complianceConfigFromEnv(): ComplianceConfig {
  const raw = process.env.DR_APPROVED_PHRASES;
  return {
    licenseNumber: process.env.DR_LICENSE_NUMBER?.trim() || null,
    companyPhone: process.env.DR_PUBLIC_PHONE?.trim() || '(904) 979-0556',
    approvedPhrases: raw
      ? raw.split('|').map((p) => p.trim()).filter(Boolean)
      : ["We Fight for Your Home So You Don't Have To"],
    requireHumanReviewForClaimTopics: process.env.SOCIAL_REVIEW_CLAIM_POSTS !== 'false',
  };
}

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------

export interface ComplianceInput {
  caption: string;
  platform: SocialPlatform;
  hasImage?: boolean;
  /** Skip appending the license/disclosures — used when previewing raw model output. */
  raw?: boolean;
}

export function checkCompliance(input: ComplianceInput, config: ComplianceConfig): ComplianceResult {
  const { platform } = input;
  const limits = PLATFORM_LIMITS[platform];
  const findings: ComplianceFinding[] = [];
  const original = (input.caption ?? '').trim();

  // Approved company wording is exempt from the pattern scan. Blank it out for
  // scanning purposes only — the published caption keeps it intact.
  let scanText = original;
  for (const phrase of config.approvedPhrases) {
    scanText = scanText.split(phrase).join(' ');
  }

  if (!original) {
    findings.push({ code: 'EMPTY_CAPTION', severity: 'blocker', message: 'Caption is empty.' });
  }

  for (const rule of [...BLOCKING_RULES, ...REVIEW_RULES]) {
    const match = rule.pattern.exec(scanText);
    if (!match) continue;
    findings.push({
      code: rule.code,
      severity: BLOCKING_RULES.includes(rule) ? 'blocker' : 'review',
      message: rule.message,
      excerpt: match[0],
    });
  }

  // --- License number: required in all advertising (FL Admin Code 61G4-12.011)
  const licenseLine = config.licenseNumber ? `FL Lic. #${config.licenseNumber}` : null;
  if (!licenseLine) {
    findings.push({
      code: 'LICENSE_MISSING',
      severity: 'blocker',
      message:
        'DR_LICENSE_NUMBER is not set. Florida requires the contractor license number in all advertising, so nothing can publish until it is configured.',
    });
  }

  // --- Insurance-claim topic: attach the three 489.147 disclosures
  const mentionsInsuranceClaim = INSURANCE_TOPIC_PATTERN.test(scanText);
  let caption = original;
  let disclosuresApplied = false;

  if (!input.raw) {
    if (licenseLine && !original.includes(licenseLine) && !new RegExp(`lic\\w*\\.?\\s*#?\\s*${escapeRegex(config.licenseNumber ?? '')}`, 'i').test(original)) {
      caption = `${caption}\n\n${licenseLine}`;
    }

    if (mentionsInsuranceClaim) {
      const missing = FL_489_147_DISCLOSURES.filter((d) => !caption.includes(d));
      if (missing.length > 0) {
        caption = `${caption}\n\n${missing.join('\n\n')}`;
        disclosuresApplied = true;
      }
    }
  }

  if (mentionsInsuranceClaim) {
    findings.push({
      code: 'INSURANCE_TOPIC',
      severity: config.requireHumanReviewForClaimTopics ? 'review' : 'warning',
      message:
        'Post references insurance claims. The three Fla. Stat. 489.147 disclosures were appended. Note the statute also sets a minimum font size (≥12pt and ≥half the largest font on the page) that cannot be enforced on text overlaid in an image — a human must confirm any graphic in this post carries the disclosures legibly.',
    });
  }

  // --- Platform mechanics
  if (caption.length > limits.characters) {
    findings.push({
      code: 'OVER_CHARACTER_LIMIT',
      severity: 'blocker',
      message: `Caption is ${caption.length} characters after required disclosures; ${platform} allows ${limits.characters}. Shorten the body copy — the disclosures cannot be trimmed.`,
    });
  }

  const hashtags = caption.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  if (hashtags.length > limits.hashtags) {
    findings.push({
      code: 'TOO_MANY_HASHTAGS',
      severity: 'blocker',
      message: `${hashtags.length} hashtags; ${platform} allows ${limits.hashtags}.`,
    });
  }

  if (limits.requiresImage && input.hasImage === false) {
    findings.push({
      code: 'MEDIA_REQUIRED',
      severity: 'blocker',
      message: `${platform} cannot publish a text-only post — an image or video is required.`,
    });
  }

  // --- Advisory checks
  if (!caption.includes(config.companyPhone)) {
    findings.push({
      code: 'NO_PHONE',
      severity: 'warning',
      message: `Caption does not include the company phone (${config.companyPhone}).`,
    });
  }

  if (!SERVICE_AREA_PATTERN.test(caption)) {
    findings.push({
      code: 'NO_SERVICE_AREA',
      severity: 'warning',
      message: 'Caption does not name a service-area city. Local posts perform better and reinforce the geographic footprint.',
    });
  }

  const status: ComplianceStatus = findings.some((f) => f.severity === 'blocker')
    ? 'blocked'
    : findings.some((f) => f.severity === 'review')
      ? 'needs_review'
      : 'pass';

  return {
    status,
    platform,
    findings,
    caption,
    characterCount: caption.length,
    characterLimit: limits.characters,
    mentionsInsuranceClaim,
    disclosuresApplied,
  };
}

export const SERVICE_AREA_CITIES = [
  'Jacksonville',
  'Orange Park',
  'Middleburg',
  'St. Augustine',
  'Fleming Island',
  'Ponte Vedra',
  'Jacksonville Beach',
  'Nocatee',
  'Duval County',
  'Clay County',
  'St. Johns County',
];

const SERVICE_AREA_PATTERN = new RegExp(
  `\\b(${SERVICE_AREA_CITIES.map(escapeRegex).join('|')})\\b`,
  'i',
);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
