'use client';

import { STAGES, STAGE_REMARKS, type SimEvent } from '@fes/game-core';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { GameRunner, type CheckpointSnapshot, type HudState, type RunSummary } from '@/game/runner';
import { formatScore, formatTime } from '@/lib/format';
import { VoyageGauge } from './VoyageGauge';

export type StagePhase = 'ready' | 'launching' | 'running' | 'paused' | 'sinking' | 'offer' | 'result';

export interface GameStageProps {
  mode: 'practice' | 'ranked';
  /** Called on SPACE. Resolves with the seed to sail — ranked seeds are issued by the server. */
  acquireSeed: () => Promise<string>;
  /** Whether SPACE may launch right now (ranked: an unused, verified entry exists). */
  canLaunch: boolean;
  /** Shown in the ready overlay when the player cannot launch yet. */
  notReadyContent?: ReactNode;
  /** Shown under the title in the ready overlay. */
  readyCaption?: ReactNode;
  /** Shown at the top of the ready overlay in place of the mode label (e.g. a practice / ranked switch). */
  overlayTop?: ReactNode;
  /** Shown under the launch button (e.g. who the voyage will be recorded for). */
  readyFooter?: ReactNode;
  /** Projected weekly rank for a score (null if unknown / practice). */
  rankFor?: (score: number) => number | null;
  /** The explorer's best score so far, to celebrate passing it mid-voyage (null or 0: none yet). */
  personalBest?: number | null;
  onCheckpoint?: (snap: CheckpointSnapshot) => void;
  onRunEnd?: (summary: RunSummary) => void;
  onPhase?: (phase: StagePhase) => void;
  renderResult?: (summary: RunSummary, again: () => void) => ReactNode;
  /**
   * After a loss, before the result: whether to offer the voyage its bonus life. While offered, `renderLifeOffer`
   * is shown; it calls `revive` to carry on (the voyage resumes) or `decline` to end it (the result follows).
   */
  offerLife?: (summary: RunSummary) => boolean;
  renderLifeOffer?: (summary: RunSummary, actions: { revive: () => boolean; decline: () => void }) => ReactNode;
  launchError?: string | null;
}

interface Banner {
  key: number;
  title: string;
  sub: string;
}

