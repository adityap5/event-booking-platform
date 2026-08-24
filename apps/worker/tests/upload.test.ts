import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import { handleUpload } from '../src/handlers/upload.js';

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn(async (token: string) => {
      if (token.startsWith('valid-test-token')) {
        const sub = token === 'valid-test-token' ? 'user_upload_test_123' : token.replace('valid-test-token-', 'user_upload_test_');
        // Return org claim so the organiser role check passes for all valid organiser tokens
        return { sub, o: { id: 'test-org-1', rol: 'organiser' } };
      }
      if (token === 'valid-attendee-token') {
        // Authenticated attendee — no org membership in JWT; should be rejected by role check
        return { sub: 'user_attendee_123' };
      }
      throw new Error('Invalid token');
    }),
  };
});

describe('handleUpload HTTP handler magic byte inspection & rate limiting', () => {
  const workerEnv = env as unknown as Env;

  const validJpegBytes = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const validPngBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
  const validWebpBytes = Buffer.from([
    0x52, 0x49, 0x46, 0x46, // "RIFF"
    0x1C, 0x00, 0x00, 0x00, // 4-byte size field
    0x57, 0x45, 0x42, 0x50, // "WEBP"
  ]);

  async function createUploadRequest(
    fileBuffer: Uint8Array,
    fileName: string,
    claimedContentType: string,
    token = 'valid-test-token'
  ): Promise<Request> {
    const file = new File([fileBuffer], fileName, { type: claimedContentType });
    const formData = new FormData();
    formData.append('file', file);

    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    return new Request('https://worker.dev/upload/event-cover', {
      method: 'POST',
      headers,
      body: formData,
    });
  }

  it('rejects upload with 400 when file.type is image/jpeg but actual bytes are non-image plain text', async () => {
    const textBytes = Buffer.from('this is plain text pretending to be a jpeg image');
    const req = await createUploadRequest(textBytes, 'fake.jpg', 'image/jpeg', 'valid-test-token-text');

    const res = await handleUpload(req, workerEnv);

    expect(res?.status).toBe(400);
    const body = await res?.text();
    expect(body).toBe('File content does not match a supported image format');
  });

  it('accepts upload with correct JPEG magic bytes and image/jpeg file.type, storing image/jpeg in R2', async () => {
    const req = await createUploadRequest(validJpegBytes, 'photo.jpg', 'image/jpeg', 'valid-test-token-jpeg');

    const res = await handleUpload(req, workerEnv);

    expect(res?.status).toBe(200);
    const json = (await res?.json()) as { tempImageKey: string };
    expect(json.tempImageKey).toMatch(/^uploads\/tmp\/user_upload_test_jpeg\/[a-f0-9-]+\.jpg$/);

    const storedObject = await workerEnv.EVENT_COVERS.get(json.tempImageKey);
    expect(storedObject).not.toBeNull();
    expect(storedObject?.httpMetadata?.contentType).toBe('image/jpeg');
  });

  it('stores derived type (image/jpeg) in R2 even when client claims wrong file.type (image/png)', async () => {
    const req = await createUploadRequest(validJpegBytes, 'photo.png', 'image/png', 'valid-test-token-wrongtype');

    const res = await handleUpload(req, workerEnv);

    expect(res?.status).toBe(200);
    const json = (await res?.json()) as { tempImageKey: string };

    expect(json.tempImageKey).toMatch(/^uploads\/tmp\/user_upload_test_wrongtype\/[a-f0-9-]+\.jpg$/);

    const storedObject = await workerEnv.EVENT_COVERS.get(json.tempImageKey);
    expect(storedObject).not.toBeNull();
    expect(storedObject?.httpMetadata?.contentType).toBe('image/jpeg');
  });

  it('accepts valid PNG bytes and stores image/png in R2', async () => {
    const req = await createUploadRequest(validPngBytes, 'graphic.png', 'image/png', 'valid-test-token-png');

    const res = await handleUpload(req, workerEnv);

    expect(res?.status).toBe(200);
    const json = (await res?.json()) as { tempImageKey: string };
    expect(json.tempImageKey).toMatch(/^uploads\/tmp\/user_upload_test_png\/[a-f0-9-]+\.png$/);

    const storedObject = await workerEnv.EVENT_COVERS.get(json.tempImageKey);
    expect(storedObject?.httpMetadata?.contentType).toBe('image/png');
  });

  it('accepts valid WebP bytes and stores image/webp in R2', async () => {
    const req = await createUploadRequest(validWebpBytes, 'graphic.webp', 'image/webp', 'valid-test-token-webp');

    const res = await handleUpload(req, workerEnv);

    expect(res?.status).toBe(200);
    const json = (await res?.json()) as { tempImageKey: string };
    expect(json.tempImageKey).toMatch(/^uploads\/tmp\/user_upload_test_webp\/[a-f0-9-]+\.webp$/);

    const storedObject = await workerEnv.EVENT_COVERS.get(json.tempImageKey);
    expect(storedObject?.httpMetadata?.contentType).toBe('image/webp');
  });

  it('rate limiting: allows 5 uploads per 60s window for a user, then rejects 6th with 429', async () => {
    const rateLimitToken = 'valid-test-token-ratelimit';

    for (let i = 0; i < 5; i++) {
      const req = await createUploadRequest(validJpegBytes, `photo_${i}.jpg`, 'image/jpeg', rateLimitToken);
      const res = await handleUpload(req, workerEnv);
      expect(res?.status).toBe(200);
    }

    const req6 = await createUploadRequest(validJpegBytes, 'photo_6.jpg', 'image/jpeg', rateLimitToken);
    const res6 = await handleUpload(req6, workerEnv);

    expect(res6?.status).toBe(429);
    const body6 = await res6?.text();
    expect(body6).toBe('Too many uploads. Please try again shortly.');
  });

  it('returns 400 Malformed request body when multipart form data parsing fails', async () => {
    const malformedReq = new Request('https://worker.dev/upload/event-cover', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer valid-test-token-malformed',
        'Content-Type': 'multipart/form-data; boundary=---------------------------974767299852498929531610575',
      },
      body: 'this is not valid multipart payload -- missing boundaries and headers',
    });

    const res = await handleUpload(malformedReq, workerEnv);

    expect(res?.status).toBe(400);
    const body = await res?.text();
    expect(body).toBe('Malformed request body');
  });

  it('role check: authenticated attendee (no org claim in JWT) is rejected with 403 before rate limiter or R2', async () => {
    // 'valid-attendee-token' resolves to a user with no 'o' claim — authenticated but not an organiser
    const req = await createUploadRequest(
      Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), // valid JPEG magic bytes
      'photo.jpg',
      'image/jpeg',
      'valid-attendee-token'
    );

    const res = await handleUpload(req, workerEnv);

    expect(res?.status).toBe(403);
    const body = await res?.text();
    expect(body).toContain('only organisers may upload');
  });
});

