import { formatUnits } from 'viem';

export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatScore(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('en-US');
}

export function shortAddress(a: string | null | undefined): string {
  if (!a) return '—';
  return `${a.slice(0, 5)}…${a.slice(-4)}`;
}

/** Human amount for a raw token value (string or bigint), trimmed to `dp` decimals. */
export function formatToken(raw: string | bigint | null | undefined, decimals = 18, dp = 2): string {
  if (raw === null || raw === undefined || raw === '') return '—';
  const v = typeof raw === 'bigint' ? raw : BigInt(raw);
  const s = formatUnits(v, decimals);
  const [i, f = ''] = s.split('.');
  const int = BigInt(i).toLocaleString('en-US');
  const frac = f.slice(0, dp).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function countdownParts(ms: number): { d: number; h: number; m: number; s: number } {
  const t = Math.max(0, Math.floor(ms / 1000));
  return { d: Math.floor(t / 86400), h: Math.floor((t % 86400) / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 };
}

export function explorerTx(base: string | undefined, hash: string | null | undefined): string | null {
  if (!base || !hash) return null;
  return `${base.replace(/\/$/, '')}/tx/${hash}`;
}
