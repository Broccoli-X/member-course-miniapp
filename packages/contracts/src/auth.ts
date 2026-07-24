/**
 * Administrator authentication contracts.
 *
 * These types are produced and consumed by the admin auth endpoints
 * (`POST /api/admin/v1/auth/{login,refresh,logout}`). They are intentionally
 * framework-agnostic so the same shapes can be re-used by the miniprogram
 * client and by automated tests.
 */

/** Shape of the access-token JWT payload issued for an administrator. */
export interface AdminAccessTokenPayload {
  /** Discriminator so a single secret can later serve multiple token kinds. */
  readonly kind: 'access';
  /** The `AdminUser.id` this token authenticates. */
  readonly sub: string;
  /** The administrator's username, copied in for logging/auditing. */
  readonly username: string;
  /**
   * Numeric issued-at (seconds since epoch). Used together with `exp` to
   * derive token lifetime; not the same as the admin's `version` column.
   */
  readonly iat: number;
  /** Numeric expiry (seconds since epoch). 15-minute lifetime. */
  readonly exp: number;
}

/** Principal attached to a request after a valid access token is verified. */
export interface AdminPrincipal {
  readonly adminUserId: string;
  readonly username: string;
}

/** Body of `POST /api/admin/v1/auth/login`. */
export interface AdminLoginRequest {
  readonly username: string;
  readonly password: string;
}

/** Successful login response. */
export interface AdminLoginResponse {
  readonly accessToken: string;
  /** Opaque refresh token; only its hash is persisted server-side. */
  readonly refreshToken: string;
  /** Access-token absolute expiry in ms since epoch (for client UIs). */
  readonly expiresIn: number;
  readonly admin: {
    readonly id: string;
    readonly username: string;
  };
}

/** Body of `POST /api/admin/v1/auth/refresh`. */
export interface AdminRefreshRequest {
  readonly refreshToken: string;
}

/** Successful refresh response. Rotates the refresh token on every use. */
export interface AdminRefreshResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

/** Body of `POST /api/admin/v1/auth/logout`. */
export interface AdminLogoutRequest {
  readonly refreshToken: string;
}

/** Standard empty acknowledgement for logout. */
export interface AdminLogoutResponse {
  readonly revoked: boolean;
}
