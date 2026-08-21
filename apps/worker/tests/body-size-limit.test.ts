import { describe, it, expect, vi } from 'vitest';
import { SELF } from 'cloudflare:test';

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn(async (token: string) => {
      if (token.startsWith('valid-test-token')) {
        const sub = token === 'valid-test-token' ? 'user_upload_test_123' : token.replace('valid-test-token-', 'user_upload_test_');
        // Include org claim so the organiser role check in handleUpload passes
        return { sub, o: { id: 'test-org-1', rol: 'organiser' } };
      }
      throw new Error('Invalid token');
    }),
  };
});

function createByteStream(byteLength: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(byteLength));
      controller.close();
    },
  });
}

describe('100KB Cap on tRPC POST Request Bodies', () => {

  it('1. Under-limit tRPC POST succeeds past the size-check layer', async () => {
    // Body is under 100KB (102400 bytes)
    const smallPayload = JSON.stringify({ json: { id: '123' } });
    const res = await SELF.fetch('https://worker.dev/trpc/events.getById?batch=1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: smallPayload,
    });

    // Should NOT be 413 Payload Too Large
    expect(res.status).not.toBe(413);
  });

  it('2. Content-Length fast-path rejection', async () => {
    // Declared Content-Length > 102400
    const res = await SELF.fetch('https://worker.dev/trpc/events.getById?batch=1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '102401',
      },
      body: JSON.stringify({ json: { id: '123' } }),
    });

    expect(res.status).toBe(413);
    const text = await res.text();
    expect(text).toBe('Request body too large.');
  });

  it('3. Streaming enforcement, no Content-Length — genuinely end-to-end', async () => {
    // Create a body > 102400 bytes streamed via ReadableStream without Content-Length
    const chunkSize = 32768; // 32KB per chunk
    const totalChunks = 4; // 128KB total > 102400 bytes

    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < totalChunks; i++) {
          controller.enqueue(new Uint8Array(chunkSize));
        }
        controller.close();
      },
    });

    const res = await SELF.fetch('https://worker.dev/trpc/events.getById?batch=1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: stream,
      // @ts-expect-error duplex is required by node/workerd fetch when body is ReadableStream
      duplex: 'half',
    });

    expect(res.status).toBe(413);
    const text = await res.text();
    expect(text).toBe('Request body too large.');
  });

  it('4. Exact boundary test via streaming loop (102400 bytes allowed, 102401 bytes rejected)', async () => {
    // 102400 bytes via ReadableStream (no Content-Length header) -> goes through streaming reader loop
    const stream102400 = createByteStream(102400);
    const res102400 = await SELF.fetch('https://worker.dev/trpc/events.getById?batch=1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: stream102400,
      // @ts-expect-error duplex required for streaming body in fetch
      duplex: 'half',
    });
    expect(res102400.status).not.toBe(413);

    // 102401 bytes via ReadableStream (no Content-Length header) -> rejected by streaming reader loop
    const stream102401 = createByteStream(102401);
    const res102401 = await SELF.fetch('https://worker.dev/trpc/events.getById?batch=1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: stream102401,
      // @ts-expect-error duplex required for streaming body in fetch
      duplex: 'half',
    });
    expect(res102401.status).toBe(413);
    const text102401 = await res102401.text();
    expect(text102401).toBe('Request body too large.');
  });

  it('5. Content-Length fast-path boundary test (explicit Content-Length: 102401)', async () => {
    const res = await SELF.fetch('https://worker.dev/trpc/events.getById?batch=1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '102401',
      },
      body: JSON.stringify({ json: { id: '123' } }),
    });

    expect(res.status).toBe(413);
    const text = await res.text();
    expect(text).toBe('Request body too large.');
  });

  it('6. Upload exemption still works', async () => {
    // Upload endpoint (/upload/event-cover) must bypass body size check
    const validJpegBytes = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
    const file = new File([validJpegBytes], 'photo.jpg', { type: 'image/jpeg' });
    const formData = new FormData();
    formData.append('file', file);

    const res = await SELF.fetch('https://worker.dev/upload/event-cover', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer valid-test-token-size-exemption',
      },
      body: formData,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { tempImageKey: string };
    expect(json.tempImageKey).toBeDefined();
  });
});
