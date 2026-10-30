'use client';

import { encodeInputs, randomSeedHex } from '@fes/game-core';
import type { SubmitPracticeResponse } from '@fes/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { GameStage } from '@/components/game/GameStage';
import { GameOverCard } from '@/components/game/GameOverCard';
import { JoinForm } from '@/components/site/JoinForm';
import type { RunSummary } from '@/game/runner';
import { api } from '@/lib/api';
import { pendingPractice, savePendingPractice, sendPractice } from '@/lib/practice';
import { NeedsSignIn, describeError, describeRejection } from '@/lib/ranked';
import { useSession } from '@/lib/session';
import { shareScore } from '@/lib/share';
import { usePlayer } from '@/lib/queries';
import { load, store } from '@/lib/storage';
import { useExplorer } from './ExplorerGate';

type Log = { state: 'guest' } | { state: 'logging' } | { state: 'done'; res: SubmitPracticeResponse } | { state: 'error'; message: string };
type Body = { endTick: number; inputs: number[]; claimedScore: number; finalHash: string; checkpoints: string[] };

/** A guest's best practice score, kept on this device. */
const GUEST_BEST_KEY = 'fes:practice-best';

/**
 * Free practice, open to everyone. A signed-in explorer's voyages are replayed by the Society and recorded
 * on the leaderboard (beside competitive scores) under their name; a guest's are not. Free play never wins prizes.
 */
