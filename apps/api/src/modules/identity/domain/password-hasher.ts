/**
 * Identity domain ports.
 *
 * This file holds the two abstractions the {@link AdminAuthService} orchestrates
 * so that the auth logic stays unit-testable without MySQL or a real JWT
 * secret: a {@link PasswordHasher} (argon2 adapter) and a {@link TokenService}
 * (JWT + refresh-token hash adapter). Implementations live under
 * `infrastructure/`; tests substitute fakes/mocks.
 */

/**
 * Hashes and verifies passwords using Argon2id. The plain password is never
 * persisted — only the encoded hash string returned by {@link hash}.
 */
export interface PasswordHasher {
  /** Produce an Argon2id encoded hash for the given plain password. */
  hash(plain: string): Promise<string>;
  /** Return true iff `plain` matches a previously computed `encoded` hash. */
  verify(encoded: string, plain: string): Promise<boolean>;
}

/**
 * Result of minting a fresh refresh token. The plaintext token is returned to
 * the caller exactly once; only {@link tokenHash} is persisted.
 */
export interface IssuedRefreshToken {
  /** Plaintext token to hand to the client. Never stored server-side. */
  readonly token: string;
  /** SHA-256 hex digest of `token`; safe to persist on `RefreshSession`. */
  readonly tokenHash: string;
  /** Absolute expiry, ms since epoch. */
  readonly expiresAt: Date;
}

/** Verified refresh session returned by {@link TokenService.verifyRefreshToken}. */
export interface VerifiedRefreshSession {
  readonly sessionId: string;
  readonly adminUserId: string;
}

/**
 * Mints access JWTs and issues/verifies opaque rotating refresh tokens.
 * Implementations are responsible for hashing refresh tokens (SHA-256) so the
 * service layer never handles the plaintext token except to echo it back to
 * the client.
 */
export interface TokenService {
  /** Sign a 15-minute admin access JWT for the given principal. */
  signAccessToken(principal: { adminUserId: string; username: string }): Promise<string>;

  /**
   * Mint a brand-new refresh token (plaintext + hash + expiry). The caller is
   * responsible for persisting the {@link IssuedRefreshToken.tokenHash} on a
   * `RefreshSession` row.
   */
  issueRefreshToken(adminUserId: string): Promise<IssuedRefreshToken>;

  /**
   * Hash a plaintext refresh token for lookup. Used by the service to find the
   * candidate `RefreshSession` row before verifying it.
   */
  hashRefreshToken(token: string): string;

  /**
   * Validate that `expiresAt` is in the future. (Persistence-layer revocation
   * is checked separately by the service against the loaded row.)
   */
  isRefreshExpiryValid(expiresAt: Date, now?: Date): boolean;
}
