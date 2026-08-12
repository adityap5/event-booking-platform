import { verifyToken } from '@clerk/backend';
import { resolveAllowedOrigin, ALLOWED_ORIGINS } from '../cors.js';
import type { Env } from '../index.js';

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
        authorizedParties: ALLOWED_ORIGINS,
      });
    } catch {
      return new Response('Unauthorized', { status: 401 });
    }
    const userId = verifiedToken.sub;

    // Parse multipart form data
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (file === null) {
      return new Response('Missing file', { status: 400 });
    }

    // Server-side file validation — check the Content-Type of the file part
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      return new Response('Invalid file type. Allowed: jpeg, png, webp', { status: 400 });
    }
    const MAX_SIZE = 5 * 1024 * 1024; // 5MB
    if (file.size > MAX_SIZE) {
      return new Response('File too large. Maximum 5MB', { status: 400 });
    }

    // Temporary R2 key — scoped to the uploading user, never exposes the original filename
    const ext = file.type === 'image/jpeg' ? 'jpg'
              : file.type === 'image/png'  ? 'png'
              : 'webp';
    const tempId = crypto.randomUUID();
    const key = `uploads/tmp/${userId}/${tempId}.${ext}`;

    // Upload to R2
    const buffer = await file.arrayBuffer();
    await env.EVENT_COVERS.put(key, buffer, {
      httpMetadata: { contentType: file.type },
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
    const key = url.pathname.slice('/images/'.length);
    if (!key) {
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
