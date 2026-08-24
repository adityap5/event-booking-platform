import { verifyToken } from '@clerk/backend';
import { resolveAllowedOrigin, JWT_AUTHORIZED_PARTIES } from '../cors.js';
import type { Env } from '../index.js';
import { logStructured } from '../logger.js';

export async function handleUpload(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);

  // CORS preflight for the event-cover upload endpoint
  if (url.pathname === '/upload/event-cover' && request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': resolveAllowedOrigin(request),
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // Handle event cover image uploads (temp upload — eventId not required at this stage)
  if (url.pathname === '/upload/event-cover' && request.method === 'POST') {
    // Verify auth
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response('Unauthorized', { status: 401 });
    }
    const token = authHeader.slice(7);
    let verifiedToken: Awaited<ReturnType<typeof verifyToken>>;
    try {
      verifiedToken = await verifyToken(token, {
        jwtKey: env.CLERK_JWT_KEY,
        authorizedParties: JWT_AUTHORIZED_PARTIES,
      });
    } catch {
      return new Response('Unauthorized', { status: 401 });
    }
    const userId = verifiedToken.sub;

    // Role check: only org members with the 'organiser' role may upload event covers.
    // The Clerk JWT carries org context in the 'o' claim (o.id = orgId, o.rol = role).
    // An attendee who is authenticated but not an organiser is rejected here — the
    // rate limiter and R2 writes are not reached, so there is no storage cost.
    // 'organiser' matches the role string used in requireOrganiserRole() for createEvent.
    const claims = verifiedToken as unknown as { o?: { id?: string; rol?: string } };
    const orgId = claims.o?.id ?? null;
    const role = claims.o?.rol ?? null;
    if (!orgId || role !== 'organiser') {
      return new Response('Forbidden: only organisers may upload event covers.', { status: 403 });
    }

    // Rate limit: 5 cover image uploads per userId per 60 seconds (tighter limit to protect R2 storage from flood uploads)
    const rateLimiter = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(userId));
    const { allowed } = await rateLimiter.checkLimit('uploadEventCover', 5, 60_000);
    if (!allowed) {
      logStructured({
        category: 'rate_limit_rejection',
        action: 'uploadEventCover',
        userId,
      });
      return new Response('Too many uploads. Please try again shortly.', { status: 429 });
    }

    // Parse multipart form data
    // request.formData() throws on a malformed multipart body — without this, that becomes an uncaught exception instead of a clean 400, since nothing upstream in index.ts catches it either.
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return new Response('Malformed request body', { status: 400 });
    }

    const file = formData.get('file') as File | null;
    if (file === null) {
      return new Response('Missing file', { status: 400 });
    }

    const MAX_SIZE = 5 * 1024 * 1024; // 5MB
    if (file.size > MAX_SIZE) {
      return new Response('File too large. Maximum 5MB', { status: 400 });
    }

    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // Content-type is derived from actual file bytes, never trusted from the client — file.type is a client-declared
    // header we don't control, and previously flowed all the way through to the response Content-Type served back on every /images/* request.
    let detectedType: string | null = null;
    let ext = '';

    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
      detectedType = 'image/jpeg';
      ext = 'jpg';
    } else if (
      bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
      bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A
    ) {
      detectedType = 'image/png';
      ext = 'png';
    } else if (
      bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
      detectedType = 'image/webp';
      ext = 'webp';
    }

    if (!detectedType) {
      return new Response('File content does not match a supported image format', { status: 400 });
    }

    // Temporary R2 key — scoped to the uploading user, never exposes the original filename
    const tempId = crypto.randomUUID();
    const key = `uploads/tmp/${userId}/${tempId}.${ext}`;

    // Upload to R2
    await env.EVENT_COVERS.put(key, buffer, {
      httpMetadata: { contentType: detectedType },
    });

    return new Response(JSON.stringify({ tempImageKey: key }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': resolveAllowedOrigin(request),
      },
    });
  }

  // Serve R2 cover images publicly — no auth required, images are public by design
  if (url.pathname.startsWith('/images/')) {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown-ip';
    const rateLimiter = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(ip));
    const { allowed } = await rateLimiter.checkLimit('publicImageRead', 120, 60_000);
    if (!allowed) {
      logStructured({
        category: 'rate_limit_rejection',
        action: 'publicImageRead',
        keyType: 'ip',
      });
      return new Response('Too many requests. Please try again shortly.', { status: 429 });
    }

    const key = url.pathname.slice('/images/'.length);
    if (!key || !key.startsWith('events/')) {
      return new Response('Not Found', { status: 404 });
    }

    const object = await env.EVENT_COVERS.get(key);
    if (object === null) {
      return new Response('Not Found', { status: 404 });
    }

    const contentType = object.httpMetadata?.contentType ?? 'application/octet-stream';
    return new Response(object.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        // Keys are UUID-based and immutable once written — safe to cache hard
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': resolveAllowedOrigin(request),
      },
    });
  }
  
  return null;
}