export function PracticeArena({
  intro,
  rankFor,
  modeSwitch,
  onWantRanked,
  onAddName,
  onLock,
}: {
  /** Shown in place of the launch button (the name step, or the choice of free or competitive play). */
  intro?: ReactNode;
  /** Where a free-play score would place on this week's leaderboard (competitive and free play together). */
  rankFor: (score: number) => number | null;
  modeSwitch?: ReactNode;
  onWantRanked: () => void;
  /** A guest asks to add a name. */
  onAddName: () => void;
  onLock?: (locked: boolean) => void;
}) {
  const { offline, address, name } = useExplorer();
  const session = useSession();
  const qc = useQueryClient();
  const runId = useRef<string | null>(null);
  const [log, setLog] = useState<Log>({ state: 'guest' });
  /** A guest's last voyage, kept so it can be recorded if they add their name on the result card. */
  const [guestRun, setGuestRun] = useState<{ runId: string; body: Body } | null>(null);
  const [guestBest, setGuestBest] = useState<{ best: number | null; newBest: boolean }>({ best: null, newBest: false });
  const recording = !!address && !!name && !offline;
  const { data: player } = usePlayer(recording ? address : null);
  /** The best free-play score before this voyage: passing it is celebrated, and a first voyage is not a "new best". */
  const [bestBefore, setBestBefore] = useState<number | null>(null);

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['practice-leaderboard'] });
    void qc.invalidateQueries({ queryKey: ['player'] });
  }, [qc]);

  // Voyages finished while the Society was unreachable are recorded once it answers again.
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    void (async () => {
      for (const p of pendingPractice(address)) {
        if (cancelled) return;
        try {
          await sendPractice(p);
          refresh();
        } catch (err) {
          if (err instanceof NeedsSignIn) return session.signOut();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, refresh, session]);

  // Every voyage starts from a seed issued by the Society, so a guest's can still be recorded afterwards.
  const acquireSeed = useCallback(async () => {
    runId.current = null;
    setLog({ state: 'guest' });
    setGuestRun(null);
    setBestBefore(recording ? (player?.practiceBest ?? null) : load<number>(GUEST_BEST_KEY));
    if (!offline) {
      try {
        const res = await api.startPractice();
        runId.current = res.runId;
        return res.seed;
      } catch {
        // The Society could not be reached: sail anyway, unrecorded.
      }
    }
    return randomSeedHex();
  }, [offline, recording, player]);

  const record = useCallback(
    (id: string, player: `0x${string}`, body: Body) => {
      const pending = { runId: id, player, body };
      savePendingPractice(pending);
      setLog({ state: 'logging' });
      return sendPractice(pending)
        .then((res) => {
          setLog({ state: 'done', res });
          setGuestRun(null);
          refresh();
        })
        .catch((err) => {
          if (err instanceof NeedsSignIn) session.signOut();
          setLog({ state: 'error', message: describeError(err) });
        });
    },
    [refresh, session],
  );

  const onRunEnd = useCallback(
    (s: RunSummary) => {
      const id = runId.current;
      runId.current = null;
      const body: Body = { endTick: s.endTick, inputs: encodeInputs(s.inputs), claimedScore: s.result.score, finalHash: s.result.finalHash, checkpoints: s.result.checkpointHashes };
      if (id && address && recording) {
        void record(id, address, body);
        return;
      }
      const prev = load<number>(GUEST_BEST_KEY);
      const best = prev === null || s.result.score > prev;
      if (best) store(GUEST_BEST_KEY, s.result.score);
      // A first voyage sets the bar; it does not beat one.
      setGuestBest({ best: best ? s.result.score : prev, newBest: best && prev !== null });
      if (id) setGuestRun({ runId: id, body });
    },
    [address, recording, record],
  );


  const footer = (
    <div className="mt-5 border-t border-gold/20 pt-4 font-serif text-base text-parchment-3">
      {recording ? (
        <>
          Scores post to the leaderboard as <span className="text-gold-2">{name}</span>.
        </>
      ) : offline ? (
        <>Playing as a guest. Scores can’t be saved right now.</>
      ) : (
        <>
          Playing as a guest ·{' '}
          <button type="button" className="text-gold-2 underline-offset-2 hover:underline" onClick={onAddName}>
            Add your name
          </button>
        </>
      )}
    </div>
  );

  return (
    <GameStage
      mode="practice"
      canLaunch={!intro}
      acquireSeed={acquireSeed}
      rankFor={rankFor}
      personalBest={bestBefore}
      // Before a mode is chosen there is no mode to label.
      overlayTop={intro ? <></> : modeSwitch}
      readyCaption={<>Dodge everything, grab the treasure, and don’t go over the Edge.</>}
      notReadyContent={intro}
      readyFooter={footer}
      onRunEnd={onRunEnd}
      onPhase={(ph) => onLock?.(ph === 'launching' || ph === 'running' || ph === 'paused' || ph === 'sinking')}
      renderResult={(s, again) => {
        const res = log.state === 'done' ? log.res : null;
        const verified = res?.status === 'verified';
        const guest = log.state === 'guest';
        const place = rankFor(s.result.score);
        return (
          <GameOverCard
            name={recording ? name : null}
            cause={s.result.death}
            stats={{
              score: s.result.score,
              survivalMs: s.result.survivalMs,
              evidence: s.result.evidence,
              superCoins: s.result.superCoins,
              personalBest: guest ? guestBest.best : (res?.personalBest ?? null),
              rank: place,
              pointsToThird: null,
              newBest: guest ? guestBest.newBest : verified && bestBefore !== null && s.result.score > bestBefore,
            }}
            status={
              guest ? (
                guestRun && !offline ? (
                  <div>
                    <div>Add your name to post this score{place ? `. It would rank #${place} this week` : ''}.</div>
                    <div className="mx-auto mt-3 max-w-md">
                      <JoinForm submitLabel="Add my name" onJoined={(player) => record(guestRun.runId, player, guestRun.body)} />
                    </div>
                  </div>
                ) : (
                  <>Guest voyage, not saved.</>
                )
              ) : log.state === 'logging' ? (
                <span className="italic">Saving to the leaderboard…</span>
              ) : log.state === 'error' ? (
                <span className="text-[#f0b49a]">{log.message} It’ll be saved once the server answers.</span>
              ) : res && !verified ? (
                <span className="text-[#f0b49a]">{describeRejection(res.reason)}</span>
              ) : verified ? (
                <>Saved{place ? ` · #${place} on this week’s leaderboard` : ' to the leaderboard'}</>
              ) : null
            }
            primary={{ label: 'Sail again', onClick: again }}
            secondary={{ label: 'Play competitive', onClick: onWantRanked }}
            onShare={() => shareScore(s.result.score, s.result.death, false)}
            footnote="Free play never wins prizes · Space or Enter to sail again"
          />
        );
      }}
    />
  );
}
