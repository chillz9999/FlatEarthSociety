'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useAccount } from 'wagmi';
import { JoinForm } from '@/components/site/JoinForm';
import { placeOnBoard, useCombinedBoard } from '@/lib/board';
import { priceOf } from '@/lib/prices';
import { useConfig } from '@/lib/queries';
import { load, store } from '@/lib/storage';
import { useExplorer } from './ExplorerGate';
import { PracticeArena } from './PracticeArena';
import { RankedArena } from './RankedArena';
import { WeekPanel } from './WeekPanel';

type Mode = 'practice' | 'ranked';

/** The explorer chose to play without a name (remembered on this device). */
const GUEST_KEY = 'fes:guest';

export function TestScreen() {
  /** Free play or competitive play; null until the explorer has chosen. */
  const [mode, setMode] = useState<Mode | null>(null);
  const [guest, setGuestState] = useState(false);
  /** While a voyage is under way the mode cannot change (it would abandon a ranked attempt). */
  const [locked, setLocked] = useState(false);
  const { rows } = useCombinedBoard();
  const { address } = useAccount();
  const explorer = useExplorer();

  useEffect(() => {
    setGuestState(load<boolean>(GUEST_KEY) === true);
    const m = new URLSearchParams(window.location.search).get('mode');
    if (m === 'ranked' || m === 'practice') setMode(m);
  }, []);

  const setGuest = useCallback((g: boolean) => {
    store(GUEST_KEY, g || null);
    setGuestState(g);
  }, []);

  /** Back to the name field (from a guest's "Add your name"). */
  const addName = useCallback(() => {
    setGuest(false);
    setMode(null);
  }, [setGuest]);

  /** Where a score would place on this week's leaderboard (competitive and free play together). */
  const rankFor = useCallback((score: number) => placeOnBoard(rows, score, address, mode === 'ranked' ? 'competitive' : 'free'), [rows, address, mode]);

  // First a name (or play as a guest), then free or competitive play.
  const named = !explorer.gate;
  const needsName = !named && !guest && !explorer.offline;
  const intro = needsName ? (
    <NameStep onGuest={() => setGuest(true)} />
  ) : mode === null ? (
    <ChooseMode name={named ? explorer.name : null} onChoose={setMode} onAddName={explorer.offline || named ? undefined : addName} />
  ) : undefined;

  // Once chosen, the mode can be switched from the top of the panel.
  const modeSwitch =
    mode === null ? undefined : (
      <div className="flex justify-center border-b border-gold/20" role="tablist" aria-label="How to play">
        {(['practice', 'ranked'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            disabled={locked && mode !== m}
            className={`-mb-px border-b-2 px-5 pb-2 font-display text-xs tracking-[0.22em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${mode === m ? 'border-gold text-gold-3' : 'border-transparent text-parchment-3 hover:text-parchment'}`}
          >
            {m === 'practice' ? 'Free play' : 'Competitive play'}
          </button>
        ))}
      </div>
    );

  return (
    <div className="mx-auto flex max-w-[1680px] justify-center gap-6 px-8 py-5">
      {/* The game fills the window: as wide as the column allows, never taller than the screen below the header. */}
      <section className="min-w-0 flex-1 max-w-[calc((100vh-6.5rem)*16/9)]">
        {mode === 'ranked' ? (
          <RankedArena key="ranked" rankFor={rankFor} modeSwitch={modeSwitch} onWantPractice={() => setMode('practice')} onLock={setLocked} />
        ) : (
          <PracticeArena key="practice" intro={intro} rankFor={rankFor} modeSwitch={modeSwitch} onWantRanked={() => setMode('ranked')} onAddName={addName} onLock={setLocked} />
        )}
      </section>
      <aside className="hidden w-[300px] shrink-0 xl:block">
        <WeekPanel />
      </aside>
    </div>
  );
}

/** The first thing a new explorer sees: a name for the leaderboard, or play as a guest. */
function NameStep({ onGuest }: { onGuest: () => void }) {
  return (
    <div>
      <div className="font-display text-xl text-gold-2">Add your name</div>
      <div className="mt-1 font-serif text-lg text-parchment-2">It goes on the leaderboard with your scores.</div>
      <div className="mx-auto mt-4 max-w-sm">
        <JoinForm submitLabel="Continue" />
      </div>
      <button type="button" className="mt-5 font-serif text-base text-parchment-3 underline-offset-2 hover:text-gold-2 hover:underline" onClick={onGuest}>
        Play as a guest
      </button>
    </div>
  );
}

/** Free play or competitive play. */
function ChooseMode({ name, onChoose, onAddName }: { name: string | null; onChoose: (m: Mode) => void; onAddName?: () => void }) {
  const { data: cfg } = useConfig();
  const entry = priceOf(cfg, 'entry');
  return (
    <div>
      {name ? (
        <div className="font-serif text-lg text-parchment-2">
          Welcome, <span className="text-gold-2">{name}</span>.
        </div>
      ) : (
        onAddName && (
          <div className="font-serif text-base text-parchment-3">
            Playing as a guest ·{' '}
            <button type="button" className="text-gold-2 underline-offset-2 hover:underline" onClick={onAddName}>
              Add your name
            </button>
          </div>
        )
      )}
      <div className="mt-5 grid grid-cols-2 gap-4">
        <Choice title="Free play" text="Play as often as you like. No prizes." onClick={() => onChoose('practice')} />
        <Choice title="Competitive play" text={`${entry.usd} a game. The week’s top three win $WIF.`} onClick={() => onChoose('ranked')} gold />
      </div>
    </div>
  );
}

function Choice({ title, text, onClick, gold }: { title: ReactNode; text: ReactNode; onClick: () => void; gold?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group border px-5 py-5 text-center transition-colors ${gold ? 'border-gold/70 bg-gold/10 hover:bg-gold/20' : 'border-gold/35 hover:border-gold/70 hover:bg-gold/5'}`}
    >
      <div className="font-display text-sm tracking-[0.16em] whitespace-nowrap text-gold-3 uppercase">{title}</div>
      <div className="mt-2 font-serif text-base text-parchment-2">{text}</div>
    </button>
  );
}
