import { Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES, HTTP_STATUS } from '@member-course/contracts';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { BusinessError } from '../../../common/errors/business-error.js';
import {
  PasswordHasher,
  TokenService,
} from '../domain/password-hasher.js';
import { PASSWORD_HASHER, TOKEN_SERVICE } from '../tokens.js';

/**
 * Tunable security parameters. Kept as named constants so unit tests can
 * assert against them and reviewers can grep for the policy in one place.
 */
export const LOCKOUT_POLICY = {
  /** Lock once this many consecutive failures is reached. */
  maxFailedAttempts: 5,
  /** Lock duration in milliseconds (15 minutes per the brief). */
  lockDurationMs: 15 * 60 * 1000,
} as const;

/** Access-token lifetime in seconds (15 minutes per the brief). */
export const ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;

export const ADMIN_STATUS = {
  ACTIVE: 'ACTIVE',
  LOCKED: 'LOCKED',
  DISABLED: 'DISABLED',
} as const;

/** Input shape for {@link AdminAuthService.login}. */
export interface LoginInput {
  readonly username: string;
  readonly password: string;
}

export interface LoginResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly admin: { readonly id: string; readonly username: string };
}

export interface RefreshResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

/**
 * Orchestrates administrator authentication.
 *
 * The service holds no IO adapters of its own — it delegates persistence to
 * {@link PrismaService}, password hashing to {@link PasswordHasher}, and all
 * token concerns to {@link TokenService}. That triad of injected ports is what
 * makes the lockout/rotation rules unit-testable without a database.
 *
 * Security rules enforced here (see `.superpowers/sdd/task-4-brief.md`):
 *  - Argon2id password verification (delegated to {@link PasswordHasher}).
 *  - Lockout: after {@link LOCKOUT_POLICY.maxFailedAttempts} consecutive
 *    failures, the account is locked for {@link LOCKOUT_POLICY.lockDurationMs};
 *    any login attempt while locked — even with valid credentials — returns
 *    HTTP 429 with code `ADMIN_LOGIN_LOCKED`. A successful login within the
 *    lockout *window before the threshold is reached* resets the counter.
 *  - Refresh tokens rotate on every use: the presented session is revoked
 *    (`revokedAt` set) and a fresh token/session is minted. Reusing a revoked
 *    token yields HTTP 401.
 *  - A `DISABLED` administrator cannot log in (HTTP 401).
 */
@Injectable()
export class AdminAuthService {
  constructor(
    private readonly db: PrismaService,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenService,
  ) {}

  // ── Login ──────────────────────────────────────────────────────────────

