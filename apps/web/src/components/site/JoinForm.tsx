'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useAccount } from 'wagmi';
import { ApiError, api } from '@/lib/api';
import { usePlayer } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { ErrorNote, WalletList } from './WalletList';

const NAME = /^[A-Za-z0-9 _.'-]+$/;

/**
 * Becoming a named explorer, name first: type a name, then connect a wallet and sign (free) to claim it.
 * `onJoined` runs once the name is saved — for instance to record the voyage just sailed.
 */
export function JoinForm({ submitLabel = 'Save name', onJoined }: { submitLabel?: string; onJoined?: (address: `0x${string}`, name: string) => Promise<void> | void }) {
  const { address, isConnected } = useAccount();
  const session = useSession();
  const qc = useQueryClient();
  const known = usePlayer(isConnected ? address : null).data?.displayName ?? null;
  const [name, setName] = useState('');
  const [phase, setPhase] = useState<'name' | 'wallet' | 'sign' | 'saving'>('name');
  const [error, setError] = useState<string | null>(null);
  const chosen = useRef('');

  // A returning explorer's wallet already has a name.
  useEffect(() => {
    if (known) setName((n) => n || known);
  }, [known]);

  const finish = useCallback(async () => {
    if (!address) return;
    setError(null);
    const signedIn = !!session.address && session.address.toLowerCase() === address.toLowerCase();
    if (!signedIn) {
      setPhase('sign');
      if (!(await session.signIn())) return setPhase('name');
    }
    setPhase('saving');
    try {
      if (chosen.current !== known) await api.setName(chosen.current);
      await qc.invalidateQueries({ queryKey: ['player'] });
      void qc.invalidateQueries({ queryKey: ['leaderboard'] });
      void qc.invalidateQueries({ queryKey: ['practice-leaderboard'] });
      await onJoined?.(address, chosen.current);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^displayName: /, '') : 'Couldn’t save your name. Please try again.');
      setPhase('name');
    }
  }, [address, known, onJoined, qc, session]);

  // Once the wallet connects, carry on with the name already chosen.
  useEffect(() => {
    if (phase === 'wallet' && isConnected && address) void finish();
  }, [phase, isConnected, address, finish]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (n.length === 0) return setError('Enter a name first.');
    if (n.length < 3) return setError('Use at least 3 characters.');
    if (n.length > 24 || !NAME.test(n)) return setError('Use up to 24 letters, numbers, spaces or _ . \' -');
    if (/^0x/i.test(n)) return setError('Names can’t start with 0x.');
    setError(null);
    if (n.toLowerCase() !== known?.toLowerCase()) {
      try {
        const { available } = await api.nameAvailable(n);
        if (!available) return setError('That name is taken. Try another.');
      } catch (err) {
        // Only a courtesy: saving the name checks it again. Carry on unless the API cannot be reached at all.
        if (!(err instanceof ApiError) || err.status === 0) return setError(err instanceof Error ? err.message : 'Can’t reach the server. Check your connection and try again.');
      }
    }
    chosen.current = n;
    if (isConnected && address) void finish();
    else setPhase('wallet');
  };

  if (phase === 'wallet') {
    return (
      <div className="text-left">
        <div className="mb-2 font-serif text-base text-parchment-2">
          Connect a wallet to claim <span className="text-gold-2">{chosen.current}</span>. It’s free.
        </div>
        <WalletList />
        <button type="button" className="mt-3 font-serif text-sm text-parchment-3 hover:text-gold-2" onClick={() => setPhase('name')}>
          ← Change name
        </button>
      </div>
    );
  }
  if (phase === 'sign' || phase === 'saving') {
    return (
      <div className="font-serif text-base text-gold-2 italic">
        {phase === 'sign' ? 'Sign the message in your wallet. It’s free…' : 'Saving your name…'}
        {session.error && <ErrorNote>{session.error}</ErrorNote>}
      </div>
    );
  }
  return (
    <form onSubmit={(e) => void submit(e)}>
      <div className="flex gap-2">
        <input
          aria-label="Explorer name"
          value={name}
          maxLength={24}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Capt. Meridian"
          className="w-full border border-gold/40 bg-ink px-3 py-2 font-serif text-base text-parchment outline-none focus:border-gold"
        />
        <button type="submit" className="btn btn-gold btn-sm shrink-0">
          {submitLabel}
        </button>
      </div>
      {(error || session.error) && <ErrorNote>{error || session.error}</ErrorNote>}
    </form>
  );
}
