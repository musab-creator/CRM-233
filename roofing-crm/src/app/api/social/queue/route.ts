import { NextRequest, NextResponse } from 'next/server';
import { authorizeAutomation, automationWarnings } from '@/lib/social/auth';
import { buildCaptionPrompt } from '@/lib/social/prompt';
import { addPost, duePosts, listPosts, updatePost, type SocialPost } from '@/lib/social/queue';
import type { SocialPlatform } from '@/lib/social/compliance';

// The publishing workflow polls this on its schedule. Each due post is expanded
// into one job per target platform, with the caption prompt already built, so
// the workflow can fan out without knowing anything about brand voice.
export async function GET(request: NextRequest) {
  const unauthorized = authorizeAutomation(request);
  if (unauthorized) return unauthorized;

  const params = request.nextUrl.searchParams;
  const limit = Math.min(Number(params.get('limit') ?? 5) || 5, 25);
  const claim = params.get('claim') === 'true';

  const posts = params.get('all') === 'true' ? listPosts() : duePosts(limit);

  const jobs = posts.flatMap((post) =>
    post.platforms.map((platform: SocialPlatform) => {
      const prompt = buildCaptionPrompt(post, platform);
      return {
        postId: post.id,
        platform,
        theme: post.theme,
        targetCity: post.targetCity,
        scheduledFor: post.scheduledFor,
        media: post.media,
        googleCta: post.googleCta,
        // A caption already written by a human short-circuits generation.
        existingCaption: post.caption ?? null,
        prompt,
      };
    }),
  );

  // Mark them in flight so a second poll does not double-publish.
  if (claim) {
    for (const post of posts) updatePost(post.id, { status: 'generating' });
  }

  return NextResponse.json({
    count: jobs.length,
    posts: posts.length,
    jobs,
    warnings: automationWarnings(),
  });
}

// Enqueue a post — used by the CRM UI and by the job-completion workflow.
export async function POST(request: NextRequest) {
  const unauthorized = authorizeAutomation(request);
  if (unauthorized) return unauthorized;

  try {
    const body = (await request.json()) as Partial<SocialPost>;

    if (!body.brief || !Array.isArray(body.platforms) || body.platforms.length === 0) {
      return NextResponse.json(
        { error: 'Missing required fields: brief, platforms' },
        { status: 400 },
      );
    }

    const post = addPost({
      theme: body.theme ?? 'job_showcase',
      platforms: body.platforms,
      scheduledFor: body.scheduledFor ?? new Date().toISOString(),
      brief: body.brief,
      targetCity: body.targetCity ?? 'Jacksonville',
      media: body.media ?? [],
      googleCta: body.googleCta,
      caption: body.caption,
      jobId: body.jobId,
      status: body.status,
    });

    return NextResponse.json({ success: true, post }, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}
