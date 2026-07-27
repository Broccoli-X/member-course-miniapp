import { Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES, HTTP_STATUS } from '@member-course/contracts';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { BusinessError } from '../../../common/errors/business-error.js';
import { TokenService } from '../domain/password-hasher.js';
import { WechatGateway } from '../domain/wechat-gateway.js';
import { TOKEN_SERVICE, WECHAT_GATEWAY } from '../tokens.js';
import { ACCESS_TOKEN_LIFETIME_SECONDS } from './admin-auth.service.js';

// Re-export the access-token lifetime so the mini controller can echo
// `expiresIn` without importing the admin service directly.
export { ACCESS_TOKEN_LIFETIME_SECONDS };

/** Result of {@link WechatAuthService.login}. */
export interface WechatLoginResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly provisional: boolean;
  readonly accountId: string;
}

/** Result of {@link WechatAuthService.refresh}. */
export interface MemberRefreshResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  /**
   * Whether the account was still provisional (`isProvisional`) at refresh
   * time. The mini-program client keeps `bound` in memory only, so on a cold
   * launch it relies on this flag to restore `bound = !provisional` and avoid
   * locking returning bound users out of every private page.
   */
  readonly provisional: boolean;
}

/** Status values the schema uses for `MemberAccount.status`. */
export const MEMBER_STATUS = {
  ACTIVE: 'ACTIVE',
  // SUSPENDED is the schema-documented "soft-block" value; we treat any
  // non-ACTIVE account as unable to authenticate.
  SUSPENDED: 'SUSPENDED',
  // DISABLED is what the phone-binding merge sets on the consumed provisional
  // account (see PhoneBindingService). It is NOT in the schema's inline
  // comment, but the column is a free-form String and the brief's verbatim
  // test asserts `accountStatus(provisional.accountId) === 'DISABLED'`.
  DISABLED: 'DISABLED',
} as const;

/**
 * Mini-program (member) authentication.
 *
 * The login flow exchanges a `wx.login` code for an `openId` via the
 * {@link WechatGateway}, then find-or-creates a `MemberAccount` + its
 * `WechatIdentity`. A brand-new account is *provisional* (`isProvisional=true`,
 * no `normalizedPhone`) until the member binds a verified phone through
 * {@link PhoneBindingService.bind}.
 *
 * Refresh-token rotation mirrors the admin flow exactly: a conditional
 * `updateMany` guarded by `revokedAt: null` AND the optimistic-lock `version`
 * runs inside one transaction, so two concurrent refreshes presenting the same
 * live token produce exactly one winner (the loser sees `count === 0` and gets
 * a 401). Revoked-token reuse is rejected with 401.
 *
 * The service holds no IO adapters of its own — it delegates persistence to
 * {@link PrismaService}, WeChat calls to {@link WechatGateway}, and all token
 * concerns to {@link TokenService}. That triad is what makes the rules
 * unit-testable without MySQL.
 */
@Injectable()
export class WechatAuthService {
  constructor(
    private readonly db: PrismaService,
    @Inject(WECHAT_GATEWAY) private readonly wechat: WechatGateway,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenService,
  ) {}

  // ── Login ──────────────────────────────────────────────────────────────

