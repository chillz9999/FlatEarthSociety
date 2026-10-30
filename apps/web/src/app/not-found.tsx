import type { Metadata } from 'next';
import Link from 'next/link';
import { SocietySeal } from '@/components/site/SocietySeal';

export const metadata: Metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center px-6 py-24 text-center">
      <SocietySeal size={120} />
      <div className="label mt-8">Error 404</div>
      <h1 className="mt-3 font-display text-4xl text-gold-2">Uncharted waters</h1>
      <p className="mt-4 font-serif text-xl text-parchment-2">This page isn’t on any of the Society’s charts.</p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link href="/" className="btn btn-gold">
          Play the Society Test
        </Link>
        <Link href="/leaderboard" className="btn btn-ghost">
          Leaderboard
        </Link>
      </div>
    </div>
  );
}
