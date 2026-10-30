'use client';

import { useState, type ReactNode } from 'react';
import { EXPLORER_URL } from '@/lib/env';

/** Where the burned half of every payment goes: an address no one holds a key for. */
const DEAD = '0x000000000000000000000000000000000000dEaD';
import { formatToken, shortAddress } from '@/lib/format';
import { priceOf, swapUrl } from '@/lib/prices';
import { useCompetition, useConfig, useTreasury } from '@/lib/queries';

/** How the Society Test is played and how its prizes work, in as few words as possible. */
export function RulesScreen() {
  const { data: cfg } = useConfig();
  const { data: comp } = useCompetition();
  const { data: treasury } = useTreasury();
  const entry = priceOf(cfg, 'entry');
  const life = priceOf(cfg, 'life');
  const wifDec = cfg?.wif?.decimals ?? 18;
  const burned = cfg?.protocolShareBurned !== false;
  const buy = swapUrl(cfg?.wif?.address);

  return (
    <div className="mx-auto max-w-[900px] px-4 pt-10 md:px-8">
      <div className="label">The Society Test</div>
      <h1 className="mt-2 font-display text-4xl text-gold-2 candle md:text-5xl">Game rules</h1>

      <Section title="How to play">
        <li>
          Your ship sails ahead on its own, faster and faster. Steer it sideways with <Key>←</Key> <Key>→</Key> or <Key>A</Key> <Key>D</Key>.
        </li>
        <li>Rocks, ice, walls, wrecks, kraken and whirlpools sink it, and so does sailing off the Edge on either side.</li>
        <li>
          The farther you sail, the higher your score: each knot of speed earns a point a second. A gold coin adds 250 points, a ruby super coin 2,500.
        </li>
        <li>The sea grows harder through five stages: Calm Waters, Uncharted Territory, Dangerous Waters, the Outer Rim and the Edge.</li>
        <li>
          <Key>Esc</Key> pauses free play. Competitive play can’t be paused. A voyage lasts 30 minutes at most.
        </li>
      </Section>

      <Section title="Free and competitive play">
        <li>Free play is free and never wins a prize.</li>
        <li>
          A competitive game costs {entry.usd}
          {entry.wif ? ` (${entry.wif} today)` : ''}, paid in $WIF from your wallet on Robinhood Chain.
        </li>
        <li>
          When your ship sinks in a competitive game, one bonus life costs {life.usd}: you keep your score and sail on from where you sank, shielded for a moment.
        </li>
      </Section>

      <Section title="Prizes">
        <li>
          50% of every payment, for every competitive game and every bonus life, goes to the week’s Pot.{' '}
          {burned ? 'The other 50% is burned (below).' : 'The other 50% is kept by the Society.'}
        </li>
        <li>Weeks run Monday to Sunday (UTC). Your best competitive score of the week counts; a tie goes to whoever got there first.</li>
        <li>The week’s top three competitive scores win 50%, 30% and 20% of the Pot, paid in $WIF to their wallets after the week closes.</li>
      </Section>

      {burned && (
        <Section title="50% burned">
          <li>50% of every payment is burned, reducing the circulating supply of $WIF.</li>
          <li>
            Burned $WIF goes to the dead address <Addr label="" address={DEAD} />, which no one can ever spend from. The contract makes this permanent:
            no one can change it, not even the Society.
          </li>
          {treasury && BigInt(treasury.totals.wifProtocol) > 0n && (
            <li>
              Total burned: <span className="num text-parchment">{formatToken(treasury.totals.wifProtocol, wifDec)}</span> $WIF.
            </li>
          )}
        </Section>
      )}

      <Section title="Fair play">
        <li>Every competitive voyage is replayed by the server, move for move, and counts only if the replay matches.</li>
        <li>Unusual voyages near the top are checked by hand before they’re ranked.</li>
        <li>By paying, you confirm prize competitions are allowed where you live.</li>
      </Section>

      <Section title="Payment">
        <li>
          You need $WIF and a little ETH on Robinhood Chain for network fees.
          {buy && (
            <>
              {' '}
              <a href={buy} target="_blank" rel="noopener noreferrer" className="text-gold-2 underline-offset-2 hover:underline">
                Buy $WIF on Uniswap ↗
              </a>
            </>
          )}
        </li>
        {cfg?.wif?.address && (
          <li>
            The contract address for $WIF is <span className="num break-all text-parchment">{cfg.wif.address}</span> <CopyButton text={cfg.wif.address} />
          </li>
        )}
        {comp && BigInt(comp.wifCollected) > 0n && (
          <li>
            This week: <span className="num text-parchment">{formatToken(comp.wifCollected, wifDec)}</span> $WIF paid ·{' '}
            <span className="num text-parchment">{formatToken(comp.wifRewardAllocation, wifDec)}</span> to the Pot ·{' '}
            <span className="num text-parchment">{formatToken(comp.wifProtocol, wifDec)}</span> {burned ? 'burned' : 'to the Society'}
          </li>
        )}
        {cfg?.entryContract && (
          <li>
            Contracts: <Addr label="entry" address={cfg.entryContract} /> · <Addr label="prize vault" address={cfg.vaultContract} /> ·{' '}
            <Addr label="$WIF" address={cfg.wif?.address} />
          </li>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="plaque mt-6 p-7">
      <h2 className="font-display text-xl tracking-[0.12em] text-gold-2 uppercase">{title}</h2>
      <ul className="mt-4 list-disc space-y-2 pl-5 font-serif text-lg text-parchment-2 marker:text-gold">{children}</ul>
    </section>
  );
}

/** Copies `text` (the $WIF contract address) and says so for a moment. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ml-1 border border-gold/45 px-2 py-0.5 align-middle font-display text-[0.7rem] tracking-[0.14em] text-gold-2 uppercase hover:bg-gold/10"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function Key({ children }: { children: ReactNode }) {
  return <kbd className="mx-0.5 inline-block min-w-[1.6em] border border-gold/45 px-1.5 text-center font-display text-[0.8rem] text-gold-2">{children}</kbd>;
}

function Addr({ label, address }: { label: string; address: string | null | undefined }) {
  if (!address) return <span>{label}</span>;
  const href = EXPLORER_URL ? `${EXPLORER_URL.replace(/\/$/, '')}/address/${address}` : null;
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="text-gold-2 hover:underline">
      {label && `${label} `}
      {shortAddress(address)}
    </a>
  ) : (
    <span className="num">
      {label && `${label} `}
      {shortAddress(address)}
    </span>
  );
}
