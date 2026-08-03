import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

// Routes that require authentication + an active organization
const isProtectedRoute = createRouteMatcher([
  '/dashboard(.*)',
  '/events(.*)',
  '/bookings(.*)',
]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    const { userId, orgId, redirectToSignIn } = await auth();

    // Must be signed in
    if (!userId) {
      return redirectToSignIn();
    }

    // Must have an active organization
    if (!orgId) {
      // Redirect to org selection — Clerk's <OrganizationSwitcher /> will
      // let users create or pick an org. Adjust this URL to wherever you
      // want org-less users to land.
      return NextResponse.redirect(new URL('/select-org', req.url));
    }
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
};
