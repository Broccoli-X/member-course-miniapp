import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as argon2 from 'argon2';
import { AdminAuthService, LOCKOUT_POLICY, ACCESS_TOKEN_LIFETIME_SECONDS } from './admin-auth.service.js';
import type { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import {
  PasswordHasher,
  TokenService,
} from '../domain/password-hasher.js';

// ── Test doubles ────────────────────────────────────────────────────────

/**
 * Real argon2 hasher so unit tests exercise the actual verify path (it's just
 * CPU work — no DB required). Avoids the trap of mocking out the thing under
 * test.
 */
class RealArgon2Hasher implements PasswordHasher {
  async hash(plain: string): Promise<string> {
    return argon2.hash(plain, { type: argon2.argon2id });
  }
  async verify(encoded: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(encoded, plain);
    } catch {
      return false;
    }
  }
}

/** Token hashes are derived from the plaintext by a reversible prefix scheme. */
const PLAINTEXT_PREFIX = 'rt_';
const hashOf = (t: string): string => 'hash:' + t;
const tokenForHash = (h: string): string => h.replace(/^hash:/, '');

/**
 * Deterministic TokenService for the service-layer rules tests. Produces a
 * predictable rotation so the test can assert "new token differs from old".
 */
class FakeTokenService implements TokenService {
  private counter = 0;
  signAccessToken = vi.fn(async (p: { adminUserId: string; username: string }) =>
    `access.${p.adminUserId}.${p.username}`,
  );
  issueRefreshToken = vi.fn(async (adminUserId: string) => {
    this.counter += 1;
    const token = `${PLAINTEXT_PREFIX}${adminUserId}.${this.counter}`;
    return {
      token,
      tokenHash: hashOf(token),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    };
  });
  hashRefreshToken = vi.fn((token: string) => hashOf(token));
  isRefreshExpiryValid = vi.fn(
    (expiresAt: Date, now: Date = new Date()) => expiresAt.getTime() > now.getTime(),
  );
  /** Test helper: reconstruct the plaintext from a hash for assertions. */
  plaintextFromHash(h: string): string {
    return tokenForHash(h);
  }
}

// ── In-memory PrismaService ─────────────────────────────────────────────

type AdminUserRow = {
  id: string;
  username: string;
  passwordHash: string;
  status: string;
  failedLoginCount: number;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

type RefreshSessionRow = {
  id: string;
  adminUserId: string | null;
  memberAccountId: string | null;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

function createMockDb(): {
  db: PrismaService;
  admins: Map<string, AdminUserRow>;
  sessions: Map<string, RefreshSessionRow>;
} {
  const admins = new Map<string, AdminUserRow>();
  const sessions = new Map<string, RefreshSessionRow>(); // keyed by id
  let sessionSeq = 0;

  const adminUser = {
    findUnique: vi.fn(async ({ where }: { where: { username?: string; id?: string } }) => {
      if (where.username !== undefined) {
        for (const r of admins.values()) if (r.username === where.username) return r;
        return null;
      }
      if (where.id !== undefined) return admins.get(where.id) ?? null;
      return null;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<AdminUserRow> }) => {
      const r = admins.get(where.id);
      if (!r) throw new Error('admin not found');
      Object.assign(r, data, { updatedAt: new Date() });
      return r;
    }),
  };

  const refreshSession = {
    findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => {
      for (const r of sessions.values()) if (r.tokenHash === where.tokenHash) return r;
      return null;
    }),
    create: vi.fn(async ({ data }: { data: Omit<RefreshSessionRow, 'id' | 'createdAt' | 'updatedAt' | 'version'> & Partial<RefreshSessionRow> }) => {
      sessionSeq += 1;
      const id = `sess-${sessionSeq}`;
      const now = new Date();
      const row: RefreshSessionRow = {
        id,
        adminUserId: data.adminUserId ?? null,
        memberAccountId: data.memberAccountId ?? null,
        tokenHash: data.tokenHash,
        expiresAt: data.expiresAt,
        revokedAt: data.revokedAt ?? null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      sessions.set(id, row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<RefreshSessionRow> }) => {
      const r = sessions.get(where.id);
      if (!r) throw new Error('session not found');
      Object.assign(r, data, { updatedAt: new Date() });
      return r;
    }),
    /**
     * Conditional update used by the refresh-rotation optimistic-lock guard.
     * Honors the `revokedAt` + `version` predicates in `where` so concurrent
     * callers observe exactly one winner — mirroring the real MySQL behaviour.
     */
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string; revokedAt?: Date | null; version?: number };
        data: Omit<Partial<RefreshSessionRow>, 'version'> & {
          version?: { increment: number };
        };
      }): Promise<{ count: number }> => {
        const r = sessions.get(where.id);
        if (!r) return { count: 0 };
        // Predicate: id matches (already checked) + revokedAt + version guard.
        const revokedOk =
          where.revokedAt === undefined || r.revokedAt === where.revokedAt;
        const versionOk = where.version === undefined || r.version === where.version;
        if (!revokedOk || !versionOk) return { count: 0 };
        const { version: versionOp, ...rest } = data;
        Object.assign(r, rest, { updatedAt: new Date() });
        // Apply the optimistic-lock version increment.
        if (versionOp && typeof versionOp === 'object' && 'increment' in versionOp) {
          r.version += versionOp.increment;
        }
        return { count: 1 };
      },
    ),
  };

  const transactionClient = {
    adminUser,
    refreshSession,
  };

  const db = {
    adminUser,
    refreshSession,
    $transaction: vi.fn(
      async <T>(fn: (tx: typeof transactionClient) => Promise<T>): Promise<T> =>
        fn(transactionClient),
    ),
  } as unknown as PrismaService;

  return { db, admins, sessions };
}

