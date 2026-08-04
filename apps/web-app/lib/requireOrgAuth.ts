import { getAuth } from '@clerk/nextjs/server';
import {
  GetServerSideProps,
  GetServerSidePropsContext,
  GetServerSidePropsResult,
} from 'next';

/**
 * Extended context that guarantees `userId` and `orgId` are present.
 */
export type AuthenticatedOrgContext = GetServerSidePropsContext & {
  userId: string;
  orgId: string;
};

/**
 * Higher-Order Function for `getServerSideProps` to enforce both user authentication
 * and organization membership.
 *
 * - If not signed in -> Redirects to sign-in page.
 * - If signed in but no active org -> Redirects to dashboard.
 * - Otherwise -> Executes `innerGssp` (if provided) and automatically injects `userId` and `orgId` into page props.
 *
 * @param innerGssp Optional inner `getServerSideProps` logic.
 */
export function requireOrgAuth<P extends { [key: string]: any } = { [key: string]: any }>(
  innerGssp?: (ctx: AuthenticatedOrgContext) => Promise<GetServerSidePropsResult<P>>
): GetServerSideProps<P & { userId: string; orgId: string }> {
  return async (ctx) => {
    const { userId, orgId } = getAuth(ctx.req);

    // 1. Check if user is authenticated
    if (!userId) {
      return {
        redirect: {
          destination: '/sign-in?redirect_url=' + encodeURIComponent(ctx.resolvedUrl),
          permanent: false,
        },
      };
    }

    // 2. Check if user has an active organization
    if (!orgId) {
      return {
        redirect: {
          destination: '/dashboard',
          permanent: false,
        },
      };
    }

    const authContext: AuthenticatedOrgContext = { ...ctx, userId, orgId };

    // 3. Execute inner getServerSideProps if provided
    if (innerGssp) {
      const result = await innerGssp(authContext);

      // If the inner function returns props, we inject userId and orgId into them
      if ('props' in result) {
        // Handle Promise-based props or synchronous props
        const props = await result.props;
        return {
          ...result,
          props: {
            ...props,
            userId,
            orgId,
          } as P & { userId: string; orgId: string },
        };
      }

      // Pass through redirects or notFound untouched
      return result as GetServerSidePropsResult<P & { userId: string; orgId: string }>;
    }

    // 4. Default return if no inner function was provided
    return {
      props: {
        userId,
        orgId,
      } as unknown as P & { userId: string; orgId: string },
    };
  };
}
