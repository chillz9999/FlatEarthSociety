'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { WagmiProvider } from 'wagmi';
import { useLiveUpdates } from '@/lib/queries';
import { SessionProvider } from '@/lib/session';
import { wagmiConfig } from '@/lib/wagmi';

function Live() {
  useLiveUpdates();
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } }));
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={client}>
        <SessionProvider>
          <Live />
          {children}
        </SessionProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