describe('GET /images/* R2 key namespace access boundary', () => {
  const workerEnv = env as unknown as Env;
  const sampleJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);

  it('1. temporary upload object in uploads/tmp/ is NOT publicly accessible through /images/ (returns 404)', async () => {
    const tempKey = 'uploads/tmp/test-user/test-temp-id.jpg';
    await workerEnv.EVENT_COVERS.put(tempKey, sampleJpeg, {
      httpMetadata: { contentType: 'image/jpeg' },
    });

    const req = new Request(`https://worker.dev/images/${tempKey}`, {
      method: 'GET',
    });
    const res = await handleUpload(req, workerEnv);

    expect(res?.status).toBe(404);
    const body = await res?.text();
    expect(body).toBe('Not Found');
  });

  it('2. finalized event cover in events/ remains publicly accessible through /images/ (returns 200 and Content-Type)', async () => {
    const eventKey = 'events/test-event/cover.jpg';
    await workerEnv.EVENT_COVERS.put(eventKey, sampleJpeg, {
      httpMetadata: { contentType: 'image/jpeg' },
    });

    const req = new Request(`https://worker.dev/images/${eventKey}`, {
      method: 'GET',
    });
    const res = await handleUpload(req, workerEnv);

    expect(res?.status).toBe(200);
    expect(res?.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res?.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    const bytes = new Uint8Array(await res!.arrayBuffer());
    expect(bytes).toEqual(new Uint8Array(sampleJpeg));
  });

  it('3. arbitrary non-event R2 keys are rejected with 404 before fetching', async () => {
    const randomKey = 'random/file.jpg';
    await workerEnv.EVENT_COVERS.put(randomKey, sampleJpeg, {
      httpMetadata: { contentType: 'image/jpeg' },
    });

    const req = new Request(`https://worker.dev/images/${randomKey}`, {
      method: 'GET',
    });
    const res = await handleUpload(req, workerEnv);

    expect(res?.status).toBe(404);
    const body = await res?.text();
    expect(body).toBe('Not Found');
  });

  it('4. empty key or root /images/ request returns 404', async () => {
    const req = new Request('https://worker.dev/images/', {
      method: 'GET',
    });
    const res = await handleUpload(req, workerEnv);

    expect(res?.status).toBe(404);
    const body = await res?.text();
    expect(body).toBe('Not Found');
  });
});

