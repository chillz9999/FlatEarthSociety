'use client';

import { weekLabel } from '@fes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { EXPLORER_URL } from '@/lib/env';
import { explorerTx, formatScore, formatTime, formatToken, shortAddress } from '@/lib/format';
import { useConfig } from '@/lib/queries';
import { describeError } from '@/lib/ranked';
import { useSession } from '@/lib/session';

export function AdminConsole() {
  const session = useSession();
  const qc = useQueryClient();
  const { data: cfg } = useConfig();
  const { data, error, isLoading } = useQuery({ queryKey: ['admin'], queryFn: api.admin.overview, enabled: session.isAdmin, refetchInterval: 20_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const wifDec = cfg?.wif?.decimals ?? 18;
  const fesDec = cfg?.fes?.decimals ?? 18;

  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setMessage(null);
    try {
      await fn();
      setMessage(done);
      await qc.invalidateQueries();
    } catch (err) {
      setMessage(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  if (!session.isAdmin) {
    return (
      <div className="mx-auto max-w-3xl px-8 pt-20 text-center">
        <h1 className="font-display text-3xl text-gold-2">Society Administration</h1>
        <p className="mt-4 font-serif text-xl text-parchment-2">Only the Society’s administrators may enter. Connect and sign in with an administrator wallet.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] px-8 pt-10">
      <div className="flex items-end justify-between">
        <div>
          <div className="label">Restricted</div>
          <h1 className="mt-2 font-display text-4xl text-gold-2">Society Administration</h1>
        </div>
        <div className="text-right font-sans text-xs text-parchment-3">
          <div>Settler: {data?.settlerAddress ?? 'not configured'}</div>
          <div>
            Practice this week: {data?.practice.runs ?? '—'} voyages by {data?.practice.players ?? '—'} explorers
          </div>
          <div>
            Indexer at block {data?.indexer.lastBlock ?? '—'} · {data?.indexer.lastRunAt ? new Date(data.indexer.lastRunAt).toLocaleTimeString() : 'never'}{' '}
            <button type="button" className="ml-2 text-gold-2 underline" disabled={!!busy} onClick={() => void act('sync', api.admin.sync, 'Indexer synchronised.')}>
              sync now
            </button>
          </div>
        </div>
      </div>
      {message && <div className="plaque mt-5 px-5 py-3 font-sans text-sm text-parchment">{message}</div>}
      {isLoading && <p className="mt-8 font-serif text-parchment-3 italic">Loading…</p>}
      {error && <p className="mt-8 font-sans text-sm text-[#f0b49a]">{describeError(error)}</p>}

      <section className="mt-8">
        <h2 className="font-display text-xl text-gold-2">Competitions</h2>
        <div className="mt-4 space-y-4">
          {data?.weeks.map((w) => (
            <div key={w.weekId} className="plaque p-5">
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-display text-lg text-parchment">{weekLabel(w.weekId)}</span>
                  <span className="ml-3 border border-gold/40 px-2 py-0.5 font-sans text-xs text-gold-2 uppercase">{w.status}</span>
                </div>
                <div className="flex gap-2">
                  <button type="button" className="btn btn-ghost px-3! py-2! text-[0.7rem]!" disabled={!!busy || !['open', 'closing'].includes(w.status)} onClick={() => void act(`close-${w.weekId}`, () => api.admin.closeWeek(w.weekId), 'Week closed.')}>
                    Close
                  </button>
                  <button type="button" className="btn btn-ghost px-3! py-2! text-[0.7rem]!" disabled={!!busy || w.status !== 'closed' || w.wifAllocated === w.wifConverted} onClick={() => void act(`convert-${w.weekId}`, () => api.admin.convertWeek(w.weekId), 'Conversion sent.')}>
                    Convert
                  </button>
                  <button type="button" className="btn btn-ghost px-3! py-2! text-[0.7rem]!" disabled={!!busy || w.status !== 'closed' || w.blockers.length > 0} onClick={() => void act(`final-${w.weekId}`, () => api.admin.finalizeWeek(w.weekId), 'Week finalized onchain.')}>
                    Finalize
                  </button>
                  <button type="button" className="btn btn-gold px-3! py-2! text-[0.7rem]!" disabled={!!busy || w.status !== 'finalized'} onClick={() => void act(`pay-${w.weekId}`, () => api.admin.payout(w.weekId), 'Prizes paid.')}>
                    Pay prizes
                  </button>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-4 gap-4 font-sans text-sm text-parchment-2">
                <div>
                  WIF allocated: <span className="num">{formatToken(w.wifAllocated, wifDec)}</span>
                </div>
                <div>
                  WIF converted: <span className="num">{formatToken(w.wifConverted, wifDec)}</span>
                </div>
                <div>
                  Prize pool: <span className="num text-gold-3">{formatToken(w.fesPool, fesDec)}</span>
                </div>
                <div>
                  Finalize tx:{' '}
                  {w.finalizeTx ? (
                    <a className="text-gold-2 hover:underline" href={explorerTx(EXPLORER_URL, w.finalizeTx) ?? '#'} target="_blank" rel="noreferrer">
                      {shortAddress(w.finalizeTx)}
                    </a>
                  ) : (
                    '—'
                  )}
                </div>
              </div>
              <div className="mt-2 font-sans text-sm text-parchment-2">
                Top three: {w.winners.length ? w.winners.map((x) => `${x.rank}. ${shortAddress(x.address)} (${formatScore(x.score)})`).join(' · ') : 'none'}
              </div>
              {w.blockers.length > 0 && <ul className="mt-2 list-disc pl-5 font-sans text-sm text-[#f0b49a]">{w.blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
            </div>
          ))}
        </div>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-xl text-gold-2">Flagged expeditions awaiting review</h2>
        <AttemptTable
          rows={data?.flagged ?? []}
          empty="No flagged runs."
          actions={(a) => (
            <>
              <button type="button" className="text-verdigris underline" disabled={!!busy} onClick={() => void act(`ap-${a.id}`, () => api.admin.review(a.id, 'approve', 'reviewed'), 'Approved.')}>
                approve
              </button>
              <button type="button" className="ml-3 text-[#f0b49a] underline" disabled={!!busy} onClick={() => void act(`rj-${a.id}`, () => api.admin.review(a.id, 'reject', 'rejected after review'), 'Rejected.')}>
                reject
              </button>
            </>
          )}
        />
      </section>

      <section className="mt-10">
        <h2 className="font-display text-xl text-gold-2">Interrupted expeditions</h2>
        <AttemptTable
          rows={data?.abandoned ?? []}
          empty="No abandoned runs."
          actions={(a) => (
            <button
              type="button"
              className="text-gold-2 underline"
              disabled={!!busy}
              onClick={() => {
                const note = window.prompt('Reason for restoration (recorded in the audit log):');
                if (note && note.length >= 3) void act(`rs-${a.id}`, () => api.admin.restore(a.id, note), 'Attempt restored.');
              }}
            >
              restore
            </button>
          )}
        />
      </section>

      <section className="mt-10">
        <h2 className="font-display text-xl text-gold-2">Audit log</h2>
        <div className="plaque mt-4 max-h-[420px] overflow-y-auto p-4 font-mono text-xs text-parchment-2">
          {data?.audit.map((e, i) => (
            <div key={i} className="border-b border-gold/10 py-1.5">
              <span className="text-parchment-3">{new Date(e.at).toISOString()}</span> <span className="text-gold-2">{e.action}</span>{' '}
              <span>{e.actor.length > 20 ? shortAddress(e.actor) : e.actor}</span> <span className="text-parchment-3">{e.detail}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

type Row = { id: string; player: string; score: number | null; survivalMs: number | null; flags: string[]; note: string | null; createdAt: string };

function AttemptTable({ rows, empty, actions }: { rows: Row[]; empty: string; actions: (r: Row) => React.ReactNode }) {
  if (rows.length === 0) return <p className="mt-3 font-serif text-parchment-3 italic">{empty}</p>;
  return (
    <table className="plaque mt-4 w-full text-left font-sans text-sm">
      <thead>
        <tr className="label">
          <th className="px-4 py-2 font-normal">Attempt</th>
          <th className="px-4 py-2 font-normal">Explorer</th>
          <th className="px-4 py-2 text-right font-normal">Score</th>
          <th className="px-4 py-2 text-right font-normal">Survival</th>
          <th className="px-4 py-2 font-normal">Flags / note</th>
          <th className="px-4 py-2 font-normal">Action</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-t border-gold/10">
            <td className="num px-4 py-2 text-xs">{r.id.slice(0, 8)}</td>
            <td className="num px-4 py-2">{shortAddress(r.player)}</td>
            <td className="num px-4 py-2 text-right">{formatScore(r.score)}</td>
            <td className="num px-4 py-2 text-right">{r.survivalMs ? formatTime(r.survivalMs) : '—'}</td>
            <td className="px-4 py-2 text-xs text-parchment-3">{[r.flags.join(', '), r.note].filter(Boolean).join(' · ') || '—'}</td>
            <td className="px-4 py-2">{actions(r)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
