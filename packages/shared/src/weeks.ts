/**
 * Competition weeks run Monday 00:00:00 UTC → Sunday 23:59:59 UTC. The same
 * arithmetic is used onchain (SocietyWeeks.sol), so a payment's week is
 * unambiguous: weekId = floor((unixSeconds − EPOCH) / WEEK).
 */
export const WEEK_EPOCH_SECONDS = 345_600; // Monday 1970-01-05 00:00:00 UTC
export const WEEK_SECONDS = 604_800;

export function weekIdAt(unixMs: number): number {
  return Math.floor((Math.floor(unixMs / 1000) - WEEK_EPOCH_SECONDS) / WEEK_SECONDS);
}

/** Start of the week in unix milliseconds (inclusive). */
export function weekStartMs(weekId: number): number {
  return (WEEK_EPOCH_SECONDS + weekId * WEEK_SECONDS) * 1000;
}

/** End of the week in unix milliseconds (exclusive — the next week's start). */
export function weekEndMs(weekId: number): number {
  return weekStartMs(weekId + 1);
}

/** "Week of 3 Nov 2026" */
export function weekLabel(weekId: number): string {
  const d = new Date(weekStartMs(weekId));
  return `Week of ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`;
}
