'use client';

import type { Leaderboard } from '@fes/shared';
import { useMemo } from 'react';
import { useLeaderboard, usePracticeLeaderboard } from './queries';

export type PlayKind = 'competitive' | 'free';

export interface BoardRow {
  key: string;
  /** Position on the combined board (competitive and free play together). */
  position: number;
  address: string;
  displayName: string | null;
  score: number;
  kind: PlayKind;
  /** 1–3 for the competitive scores in the prize places; free play never wins a prize. */
  prizeRank: number | null;
  achievedAt: string;
}

/** Each explorer's best competitive score and best free-play score, ranked together. */
export function combineBoards(ranked: Leaderboard | undefined, free: Leaderboard | undefined): BoardRow[] {
  const rows: Omit<BoardRow, 'position'>[] = [
    ...(ranked?.entries ?? []).map((e) => ({
      key: `c:${e.address}`,
      address: e.address,
      displayName: e.displayName,
      score: e.score,
      kind: 'competitive' as const,
      prizeRank: e.rank <= 3 ? e.rank : null,
      achievedAt: e.achievedAt,
    })),
    ...(free?.entries ?? []).map((e) => ({
      key: `f:${e.address}`,
      address: e.address,
      displayName: e.displayName,
      score: e.score,
      kind: 'free' as const,
      prizeRank: null,
      achievedAt: e.achievedAt,
    })),
  ];
  rows.sort((a, b) => b.score - a.score || a.achievedAt.localeCompare(b.achievedAt));
  return rows.map((r, i) => ({ ...r, position: i + 1 }));
}

/** This week's (or `week`'s) combined board. */
export function useCombinedBoard(week?: number) {
  const ranked = useLeaderboard(week, 100);
  const free = usePracticeLeaderboard(week, 100);
  const rows = useMemo(() => combineBoards(ranked.data, free.data), [ranked.data, free.data]);
  return {
    rows,
    ranked: ranked.data,
    isLoading: ranked.isLoading || free.isLoading,
    isError: ranked.isError && free.isError,
  };
}

/**
 * Where a score would place on the combined board. The explorer's own row of the same kind is left out, since a
 * new best replaces it.
 */
export function placeOnBoard(rows: BoardRow[], score: number, me: string | null | undefined, kind: PlayKind): number {
  const self = me?.toLowerCase();
  let place = 1;
  for (const r of rows) if (!(r.address === self && r.kind === kind) && r.score >= score) place++;
  return place;
}
