'use client';

import { encodeInputs } from '@fes/game-core';
import type { SubmitAttemptResponse } from '@fes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAccount } from 'wagmi';
import { GameOverCard } from '@/components/game/GameOverCard';
import { GameStage } from '@/components/game/GameStage';
import { ConnectWallet } from '@/components/site/ConnectWallet';
import type { CheckpointSnapshot, RunSummary } from '@/game/runner';
import { api } from '@/lib/api';
import { CHAIN } from '@/lib/env';
import { formatToken } from '@/lib/format';
import { openSwap, priceOf, swapUrl } from '@/lib/prices';
import { useConfig, usePlayer } from '@/lib/queries';
import {
  NeedsSignIn,
  confirmPayment,
  describeError,
  describeRejection,
  mintDemoWif,
  pendingEntryTx,
  pendingSubmissions,
  purchaseAttempt,
  savePendingSubmission,
  submitPending,
  wifBalance,
  type PendingSubmission,
  type PurchaseStep,
} from '@/lib/ranked';
import { useSession } from '@/lib/session';
import { shareScore } from '@/lib/share';
import { Notice, useExplorer } from './ExplorerGate';
import { LifeOffer } from './LifeOffer';

const STEP_TEXT: Record<PurchaseStep, string> = {
  idle: '',
  reserving: 'Reserving your game…',
  approving: 'Allow the $WIF payment in your wallet…',
  paying: 'Confirm the payment in your wallet…',
  checking: 'Your wallet reported a problem. Checking whether the payment went through…',
  confirming: 'Waiting for the network to confirm…',
  verifying: 'Checking your payment…',
  done: 'Paid. You’re in.',
};

type Verification = { state: 'idle' } | { state: 'verifying' } | { state: 'done'; res: SubmitAttemptResponse } | { state: 'error'; message: string };