export function GameStage(props: GameStageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runnerRef = useRef<GameRunner | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [phase, setPhaseState] = useState<StagePhase>('ready');
  const phaseRef = useRef<StagePhase>('ready');
  const [hud, setHud] = useState<HudState | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const summaryRef = useRef<RunSummary | null>(null);
  summaryRef.current = summary;
  const [muted, setMuted] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(true);
  /** "+250" / "+2,500" floating up beside the score as treasure is collected. */
  const [gains, setGains] = useState<{ key: number; text: string; big: boolean }[]>([]);
  /** Call-outs over the sea: a close call, a new personal best. */
  const [callouts, setCallouts] = useState<{ key: number; text: string; best: boolean }[]>([]);
  const lastCloseCall = useRef(0);
  /** The personal best has been passed this voyage (announced once). */
  const passedBest = useRef(false);
  /** Bumped each time the weekly rank climbs, to flash it. */
  const [rankFlash, setRankFlash] = useState(0);
  const lastRank = useRef<number | null>(null);

  const callout = useCallback((text: string, best: boolean) => {
    const c = { key: Date.now() + Math.random(), text, best };
    setCallouts((list) => [...list.slice(-1), c]);
    window.setTimeout(() => setCallouts((list) => list.filter((x) => x !== c)), 1300);
  }, []);

  const setPhase = useCallback((p: StagePhase) => {
    phaseRef.current = p;
    setPhaseState(p);
    propsRef.current.onPhase?.(p);
  }, []);

  // While the ship is under way (and going down) the pointer is hidden: steering is all keys. It is back when there is
  // something to click: on pausing, the bonus-life offer and the result.
  useEffect(() => {
    if (phase !== 'launching' && phase !== 'running' && phase !== 'sinking') return;
    document.documentElement.classList.add('sailing');
    return () => document.documentElement.classList.remove('sailing');
  }, [phase]);

  useEffect(() => {
    try {
      setMuted(localStorage.getItem('fes:muted') === '1');
    } catch {
      /* storage unavailable */
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const runner = new GameRunner(canvas, props.mode, {});
    runnerRef.current = runner;
    if (process.env.NODE_ENV !== 'production') {
      (window as unknown as { __fesRunner?: GameRunner }).__fesRunner = runner;
      // Development aid: the hazard artwork, for galleries in browser tests.
      void import('@/game/art3d').then((m) => ((window as unknown as { __fesArt3d?: unknown }).__fesArt3d = m));
    }
    return () => {
      runner.destroy();
      runnerRef.current = null;
    };
    // The runner lives for the lifetime of the stage; mode changes remount the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    runnerRef.current?.setMuted(muted);
    try {
      localStorage.setItem('fes:muted', muted ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  }, [muted]);

  useEffect(() => {
    const runner = runnerRef.current;
    if (!runner) return;
    runner.setCallbacks({
      onHud: (h) => {
        setHud(h);
        const best = propsRef.current.personalBest;
        if (!passedBest.current && best && h.score > best && phaseRef.current === 'running') {
          passedBest.current = true;
          callout('New personal best', true);
          runnerRef.current?.sound.personalBest();
        }
      },
      onEvent: (e: SimEvent) => {
        if (e.type === 'nearMiss') {
          const now = performance.now();
          if (now - lastCloseCall.current > 1500) {
            lastCloseCall.current = now;
            callout('Close call', false);
          }
        } else if (e.type === 'stage') {
          const st = STAGES[e.stage];
          setBanner({ key: Date.now(), title: st.name, sub: STAGE_REMARKS[e.stage] ?? st.description });
        } else if (e.type === 'protectionEnd') {
          window.setTimeout(() => setShowControls(false), 2500);
        } else if (e.type === 'evidence') {
          const pts = runnerRef.current?.sim.config.evidence;
          if (!pts) return;
          const gain = { key: e.id, text: `+${(e.superCoin ? pts.superPoints : pts.points).toLocaleString('en-US')}`, big: e.superCoin };
          setGains((g) => [...g.slice(-4), gain]);
          window.setTimeout(() => setGains((g) => g.filter((x) => x !== gain)), e.superCoin ? 1600 : 1000);
        }
      },
      onDeath: () => setPhase('sinking'),
      onEnd: (s) => {
        setSummary(s);
        if (propsRef.current.offerLife?.(s)) {
          setPhase('offer');
          return;
        }
        setPhase('result');
        propsRef.current.onRunEnd?.(s);
      },
      onCheckpoint: (snap) => propsRef.current.onCheckpoint?.(snap),
    });
  }, [setPhase, callout]);

  const launch = useCallback(async () => {
    const runner = runnerRef.current;
    if (!runner || phaseRef.current !== 'ready' || !propsRef.current.canLaunch) return;
    setLaunchError(null);
    setPhase('launching');
    runner.sound.ensure();
    try {
      const seed = await propsRef.current.acquireSeed();
      runner.load(seed);
      if (process.env.NODE_ENV !== 'production') {
        const q = new URLSearchParams(window.location.search);
        if (q.has('autopilot')) runner.enableAutopilot();
        if (q.has('skip')) runner.fastForward(Number(q.get('skip')));
      }
      runner.begin();
      passedBest.current = false;
      lastRank.current = null;
      setCallouts([]);
      setSummary(null);
      setShowControls(runner.sim.tick === 0);
      const stage = runner.sim.stageIndex;
      setBanner({ key: Date.now(), title: STAGES[stage].name, sub: STAGE_REMARKS[stage] });
      setPhase('running');
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : 'Couldn’t start the voyage. Please try again.');
      setPhase('ready');
    }
  }, [setPhase]);

  const revive = useCallback(() => {
    const runner = runnerRef.current;
    if (!runner || phaseRef.current !== 'offer' || !runner.revive()) return false;
    setSummary(null);
    setBanner({ key: Date.now(), title: 'A second chance', sub: 'The Society has put your ship back on the water.' });
    setPhase('running');
    return true;
  }, [setPhase]);

  const decline = useCallback(() => {
    if (phaseRef.current !== 'offer') return;
    const s = summaryRef.current;
    setPhase('result');
    if (s) propsRef.current.onRunEnd?.(s);
  }, [setPhase]);

  /** From the result: free play sets sail again at once; competitive play goes back to the launch screen. */
  const again = useCallback(() => {
    setSummary(null);
    setHud(null);
    setPhase('ready');
    if (propsRef.current.mode === 'practice') void launch();
  }, [setPhase, launch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const p = phaseRef.current;
      if (e.code === 'Space' && p === 'ready') {
        e.preventDefault();
        void launch();
      } else if (e.code === 'Escape' && propsRef.current.mode === 'practice' && (p === 'running' || p === 'paused')) {
        const r = runnerRef.current;
        if (!r) return;
        r.togglePause();
        setPhase(r.isPaused ? 'paused' : 'running');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [launch, setPhase]);

  const live = phase === 'running' || phase === 'paused' || phase === 'sinking' || phase === 'offer' || phase === 'result';
  const rank = live && hud && props.rankFor ? props.rankFor(hud.score) : null;

  // Flash the rank as the voyage climbs the leaderboard.
  useEffect(() => {
    if (phase !== 'running' || rank === null) return;
    if (lastRank.current !== null && rank < lastRank.current) setRankFlash((k) => k + 1);
    lastRank.current = rank;
  }, [rank, phase]);
  const edgeWarning = hud && (phase === 'running' || phase === 'paused') && hud.edgeDistance < 110;

  return (
    <div className="relative aspect-video w-full overflow-hidden bg-black select-none rope" data-phase={phase}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      {/* HUD */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-4">
        <div className="min-w-40">
          {hud && phase !== 'ready' && phase !== 'launching' && (
            <>
              <div className="label text-[0.6rem] text-parchment-3">{props.mode === 'practice' ? 'Free play' : 'Competitive'}</div>
              <div className="font-display text-sm text-gold-2">{STAGES[hud.stageIndex]?.name}</div>
            </>
          )}
        </div>
        <div className={`flex gap-3 transition-opacity duration-300 ${phase === 'ready' || phase === 'launching' ? 'invisible opacity-0' : 'opacity-100'}`}>
          <div className="relative">
            <HudPlaque label="Score" value={hud ? formatScore(hud.score) : '0'} wide />
            <div className="pointer-events-none absolute top-full left-1/2 -translate-x-1/2">
              {gains.map((g) => (
                <div
                  key={g.key}
                  className={`gain-rise absolute top-1 left-0 font-display font-semibold whitespace-nowrap drop-shadow-[0_2px_4px_rgba(0,0,0,0.9)] ${g.big ? 'text-2xl text-[#ffd27a]' : 'text-lg text-gold-3'}`}
                  style={{ animationDuration: g.big ? '1.6s' : '1s' }}
                >
                  {g.text}
                </div>
              ))}
            </div>
          </div>
          <HudPlaque label="Time" value={formatTime(hud?.timeMs ?? 0)} />
          <HudPlaque label="Rank" value={rank ? `#${rank}` : '—'} flashKey={rankFlash} />
        </div>
        <div className="pointer-events-auto flex min-w-40 justify-end">
          <button
            type="button"
            onClick={() => setMuted((m) => !m)}
            className="btn-ghost btn px-3! py-2! text-[0.65rem]!"
            aria-label={muted ? 'Unmute sound' : 'Mute sound'}
          >
            {muted ? 'Sound: off' : 'Sound: on'}
          </button>
        </div>
      </div>

      {hud && (phase === 'running' || phase === 'paused' || phase === 'sinking') && (
        <div className="pointer-events-none absolute right-4 bottom-4 opacity-95">
          <VoyageGauge x={hud.shipX} halfWidth={hud.halfWidth} speed={hud.speed} />
        </div>
      )}

      {hud && hud.evidence > 0 && phase !== 'ready' && (
        <div className="pointer-events-none absolute bottom-5 left-5 flex items-center gap-2">
          <span className="inline-block h-4 w-4 rounded-full bg-linear-to-br from-gold-3 to-bronze shadow-[0_0_10px_rgba(242,213,126,0.6)]" />
          <span className="num text-sm text-gold-2">
            × {hud.evidence} treasure{hud.superCoins > 0 ? ` · ${hud.superCoins} super` : ''}
          </span>
        </div>
      )}

      {banner && (phase === 'running' || phase === 'sinking') && (
        <div key={banner.key} className="stage-banner pointer-events-none absolute inset-x-0 top-[20%] flex justify-center">
          {/* A dark band behind the words: the banner crosses the brightest part of the sky. */}
          <div className="bg-[radial-gradient(closest-side,rgba(10,8,5,0.7),rgba(10,8,5,0.4)_60%,transparent)] px-28 py-7 text-center">
            <div className="font-display text-3xl text-gold-3 uppercase drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]">{banner.title}</div>
            <div className="mt-2 font-serif text-lg text-parchment italic drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]">{banner.sub}</div>
          </div>
        </div>
      )}

      {phase === 'running' &&
        callouts.map((c) => (
          <div
            key={c.key}
            className={`callout pointer-events-none absolute left-1/2 font-display tracking-[0.3em] whitespace-nowrap uppercase drop-shadow-[0_2px_8px_rgba(0,0,0,0.95)] ${c.best ? 'top-[34%] text-2xl text-verdigris' : 'top-[46%] text-lg text-parchment'}`}
          >
            {c.text}
          </div>
        ))}

      {edgeWarning && (
        <div className="pointer-events-none absolute inset-x-0 bottom-28 text-center">
          <span className="font-display text-sm tracking-[0.4em] text-[#f0b49a] uppercase drop-shadow-[0_2px_6px_rgba(0,0,0,0.95)] animate-pulse">
            The Edge is close
          </span>
        </div>
      )}

      {(phase === 'running' || phase === 'launching') && showControls && (
        <div className="pointer-events-none absolute inset-x-0 bottom-6 text-center fade-up">
          <div className="font-display text-sm tracking-[0.3em] text-parchment uppercase drop-shadow-[0_2px_6px_rgba(0,0,0,0.95)]">← → or A / D to steer</div>
          <div className="mt-1 font-display text-xs tracking-[0.5em] text-gold-2 uppercase">Survive the Edge</div>
        </div>
      )}

      {/* Overlays */}
      {(phase === 'ready' || phase === 'launching') && (
        <div className="absolute inset-0 flex overflow-y-auto bg-[radial-gradient(ellipse_at_center,rgba(13,11,8,0.35),rgba(13,11,8,0.85))] py-4">
          <div className="plaque fade-up m-auto w-[min(560px,84%)] px-10 py-8 text-center">
            {props.overlayTop ?? <div className="label">{props.mode === 'practice' ? 'Free play' : 'Competitive play'}</div>}
            <h2 className="mt-3 font-display text-3xl text-gold-2 candle">The Society Test</h2>
            <div className="rule my-5" />
            {props.readyCaption && <div className="mb-5 font-serif text-lg text-parchment-2">{props.readyCaption}</div>}
            {props.canLaunch ? (
              <>
                <div className="mb-5 flex items-center justify-center gap-3 text-parchment-2">
                  <Key>←</Key>
                  <Key>→</Key>
                  <span className="font-serif italic">or</span>
                  <Key>A</Key>
                  <Key>D</Key>
                  <span className="font-serif text-base italic">to steer</span>
                </div>
                <button type="button" className="btn btn-gold pulse-gold" onClick={() => void launch()} disabled={phase === 'launching'}>
                  {phase === 'launching' ? 'Preparing your vessel…' : 'Press Space to launch'}
                </button>
                {props.readyFooter}
              </>
            ) : (
              props.notReadyContent
            )}
            {(launchError || props.launchError) && <div className="mt-4 font-serif text-base text-[#f0b49a]">{launchError || props.launchError}</div>}
          </div>
        </div>
      )}

      {phase === 'paused' && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/55">
          <div className="plaque px-10 py-8 text-center">
            <div className="font-display text-2xl text-gold-2">Paused</div>
            <div className="mt-2 font-serif text-lg text-parchment-2 italic">Press Escape to resume.</div>
          </div>
        </div>
      )}

      {phase === 'offer' && summary && props.renderLifeOffer && (
        <div className="absolute inset-0 flex overflow-y-auto bg-[radial-gradient(ellipse_at_center,rgba(13,11,8,0.45),rgba(5,4,3,0.9))] py-3">
          {props.renderLifeOffer(summary, { revive, decline })}
        </div>
      )}

      {phase === 'result' && summary && props.renderResult && (
        <div className="absolute inset-0 flex overflow-y-auto bg-[radial-gradient(ellipse_at_center,rgba(13,11,8,0.55),rgba(5,4,3,0.94))] py-3">
          {props.renderResult(summary, again)}
        </div>
      )}
    </div>
  );
}

function HudPlaque({ label, value, wide, flashKey = 0 }: { label: string; value: string; wide?: boolean; flashKey?: number }) {
  return (
    <div className={`plaque px-4 py-2 text-center ${wide ? 'min-w-36' : 'min-w-24'}`}>
      <div className="label text-[0.58rem]!">{label}</div>
      <div className="num text-2xl font-semibold text-gold-3">
        <span key={flashKey} className={flashKey ? 'hud-flash' : undefined}>
          {value}
        </span>
      </div>
    </div>
  );
}

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-9 min-w-9 items-center justify-center rounded-sm border border-gold/60 bg-ink-3 px-2 font-display text-sm text-gold-2 shadow-[inset_0_-2px_0_rgba(0,0,0,0.6)]">
      {children}
    </kbd>
  );
}
