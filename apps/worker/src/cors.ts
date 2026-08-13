export const ALLOWED_ORIGINS = [
  'https://event-booking-web.aditya29.workers.dev',
  'http://localhost:3000',
  'http://172.18.225.133:3000'
];

export function resolveAllowedOrigin(request: Request): string {
  const origin = request.headers.get('Origin');
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return origin;
  }
  return ALLOWED_ORIGINS[0] as string;
}
