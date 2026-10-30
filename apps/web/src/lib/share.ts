import type { DeathCause } from '@fes/game-core';

/** The public address of the Society's site, shared with every score. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://www.flatearthsociety.xyz').replace(/\/$/, '');

/** How each loss reads on a shared score. */
const CAUSE_LABELS: Record<DeathCause, string> = {
  rock: 'Rocks',
  island: 'Ran aground',
  debris: 'Wreckage',
  iceberg: 'Iceberg',
  tentacle: 'A kraken’s tentacle',
  leviathan: 'The leviathan',
  wreck: 'A shipwreck',
  pillar: 'The Society’s gate',
  colossus: 'The Colossus',
  whirlpool: 'Whirlpool',
  edge: 'Fell off the Edge',
  timeout: 'None. Sailed the whole examination',
};

/** The text posted when an explorer shares a score. */
export function shareText(score: number, cause: DeathCause | null, ranked: boolean): string {
  const survived = cause === null || cause === 'timeout';
  return [
    survived ? 'My voyage is complete. The truth remains out there.' : 'My ship was destroyed. The truth remains out there.',
    `🚢 Score: ${score.toLocaleString('en-US')}`,
    `🌍 Society Test: ${ranked ? 'Competitive' : 'Free play'}`,
    `💀 Lost to: ${cause ? CAUSE_LABELS[cause] : CAUSE_LABELS.timeout}`,
    '',
    `The Truth Lies at the Edge. ${SITE_URL}`,
  ].join('\n');
}

/** Open a share-to-X intent for a score. The site link is part of the text. */
export function shareScore(score: number, cause: DeathCause | null, ranked: boolean): void {
  const url = `https://x.com/intent/post?text=${encodeURIComponent(shareText(score, cause, ranked))}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}
