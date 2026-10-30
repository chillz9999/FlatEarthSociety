import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getAddress, verifyMessage } from 'viem';
import { parseSiweMessage, validateSiweMessage } from 'viem/siwe';
import type { Db } from '../db';
import { HttpError } from '../errors';

export interface SessionClaims {
  sub: `0x${string}`;
  adm: boolean;
  iat: number;
  exp: number;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly opts: {
      secret: string;
      ttlHours: number;
      chainId: number;
      admins: Set<string>;
      allowedDomains: string[];
      /** Optional smart-wallet aware verifier (ERC-1271/6492) — falls back to EOA verification. */
      verifier?: (args: { address: `0x${string}`; message: string; signature: `0x${string}` }) => Promise<boolean>;
    },
  ) {}

  async issueNonce(): Promise<string> {
    const nonce = randomBytes(16).toString('hex');
    await this.db.query('insert into auth_nonces (nonce) values ($1)', [nonce]);
    // Opportunistic cleanup of stale nonces.
    await this.db.query("delete from auth_nonces where created_at < now() - interval '1 day'");
    return nonce;
  }

  /** Verify a Sign-In with Ethereum message and issue a session token. */
  async verify(message: string, signature: `0x${string}`): Promise<{ token: string; address: `0x${string}`; isAdmin: boolean; expiresAt: string }> {
    const fields = parseSiweMessage(message);
    if (!fields.address || !fields.nonce || !fields.domain) throw new HttpError(400, 'bad_message', 'The sign-in request was malformed. Please sign in again.');
    if (fields.chainId !== this.opts.chainId) throw new HttpError(400, 'wrong_chain', `Sign in on chain ${this.opts.chainId}`);
    if (this.opts.allowedDomains.length && !this.opts.allowedDomains.includes(fields.domain)) {
      throw new HttpError(400, 'bad_domain', 'This sign-in request is for a different site.');
    }
    if (!validateSiweMessage({ message: fields, time: new Date() })) {
      throw new HttpError(400, 'expired_message', 'This sign-in request has expired. Please sign in again.');
    }
    const issued = fields.issuedAt ? fields.issuedAt.getTime() : 0;
    if (Math.abs(Date.now() - issued) > 10 * 60_000) throw new HttpError(400, 'stale_message', 'This sign-in request has expired. Please sign in again.');

    // Single-use nonce.
    const used = await this.db.query<{ nonce: string }>(
      "update auth_nonces set used_at = now() where nonce = $1 and used_at is null and created_at > now() - interval '15 minutes' returning nonce",
      [fields.nonce],
    );
    if (used.rows.length === 0) throw new HttpError(400, 'bad_nonce', 'This sign-in request has expired. Please sign in again.');

    const address = getAddress(fields.address);
    const ok = this.opts.verifier
      ? await this.opts.verifier({ address, message, signature })
      : await verifyMessage({ address, message, signature });
    if (!ok) throw new HttpError(401, 'bad_signature', 'The signature doesn’t match this wallet. Please sign in again.');

    await this.db.query('insert into players (address) values ($1) on conflict (address) do nothing', [address.toLowerCase()]);
    const isAdmin = this.opts.admins.has(address.toLowerCase());
    const now = Math.floor(Date.now() / 1000);
    const claims: SessionClaims = { sub: address, adm: isAdmin, iat: now, exp: now + this.opts.ttlHours * 3600 };
    return { token: this.sign(claims), address, isAdmin, expiresAt: new Date(claims.exp * 1000).toISOString() };
  }

  sign(claims: SessionClaims): string {
    const payload = b64(JSON.stringify(claims));
    const sig = createHmac('sha256', this.opts.secret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  /** Validate a bearer token. Admin status is re-checked against the current admin list. */
  readToken(token: string | undefined): SessionClaims | null {
    if (!token) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = createHmac('sha256', this.opts.secret).update(payload).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionClaims;
      if (claims.exp * 1000 < Date.now()) return null;
      return { ...claims, adm: this.opts.admins.has(claims.sub.toLowerCase()) };
    } catch {
      return null;
    }
  }
}