export function RankedArena({
  rankFor,
  modeSwitch,
  onWantPractice,
  onLock,
}: {
  rankFor: (score: number) => number | null;
  modeSwitch?: ReactNode;
  onWantPractice?: () => void;
  onLock?: (locked: boolean) => void;
}) {
  const { address, chainId } = useAccount();
  const session = useSession();
  const explorer = useExplorer('ranked');
  const { data: cfg } = useConfig();
  const qc = useQueryClient();
  const signedIn = !!session.address && !!address && session.address.toLowerCase() === address.toLowerCase();

  const attemptsQ = useQuery({
    queryKey: ['my-attempts', session.address],
    queryFn: api.myAttempts,
    enabled: signedIn,
    refetchInterval: 15_000,
  });
  const available = attemptsQ.data?.available ?? [];
  const interrupted = (attemptsQ.data?.recent ?? []).find((a) => a.status === 'abandoned' && (a.note ?? '').includes('no_contact'));

  const balanceQ = useQuery({
    queryKey: ['wif-balance', address, cfg?.wif?.address],
    queryFn: () => wifBalance(cfg!.wif!.address, address!),
    enabled: !!address && !!cfg?.wif && chainId === CHAIN.id,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });
  const { refetch: refetchBalance } = balanceQ;
  const refreshBalance = useCallback(async () => {
    if (address && cfg?.wif) await refetchBalance();
  }, [address, cfg?.wif, refetchBalance]);
  // Back from buying $WIF in Uniswap's window. Switching windows (not tabs) is not a "focus" to the query cache, so
  // read the balance again whenever this window regains focus.
  useEffect(() => {
    const onFocus = () => void refreshBalance();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshBalance]);

  const [step, setStep] = useState<PurchaseStep>('idle');
  const [error, setError] = useState<string | null>(null);
  const [verification, setVerification] = useState<Verification>({ state: 'idle' });
  const activeAttempt = useRef<string | null>(null);
  const [inRun, setInRun] = useState(false);

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['my-attempts'] });
    void qc.invalidateQueries({ queryKey: ['wif-balance'] });
    void qc.invalidateQueries({ queryKey: ['leaderboard'] });
    void qc.invalidateQueries({ queryKey: ['competition'] });
  }, [qc]);

  // Finished runs the server has not acknowledged yet. No new attempt launches until they are delivered.
  const [unsent, setUnsent] = useState(0);
  const flushing = useRef(false);
  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      for (const p of pendingSubmissions(session.address)) {
        try {
          const res = await submitPending(p);
          if (p.attemptId === activeAttempt.current) setVerification({ state: 'done', res });
          refresh();
        } catch (err) {
          if (err instanceof NeedsSignIn) {
            session.signOut();
            break;
          }
          if (p.attemptId === activeAttempt.current) setVerification({ state: 'error', message: describeError(err) });
        }
      }
    } finally {
      flushing.current = false;
      setUnsent(pendingSubmissions(session.address).length);
    }
  }, [refresh, session]);

  // Recover interrupted work (an unverified payment, unacknowledged runs) and keep retrying in the background.
  useEffect(() => {
    setUnsent(pendingSubmissions(session.address).length);
    if (!signedIn) return;
    const tx = pendingEntryTx();
    if (tx) void confirmPayment(tx.attemptId, tx.txHash).then(refresh).catch(() => undefined);
    void flush();
    const timer = window.setInterval(() => {
      if (pendingSubmissions(session.address).length) void flush();
    }, 15_000);
    const online = () => void flush();
    window.addEventListener('online', online);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', online);
    };
  }, [signedIn, refresh, flush, session.address]);

  const entryPrice = priceOf(cfg, 'entry');
  const lifePrice = priceOf(cfg, 'life');
  const fee = entryPrice.raw;
  const wifDec = cfg?.wif?.decimals ?? 18;
  const balance = balanceQ.data ?? null;
  const shortOfWif = fee !== null && balance !== null && balance < fee;
  const buyWif = () => {
    const url = swapUrl(cfg?.wif?.address, { need: shortOfWif ? fee! - balance! : null, decimals: wifDec });
    if (url) openSwap(url);
  };
  const canBuyWif = !!swapUrl(cfg?.wif?.address);

  // A payment the wallet reported as failed may still be credited once the server's indexer sees it.
  useEffect(() => {
    if (available.length > 0) setError(null);
  }, [available.length]);

  const buy = async () => {
    if (!address) return;
    setError(null);
    try {
      await purchaseAttempt(address, setStep);
      refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setStep('idle');
    }
  };

  const { data: player } = usePlayer(address);
  /** This week's best before this voyage: passing it is celebrated, and a first voyage is not a "new best". */
  const [bestBefore, setBestBefore] = useState<number | null>(null);

  const acquireSeed = useCallback(async () => {
    const next = available[0];
    if (!next) throw new Error('No paid game left. Buy one to play.');
    const res = await api.startAttempt(next.id);
    activeAttempt.current = next.id;
    setVerification({ state: 'idle' });
    setBestBefore(player?.weeklyBest ?? null);
    setInRun(true);
    return res.seed;
  }, [available, player]);

  const onCheckpoint = useCallback((snap: CheckpointSnapshot) => {
    const id = activeAttempt.current;
    if (!id) return;
    void api.checkpoint(id, { tick: snap.tick, inputs: encodeInputs(snap.inputs), checkpoints: snap.checkpoints }).catch(() => undefined);
  }, []);

  const onRunEnd = useCallback(
    (s: RunSummary) => {
      const id = activeAttempt.current;
      setInRun(false);
      if (!id) return;
      const pending: PendingSubmission = {
        attemptId: id,
        player: session.address ?? undefined,
        body: { endTick: s.endTick, inputs: encodeInputs(s.inputs), claimedScore: s.result.score, finalHash: s.result.finalHash, checkpoints: s.result.checkpointHashes },
      };
      savePendingSubmission(pending);
      setUnsent(pendingSubmissions(session.address).length);
      setVerification({ state: 'verifying' });
      void flush();
    },
    [flush, session.address],
  );

  // A lost ship may buy its one bonus life (not once the examination's time is up).
  const offerLife = useCallback(
    (s: RunSummary) =>
      !!activeAttempt.current && !!address && chainId === CHAIN.id && !!cfg?.extraLifeFee && !s.result.revived && s.result.death !== null && s.result.death !== 'timeout',
    [address, chainId, cfg?.extraLifeFee],
  );

  // Warn before leaving mid-run (the sea does not stop for a ranked attempt).
  useEffect(() => {
    if (!inRun) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [inRun]);

  let gate: ReactNode = null;
  if (explorer.offline) {
    gate = explorer.gate;
  } else if (!cfg?.entryContract) {
    gate = <Notice title="Competitive play opens soon">Free play is open now.</Notice>;
  } else if (explorer.gate) {
    gate = explorer.gate;
  } else if (chainId !== CHAIN.id) {
    gate = (
      <Notice title={`Switch to ${CHAIN.name}`}>
        <div className="mt-4 flex justify-center">
          <ConnectWallet />
        </div>
      </Notice>
    );
  } else if (cfg.entriesPaused) {
    gate = <Notice title="Competitive play is paused">New games can’t be bought for now. Games you’ve already paid for still count.</Notice>;
  }

  if (!gate && unsent > 0) {
    gate = (
      <Notice title="Sending your last voyage">
        Your last game hasn’t reached the server yet. It’s retried automatically, and you can play again once it arrives.
        <div className="mt-4">
          <button type="button" className="btn btn-ghost" onClick={() => void flush()}>
            Retry now
          </button>
        </div>
      </Notice>
    );
  }

  const purchasePanel = (
    <div>
      {gate ?? (
        <>
          <div className="mb-5 flex items-center justify-center gap-8">
            <div>
              <div className="label">One competitive game</div>
              <div className="num text-3xl text-gold-3">{entryPrice.usd}</div>
              <div className="num text-sm text-parchment-3">{entryPrice.wif ?? '—'}</div>
            </div>
            <div className="text-left font-serif text-sm leading-relaxed text-parchment-3">
              50% to the Pot, 50% burned
              <br />
              Bonus life if you sink: {lifePrice.usd}
              <br />
              Balance: <span className="num text-parchment-2">{balance !== null ? `${formatToken(balance, wifDec)} $WIF` : '—'}</span>
              {' · '}
              <button
                type="button"
                className="text-gold-2 underline-offset-2 hover:underline disabled:opacity-60"
                disabled={balanceQ.isFetching}
                onClick={() => void refreshBalance()}
              >
                {balanceQ.isFetching ? 'Refreshing…' : 'Refresh'}
              </button>
              {canBuyWif && !shortOfWif && (
                <>
                  {' · '}
                  <button type="button" className="text-gold-2 underline-offset-2 hover:underline" onClick={buyWif}>
                    Buy more
                  </button>
                </>
              )}
            </div>
          </div>
          {step !== 'idle' ? (
            <div className="font-serif text-lg text-gold-2 italic">{STEP_TEXT[step]}</div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <button type="button" className="btn btn-gold pulse-gold" onClick={() => void buy()} disabled={shortOfWif || fee === null}>
                Pay {entryPrice.usd} &amp; enter
              </button>
              {shortOfWif && (
                <div className="font-serif text-base text-[#f0b49a]">
                  Not enough $WIF in this wallet.
                  {canBuyWif && (
                    <>
                      {' '}
                      <button type="button" className="text-gold-2 underline underline-offset-2 hover:text-gold-3" onClick={buyWif}>
                        Buy $WIF
                      </button>
                    </>
                  )}
                </div>
              )}
              {cfg?.demoTokens && address && cfg.wif && (
                <button
                  type="button"
                  className="font-serif text-sm text-gold-2 underline-offset-2 hover:underline"
                  onClick={() =>
                    void mintDemoWif(cfg.wif!.address, address, ((fee ?? 10n ** 19n) + (lifePrice.raw ?? 0n)) * 5n)
                      .then(refresh)
                      .catch((e) => setError(describeError(e)))
                  }
                >
                  Demo network: mint test $WIF
                </button>
              )}
            </div>
          )}
          {interrupted && (
            <div className="mt-5 border-t border-gold/20 pt-4 font-serif text-base text-parchment-2">
              A paid game was interrupted before it started.{' '}
              <button
                type="button"
                className="text-gold-2 underline"
                onClick={() =>
                  void api
                    .restoreAttempt(interrupted.id)
                    .then(refresh)
                    .catch((e) => setError(describeError(e)))
                }
              >
                Restore it
              </button>
            </div>
          )}
          {error && <div className="mt-4 font-serif text-base text-[#f0b49a]">{error}</div>}
          <div className="mt-4 font-serif text-sm text-parchment-3">
            By paying, you confirm prize competitions are allowed where you live.
          </div>
        </>
      )}
    </div>
  );

  return (
    <GameStage
      mode="ranked"
      personalBest={bestBefore}
      canLaunch={!gate && available.length > 0 && unsent === 0}
      acquireSeed={acquireSeed}
      readyCaption={
        !gate && available.length > 0 ? (
          <>
            <b className="text-gold-2">{available.length}</b> paid {available.length === 1 ? 'game' : 'games'} ready · No pausing in competitive play
          </>
        ) : undefined
      }
      notReadyContent={purchasePanel}
      overlayTop={modeSwitch}
      rankFor={rankFor}
      onPhase={(ph) => onLock?.(ph === 'launching' || ph === 'running' || ph === 'paused' || ph === 'sinking' || ph === 'offer')}
      onCheckpoint={onCheckpoint}
      onRunEnd={onRunEnd}
      offerLife={offerLife}
      renderLifeOffer={(s, { revive, decline }) =>
        activeAttempt.current && address ? (
          <LifeOffer
            summary={s}
            attemptId={activeAttempt.current}
            player={address}
            price={lifePrice}
            balance={balance}
            refreshBalance={refreshBalance}
            wif={cfg?.wif ? { address: cfg.wif.address, decimals: cfg.wif.decimals } : null}
            revive={revive}
            decline={decline}
          />
        ) : null
      }
      renderResult={(s, again) => {
        const v = verification;
        const res = v.state === 'done' ? v.res : null;
        const remaining = available.length;
        return (
          <GameOverCard
            ranked
            name={explorer.name}
            cause={s.result.death}
            stats={{
              score: res?.score ?? s.result.score,
              survivalMs: res?.survivalMs ?? s.result.survivalMs,
              evidence: res?.evidence ?? s.result.evidence,
              superCoins: s.result.superCoins,
              personalBest: res?.personalBest ?? null,
              rank: res?.rank ?? null,
              pointsToThird: res?.pointsToThird ?? null,
              newBest: !!res && res.status === 'verified' && bestBefore !== null && res.score > bestBefore,
            }}
            status={
              v.state === 'verifying' ? (
                <span className="italic">Checking your voyage…</span>
              ) : v.state === 'error' ? (
                <span className="text-[#f0b49a]">{v.message} It’s saved on this device and will be sent again automatically.</span>
              ) : res?.status === 'verified' ? (
                <>Verified{res.rank ? ` · #${res.rank} this week` : ''}</>
              ) : res?.status === 'flagged' ? (
                <>Under review. Unusual voyages are checked by hand before they’re ranked.</>
              ) : res?.status === 'rejected' ? (
                <span className="text-[#f0b49a]">{describeRejection(res.reason)}</span>
              ) : null
            }
            primary={{
              label: remaining > 0 ? `Play again · ${remaining} ${remaining === 1 ? 'game' : 'games'} left` : `Play again · ${entryPrice.usd}`,
              onClick: again,
              disabled: v.state === 'verifying',
            }}
            secondary={onWantPractice ? { label: 'Free play', onClick: onWantPractice } : undefined}
            onShare={() => shareScore(res?.score ?? s.result.score, s.result.death, true)}
            footnote={remaining > 0 ? 'Space or Enter to play again' : undefined}
          />
        );
      }}
    />
  );
}
