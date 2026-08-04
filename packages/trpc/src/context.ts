import { verifyToken } from '@clerk/backend';
import { TRPCError } from '@trpc/server';
import type { FetchCreateContextFnOptions } from '@trpc/server/adapters/fetch';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '@event-booking/shared';

interface CreateContextOptions extends FetchCreateContextFnOptions {
  /**
   * The Clerk JWT Key (Public Key). 
   * Provides networkless verification to avoid per-request latency.
   * Obtain this from the Clerk Dashboard: API Keys -> Advanced -> JWT public key.
   */
  clerkJwtKey: string;
  /**
   * Allowed domains/origins for the issuing party (azp claim).
   * Prevents CSRF-style replay attacks where a token from another application is used here.
   */
  authorizedParties: string[];
  db: DrizzleD1Database<typeof schema>;
}

export async function createContext(opts: CreateContextOptions) {
  const { req, clerkJwtKey, authorizedParties, db } = opts;
  
  // 1. Read the Authorization header from the incoming request
  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Missing or malformed Authorization header',
    });
  }

  const token = authHeader.replace('Bearer ', '');
  if (!token) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Missing token in Authorization header',
    });
  }

  try {
    // 2. Verify the JWT against Clerk's JWKS using @clerk/backend
    // Networkless verification using the provided jwtKey (Public Key).
    // In Edge/Worker environments, it uses Web Crypto API internally.
    const verifiedClaims = await verifyToken(token, {
      jwtKey: clerkJwtKey,
      authorizedParties,
    });

    // Define the expected shape of the Clerk v2 token claims for organizations
    type V2Claims = {
      sub: string;
      o?: {
        id: string;
        rol: string;
        slg: string;
      };
    };

    const claims = verifiedClaims as unknown as V2Claims;

    // 3. Return verified claims: userId, orgId, role
    return {
      userId: claims.sub,
      // In Clerk's v2 session token format, organization data is nested under the 'o' object.
      // If the user has no active organization, the 'o' claim is completely omitted.
      orgId: claims.o?.id,
      role: claims.o?.rol,
      db,
    };
  } catch (error) {
    // Log the actual error internally for debugging
    console.error('Token verification failed:', error);

    // 4. Throw a generic tRPC UNAUTHORIZED error to prevent leaking internal error details
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Invalid or expired token',
    });
  }
}

export type Context = Awaited<ReturnType<typeof createContext>>;
