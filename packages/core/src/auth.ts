import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import type { Pool } from '@transferhub/db';
import { withTransaction } from '@transferhub/db';
import { type Queryable, recordAudit } from '@transferhub/platform';
import { DomainError, invalid } from './errors';
import { ensureCustomerAccounts } from './ledger';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

// ----------------------------------------------------------------------------------------------
// Passwords
// ----------------------------------------------------------------------------------------------
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

// ----------------------------------------------------------------------------------------------
// TOTP (RFC 6238, SHA-1, 30 s, 6 digits) — the MFA baseline in TH-SEC §3
// ----------------------------------------------------------------------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpAt(secret: string, timeMs: number, stepOffset = 0): string {
  const counter = Math.floor(timeMs / 1000 / 30) + stepOffset;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = h[h.length - 1]! & 0xf;
  const code = (h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

/** Accepts the current code and one step either side, to tolerate clock drift. */
export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  return [-1, 0, 1].some((o) => {
    const expected = Buffer.from(totpAt(secret, now, o));
    return timingSafeEqual(expected, Buffer.from(code));
  });
}

export function otpauthUrl(secret: string, email: string): string {
  const label = encodeURIComponent(`TransferHub:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=TransferHub&algorithm=SHA1&digits=6&period=30`;
}

// ----------------------------------------------------------------------------------------------
// Sessions (opaque token in an httpOnly cookie; only its hash is stored)
// ----------------------------------------------------------------------------------------------
export const SESSION_HOURS = 12;

const sha = (token: string) => createHash('sha256').update(token).digest();

export interface SessionUser {
  sessionId: string;
  userId: string;
  email: string;
  fullName: string;
  isStaff: boolean;
  staffRoles: string[];
  mfaEnabled: boolean;
  mfaVerified: boolean;
}

export async function createSession(db: Queryable, userId: string, userAgent?: string) {
  const token = randomBytes(32).toString('base64url');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO app.sessions (user_id, token_sha256, expires_at, user_agent)
     VALUES ($1, $2, now() + make_interval(hours => $3), $4) RETURNING id`,
    [userId, sha(token), SESSION_HOURS, userAgent?.slice(0, 300) ?? null],
  );
  return { token, sessionId: rows[0]!.id };
}

export async function sessionFromToken(db: Queryable, token: string): Promise<SessionUser | null> {
  const { rows } = await db.query<{
    session_id: string;
    user_id: string;
    email: string;
    full_name: string;
    is_staff: boolean;
    staff_roles: string[];
    mfa_enabled_at: Date | null;
    mfa_verified_at: Date | null;
    status: string;
  }>(
    `UPDATE app.sessions s SET last_seen_at = now()
       FROM app.users u
      WHERE s.token_sha256 = $1 AND s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()
      RETURNING s.id AS session_id, u.id AS user_id, u.email, u.full_name, u.is_staff, u.staff_roles,
                u.mfa_enabled_at, s.mfa_verified_at, u.status`,
    [sha(token)],
  );
  const r = rows[0];
  if (!r || r.status !== 'active') return null;
  return {
    sessionId: r.session_id,
    userId: r.user_id,
    email: r.email,
    fullName: r.full_name,
    isStaff: r.is_staff,
    staffRoles: r.staff_roles,
    mfaEnabled: r.mfa_enabled_at !== null,
    mfaVerified: r.mfa_verified_at !== null,
  };
}

export async function revokeSession(db: Queryable, sessionId: string): Promise<void> {
  await db.query(
    `UPDATE app.sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId],
  );
}

