'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ConnectWallet } from './ConnectWallet';

/** `desktop`: only on larger screens (phones can't play, so they get the pages they can read). */
const NAV: { href: string; label: string; short?: string; desktop?: boolean }[] = [
  { href: '/', label: 'Play', desktop: true },
  { href: '/leaderboard', label: 'Leaderboard' },
  { href: '/rules', label: 'Game rules', short: 'Rules' },
  { href: '/lore', label: 'Lore' },
];

export function SiteHeader() {
  const path = usePathname();
  const current = (href: string) => (href === '/' ? path === '/' : !!path?.startsWith(href));
  return (
    <header className="relative z-40 border-b border-gold/20 bg-ink/80 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-[1680px] items-center justify-between gap-4 px-4 md:px-8">
        <Link href="/" className="group flex items-center gap-3">
          {/* The Society's coin (public/logo.svg, also the favicon). */}
          {/* eslint-disable-next-line @next/next/no-img-element -- a static SVG: nothing for next/image to optimise */}
          <img src="/logo.svg" alt="" width={44} height={44} className="h-11 w-11" />
          <div className="hidden font-display text-[0.95rem] font-semibold tracking-[0.2em] text-gold-2 sm:block">The Flat Earth Society</div>
        </Link>
        <nav className="flex items-center gap-5 md:gap-9">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={current(n.href) ? 'page' : undefined}
              className={`link-underline font-display text-[0.78rem] tracking-[0.22em] whitespace-nowrap uppercase transition-colors ${n.desktop ? 'hidden sm:inline' : ''} ${current(n.href) ? 'text-gold-3' : 'text-parchment-2 hover:text-gold-2'}`}
            >
              {/* Phones get the short name, so the header keeps to one line. */}
              {n.short ? (
                <>
                  <span className="sm:hidden">{n.short}</span>
                  <span className="hidden sm:inline">{n.label}</span>
                </>
              ) : (
                n.label
              )}
            </Link>
          ))}
          {/* Playing needs a computer, so phones (the leaderboard only) get no wallet button. */}
          <div className="hidden lg:block">
            <ConnectWallet compact />
          </div>
        </nav>
      </div>
    </header>
  );
}
