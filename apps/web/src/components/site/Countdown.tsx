'use client';

import { useEffect, useState } from 'react';
import { countdownParts } from '@/lib/format';

export function Countdown({ to, compact = false }: { to: string | number | null | undefined; compact?: boolean }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  if (!to || now === null) return <span className="num">—</span>;
  const end = typeof to === 'number' ? to : Date.parse(to);
  const { d, h, m, s } = countdownParts(end - now);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (compact) {
    return (
      <span className="num">
        {d}d {pad(h)}h {pad(m)}m {pad(s)}s
      </span>
    );
  }
  return (
    <span className="num inline-flex gap-3">
      {[
        [d, 'days'],
        [h, 'hrs'],
        [m, 'min'],
        [s, 'sec'],
      ].map(([v, l]) => (
        <span key={l as string} className="flex flex-col items-center">
          <span className="text-3xl font-semibold text-gold-3">{pad(v as number)}</span>
          <span className="label text-[0.55rem]!">{l}</span>
        </span>
      ))}
    </span>
  );
}
