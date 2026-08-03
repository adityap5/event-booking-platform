import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { useAuth } from '@clerk/nextjs';

/**
 * Creates a tRPC client that attaches Clerk's session JWT as a
 * Bearer token on every request.
 *
 * Usage in a React component:
 *
 * ```tsx
 * import { useAuth } from '@clerk/nextjs';
 * import { createAuthenticatedTRPCClient } from '@/lib/trpc';
 *
 * function MyComponent() {
 *   const { getToken } = useAuth();
 *   const trpc = createAuthenticatedTRPCClient(getToken);
 *
 *   // trpc.someRouter.someQuery.query()
 * }
 * ```
 *
 * The JWT automatically includes the user's active `orgId`, `orgRole`,
 * and `orgSlug` in its claims when an organization is selected.
 *
 * `getToken()` returns a short-lived JWT that auto-refreshes via
 * Clerk's session management — no manual refresh logic needed.
 */
import type { AppRouter } from '@event-booking/worker/src/router';

export function createAuthenticatedTRPCClient(
  getToken: ReturnType<typeof useAuth>['getToken']
) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: process.env.NEXT_PUBLIC_TRPC_URL!,
        async headers() {
          const token = await getToken();
          return {
            Authorization: token ? `Bearer ${token}` : '',
          };
        },
      }),
    ],
  });
}
