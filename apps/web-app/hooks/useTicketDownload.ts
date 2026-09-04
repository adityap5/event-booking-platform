import { useState, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import { createAuthenticatedTRPCClient } from '../lib/trpc';

export type DownloadStatus = 'idle' | 'loading' | 'error';

export function useTicketDownload() {
  const { getToken } = useAuth();
  const [downloadState, setDownloadState] = useState<Record<string, DownloadStatus>>({});

  const handleDownloadTicket = useCallback(async (bookingId: string) => {
    setDownloadState(prev => ({ ...prev, [bookingId]: 'loading' }));
    try {
      const trpc = createAuthenticatedTRPCClient(getToken);
      const result = await trpc.getTicket.query({ bookingId });
      // Decode base64 PDF and trigger browser download
      const binary = atob(result.pdf);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setDownloadState(prev => ({ ...prev, [bookingId]: 'idle' }));
    } catch {
      setDownloadState(prev => ({ ...prev, [bookingId]: 'error' }));
    }
  // getToken is a stable Clerk reference
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { downloadState, handleDownloadTicket };
}
