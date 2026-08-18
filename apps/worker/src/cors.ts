// Kept as separate constants despite being identical today so that if a dev origin
// is ever reintroduced for CORS testing, it doesn't silently also become a trusted
// JWT audience by sharing the same constant.
export const CORS_ALLOWED_ORIGINS = [
  'https://event-booking-web.aditya29.workers.dev',
];

export const JWT_AUTHORIZED_PARTIES = [
  'https://event-booking-web.aditya29.workers.dev',
];

export function resolveAllowedOrigin(request: Request): string {
  const origin = request.headers.get('Origin');
  if (origin && CORS_ALLOWED_ORIGINS.includes(origin)) {
    return origin;
  }
  return CORS_ALLOWED_ORIGINS[0] as string;
}

export function applyWorkerSecurityHeaders(response: Response): Response {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  response.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  return response;
}
