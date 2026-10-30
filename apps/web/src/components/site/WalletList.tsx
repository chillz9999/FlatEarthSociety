'use client';

import { useConnect } from 'wagmi';
import { CHAIN } from '@/lib/env';
import { describeError } from '@/lib/ranked';

/** The wallets found in this browser, one button each. Connecting never forces a network switch. */
export function WalletList({ onPicked }: { onPicked?: () => void }) {
  const { connectors, connect, isPending, variables, error } = useConnect();
  // Prefer discovered wallets (EIP-6963); offer the generic injected entry only when the browser has a wallet at all.
  const named = connectors.filter((c) => c.id !== 'injected');
  const injected = typeof window !== 'undefined' && !!(window as { ethereum?: unknown }).ethereum;
  const list = named.length ? named : injected ? connectors : [];
  const picking = isPending ? variables?.connector : undefined;

  if (list.length === 0) {
    return (
      <p className="font-serif text-base text-parchment-2">
        No wallet found in this browser. Install a wallet such as MetaMask or Rabby (it must support {CHAIN.name}), then reload this page.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {list.map((c) => (
        <button
          key={c.uid}
          type="button"
          disabled={isPending}
          onClick={() => {
            connect({ connector: c });
            onPicked?.();
          }}
          className="group flex w-full items-center gap-3 border border-gold/35 bg-ink/70 px-4 py-2.5 text-left font-serif text-base text-parchment transition-colors hover:border-gold hover:bg-gold/10 disabled:cursor-wait disabled:opacity-60"
        >
          {c.icon ? <img src={c.icon} alt="" className="h-6 w-6 rounded" /> : <span className="h-6 w-6 rounded bg-gold/25" />}
          <span className="flex-1">{c.name === 'Injected' ? 'Browser wallet' : c.name}</span>
          <span className="text-xs text-gold-2 opacity-0 transition-opacity group-hover:opacity-100">
            {picking && 'uid' in picking && picking.uid === c.uid ? 'Opening…' : '→'}
          </span>
        </button>
      ))}
      {error && <ErrorNote>{describeError(error)}</ErrorNote>}
    </div>
  );
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" className="mt-3 border border-[#f0b49a]/40 bg-[#f0b49a]/10 px-3 py-2 text-left font-serif text-base text-[#f0b49a]">
      {children}
    </div>
  );
}