/** Seed an admin into the mock DB and return its id. */
async function seedAdminRow(
  admins: Map<string, AdminUserRow>,
  username: string,
  password: string,
  overrides: Partial<AdminUserRow> = {},
): Promise<string> {
  const id = `admin-${username}`;
  admins.set(id, {
    id,
    username,
    passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
    status: 'ACTIVE',
    failedLoginCount: 0,
    lockedUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    ...overrides,
  });
  return id;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('AdminAuthService', () => {
  let mock: ReturnType<typeof createMockDb>;
  let hasher: RealArgon2Hasher;
  let tokens: FakeTokenService;
  let service: AdminAuthService;

  beforeEach(() => {
    mock = createMockDb();
    hasher = new RealArgon2Hasher();
    tokens = new FakeTokenService();
    service = new AdminAuthService(mock.db, hasher, tokens);
  });

  describe('login', () => {
    it('returns tokens and resets failure counters on valid credentials', async () => {
      const id = await seedAdminRow(mock.admins, 'alice', 'pw-correct', {
        failedLoginCount: 2,
      });
      const result = await service.login({ username: 'alice', password: 'pw-correct' });
      expect(result.accessToken).toBe(`access.${id}.alice`);
      expect(result.refreshToken.startsWith(PLAINTEXT_PREFIX)).toBe(true);
      expect(result.expiresIn).toBe(ACCESS_TOKEN_LIFETIME_SECONDS);
      expect(result.admin).toEqual({ id, username: 'alice' });
      // Counter reset
      expect(mock.admins.get(id)?.failedLoginCount).toBe(0);
      expect(mock.admins.get(id)?.lockedUntil).toBeNull();
      // Session persisted
      expect(mock.sessions.size).toBe(1);
      const session = [...mock.sessions.values()][0];
      expect(session.adminUserId).toBe(id);
      expect(session.revokedAt).toBeNull();
    });

    it('rejects an unknown user with 401', async () => {
      await expect(
        service.login({ username: 'ghost', password: 'anything' }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED', httpStatus: 401 });
      expect(tokens.issueRefreshToken).not.toHaveBeenCalled();
    });

    it('rejects a wrong password with 401 and bumps failedLoginCount', async () => {
      const id = await seedAdminRow(mock.admins, 'bob', 'pw-correct');
      await expect(
        service.login({ username: 'bob', password: 'pw-wrong' }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED', httpStatus: 401 });
      expect(mock.admins.get(id)?.failedLoginCount).toBe(1);
      expect(mock.admins.get(id)?.lockedUntil).toBeNull();
    });

    it('refuses a DISABLED admin even with valid credentials', async () => {
      await seedAdminRow(mock.admins, 'carol', 'pw-correct', { status: 'DISABLED' });
      await expect(
        service.login({ username: 'carol', password: 'pw-correct' }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED', httpStatus: 401 });
      expect(tokens.issueRefreshToken).not.toHaveBeenCalled();
    });
  });

  describe('lockout', () => {
    it('locks for ~15 minutes after 5 consecutive failures', async () => {
      const id = await seedAdminRow(mock.admins, 'dave', 'pw-correct');
      const t0 = new Date('2026-01-01T00:00:00.000Z');
      let now = t0;
      // Mock Date inside the service via the `now` parameter
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await expect(
          service.login({ username: 'dave', password: 'wrong' }, now),
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED', httpStatus: 401 });
        expect(mock.admins.get(id)?.lockedUntil).toBeNull();
        now = new Date(now.getTime() + 1_000);
      }
      // 5th failure trips the lock
      await expect(
        service.login({ username: 'dave', password: 'wrong' }, now),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED', httpStatus: 401 });
      const locked = mock.admins.get(id);
      expect(locked?.failedLoginCount).toBe(LOCKOUT_POLICY.maxFailedAttempts);
      expect(locked?.lockedUntil).not.toBeNull();
      const expectedLockEnd = new Date(
        t0.getTime() + LOCKOUT_POLICY.lockDurationMs,
      );
      // The 5th attempt used `now` (== t0 + 4s), allow a few seconds slack
      const lockMs = locked!.lockedUntil!.getTime();
      expect(lockMs).toBeGreaterThanOrEqual(expectedLockEnd.getTime());
      expect(lockMs).toBeLessThanOrEqual(expectedLockEnd.getTime() + 60_000);
    });

    it('returns 429 ADMIN_LOGIN_LOCKED on the 6th attempt even with valid credentials', async () => {
      const id = await seedAdminRow(mock.admins, 'eve', 'pw-correct');
      let now = new Date('2026-01-01T00:00:00.000Z');
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(
          service.login({ username: 'eve', password: 'wrong' }, now),
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED', httpStatus: 401 });
        now = new Date(now.getTime() + 1_000);
      }
      expect(mock.admins.get(id)?.lockedUntil).not.toBeNull();
      // 6th attempt with VALID password → still locked
      await expect(
        service.login({ username: 'eve', password: 'pw-correct' }, now),
      ).rejects.toMatchObject({
        code: 'ADMIN_LOGIN_LOCKED',
        httpStatus: 429,
      });
      expect(tokens.issueRefreshToken).not.toHaveBeenCalled();
    });

    it('resets the counter on a successful login before the threshold', async () => {
      const id = await seedAdminRow(mock.admins, 'frank', 'pw-correct');
      const now = new Date();
      // Two failures
      await expect(service.login({ username: 'frank', password: 'wrong' }, now)).rejects.toMatchObject({ httpStatus: 401 });
      await expect(service.login({ username: 'frank', password: 'wrong' }, now)).rejects.toMatchObject({ httpStatus: 401 });
      expect(mock.admins.get(id)?.failedLoginCount).toBe(2);
      // Success → reset
      await service.login({ username: 'frank', password: 'pw-correct' }, now);
      expect(mock.admins.get(id)?.failedLoginCount).toBe(0);
      expect(mock.admins.get(id)?.lockedUntil).toBeNull();
    });

    it('allows login again after the lockout window expires', async () => {
      const id = await seedAdminRow(mock.admins, 'gina', 'pw-correct');
      const t0 = new Date('2026-01-01T00:00:00.000Z');
      let now = t0;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(
          service.login({ username: 'gina', password: 'wrong' }, now),
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED', httpStatus: 401 });
        now = new Date(now.getTime() + 1_000);
      }
      // After the lock window, valid credentials succeed
      const afterLock = new Date(t0.getTime() + LOCKOUT_POLICY.lockDurationMs + 60_000);
      const result = await service.login({ username: 'gina', password: 'pw-correct' }, afterLock);
      expect(result.admin.id).toBe(id);
      expect(mock.admins.get(id)?.failedLoginCount).toBe(0);
    });
  });

  describe('refresh rotation', () => {
    it('issues a new refresh token and revokes the old session', async () => {
      const id = await seedAdminRow(mock.admins, 'hank', 'pw-correct');
      const login = await service.login({ username: 'hank', password: 'pw-correct' });
      expect(mock.sessions.size).toBe(1);
      const oldSessionId = [...mock.sessions.values()][0].id;

      const refreshed = await service.refresh(login.refreshToken);

      expect(refreshed.refreshToken).not.toBe(login.refreshToken);
      expect(refreshed.accessToken).toBe(`access.${id}.hank`);
      // Old session revoked, new session created
      expect(mock.sessions.size).toBe(2);
      const oldRow = mock.sessions.get(oldSessionId);
      expect(oldRow?.revokedAt).not.toBeNull();
      const newRow = [...mock.sessions.values()].find((s) => s.revokedAt === null);
      expect(newRow?.adminUserId).toBe(id);
      expect(newRow?.tokenHash).toBe(hashOf(refreshed.refreshToken));
    });

    it('rejects reuse of a revoked token with 401', async () => {
      await seedAdminRow(mock.admins, 'ivy', 'pw-correct');
      const login = await service.login({ username: 'ivy', password: 'pw-correct' });
      await service.refresh(login.refreshToken);
      // Reuse the original (now revoked) token
      await expect(service.refresh(login.refreshToken)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        httpStatus: 401,
      });
    });

    it('rejects an unknown refresh token with 401', async () => {
      await expect(service.refresh('rt_bogus.1')).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        httpStatus: 401,
      });
    });

    it('rejects an expired refresh token with 401', async () => {
      await seedAdminRow(mock.admins, 'jack', 'pw-correct');
      const login = await service.login({ username: 'jack', password: 'pw-correct' });
      // Force expiry by backdating the session row
      const session = [...mock.sessions.values()][0];
      session.expiresAt = new Date(Date.now() - 1);
      await expect(service.refresh(login.refreshToken)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        httpStatus: 401,
      });
    });

    it('serializes concurrent refreshes of one live token to one winner (optimistic lock)', async () => {
      // The optimistic-lock guard (updateMany WHERE version=...) must ensure
      // that two refresh calls presenting the same live token yield exactly
      // one success and one 401 — the loser observes the version bump and
      // refuses, defeating token reuse under contention.
      await seedAdminRow(mock.admins, 'kara', 'pw-correct');
      const login = await service.login({ username: 'kara', password: 'pw-correct' });

      const results = await Promise.allSettled([
        service.refresh(login.refreshToken),
        service.refresh(login.refreshToken),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      // Loser gets a 401 (token-already-revoked).
      expect(rejected[0]).toMatchObject({
        status: 'rejected',
        reason: { code: 'UNAUTHORIZED', httpStatus: 401 },
      });
      // Winner got a rotated token that differs from the original.
      const winner = (fulfilled[0] as PromiseFulfilledResult<{
        refreshToken: string;
      }>).value;
      expect(winner.refreshToken).not.toBe(login.refreshToken);
    });
  });

  describe('logout', () => {
    it('revokes the presented session', async () => {
      await seedAdminRow(mock.admins, 'kate', 'pw-correct');
      const login = await service.login({ username: 'kate', password: 'pw-correct' });
      const sessionId = [...mock.sessions.values()][0].id;
      expect(mock.sessions.get(sessionId)?.revokedAt).toBeNull();

      const result = await service.logout(login.refreshToken);
      expect(result).toEqual({ revoked: true });
      expect(mock.sessions.get(sessionId)?.revokedAt).not.toBeNull();
    });

    it('is idempotent — returning revoked:false for unknown or already-revoked tokens', async () => {
      await seedAdminRow(mock.admins, 'leo', 'pw-correct');
      const login = await service.login({ username: 'leo', password: 'pw-correct' });
      await service.logout(login.refreshToken);
      // Second logout on the same token
      expect(await service.logout(login.refreshToken)).toEqual({ revoked: false });
      // Unknown token
      expect(await service.logout('rt_unknown')).toEqual({ revoked: false });
    });
  });
});
