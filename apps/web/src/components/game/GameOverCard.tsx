'use client';

import { DEATH_HEADLINES, FAILURE_REMARKS, STAGES, stageIndexAt, type DeathCause } from '@fes/game-core';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { renderScoreCard } from '@/lib/certificate';
import { formatScore, formatTime } from '@/lib/format';
import { SITE_URL } from '@/lib/share';

export interface GameOverStats {
  score: number;
  survivalMs: number;
  evidence: number;
  /** Super coins among the treasure. */
  superCoins?: number;
  personalBest: number | null;
  rank: number | null;
  pointsToThird: number | null;
  newBest: boolean;
}

/** The result of a voyage: its record card (click to save), what it means, and what to do next. */
export function GameOverCard({
  cause,
  stats,
  status,
  primary,
  secondary,
  onShare,
  footnote,
  ranked = false,
  name = null,
}: {
  cause: DeathCause | null;
  stats: GameOverStats;
  /** e.g. "Verifying with the Society…" for ranked runs. */
  status?: ReactNode;
  primary: { label: ReactNode; onClick: () => void; disabled?: boolean };
  /** A second main action, shown beside the primary one. */
  secondary?: { label: ReactNode; onClick: () => void };
  onShare?: () => void;
  footnote?: ReactNode;
  ranked?: boolean;
  /** Who sailed (printed on the record card; null: a guest). */
  name?: string | null;
}) {
  const c = cause ?? 'edge';
  const remark = useMemo(() => FAILURE_REMARKS[Math.floor(Math.random() * FAILURE_REMARKS.length)], []);
  const treasure = stats.superCoins ? `${stats.evidence} (${stats.superCoins} super)` : String(stats.evidence);
  const fileName = `society-record-${stats.score}.png`;
  const stage = STAGES[stageIndexAt(stats.survivalMs / 1000)].name;
  const date = useMemo(() => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }), []);

  /** The record card (a PNG data URL); null until it is first drawn. Redrawn when the rank comes in. */
  const [card, setCard] = useState<string | null>(null);
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const canCopy = typeof window !== 'undefined' && 'ClipboardItem' in window && !!navigator.clipboard?.write;

  useEffect(() => {
    let live = true;
    void renderScoreCard({
      headline: DEATH_HEADLINES[c].replace(/\.$/, ''),
      remark,
      score: stats.score,
      survival: formatTime(stats.survivalMs),
      treasure,
      rank: stats.rank,
      ranked,
      stage,
      name,
      date,
      site: SITE_URL.replace(/^https?:\/\//, ''),
    }).then((url) => {
      if (live) setCard(url);
    });
    return () => {
      live = false;
    };
  }, [c, remark, stats.score, stats.survivalMs, treasure, stats.rank, ranked, stage, name, date]);

  const copy = async () => {
    if (!card) return;
    try {
      const blob = await (await fetch(card)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      setCopied('done');
    } catch {
      setCopied('failed');
    }
  };

  // Enter or Space: the main action. Held back for a moment so a key still down from the voyage never skips
  // the result unseen.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setArmed(true), 700);
    return () => window.clearTimeout(t);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.code !== 'Enter' && e.code !== 'Space') return;
      e.preventDefault();
      if (armed && !e.repeat && !primary.disabled) primary.onClick();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [primary, armed]);

  const best = stats.newBest ? 'A new personal best' : stats.personalBest !== null ? `Personal best ${formatScore(stats.personalBest)}` : null;
  const third =
    ranked && stats.pointsToThird !== null
      ? stats.pointsToThird === 0
        ? 'You hold a prize position'
        : `${formatScore(stats.pointsToThird)} points to third place`
      : null;
  const details = [best, third].filter(Boolean).join(' · ');

  return (
    <div className="plaque fade-up m-auto w-[min(960px,94%)] px-7 py-5">
      <div className="label text-center">Record of the Society · Voyage {c === 'timeout' ? 'complete' : 'lost'}</div>
      {/* The record card on the left (with what you can do with it), what it means and what next on the right. */}
      <div className="mt-3 grid grid-cols-[1.3fr_1fr] items-center gap-7">
        <div>
          {card ? (
            <a href={card} download={fileName} title="Click to save" className="block cursor-pointer outline-offset-4 hover:opacity-95">
              {/* eslint-disable-next-line @next/next/no-img-element -- a generated data URL, not a static asset */}
              <img
                src={card}
                alt={`Record card: ${DEATH_HEADLINES[c]} Final score ${formatScore(stats.score)}.`}
                width={1200}
                height={630}
                className="h-auto w-full shadow-[0_8px_30px_rgba(0,0,0,0.55)]"
              />
            </a>
          ) : (
            <div className="flex aspect-[1200/630] w-full items-center justify-center bg-ink-3/60 font-serif text-lg text-parchment-3 italic">
              Drawing your record card…
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 font-display text-xs tracking-[0.18em] text-gold-2 uppercase">
            {card && (
              <a href={card} download={fileName} className="hover:text-gold-3">
                Save card
              </a>
            )}
            {onShare && (
              <button type="button" className="uppercase hover:text-gold-3" onClick={onShare}>
                Share score
              </button>
            )}
            {canCopy && card && (
              <button type="button" className="uppercase hover:text-gold-3" onClick={() => void copy()}>
                {copied === 'done' ? 'Copied' : copied === 'failed' ? 'Could not copy' : 'Copy image'}
              </button>
            )}
          </div>
        </div>
        <div className="text-center">
          {details && <div className={`font-display text-xs tracking-[0.2em] uppercase ${stats.newBest ? 'text-verdigris' : 'text-parchment-2'}`}>{details}</div>}
          {status && <div className="mt-2 font-serif text-lg leading-snug text-parchment-2">{status}</div>}
          <div className="mt-4 flex flex-col gap-3">
            <button type="button" className="btn btn-gold w-full" onClick={primary.onClick} disabled={primary.disabled}>
              {primary.label}
            </button>
            {secondary && (
              <button type="button" className="btn btn-ghost w-full" onClick={secondary.onClick}>
                {secondary.label}
              </button>
            )}
          </div>
          {footnote && <div className="mt-3 font-serif text-sm text-parchment-3">{footnote}</div>}
        </div>
      </div>
    </div>
  );
}
