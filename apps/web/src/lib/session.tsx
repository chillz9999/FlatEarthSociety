'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createSiweMessage } from 'viem/siwe';
import { useAccount, useSignMessage } from 'wagmi';
import { api, getToken, setToken } from './api';
import { CHAIN } from './env';
import { describeError } from './ranked';

interface SessionState {
  /** Wallet address the server has authenticated (Sign-In with Ethereum). */
  address: `0x${string}` | null;
  isAdmin: boolean;
  signingIn: boolean;
  error: string | null;
  signIn: () => Promise<boolean>;
  signOut: () => void;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const { address: wallet, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Restore an existing session for the connected wallet.
  useEffect(() => {
    if (!isConnected || !wallet) {
      setAddress(null);
      setIsAdmin(false);
      return;
    }
    if (!getToken()) return;
    let cancelled = false;
    api
      .me()
      .then((me) => {
        if (cancelled) return;
        if (me.address.toLowerCase() === wallet.toLowerCase()) {
          setAddress(me.address);
          setIsAdmin(me.isAdmin);
        } else {
          setToken(null);
          setAddress(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setToken(null);
          setAddress(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [wallet, isConnected]);

  const signIn = useCallback(async () => {
    if (!wallet) return false;
    setSigningIn(true);
    setError(null);
    try {
      const { nonce } = await api.nonce();
      const message = createSiweMessage({
        address: wallet,
        chainId: CHAIN.id,
        domain: window.location.host,
        uri: window.location.origin,
        nonce,
        version: '1',
        statement: 'The Flat Earth Society: sign in to take the Society Test. This signature costs nothing.',
        issuedAt: new Date(),
      });
      const signature = await signMessageAsync({ message });
      const session = await api.verify(message, signature);
      setToken(session.token);
      setAddress(session.address);
      setIsAdmin(session.isAdmin);
      return true;
    } catch (err) {
      setError(describeError(err) || 'Sign-in failed. Please try again.');
      return false;
    } finally {
      setSigningIn(false);
    }
  }, [wallet, signMessageAsync]);

  const signOut = useCallback(() => {
    setToken(null);
    setAddress(null);
    setIsAdmin(false);
  }, []);

  const value = useMemo(() => ({ address, isAdmin, signingIn, error, signIn, signOut }), [address, isAdmin, signingIn, error, signIn, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}
