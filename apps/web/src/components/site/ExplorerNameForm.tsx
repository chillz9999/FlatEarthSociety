'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';

/** Choose or change the explorer name shown on the leaderboards. Names are unique. */
export function ExplorerNameForm({ initial = '', submitLabel = 'Save' }: { initial?: string; submitLabel?: string }) {
  const qc = useQueryClient();
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (n.length < 3) return setError('Use at least 3 characters.');
    setSaving(true);
    setError(null);
    try {
      await api.setName(n);
      await qc.invalidateQueries({ queryKey: ['player'] });
      void qc.invalidateQueries({ queryKey: ['leaderboard'] });
      void qc.invalidateQueries({ queryKey: ['practice-leaderboard'] });
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^displayName: /, '') : 'Couldn’t save your name. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(e) => void save(e)}>
      <div className="flex gap-2">
        <input
          aria-label="Explorer name"
          value={name}
          maxLength={24}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Capt. Meridian"
          className="w-full border border-gold/40 bg-ink px-3 py-2 font-serif text-base text-parchment outline-none focus:border-gold"
        />
        <button type="submit" className="btn btn-gold btn-sm shrink-0" disabled={saving}>
          {saving ? 'Saving…' : submitLabel}
        </button>
      </div>
      {error && <p className="mt-2 text-left font-serif text-sm text-[#f0b49a]">{error}</p>}
    </form>
  );
}
