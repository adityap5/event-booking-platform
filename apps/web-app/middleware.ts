import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

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
  if (isPublicPath) {
    return NextResponse.next();
  }

  // Check for Clerk's session cookie
  const sessionCookie = request.cookies.get('__session');

  // If no session cookie on a protected route, redirect to sign-in
  if (!sessionCookie) {
    const signInUrl = new URL('/sign-in', request.url);
    signInUrl.searchParams.set('redirect_url', pathname);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.[\\w]+$).*)',
  ],
};
