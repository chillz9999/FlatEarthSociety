'use client';

import Link from 'next/link';
import { useAccount } from 'wagmi';
import { Countdown } from '@/components/site/Countdown';
import { useCombinedBoard } from '@/lib/board';
import { formatScore, formatToken, shortAddress } from '@/lib/format';
import { priceOf, prizeToken } from '@/lib/prices';
import { useCompetition, useConfig } from '@/lib/queries';

const SHOWN = 5;

/** Beside the game: this week's Pot (the prize), when it closes, and who is leading (competitive and free play together). */
export function WeekPanel() {
  const { rows, isLoading, isError } = useCombinedBoard();
  const { data: comp } = useCompetition();
  const { data: cfg } = useConfig();
  const { address } = useAccount();
  const { symbol: prizeSym, decimals: fesDec } = prizeToken(cfg);
  const entry = priceOf(cfg, 'entry');
  const life = priceOf(cfg, 'life');
  const pool = comp ? (comp.fesPoolEstimate ?? comp.fesPool) : null;
  const me = address?.toLowerCase();
  const top = rows.slice(0, SHOWN);
  // The explorer's best row, when it is below the ones shown.
  const mine = rows.find((r) => r.address === me);

  return (
    <section className="plaque p-5">
      <h3 className="font-display text-sm tracking-[0.2em] text-gold-2 uppercase">This week’s Pot</h3>
      <div className="rule my-3" />
      <div className="num text-3xl text-gold-3">
        {formatToken(pool, fesDec)} <span className="text-base text-parchment-2">{prizeSym}</span>
      </div>
      <div className="mt-1 font-serif text-sm text-parchment-3">Top three share it 50 / 30 / 20</div>
      <div className="font-serif text-sm text-parchment-3">Every payment: 50% to the Pot, 50% burned</div>
      <div className="mt-4 flex items-baseline justify-between">
        <span className="label">Closes in</span>
        <span className="text-parchment">
          <Countdown to={comp?.endsAt} compact />
        </span>
      </div>

      <div className="rule my-4" />
      <div className="flex items-baseline justify-between">
        <h3 className="font-display text-sm tracking-[0.2em] text-gold-2 uppercase">Leaderboard</h3>
        <Link href="/leaderboard" className="font-serif text-sm text-parchment-3 hover:text-gold-2">
          View all →
        </Link>
      </div>
      {isError && <p className="mt-3 font-serif text-parchment-3 italic">The leaderboard isn’t loading right now.</p>}
      {!isError && !isLoading && top.length === 0 && <p className="mt-3 font-serif text-parchment-3 italic">No scores yet this week. Be the first.</p>}
      <ol className="mt-3 space-y-1.5">
        {top.map((r) => (
          <li key={r.key} className={`flex items-center justify-between gap-2 px-2 py-1 ${r.address === me ? 'bg-gold/15 outline outline-gold/40' : ''}`}>
            <span className="flex min-w-0 items-center gap-2">
              <span className={`num w-5 shrink-0 text-right text-sm ${r.prizeRank ? 'text-gold-3' : 'text-parchment-3'}`}>{r.position}</span>
              <span className="num truncate text-sm text-parchment-2">{r.displayName ?? shortAddress(r.address)}</span>
              {r.kind === 'free' && <span className="shrink-0 font-display text-[0.55rem] tracking-[0.15em] text-parchment-3 uppercase">free</span>}
            </span>
            <span className="num text-sm text-parchment">{formatScore(r.score)}</span>
          </li>
        ))}
      </ol>
      {mine && mine.position > SHOWN && (
        <div className="mt-2 flex justify-between border-t border-gold/20 px-2 pt-2">
          <span className="num text-sm text-gold-2">#{mine.position} You</span>
          <span className="num text-sm text-parchment">{formatScore(mine.score)}</span>
        </div>
      )}

      <div className="rule my-4" />
      <div className="flex items-baseline justify-between font-serif text-sm text-parchment-3">
        <span className="label">Competitive game</span>
        <span className="num text-parchment-2">{entry.usd}</span>
      </div>
      <div className="mt-1.5 flex items-baseline justify-between font-serif text-sm text-parchment-3">
        <span className="label">Bonus life</span>
        <span className="num text-parchment-2">{life.usd}</span>
      </div>
      <Link href="/rules" className="mt-3 block text-right font-serif text-sm text-gold-2 hover:underline">
        Rules →
      </Link>
    </section>
  );
}