// ----------------------------------------------------------------------------------------------
// Registration, login, MFA
// ----------------------------------------------------------------------------------------------
export function newReferenceCode(): string {
  // Excludes look-alike characters (0/O, 1/I) so customers can type it from a bank screen.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  let s = 'TH';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

export interface RegisterInput {
  email: string;
  password: string;
  fullName: string;
  phone: string;
  kind: 'individual' | 'business';
  customerRole: 'buyer' | 'seller';
  legalName: string;
}

export function validateRegistration(input: Partial<RegisterInput>): RegisterInput {
  const errors: Array<{ path: string; message: string }> = [];
  const email = String(input.email ?? '')
    .trim()
    .toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    errors.push({ path: 'email', message: 'Enter a valid email address.' });
  const password = String(input.password ?? '');
  if (password.length < 10)
    errors.push({ path: 'password', message: 'Use at least 10 characters.' });
  const fullName = String(input.fullName ?? '').trim();
  if (!fullName) errors.push({ path: 'fullName', message: 'Enter your full name.' });
  const phone = String(input.phone ?? '').trim();
  if (!/^\+?[0-9 ()-]{7,20}$/.test(phone))
    errors.push({ path: 'phone', message: 'Enter a valid phone number.' });
  if (input.kind !== 'individual' && input.kind !== 'business')
    errors.push({ path: 'kind', message: 'Choose individual or business.' });
  if (input.customerRole !== 'buyer' && input.customerRole !== 'seller')
    errors.push({ path: 'customerRole', message: 'Choose buyer or seller.' });
  const legalName = String(input.legalName ?? '').trim();
  if (!legalName) errors.push({ path: 'legalName', message: 'Enter the legal name.' });
  if (errors.length) throw invalid('Please correct the highlighted fields.', errors);
  return {
    email,
    password,
    fullName,
    phone,
    kind: input.kind!,
    customerRole: input.customerRole!,
    legalName,
  };
}

export async function registerCustomer(
  pool: Pool,
  raw: Partial<RegisterInput>,
  opts: { userAgent?: string; mfaSecret?: string; markVerified?: boolean } = {},
) {
  const input = validateRegistration(raw);
  const passwordHash = await hashPassword(input.password);
  const secret = opts.mfaSecret ?? newTotpSecret();
  return withTransaction(pool, async (tx) => {
    const exists = await tx.query('SELECT 1 FROM app.users WHERE email = $1', [input.email]);
    if (exists.rowCount)
      throw new DomainError('email_taken', 'An account with this email already exists.', 409);
    // Sandbox: email and phone ownership checks are simulated as passed (IAM-01 production flow
    // uses the selected identity provider's verification).
    const { rows: u } = await tx.query<{ id: string }>(
      `INSERT INTO app.users (email, full_name, phone, password_hash, email_verified_at, phone_verified_at, mfa_secret)
       VALUES ($1, $2, $3, $4, now(), now(), $5) RETURNING id`,
      [input.email, input.fullName, input.phone, passwordHash, secret],
    );
    const userId = u[0]!.id;
    const entityId = await createEntity(tx, {
      kind: input.kind,
      customerRole: input.customerRole,
      legalName: input.legalName,
      ownerUserId: userId,
    });
    await recordAudit(tx, {
      actorType: 'customer',
      actorId: userId,
      entityId,
      action: 'user.registered',
      objectType: 'user',
      objectId: userId,
      metadata: { kind: input.kind, customerRole: input.customerRole },
    });
    const session = await createSession(tx, userId, opts.userAgent);
    return {
      userId,
      entityId,
      session,
      mfaSecret: secret,
      otpauthUrl: otpauthUrl(secret, input.email),
    };
  });
}

export async function createEntity(
  tx: Queryable,
  input: {
    kind: 'individual' | 'business';
    customerRole: 'buyer' | 'seller';
    legalName: string;
    ownerUserId: string;
    country?: string;
  },
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newReferenceCode();
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO app.entities (kind, customer_role, legal_name, reference_code, country)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (reference_code) DO NOTHING RETURNING id`,
      [input.kind, input.customerRole, input.legalName, code, input.country ?? 'TT'],
    );
    if (rows[0]) {
      const entityId = rows[0].id;
      await tx.query(
        `INSERT INTO app.memberships (user_id, entity_id, role) VALUES ($1, $2, 'owner')`,
        [input.ownerUserId, entityId],
      );
      await ensureCustomerAccounts(tx, entityId, input.legalName);
      return entityId;
    }
  }
  throw new Error('Could not allocate a reference code');
}

const MAX_FAILED_LOGINS = 10;

export async function login(pool: Pool, emailRaw: string, password: string, userAgent?: string) {
  const email = String(emailRaw ?? '')
    .trim()
    .toLowerCase();
  const { rows } = await pool.query<{
    id: string;
    password_hash: string;
    status: string;
    failed_logins: number;
  }>(`SELECT id, password_hash, status, failed_logins FROM app.users WHERE email = $1`, [email]);
  const user = rows[0];
  // Same message for unknown email and wrong password, so accounts cannot be enumerated.
  const generic = new DomainError('invalid_credentials', 'Email or password is incorrect.', 401);
  if (!user) {
    await verifyPassword(
      password,
      'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    );
    throw generic;
  }
  if (user.status === 'locked') {
    throw new DomainError(
      'account_locked',
      'This account is locked. Contact support to restore access.',
      423,
    );
  }
  if (!(await verifyPassword(String(password ?? ''), user.password_hash))) {
    await pool.query(
      `UPDATE app.users SET failed_logins = failed_logins + 1,
              status = CASE WHEN failed_logins + 1 >= $2 THEN 'locked' ELSE status END
        WHERE id = $1`,
      [user.id, MAX_FAILED_LOGINS],
    );
    await recordAudit(pool, {
      actorType: 'customer',
      actorId: user.id,
      action: 'session.login_failed',
      objectType: 'session',
    });
    throw generic;
  }
  await pool.query('UPDATE app.users SET failed_logins = 0 WHERE id = $1', [user.id]);
  const session = await createSession(pool, user.id, userAgent);
  await recordAudit(pool, {
    actorType: 'customer',
    actorId: user.id,
    action: 'session.password_verified',
    objectType: 'session',
    objectId: session.sessionId,
  });
  return session;
}

/** Completes sign-in (or first-time MFA enrolment) for a session. */
export async function verifySessionMfa(
  pool: Pool,
  session: SessionUser,
  code: string,
): Promise<void> {
  const { rows } = await pool.query<{ mfa_secret: string | null }>(
    'SELECT mfa_secret FROM app.users WHERE id = $1',
    [session.userId],
  );
  const secret = rows[0]?.mfa_secret;
  if (!secret || !verifyTotp(secret, String(code ?? '').replace(/\s/g, ''))) {
    await recordAudit(pool, {
      actorType: 'customer',
      actorId: session.userId,
      action: 'session.mfa_failed',
      objectType: 'session',
      objectId: session.sessionId,
    });
    throw new DomainError(
      'invalid_mfa_code',
      'That code is not valid. Check your authenticator app and try again.',
      401,
    );
  }
  await withTransaction(pool, async (tx) => {
    await tx.query('UPDATE app.sessions SET mfa_verified_at = now() WHERE id = $1', [
      session.sessionId,
    ]);
    await tx.query(
      'UPDATE app.users SET mfa_enabled_at = COALESCE(mfa_enabled_at, now()) WHERE id = $1',
      [session.userId],
    );
    await recordAudit(tx, {
      actorType: session.isStaff ? 'staff' : 'customer',
      actorId: session.userId,
      action: 'session.mfa_verified',
      objectType: 'session',
      objectId: session.sessionId,
    });
  });
}

/** Step-up check for sensitive actions (withdrawals): a fresh code is required every time. */
export async function requireFreshMfa(db: Queryable, userId: string, code: unknown): Promise<void> {
  const { rows } = await db.query<{ mfa_secret: string | null }>(
    'SELECT mfa_secret FROM app.users WHERE id = $1',
    [userId],
  );
  const secret = rows[0]?.mfa_secret;
  if (!secret || typeof code !== 'string' || !verifyTotp(secret, code.replace(/\s/g, ''))) {
    throw new DomainError(
      'invalid_mfa_code',
      'Enter the current 6-digit code from your authenticator app to authorise this.',
      401,
    );
  }
}

/** Sandbox helper: the current code for a demo account. The API refuses this in production. */
export async function sandboxCurrentCode(db: Queryable, email: string) {
  const { rows } = await db.query<{ mfa_secret: string | null }>(
    'SELECT mfa_secret FROM app.users WHERE email = $1',
    [
      String(email ?? '')
        .trim()
        .toLowerCase(),
    ],
  );
  const secret = rows[0]?.mfa_secret;
  if (!secret) return null;
  const now = Date.now();
  return { code: totpAt(secret, now), secondsRemaining: 30 - (Math.floor(now / 1000) % 30) };
}

export interface MeView {
  user: {
    id: string;
    email: string;
    fullName: string;
    isStaff: boolean;
    staffRoles: string[];
    mfaEnabled: boolean;
  };
  session: { mfaVerified: boolean };
  memberships: Array<{
    role: string;
    entity: {
      id: string;
      kind: string;
      customerRole: string;
      legalName: string;
      referenceCode: string;
      onboardingStatus: string;
    };
  }>;
}

export async function meView(db: Queryable, s: SessionUser): Promise<MeView> {
  const { rows } = await db.query<{
    role: string;
    id: string;
    kind: string;
    customer_role: string;
    legal_name: string;
    reference_code: string;
    onboarding_status: string;
  }>(
    `SELECT m.role, e.id, e.kind, e.customer_role, e.legal_name, e.reference_code, e.onboarding_status
       FROM app.memberships m JOIN app.entities e ON e.id = m.entity_id
      WHERE m.user_id = $1 ORDER BY m.created_at`,
    [s.userId],
  );
  return {
    user: {
      id: s.userId,
      email: s.email,
      fullName: s.fullName,
      isStaff: s.isStaff,
      staffRoles: s.staffRoles,
      mfaEnabled: s.mfaEnabled,
    },
    session: { mfaVerified: s.mfaVerified },
    memberships: rows.map((r) => ({
      role: r.role,
      entity: {
        id: r.id,
        kind: r.kind,
        customerRole: r.customer_role,
        legalName: r.legal_name,
        referenceCode: r.reference_code,
        onboardingStatus: r.onboarding_status,
      },
    })),
  };
}
