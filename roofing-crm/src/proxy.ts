import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Optional password gate for public deployments.
 *
 * Set SITE_PASSWORD in the Vercel project's environment variables and the whole
 * site sits behind a browser login prompt (any username, that password). Leave
 * it unset — as it is locally and in CI — and this is a no-op.
 *
 * This exists because the CRM has no user login of its own: putting it on a
 * public domain without a gate means anyone with the URL can read it.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function proxy(request: NextRequest) {
  const password = process.env.SITE_PASSWORD;
  if (!password) return NextResponse.next();

  const header = request.headers.get('authorization');
  if (header?.startsWith('Basic ')) {
    try {
      const decoded = atob(header.slice('Basic '.length));
      const separator = decoded.indexOf(':');
      const supplied = separator === -1 ? '' : decoded.slice(separator + 1);
      if (safeEqual(supplied, password)) return NextResponse.next();
    } catch {
      // Malformed credentials fall through to the challenge below.
    }
  }

  return new NextResponse('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Diversity Roofing", charset="UTF-8"',
    },
  });
}

export const config = {
  // Everything except Next's static assets and the favicon.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
