'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { SocietySeal } from './SocietySeal';

/**
 * The Society Test is designed for desktop keyboards and screens. Smaller or touch-only devices get a polite refusal,
 * except on the leaderboard, the rules and the lore, which anyone can read anywhere.
 */
export function DesktopGate({ children }: { children: ReactNode }) {
  const [unsupported, setUnsupported] = useState(false);
  const path = usePathname();
  const readOnly = !!path && ['/leaderboard', '/rules', '/lore'].some((p) => path.startsWith(p));

  useEffect(() => {
    const check = () => {
      const touchOnly = window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(any-pointer: fine)').matches;
      setUnsupported(window.innerWidth < 1024 || window.innerHeight < 560 || touchOnly);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const gated = unsupported && !readOnly;
  return (
    <>
      {/* Behind the refusal nothing runs: no game loop draining a phone's battery. */}
      {!gated && children}
      {gated && (
        <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 bg-ink px-8 text-center">
          <SocietySeal size={180} />
          <h1 className="font-display text-2xl text-gold-2">A Larger Vessel Is Required</h1>
          <p className="max-w-md font-serif text-lg text-parchment-2">The Society Test is played with a keyboard on a larger screen. Open this page on a computer to play.</p>
          <Link href="/leaderboard" className="btn btn-ghost">
            See this week’s leaderboard
          </Link>
        </div>
      )}
    </>
  );
}
