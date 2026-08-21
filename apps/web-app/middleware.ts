import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// CSP URLs are hardcoded here because Next.js middleware runs at the edge
// before any NEXT_PUBLIC_* env vars are injected — process.env is not available
// in this file. If the worker URL changes, update img-src and connect-src below
// and NEXT_PUBLIC_TRPC_URL in .env.local / wrangler.jsonc vars together.
const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://saved-foxhound-17.clerk.accounts.dev",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: https://event-booking-worker.aditya29.workers.dev https://img.clerk.com",
  "connect-src 'self' https://event-booking-worker.aditya29.workers.dev wss://event-booking-worker.aditya29.workers.dev https://saved-foxhound-17.clerk.accounts.dev",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Define public routes
  const isPublicPath = 
     pathname === '/' || 
  pathname.startsWith('/sign-in') || 
  pathname.startsWith('/sign-up') ||
  pathname.startsWith('/api/') || 
  pathname.startsWith('/trpc/') ||
  pathname.startsWith('/events/') || 
  pathname.startsWith('/booking/');   

  let response: NextResponse;
  if (isPublicPath) {
    response = NextResponse.next();
  } else {
    // Check for Clerk's session cookie
    const sessionCookie = request.cookies.get('__session');

    // If no session cookie on a protected route, redirect to sign-in
    if (!sessionCookie) {
      const signInUrl = new URL('/sign-in', request.url);
      signInUrl.searchParams.set('redirect_url', pathname);
      response = NextResponse.redirect(signInUrl);
    } else {
      response = NextResponse.next();
    }
  }

  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  response.headers.set('Content-Security-Policy', CSP_POLICY);

  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.[\\w]+$).*)',
  ],
};
