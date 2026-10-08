import { NextRequest, NextResponse } from 'next/server';
import { authorizeAutomation } from '@/lib/social/auth';
import {
  checkCompliance,
  complianceConfigFromEnv,
  PLATFORM_LIMITS,
  type SocialPlatform,
} from '@/lib/social/compliance';
import { updatePost } from '@/lib/social/queue';

// The gate every caption passes through before it reaches a platform API.
//
// This deliberately fails closed: if the request is malformed the answer is
// "blocked", not "pass". The n8n workflows treat any non-200 here as a block
// too, so a CRM outage stops publishing rather than bypassing the check.
export async function POST(request: NextRequest) {
  const unauthorized = authorizeAutomation(request);
  if (unauthorized) return unauthorized;

  try {
    const body = (await request.json()) as {
      caption?: string;
      platform?: string;
      hasImage?: boolean;
      postId?: string;
    };

    const platform = body.platform as SocialPlatform | undefined;
    if (!platform || !(platform in PLATFORM_LIMITS)) {
      return NextResponse.json(
        {
          status: 'blocked',
          findings: [
            {
              code: 'BAD_REQUEST',
              severity: 'blocker',
              message: `platform must be one of: ${Object.keys(PLATFORM_LIMITS).join(', ')}`,
            },
          ],
        },
        { status: 400 },
      );
    }

    const result = checkCompliance(
      { caption: body.caption ?? '', platform, hasImage: body.hasImage },
      complianceConfigFromEnv(),
    );

    // Record the outcome against the post so the CRM shows why something is held.
    if (body.postId && result.status !== 'pass') {
      updatePost(body.postId, {
        status: result.status === 'blocked' ? 'blocked' : 'needs_review',
        complianceNotes: result.findings
          .filter((f) => f.severity !== 'warning')
          .map((f) => `[${platform}] ${f.code}: ${f.message}`),
      });
    }

    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      {
        status: 'blocked',
        findings: [
          { code: 'BAD_REQUEST', severity: 'blocker', message: 'Invalid request body.' },
        ],
      },
      { status: 400 },
    );
  }
}
