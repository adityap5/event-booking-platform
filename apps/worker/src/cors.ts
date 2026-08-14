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
