'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, subscribeEvents } from './api';

export function useConfig() {
  return useQuery({ queryKey: ['config'], queryFn: api.config, staleTime: 60_000, retry: 1 });
}

export function useCompetition() {
  return useQuery({ queryKey: ['competition'], queryFn: api.competition, refetchInterval: 30_000, retry: 1 });
}

export function useLeaderboard(week?: number, limit = 100) {
  return useQuery({ queryKey: ['leaderboard', week ?? 'current', limit], queryFn: () => api.leaderboard(week, limit), refetchInterval: 30_000, retry: 1 });
}

export function usePracticeLeaderboard(week?: number, limit = 100) {
  return useQuery({
    queryKey: ['practice-leaderboard', week ?? 'current', limit],
    queryFn: () => api.practiceLeaderboard(week, limit),
    refetchInterval: 30_000,
    retry: 1,
  });
}

/** All-time totals: everything paid, to the Pot, and burned (games and bonus lives, every week). */
export function useTreasury() {
  return useQuery({ queryKey: ['treasury'], queryFn: api.treasury, refetchInterval: 60_000, retry: 1 });
}

export function useHall() {
  return useQuery({ queryKey: ['hall'], queryFn: api.hall, staleTime: 60_000, retry: 1 });
}

export function usePlayer(address: string | null | undefined) {
  return useQuery({ queryKey: ['player', address?.toLowerCase()], queryFn: () => api.player(address!), enabled: !!address, retry: 1 });
}

/** Keep leaderboard and competition data live via server-sent events. */
export function useLiveUpdates() {
  const qc = useQueryClient();
  useEffect(
    () =>
      subscribeEvents((type) => {
        if (type === 'leaderboard') {
          void qc.invalidateQueries({ queryKey: ['leaderboard'] });
          void qc.invalidateQueries({ queryKey: ['competition'] });
          void qc.invalidateQueries({ queryKey: ['player'] });
        } else if (type === 'practice') {
          void qc.invalidateQueries({ queryKey: ['practice-leaderboard'] });
          void qc.invalidateQueries({ queryKey: ['player'] });
        } else if (type === 'competition') {
          void qc.invalidateQueries({ queryKey: ['competition'] });
          void qc.invalidateQueries({ queryKey: ['treasury'] });
          void qc.invalidateQueries({ queryKey: ['hall'] });
        }
      }),
    [qc],
  );
}
