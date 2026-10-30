'use client';

import { useCallback, useEffect, useState } from 'react';
import type { RunSummary } from '@/game/runner';
import { formatScore, formatToken } from '@/lib/format';
import { openSwap, swapUrl, type Price } from '@/lib/prices';
import { describeError, purchaseLife, type LifeStep } from '@/lib/ranked';

/** Seconds to decide before the voyage ends on its own. */
const OFFER_SECONDS = 20;

const STEP_TEXT: Record<LifeStep, string> = {
  idle: '',
  quoting: 'Preparing your bonus life…',
  approving: 'Allow the $WIF payment in your wallet…',
  paying: 'Confirm the payment in your wallet…',
  checking: 'Your wallet reported a problem. Checking whether the payment went through…',
  confirming: 'Waiting for the network to confirm…',
  verifying: 'Checking your payment…',
};

/** Shown when a ranked voyage's ship is lost: pay for the one bonus life and carry on, or end the voyage. */
export function LifeOffer({
  summary,
  attemptId,
  player,
  price,
  balance,
  refreshBalance,
  wif,
  revive,
  decline,
}: {
  summary: RunSummary;
  attemptId: string;
  player: `0x${string}`;
  price: Price;
  balance: bigint | null;
  /** Read the wallet's $WIF balance again (after buying some). */
  refreshBalance: () => Promise<void>;
  /** The $WIF token, to buy more of it from the offer. */
  wif: { address: string; decimals: number } | null;
  revive: () => boolean;
  decline: () => void;
}) {
  const [step, setStep] = useState<LifeStep>('idle');
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState(OFFER_SECONDS);
  const [boughtOnce, setBoughtOnce] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const busy = step !== 'idle';
  const short = price.raw !== null && balance !== null && balance < price.raw;
  const canBuy = !!wif && !!swapUrl(wif.address);

  // The clock stops while paying, after an error, and once the explorer has gone to buy $WIF (they decide again).
  useEffect(() => {
    if (busy || error || boughtOnce) return;
    if (left <= 0) {
      decline();
      return;
    }
    const t = window.setTimeout(() => setLeft((l) => l - 1), 1000);
    return () => window.clearTimeout(t);
  }, [left, busy, error, boughtOnce, decline]);

  const pay = useCallback(async () => {
    setError(null);
    try {
      await purchaseLife(player, attemptId, setStep);
      if (!revive()) setError('The voyage couldn’t be resumed.');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setStep('idle');
    }
  }, [player, attemptId, revive]);

  // Escape ends the voyage. Paying always takes a click: Enter restarts from the result card, and a reflex press
  // must never spend money.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!busy && e.key === 'Escape') decline();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, decline]);

  return (
    <div className="plaque fade-up m-auto w-[min(540px,84%)] px-10 py-8 text-center">
      <div className="label">Your ship was lost · {formatScore(summary.result.score)} points</div>
      <h2 className="mt-3 font-display text-3xl text-gold-2 candle">Carry on for {price.usd}?</h2>
      <p className="mt-3 font-serif text-lg text-parchment-2">
        Keep your score and sail on from where you sank, shielded for a moment. One bonus life per voyage.
      </p>
      <div className="mt-2 font-serif text-sm text-parchment-3">{price.wif ?? '—'} · 50% to the Pot, 50% burned</div>
      <div className="rule my-5" />
      {busy ? (
        <div className="font-serif text-lg text-gold-2 italic">{STEP_TEXT[step]}</div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <button type="button" className="btn btn-gold pulse-gold" onClick={() => void pay()} disabled={short || price.raw === null}>
            Pay {price.usd} &amp; carry on
          </button>
          {short && (
            <div className="font-serif text-base text-[#f0b49a]">
              Not enough $WIF in this wallet{balance !== null && wif ? ` (it holds ${formatToken(balance, wif.decimals)})` : ''}.
              {canBuy && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="text-gold-2 underline underline-offset-2 hover:text-gold-3"
                    onClick={() => {
                      const url = wif && swapUrl(wif.address, { need: price.raw !== null && balance !== null ? price.raw - balance : null, decimals: wif.decimals });
                      if (url) openSwap(url);
                      setBoughtOnce(true);
                    }}
                  >
                    Buy $WIF
                  </button>
                </>
              )}
              {' · '}
              <button
                type="button"
                className="text-gold-2 underline underline-offset-2 hover:text-gold-3 disabled:opacity-60"
                disabled={refreshing}
                onClick={() => {
                  setRefreshing(true);
                  void refreshBalance().finally(() => setRefreshing(false));
                }}
              >
                {refreshing ? 'Refreshing…' : 'Refresh balance'}
              </button>
            </div>
          )}
          <button type="button" className="font-serif text-base text-parchment-3 underline-offset-2 hover:text-gold-2 hover:underline" onClick={decline}>
            No thanks, end the voyage{error || boughtOnce ? '' : ` (${left})`}
          </button>
        </div>
      )}
      {error && <div className="mt-4 font-serif text-base text-[#f0b49a]">{error}</div>}
      {boughtOnce && short && !busy && (
        <div className="mt-4 font-serif text-base text-parchment-3">Finish the swap in Uniswap’s window, then come back here: the offer waits.</div>
      )}
    </div>
  );
}
