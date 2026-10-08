// Caption prompt construction.
//
// The CRM owns the brand voice and the legal guardrails, so n8n does not
// hand-write prompts — it fetches a ready-made system/user pair from
// /api/social/queue and forwards it to the Messages API. One place to edit
// when the voice changes; no drift across five workflows.

import { BRAND_VOICE, type SocialPost } from './queue';
import { PLATFORM_LIMITS, SERVICE_AREA_CITIES, type SocialPlatform } from './compliance';

export interface CaptionPrompt {
  system: string;
  user: string;
  /** JSON Schema the model's response is constrained to. */
  schema: Record<string, unknown>;
}

const PLATFORM_GUIDANCE: Record<SocialPlatform, string> = {
  facebook:
    'Facebook page post. 3-6 short paragraphs is the ceiling; most posts should be shorter. Line breaks between thoughts. At most 3 hashtags, at the very end. Write for someone scrolling on a phone who is not looking for a roofer yet.',
  instagram:
    'Instagram caption, hard cap 2,200 characters. Open with a line that stands on its own — the rest is hidden behind "more". Conversational. 8-15 hashtags at the end, mixing local (#JacksonvilleFL, #OrangeParkFL) and trade (#RoofReplacement) tags.',
  google_business:
    'Google Business Profile local post, hard cap 1,500 characters. No hashtags — they do nothing here. Front-load the city and the service, because this surfaces in local search. Plain declarative sentences; no emoji.',
};

export function buildCaptionPrompt(post: SocialPost, platform: SocialPlatform): CaptionPrompt {
  const limits = PLATFORM_LIMITS[platform];

  const system = [
    `You write social copy for ${BRAND_VOICE.company}, a roofing contractor serving ${BRAND_VOICE.serviceArea}.`,
    '',
    'VOICE',
    ...BRAND_VOICE.voice.map((v) => `- ${v}`),
    '',
    'NON-NEGOTIABLE LEGAL RULES — a violation costs the company up to $10,000 per post under Florida law:',
    ...BRAND_VOICE.hardRules.map((r) => `- ${r}`),
    '',
    'Do not write the license number or any legal disclosure into the caption. Those are appended automatically after you finish; writing them yourself produces duplicates.',
    'Do not invent job details, prices, warranty terms, customer names, or statistics. Use only what the brief gives you.',
    `The company phone is ${BRAND_VOICE.phone} and the approved tagline is "${BRAND_VOICE.tagline}" — use the tagline sparingly, not on every post.`,
  ].join('\n');

  const user = [
    `PLATFORM: ${platform}`,
    PLATFORM_GUIDANCE[platform],
    `Absolute character limit for your caption: ${Math.floor(limits.characters * 0.7)} characters. Legal disclosures are appended afterward and need the headroom.`,
    '',
    `TARGET CITY: ${post.targetCity}`,
    `THEME: ${post.theme.replace(/_/g, ' ')}`,
    '',
    'BRIEF',
    post.brief,
    '',
    post.media.length > 0
      ? `The post carries ${post.media.length} ${post.media.length === 1 ? 'image' : 'images'}. Write copy that complements the image rather than describing it.`
      : 'This is a text post with no image.',
    '',
    `Name ${post.targetCity} (or another of: ${SERVICE_AREA_CITIES.slice(0, 8).join(', ')}) somewhere in the caption.`,
    `Include the phone number ${BRAND_VOICE.phone} where a call to action fits naturally.`,
  ].join('\n');

  return { system, user, schema: CAPTION_SCHEMA };
}

/**
 * Structured-output schema. Constraining the response means n8n never parses
 * prose, and the `mentions_insurance_claim` self-report gives the compliance
 * gate a second signal alongside its own pattern scan.
 */
export const CAPTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    caption: {
      type: 'string',
      description: 'The publish-ready caption text, including any hashtags.',
    },
    hook: {
      type: 'string',
      description: 'The first line on its own, for previewing in the CRM.',
    },
    mentions_insurance_claim: {
      type: 'boolean',
      description: 'True if the caption references insurance, claims, adjusters, carriers, policies, or deductibles in any way.',
    },
    hashtags: {
      type: 'array',
      items: { type: 'string' },
      description: 'Hashtags used, without the leading #. Empty array for Google Business Profile.',
    },
  },
  required: ['caption', 'hook', 'mentions_insurance_claim', 'hashtags'],
  additionalProperties: false,
};
