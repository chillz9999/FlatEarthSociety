'use client';

import type { ReactNode } from 'react';
import { useAccount } from 'wagmi';
import { JoinForm } from '@/components/site/JoinForm';
import { useConfig, usePlayer } from '@/lib/queries';
import { useSession } from '@/lib/session';

export function Notice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div>
      <div className="font-display text-xl text-gold-2">{title}</div>
      {children && <div className="mt-2 font-serif text-lg text-parchment-2">{children}</div>}
    </div>
  );
}

/**
 * A named explorer: a name, a connected wallet, and a free signature that proves it. `gate` is what still
 * stands in the way (the name form, which connects the wallet and asks for the signature); `offline`
 * means the Society's server cannot be reached at all.
 */
export function useExplorer(mode: 'practice' | 'ranked' = 'practice'): { gate: ReactNode | null; offline: boolean; address: `0x${string}` | null; name: string | null } {
  const { address } = useAccount();
  const session = useSession();
  const cfg = useConfig();
  const signedIn = !!session.address && !!address && session.address.toLowerCase() === address.toLowerCase();
  const player = usePlayer(signedIn ? session.address : null);
  const name = player.data?.displayName ?? null;
  const offline = cfg.isError;

  let gate: ReactNode = null;
  if (offline) {
    gate = (
      <Notice title="Can’t reach the Society">
        The game server isn’t answering. Check your connection, then try again.
        <div className="mt-4">
          <button type="button" className="btn btn-ghost" onClick={() => void cfg.refetch()} disabled={cfg.isFetching}>
            {cfg.isFetching ? 'Trying…' : 'Try again'}
          </button>
        </div>
      </Notice>
    );
  } else if (signedIn && player.isPending) {
    gate = <Notice title="Loading your name…" />;
  } else if (!signedIn || !name) {
    gate = (
      <Notice title="Add your name">
        {mode === 'practice' ? 'Your scores go on the leaderboard under it.' : 'Competitive scores are posted under it, and prizes paid to its wallet.'}
        <div className="mx-auto mt-4 max-w-sm">
          <JoinForm submitLabel="Continue" />
        </div>
      </Notice>
    );
  }
  return { gate, offline, address: signedIn ? session.address : null, name };
}