  async login(input: LoginInput, now: Date = new Date()): Promise<LoginResult> {
    const admin = await this.db.adminUser.findUnique({
      where: { username: input.username },
    });

    // Always run a dummy verify when the user is missing so response timing
    // doesn't leak which usernames exist. Use a throwaway argon2 hash.
    if (!admin) {
      await this.hasher.verify(
        // Pre-computed argon2id hash of a random throwaway string; only used to
        // consume CPU when the account doesn't exist.
        '$argon2id$v=19$m=65536,t=3,p=4$bm9ucmVzcG9uc2U$Y2FuYXJ5ZHVtbXloYXNo',
        input.password,
      ).catch(() => false);
      throw BusinessError.unauthorized('Invalid username or password');
    }

    // Lockout check happens BEFORE credential verification so that even valid
    // credentials cannot bypass the cooldown.
    if (this.isLocked(admin, now)) {
      throw new BusinessError(
        ERROR_CODES.ADMIN_LOGIN_LOCKED,
        'Account is temporarily locked due to repeated failed login attempts',
        HTTP_STATUS.TOO_MANY_REQUESTS,
      );
    }

    // A disabled admin may not authenticate at all.
    if (admin.status === ADMIN_STATUS.DISABLED) {
      throw BusinessError.unauthorized('Account is disabled');
    }

    const ok = await this.hasher.verify(admin.passwordHash, input.password);
    if (!ok) {
      await this.recordFailedAttempt(admin, now);
      throw BusinessError.unauthorized('Invalid username or password');
    }

    // Success: reset the failure counter and issue tokens.
    await this.db.adminUser.update({
      where: { id: admin.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });

    const accessToken = await this.tokens.signAccessToken({
      adminUserId: admin.id,
      username: admin.username,
    });
    const refresh = await this.tokens.issueRefreshToken(admin.id);
    await this.db.refreshSession.create({
      data: {
        adminUserId: admin.id,
        tokenHash: refresh.tokenHash,
        expiresAt: refresh.expiresAt,
      },
    });

    return {
      accessToken,
      refreshToken: refresh.token,
      expiresIn: ACCESS_TOKEN_LIFETIME_SECONDS,
      admin: { id: admin.id, username: admin.username },
    };
  }

  // ── Refresh (token rotation) ───────────────────────────────────────────

  async refresh(refreshToken: string, now: Date = new Date()): Promise<RefreshResult> {
    const tokenHash = this.tokens.hashRefreshToken(refreshToken);
    const session = await this.db.refreshSession.findUnique({
      where: { tokenHash },
    });

    // Unknown token or not bound to an admin → 401. The token-hash lookup is
    // the source of truth for refresh-token identity (no DB unique constraint
    // is defined on this table per Task 2).
    if (!session || !session.adminUserId) {
      throw BusinessError.unauthorized('Invalid refresh token');
    }

    if (session.revokedAt !== null) {
      throw BusinessError.unauthorized('Refresh token has been revoked');
    }

    if (!this.tokens.isRefreshExpiryValid(session.expiresAt, now)) {
      throw BusinessError.unauthorized('Refresh token has expired');
    }

    // Atomically rotate: revoke the old session, then issue a new one. Done in
    // a transaction so a crash mid-rotation can't leave two live tokens.
    const adminId = session.adminUserId;
    const accessToken = await this.tokens.signAccessToken({
      adminUserId: adminId,
      // Username isn't on the session row; load it lazily for the JWT payload.
      username: (await this.db.adminUser.findUnique({ where: { id: adminId } }))?.username ?? '',
    });

    const newRefresh = await this.tokens.issueRefreshToken(adminId);

    await this.db.$transaction(async (tx) => {
      await tx.refreshSession.update({
        where: { id: session.id },
        data: { revokedAt: now },
      });
      await tx.refreshSession.create({
        data: {
          adminUserId: adminId,
          tokenHash: newRefresh.tokenHash,
          expiresAt: newRefresh.expiresAt,
        },
      });
    });

    return {
      accessToken,
      refreshToken: newRefresh.token,
      expiresIn: ACCESS_TOKEN_LIFETIME_SECONDS,
    };
  }

  // ── Logout ─────────────────────────────────────────────────────────────

  /**
   * Revoke the refresh session backing `refreshToken`. Returns `{revoked:true}`
   * when a live session was found and revoked; returns `{revoked:false}` when
   * the token is unknown or already revoked (idempotent logout).
   */
  async logout(refreshToken: string, now: Date = new Date()): Promise<{ revoked: boolean }> {
    const tokenHash = this.tokens.hashRefreshToken(refreshToken);
    const session = await this.db.refreshSession.findUnique({
      where: { tokenHash },
    });
    if (!session || session.revokedAt !== null) {
      return { revoked: false };
    }
    await this.db.refreshSession.update({
      where: { id: session.id },
      data: { revokedAt: now },
    });
    return { revoked: true };
  }

  // ── Lockout helpers ────────────────────────────────────────────────────

  /** True if the account is currently in a lockout cooldown. */
  private isLocked(
    admin: { lockedUntil: Date | null; failedLoginCount: number },
    now: Date,
  ): boolean {
    return admin.lockedUntil !== null && admin.lockedUntil.getTime() > now.getTime();
  }

  /**
   * Increment the failure counter; when it crosses the threshold, set
   * `lockedUntil` to `now + lockDurationMs`.
   */
  private async recordFailedAttempt(
    admin: { id: string; failedLoginCount: number },
    now: Date,
  ): Promise<void> {
    const next = admin.failedLoginCount + 1;
    const lockedUntil =
      next >= LOCKOUT_POLICY.maxFailedAttempts
        ? new Date(now.getTime() + LOCKOUT_POLICY.lockDurationMs)
        : null;
    await this.db.adminUser.update({
      where: { id: admin.id },
      data: { failedLoginCount: next, ...(lockedUntil ? { lockedUntil } : {}) },
    });
  }
}
