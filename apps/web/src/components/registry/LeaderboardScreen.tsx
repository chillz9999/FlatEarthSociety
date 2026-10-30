'use client';

import { PRIZE_SHARES_BPS } from '@fes/game-core';
import Link from 'next/link';
import { weekIdAt, weekLabel } from '@fes/shared';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAccount } from 'wagmi';
import { Countdown } from '@/components/site/Countdown';
import { useCombinedBoard, type PlayKind } from '@/lib/board';
import { formatScore, formatToken, ordinal, shortAddress } from '@/lib/format';
import { prizeToken } from '@/lib/prices';
import { useCompetition, useConfig, useHall } from '@/lib/queries';

type Filter = 'all' | PlayKind;

/** This week's (or a past week's) leaderboard, and the past winners. */
export function LeaderboardScreen() {
  const current = weekIdAt(Date.now());
  const [week, setWeek] = useState(current);
  const [filter, setFilter] = useState<Filter>('all');
  useEffect(() => {
    const w = Number(new URLSearchParams(window.location.search).get('week'));
    if (Number.isInteger(w) && w > 0 && w <= current) setWeek(w);
  }, [current]);
  const isCurrent = week === current;
  const { rows, isLoading, isError } = useCombinedBoard(isCurrent ? undefined : week);
  const { data: comp } = useCompetition();
  const { data: cfg } = useConfig();
  const { address } = useAccount();
  const me = address?.toLowerCase();
  const { symbol: prizeSym, decimals: prizeDec } = prizeToken(cfg);
  const pool = isCurrent && comp ? BigInt(comp.fesPoolEstimate ?? comp.fesPool) : null;
  const shown = filter === 'all' ? rows : rows.filter((r) => r.kind === filter);
  const weeks = useMemo(() => Array.from({ length: 8 }, (_, i) => current - i), [current]);

  return (
    <div className="mx-auto max-w-[1100px] px-4 pt-10 md:px-8">
      <header className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between md:gap-8">
        <div>
          <div className="label">{weekLabel(week)}</div>
          <h1 className="mt-2 font-display text-4xl text-gold-2 candle md:text-5xl">Leaderboard</h1>
        </div>
        {isCurrent && (
          <div className="plaque flex gap-8 px-6 py-4">
            <div>
              <div className="label">The Pot</div>
              <div className="num mt-1 text-2xl text-gold-3">
                {formatToken(pool, prizeDec)} <span className="text-base text-parchment-2">{prizeSym}</span>
              </div>
            </div>
            <div>
              <div className="label">Closes in</div>
              <div className="mt-1 text-xl text-parchment">
                <Countdown to={comp?.endsAt} compact />
              </div>
            </div>
          </div>
        )}
      </header>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
        <nav className="flex flex-wrap gap-2" aria-label="Weeks">
          {weeks.map((w) => (
            <Chip key={w} on={w === week} onClick={() => setWeek(w)}>
              {w === current ? 'This week' : weekLabel(w).replace('Week of ', '')}
            </Chip>
          ))}
        </nav>
        <div className="flex gap-2" role="group" aria-label="Show">
          {(
            [
              ['all', 'All'],
              ['competitive', 'Competitive'],
              ['free', 'Free play'],
            ] as const
          ).map(([f, label]) => (
            <Chip key={f} on={filter === f} onClick={() => setFilter(f)}>
              {label}
            </Chip>
          ))}
        </div>
      </div>

      <section className="plaque mt-5 overflow-x-auto">
        <table className="w-full text-left">
          <thead className="border-b border-gold/30 bg-ink-3/60">
            <tr className="label">
              <th className="w-20 px-3 md:px-6 py-3 font-normal">#</th>
              <th className="px-3 md:px-6 py-3 font-normal">Explorer</th>
              <th className="px-3 md:px-6 py-3 text-right font-normal">Score</th>
              <th className="hidden px-3 py-3 font-normal sm:table-cell md:px-6">Mode</th>
              <th className="px-3 md:px-6 py-3 font-normal">Prize</th>
            </tr>
          </thead>
          <tbody>
            {(isLoading || isError || shown.length === 0) && (
              <tr>
                <td colSpan={5} className="px-3 md:px-6 py-10 text-center font-serif text-lg text-parchment-3 italic">
                  {isLoading ? (
                    'Loading…'
                  ) : isError ? (
                    'The leaderboard isn’t loading right now. Try again in a moment.'
                  ) : isCurrent ? (
                    <>
                      No scores yet this week.{' '}
                      <Link href="/" className="text-gold-2 not-italic hover:underline">
                        Be the first →
                      </Link>
                    </>
                  ) : (
                    'No scores that week.'
                  )}
                </td>
              </tr>
            )}
            {shown.map((r) => {
              const mine = r.address === me;
              const share = r.prizeRank && pool !== null ? (pool * BigInt(PRIZE_SHARES_BPS[r.prizeRank - 1])) / 10_000n : null;
              return (
                <tr key={r.key} className={`border-b border-gold/10 ${mine ? 'bg-gold/12 outline outline-gold/40' : ''}`}>
                  <td className={`num px-3 md:px-6 py-3 text-lg ${r.prizeRank ? 'text-gold-3' : 'text-parchment-2'}`}>{r.position}</td>
                  <td className="px-3 md:px-6 py-3">
                    <span className={`text-lg text-parchment ${r.displayName ? 'font-serif' : 'num'}`}>{r.displayName ?? shortAddress(r.address)}</span>
                    {mine && <span className="ml-2 font-display text-[0.6rem] tracking-[0.2em] text-gold-2 uppercase">You</span>}
                  </td>
                  <td className="num px-3 md:px-6 py-3 text-right text-lg text-parchment">{formatScore(r.score)}</td>
                  <td className="hidden px-3 py-3 sm:table-cell md:px-6">
                    <span
                      className={`border px-2 py-0.5 font-display text-[0.62rem] tracking-[0.18em] uppercase ${r.kind === 'competitive' ? 'border-gold/60 text-gold-2' : 'border-parchment-3/40 text-parchment-3'}`}
                    >
                      {r.kind === 'competitive' ? 'Competitive' : 'Free play'}
                    </span>
                  </td>
                  <td className="px-3 md:px-6 py-3 font-serif text-base text-parchment-2">
                    {r.prizeRank ? (
                      <span className="text-gold-3">
                        {ordinal(r.prizeRank)}
                        {share !== null && <span className="num text-parchment-2"> · ≈ {formatToken(share, prizeDec)} {prizeSym}</span>}
                      </span>
                    ) : (
                      <span className="text-parchment-3">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <p className="mt-4 font-serif text-base text-parchment-3">
        Top three competitive scores share the Pot: 50%, 30% and 20%.{' '}
        <Link href="/rules" className="text-gold-2 hover:underline">
          Game rules →
        </Link>
      </p>
      <PastWinners />
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`border px-3 py-1.5 font-display text-[0.7rem] tracking-[0.14em] uppercase ${on ? 'border-gold bg-gold/15 text-gold-3' : 'border-gold/25 text-parchment-3 hover:text-parchment'}`}
    >
      {children}
    </button>
  );
}

/** Each settled week's top three. */
function PastWinners() {
  const { data: hall } = useHall();
  const { data: cfg } = useConfig();
  const { symbol: prizeSym, decimals: prizeDec } = prizeToken(cfg);
  if (!hall?.length) return null;
  return (
    <section className="plaque mt-6 overflow-hidden">
      <h2 className="px-7 pt-6 font-display text-xl tracking-[0.12em] text-gold-2 uppercase">Past winners</h2>
      <table className="mt-3 w-full text-left font-serif text-base">
        <tbody>
          {hall.slice(0, 12).map((w) => (
            <tr key={w.weekId} className="border-t border-gold/10">
              <td className="px-7 py-3 font-serif text-base text-parchment">{weekLabel(w.weekId).replace('Week of ', '')}</td>
              {[1, 2, 3].map((rank) => {
                const winner = w.winners.find((x) => x.rank === rank);
                return (
                  <td key={rank} className="px-4 py-3 text-parchment-2">
                    <span className="text-gold-3">{ordinal(rank)}</span>{' '}
                    {winner ? (
                      <>
                        {winner.displayName ?? shortAddress(winner.address)}{' '}
                        <span className="num text-parchment-3">
                          {formatToken(winner.fesAmount, prizeDec)} {prizeSym}
                        </span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
