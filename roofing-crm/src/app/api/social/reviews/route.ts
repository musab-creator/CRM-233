import { NextRequest, NextResponse } from 'next/server';
import { authorizeAutomation } from '@/lib/social/auth';
import { listReviews, upsertReview } from '@/lib/social/queue';

// Google Business Profile reviews mirrored into the CRM by the review workflow,
// plus whatever reply was posted. Reviews at or below the escalation threshold
// arrive with `escalated: true` and no reply — a human owns those.
export async function GET(request: NextRequest) {
  const unauthorized = authorizeAutomation(request);
  if (unauthorized) return unauthorized;
  const reviews = listReviews();
  return NextResponse.json({
    count: reviews.length,
    escalated: reviews.filter((r) => r.escalated).length,
    reviews,
  });
}

export async function POST(request: NextRequest) {
  const unauthorized = authorizeAutomation(request);
  if (unauthorized) return unauthorized;

  try {
    const body = (await request.json()) as {
      id?: string;
      reviewerName?: string;
      starRating?: number;
      comment?: string;
      createdAt?: string;
      replyText?: string;
      authoredBy?: 'automation' | 'human';
      escalated?: boolean;
    };

    if (!body.id || typeof body.starRating !== 'number') {
      return NextResponse.json(
        { error: 'Missing required fields: id, starRating' },
        { status: 400 },
      );
    }

    const review = upsertReview({
      id: body.id,
      platform: 'google_business',
      reviewerName: body.reviewerName ?? 'Google user',
      starRating: body.starRating,
      comment: body.comment ?? '',
      createdAt: body.createdAt ?? new Date().toISOString(),
      escalated: body.escalated ?? body.starRating <= 3,
      reply: body.replyText
        ? {
            text: body.replyText,
            postedAt: new Date().toISOString(),
            authoredBy: body.authoredBy ?? 'automation',
          }
        : undefined,
    });

    return NextResponse.json({ success: true, review }, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}
