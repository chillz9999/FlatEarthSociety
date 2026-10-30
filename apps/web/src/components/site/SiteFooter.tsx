import Link from 'next/link';

export function SiteFooter() {
  return (
    <footer className="mt-10 border-t border-gold/15 bg-ink/70">
      <div className="mx-auto flex max-w-[1680px] flex-col items-start justify-between gap-3 px-4 py-5 font-serif text-sm leading-relaxed text-parchment-3 md:flex-row md:items-center md:gap-10 md:px-8">
        <div className="shrink-0">
          <span className="font-display text-[0.7rem] tracking-[0.2em] text-gold-2 uppercase">The Flat Earth Society</span>
        </div>
        <p className="md:text-right">
          Prize competitions may be restricted where you live. Not financial advice.{' '}
          <Link className="text-gold-2 underline-offset-2 hover:underline" href="/rules">
            Rules
          </Link>
        </p>
      </div>
    </footer>
  );
}