  /**
   * Exchange a `wx.login` code for member tokens.
   *
   * - Resolves the openId via {@link WechatGateway.exchangeCode}.
   * - Find-or-creates the `WechatIdentity` row (and its owning `MemberAccount`).
   *   A first-time login creates a provisional account with no phone; the
   *   member must then bind a verified phone before reaching private endpoints.
   * - Re-issues the access + refresh tokens on every call (login is NOT
   *   idempotent w.r.t. tokens — each call mints a fresh session).
   *
   * We intentionally do NOT look up the account by `unionId` here: merging by
   * unionId is a future concern and the brief is explicit that binding happens
   * only via the verified-phone path. The `unionId` is stored so a future
   * migration can backfill it.
   */
  async login(code: string): Promise<WechatLoginResult> {
    const session = await this.wechat.exchangeCode(code);
    if (!session.openId) {
      throw BusinessError.unauthorized('WeChat code exchange returned no openId');
    }

    // Find-or-create in one transaction so a racing pair of logins for the
    // same openId cannot create two identities (the @unique on openId would
    // reject the second anyway, but the tx keeps the account+identity
    // allocation atomic).
    const { account } = await this.db.$transaction(async (tx) => {
      const existing = await tx.wechatIdentity.findUnique({
        where: { openId: session.openId },
        include: { account: true },
      });
      if (existing) {
        // Refresh unionId if WeChat newly returned one and we don't have it.
        if (session.unionId && !existing.unionId) {
          await tx.wechatIdentity.update({
            where: { id: existing.id },
            data: { unionId: session.unionId },
          });
        }
        return { account: existing.account };
      }
      // New visitor → provisional account + identity.
      const newAccount = await tx.memberAccount.create({
        data: { isProvisional: true, status: MEMBER_STATUS.ACTIVE },
      });
      const identity = await tx.wechatIdentity.create({
        data: {
          accountId: newAccount.id,
          openId: session.openId,
          unionId: session.unionId ?? null,
        },
        include: { account: true },
      });
      return { account: identity.account };
    });

    if (account.status !== MEMBER_STATUS.ACTIVE) {
      // A SUSPENDED or DISABLED account cannot authenticate. (The DISABLED
      // value is normally only set on a consumed provisional account after a
      // phone-binding merge — its identity was moved to the pre-created
      // account, so this branch is reached only if the openId was somehow
      // re-issued to the same provisional row.)
      throw new BusinessError(
        ERROR_CODES.UNAUTHORIZED,
        'Member account is not active',
        HTTP_STATUS.UNAUTHORIZED,
      );
    }

    const accessToken = await this.tokens.signMemberAccessToken({
      accountId: account.id,
      provisional: account.isProvisional,
    });
    const refresh = await this.tokens.issueRefreshToken(account.id);
    await this.db.refreshSession.create({
      data: {
        memberAccountId: account.id,
        tokenHash: refresh.tokenHash,
        expiresAt: refresh.expiresAt,
      },
    });

    return {
      accessToken,
      refreshToken: refresh.token,
      expiresIn: ACCESS_TOKEN_LIFETIME_SECONDS,
      provisional: account.isProvisional,
      accountId: account.id,
    };
  }

  // ── Refresh (token rotation) ───────────────────────────────────────────

  /**
   * Rotate a member refresh token. Mirrors {@link AdminAuthService.refresh}:
   * the revoke is a conditional `updateMany` guarded by `revokedAt: null` +
   * `version`, run inside one transaction so concurrent refreshes of one live
   * token produce exactly one winner. Reuse of a revoked token yields 401.
   */
  async refresh(refreshToken: string, now: Date = new Date()): Promise<MemberRefreshResult> {
    const tokenHash = this.tokens.hashRefreshToken(refreshToken);
    const session = await this.db.refreshSession.findUnique({
      where: { tokenHash },
    });

    if (!session || !session.memberAccountId) {
      throw BusinessError.unauthorized('Invalid refresh token');
    }
    if (session.revokedAt !== null) {
      throw BusinessError.unauthorized('Refresh token has been revoked');
    }
    if (!this.tokens.isRefreshExpiryValid(session.expiresAt, now)) {
      throw BusinessError.unauthorized('Refresh token has expired');
    }

    const memberId = session.memberAccountId;

    return this.db.$transaction(async (tx) => {
      const revoked = await tx.refreshSession.updateMany({
        where: { id: session.id, revokedAt: null, version: session.version },
        data: { revokedAt: now, version: { increment: 1 } },
      });
      if (revoked.count === 0) {
        throw BusinessError.unauthorized('Refresh token has been revoked');
      }

      const account = await tx.memberAccount.findUnique({
        where: { id: memberId },
      });
      if (!account || account.status !== MEMBER_STATUS.ACTIVE) {
        throw BusinessError.unauthorized('Member account is not active');
      }

      const accessToken = await this.tokens.signMemberAccessToken({
        accountId: account.id,
        provisional: account.isProvisional,
      });
      const newRefresh = await this.tokens.issueRefreshToken(account.id);
      await tx.refreshSession.create({
        data: {
          memberAccountId: account.id,
          tokenHash: newRefresh.tokenHash,
          expiresAt: newRefresh.expiresAt,
        },
      });

      return {
        accessToken,
        refreshToken: newRefresh.token,
        expiresIn: ACCESS_TOKEN_LIFETIME_SECONDS,
        provisional: account.isProvisional,
      };
    });
  }

  // ── Logout ─────────────────────────────────────────────────────────────

  /**
   * Revoke the member refresh session backing `refreshToken`. Idempotent:
   * returns `{revoked:false}` for unknown or already-revoked tokens.
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
}
