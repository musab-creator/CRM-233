import { NextRequest, NextResponse } from 'next/server';
import { authorizeAutomation } from '@/lib/social/auth';
import { recordPublishResult, updatePost } from '@/lib/social/queue';
import { PLATFORM_LIMITS, type SocialPlatform } from '@/lib/social/compliance';

// n8n reports back here after every publish attempt, success or failure, so the
// CRM is the record of what actually went out rather than the n8n execution log.
export async function POST(request: NextRequest) {
  const unauthorized = authorizeAutomation(request);
  if (unauthorized) return unauthorized;

  try {
    const body = (await request.json()) as {
      postId?: string;
      platform?: string;
      status?: 'published' | 'blocked' | 'failed';
      platformPostId?: string;
      permalink?: string;
      error?: string;
      caption?: string;
    };

    const platform = body.platform as SocialPlatform | undefined;
    if (!body.postId || !platform || !(platform in PLATFORM_LIMITS) || !body.status) {
      return NextResponse.json(
        { error: 'Missing required fields: postId, platform, status' },
        { status: 400 },
      );
    }

    if (body.caption) updatePost(body.postId, { caption: body.caption });

    const post = recordPublishResult(body.postId, platform, {
      status: body.status,
      platformPostId: body.platformPostId,
      permalink: body.permalink,
      error: body.error,
      publishedAt: new Date().toISOString(),
    });

    if (!post) {
      return NextResponse.json({ error: `Unknown post: ${body.postId}` }, { status: 404 });
    }

    return NextResponse.json({ success: true, post });
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}
