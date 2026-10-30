'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { CHAIN } from '@/lib/env';
import { shortAddress } from '@/lib/format';
import { usePlayer } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { ExplorerNameForm } from './ExplorerNameForm';
import { ErrorNote, WalletList } from './WalletList';

export function ConnectWallet({ compact = false }: { compact?: boolean }) {
  const { address, isConnected, chainId } = useAccount();
  const { isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const session = useSession();
  const { data: me } = usePlayer(session.address);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);
  // The wallet list stays open (showing any error) until the wallet actually connects.
  useEffect(() => {
    if (isConnected) setOpen(false);
  }, [isConnected]);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []);

  if (!mounted) return <button className="btn btn-ghost" disabled>Connect wallet</button>;

  const wrongChain = isConnected && chainId !== CHAIN.id;

  return (
    <div className="relative" ref={ref}>
      {!isConnected ? (
        <button type="button" className={`btn ${compact ? 'btn-ghost' : 'btn-gold'}`} onClick={() => setOpen((o) => !o)} disabled={isPending}>
          {isPending ? 'Check your wallet…' : 'Connect wallet'}
        </button>
      ) : wrongChain ? (
        <button type="button" className="btn btn-gold" onClick={() => switchChain({ chainId: CHAIN.id })} disabled={switching}>
          {switching ? 'Switching…' : `Switch to ${CHAIN.name}`}
        </button>
      ) : (
        <button type="button" className="btn btn-ghost num normal-case! tracking-normal!" onClick={() => setOpen((o) => !o)}>
          <span className={`inline-block h-2 w-2 rounded-full ${session.address ? 'bg-verdigris' : 'bg-gold'}`} />
          {(session.address && me?.displayName) || shortAddress(address)}
        </button>
      )}

      {open && (
        <div className="plaque absolute right-0 z-50 mt-3 w-72 p-4 fade-up">
          {!isConnected ? (
            <>
              <div className="label mb-3">Choose a wallet</div>
              <WalletList />
            </>
          ) : (
            <>
              <div className="label">Signed in as</div>
              <div className="num mt-1 text-sm break-all text-parchment">{address}</div>
              <div className="rule my-3" />
              {session.address ? (
                <ExplorerName address={session.address} />
              ) : (
                <button type="button" className="btn btn-gold w-full" onClick={() => void session.signIn()} disabled={session.signingIn}>
                  {session.signingIn ? 'Check your wallet…' : 'Sign in'}
                </button>
              )}
              {session.error && <ErrorNote>{session.error}</ErrorNote>}
              {session.isAdmin && (
                <Link href="/admin" className="btn btn-ghost mt-3 w-full" onClick={() => setOpen(false)}>
                  Society administration
                </Link>
              )}
              <button
                type="button"
                className="btn btn-ghost mt-3 w-full"
                onClick={() => {
                  session.signOut();
                  disconnect();
                  setOpen(false);
                }}
              >
                Disconnect
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The name shown on the leaderboards instead of the wallet address. */
function ExplorerName({ address }: { address: string }) {
  const { data } = usePlayer(address);
  return (
    <div>
      <div className="label mb-1">Your name</div>
      <ExplorerNameForm key={data?.displayName ?? ''} initial={data?.displayName ?? ''} />
    </div>
  );
}
