// In-memory social content queue.
//
// Mirrors the rest of the CRM: the app runs with realistic data and no external
// dependencies. Swap `store` for a real table when the CRM gets a database —
// every consumer goes through the exported functions, not the array.

import type { SocialPlatform } from './compliance';

export type PostStatus =
  | 'queued'        // waiting for its scheduled slot
  | 'generating'    // n8n picked it up, caption being written
  | 'needs_review'  // compliance flagged it; a human must approve
  | 'approved'      // cleared for publish
  | 'published'
  | 'blocked'       // compliance hard-stop
  | 'failed';       // platform API rejected it

export type PostTheme =
  | 'storm_response'
  | 'job_showcase'
  | 'education'
  | 'review_spotlight'
  | 'team'
  | 'seasonal_maintenance'
  | 'community';

export interface SocialMedia {
  url: string;
  type: 'image' | 'video';
  caption?: string;
}

export interface SocialPost {
  id: string;
  theme: PostTheme;
  /** Which networks this post targets. */
  platforms: SocialPlatform[];
  /** ISO timestamp. The publisher picks up anything due at or before "now". */
  scheduledFor: string;
  status: PostStatus;
  /** Human-authored brief the caption model works from. */
  brief: string;
  /** City this post is aimed at — keeps the geographic footprint visible. */
  targetCity: string;
  media: SocialMedia[];
  /** Populated by the caption model, then rewritten by the compliance gate. */
  caption?: string;
  /** Google Business Profile posts get a call-to-action button. */
  googleCta?: { actionType: 'BOOK' | 'CALL' | 'LEARN_MORE'; url?: string };
  /** Per-platform publish outcomes, keyed by platform. */
  results?: Partial<Record<SocialPlatform, PublishResult>>;
  complianceNotes?: string[];
  jobId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublishResult {
  status: 'published' | 'blocked' | 'failed';
  platformPostId?: string;
  permalink?: string;
  error?: string;
  publishedAt: string;
}

export interface SocialLead {
  id: string;
  platform: SocialPlatform;
  kind: 'comment' | 'direct_message' | 'review';
  authorName: string;
  authorHandle?: string;
  message: string;
  permalink?: string;
  receivedAt: string;
  handled: boolean;
}

export interface ReviewRecord {
  id: string;
  platform: 'google_business';
  reviewerName: string;
  starRating: number;
  comment: string;
  createdAt: string;
  reply?: { text: string; postedAt: string; authoredBy: 'automation' | 'human' };
  escalated: boolean;
}

// ---------------------------------------------------------------------------
// Brand voice — the single source of truth the caption model is given.
// ---------------------------------------------------------------------------

export const BRAND_VOICE = {
  company: 'Diversity Roofing',
  tagline: "We Fight for Your Home So You Don't Have To",
  phone: '(904) 979-0556',
  serviceArea:
    'Jacksonville, Orange Park, Middleburg, St. Augustine, Fleming Island, Ponte Vedra, Jacksonville Beach and Nocatee — Duval, Clay and St. Johns County',
  voice: [
    'Plain-spoken and steady. A neighbor who happens to know roofs, not a salesperson.',
    'Concrete over adjectives: name the city, the damage, the timeline.',
    'Never talk down to the homeowner and never manufacture panic about storms.',
  ],
  hardRules: [
    'Diversity Roofing documents damage and meets the adjuster on the roof. It does NOT interpret policy, negotiate, settle, or "handle" claims — never imply otherwise.',
    'Never mention waiving, covering, absorbing, discounting, or rebating a deductible, and never say "free roof" or "no out of pocket".',
    'Never offer gift cards, cash, or any other incentive in exchange for an inspection or a claim.',
    'Never guarantee that a claim will be approved or paid.',
    'Do not state or imply a specific claim deadline unless it is the Fla. Stat. 627.70132 deadline (1 year to file, 18 months for a supplement, both from date of loss).',
  ],
} as const;

// ---------------------------------------------------------------------------
// Seed calendar
// ---------------------------------------------------------------------------

function iso(daysFromNow: number, hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

/** Keeps the first seed post due on any fresh boot, whatever the clock says. */
function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

const now = new Date().toISOString();

const store: SocialPost[] = [
  {
    id: 'sp-001',
    theme: 'seasonal_maintenance',
    platforms: ['facebook', 'instagram', 'google_business'],
    scheduledFor: hoursAgo(2),
    status: 'queued',
    brief:
      'Pre-hurricane-season roof check: the four things a homeowner can see from the ground that mean it is worth having someone up on the roof — lifted shingle edges, granules collecting at the downspout, a soft or stained soffit, and daylight in the attic.',
    targetCity: 'Jacksonville',
    media: [{ url: 'https://example.com/media/roof-inspection-jax.jpg', type: 'image' }],
    googleCta: { actionType: 'CALL' },
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'sp-002',
    theme: 'education',
    platforms: ['facebook', 'google_business'],
    scheduledFor: iso(2, 11),
    status: 'queued',
    brief:
      'Explain the Florida claim clock plainly: under Fla. Stat. 627.70132 a homeowner has one year from the date of loss to file, and 18 months for a supplemental claim. Explain what "date of loss" means and why waiting to call is the expensive choice.',
    targetCity: 'Orange Park',
    media: [{ url: 'https://example.com/media/claim-clock.jpg', type: 'image' }],
    googleCta: { actionType: 'LEARN_MORE', url: 'https://diversity-roofing.com/storm-damage' },
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'sp-003',
    theme: 'community',
    platforms: ['facebook', 'instagram'],
    scheduledFor: iso(4, 15),
    status: 'queued',
    brief:
      'Crew spotlight from a tear-off in Middleburg — what a full-day tear-off actually looks like from 6am to dark, and why the cleanup at the end matters as much as the install.',
    targetCity: 'Middleburg',
    media: [
      { url: 'https://example.com/media/crew-middleburg-1.jpg', type: 'image' },
      { url: 'https://example.com/media/crew-middleburg-2.jpg', type: 'image' },
    ],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'sp-004',
    theme: 'storm_response',
    platforms: ['facebook', 'google_business'],
    scheduledFor: iso(6, 8),
    status: 'queued',
    brief:
      'After a wind event: what to photograph before anyone touches the roof, why a tarp is not a repair, and how to reach us for a documented inspection. Calm and practical — no scare copy.',
    targetCity: 'St. Augustine',
    media: [{ url: 'https://example.com/media/storm-response.jpg', type: 'image' }],
    googleCta: { actionType: 'CALL' },
    createdAt: now,
    updatedAt: now,
  },
];

const leads: SocialLead[] = [];
const reviews: ReviewRecord[] = [];

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export function listPosts(filter?: { status?: PostStatus }): SocialPost[] {
  return filter?.status ? store.filter((p) => p.status === filter.status) : [...store];
}

/** Posts whose scheduled slot has arrived and that are still waiting to go out. */
export function duePosts(limit = 5, at: Date = new Date()): SocialPost[] {
  return store
    .filter((p) => (p.status === 'queued' || p.status === 'approved') && new Date(p.scheduledFor) <= at)
    .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))
    .slice(0, limit);
}

