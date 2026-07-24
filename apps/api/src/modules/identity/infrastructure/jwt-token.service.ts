import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import {
  ACCESS_TOKEN_LIFETIME_SECONDS,
} from '../application/admin-auth.service.js';
import {
  IssuedRefreshToken,
  MemberAccessTokenPrincipal,
  TokenService,
} from '../domain/password-hasher.js';

/** Refresh-token lifetime: 30 days per the brief. */
export const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * JwtService-backed {@link TokenService}. Access JWTs are signed with the
 * app-wide `JWT_SECRET`; refresh tokens are opaque random bytes hashed with
 * SHA-256 before persistence so the DB never holds a usable credential.
 *
 * Both admin and member refresh tokens share the same opaque format and the
 * same `RefreshSession` table; the only difference is which foreign-key
 * column (`adminUserId` vs `memberAccountId`) the caller persists alongside
 * the hash.
 */
@Injectable()
export class JwtTokenService implements TokenService {
  constructor(private readonly jwt: JwtService) {}

  async signAccessToken(principal: {
    adminUserId: string;
    username: string;
  }): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return this.jwt.signAsync({
      kind: 'access',
      sub: principal.adminUserId,
      username: principal.username,
      iat: now,
      exp: now + ACCESS_TOKEN_LIFETIME_SECONDS,
    });
  }

  async signMemberAccessToken(principal: MemberAccessTokenPrincipal): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return this.jwt.signAsync({
      kind: 'member',
      sub: principal.accountId,
      provisional: principal.provisional,
      iat: now,
      exp: now + ACCESS_TOKEN_LIFETIME_SECONDS,
    });
  }

  async issueRefreshToken(subjectId: string): Promise<IssuedRefreshToken> {
    // 32 bytes of entropy → 256-bit refresh token, base64url-encoded so it is
    // safe to carry in JSON and HTTP headers without further escaping. The
    // subject id (admin or member) is bound into the token both for
    // defence-in-depth (a stolen token can't be replayed against a different
    // session row) and so the plaintext carries a self-describing issuer tag
    // for log diagnostics. The authoritative binding is still the foreign-key
    // column on the `refresh_session` row; this is a belt-and-braces extra.
    const entropy = randomBytes(32).toString('base64url');
    const token = `${entropy}.${subjectId}`;
    return {
      token,
      tokenHash: this.hashRefreshToken(token),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_LIFETIME_MS),
    };
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  isRefreshExpiryValid(expiresAt: Date, now: Date = new Date()): boolean {
    return expiresAt.getTime() > now.getTime();
  }
}
