import { NextRequest, NextResponse } from 'next/server';
import { authorizeAutomation } from '@/lib/social/auth';
import { addLead, listLeads } from '@/lib/social/queue';
import { PLATFORM_LIMITS, type SocialPlatform } from '@/lib/social/compliance';

// Inbound comments and DMs that the lead-capture workflow judged to be a real
// enquiry. These land in a social-specific inbox rather than the main lead
// pipeline — the pipeline lives in the Zustand store on the client, so wiring
// these through needs the database the CRM does not have yet.
export async function GET(request: NextRequest) {
  const unauthorized = authorizeAutomation(request);
  if (unauthorized) return unauthorized;
  const leads = listLeads();
  return NextResponse.json({ count: leads.length, leads });
}

export async function POST(request: NextRequest) {
  const unauthorized = authorizeAutomation(request);
  if (unauthorized) return unauthorized;

  try {
    const body = (await request.json()) as {
      platform?: string;
      kind?: 'comment' | 'direct_message' | 'review';
      authorName?: string;
      authorHandle?: string;
      message?: string;
      permalink?: string;
    };

    const platform = body.platform as SocialPlatform | undefined;
    if (!platform || !(platform in PLATFORM_LIMITS) || !body.message) {
      return NextResponse.json(
        { error: 'Missing required fields: platform, message' },
        { status: 400 },
      );
    }

    const lead = addLead({
      platform,
      kind: body.kind ?? 'comment',
      authorName: body.authorName ?? 'Unknown',
      authorHandle: body.authorHandle,
      message: body.message,
      permalink: body.permalink,
      receivedAt: new Date().toISOString(),
    });

    return NextResponse.json({ success: true, lead, suggestedLeadSource: 'social_media' }, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}