export function getPost(id: string): SocialPost | undefined {
  return store.find((p) => p.id === id);
}

export function addPost(
  post: Omit<SocialPost, 'id' | 'status' | 'createdAt' | 'updatedAt'> & { id?: string; status?: PostStatus },
): SocialPost {
  const stamp = new Date().toISOString();
  const created: SocialPost = {
    ...post,
    id: post.id ?? `sp-${Date.now().toString(36)}`,
    status: post.status ?? 'queued',
    createdAt: stamp,
    updatedAt: stamp,
  };
  store.push(created);
  return created;
}

export function updatePost(id: string, patch: Partial<SocialPost>): SocialPost | undefined {
  const post = getPost(id);
  if (!post) return undefined;
  Object.assign(post, patch, { updatedAt: new Date().toISOString() });
  return post;
}

export function recordPublishResult(
  id: string,
  platform: SocialPlatform,
  result: PublishResult,
): SocialPost | undefined {
  const post = getPost(id);
  if (!post) return undefined;
  post.results = { ...post.results, [platform]: result };

  const outcomes = post.platforms.map((p) => post.results?.[p]?.status);
  if (outcomes.every((s) => s === 'published')) post.status = 'published';
  else if (outcomes.some((s) => s === 'blocked')) post.status = 'blocked';
  else if (outcomes.every((s) => s !== undefined)) post.status = 'failed';

  post.updatedAt = new Date().toISOString();
  return post;
}

export function addLead(lead: Omit<SocialLead, 'id' | 'handled'>): SocialLead {
  const created: SocialLead = { ...lead, id: `sl-${Date.now().toString(36)}`, handled: false };
  leads.push(created);
  return created;
}

export function listLeads(): SocialLead[] {
  return [...leads];
}

export function upsertReview(review: ReviewRecord): ReviewRecord {
  const index = reviews.findIndex((r) => r.id === review.id);
  if (index >= 0) {
    reviews[index] = { ...reviews[index], ...review };
    return reviews[index];
  }
  reviews.push(review);
  return review;
}

export function listReviews(): ReviewRecord[] {
  return [...reviews];
}
