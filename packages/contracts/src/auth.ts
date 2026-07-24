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
  /** Access-token lifetime in seconds (OAuth2 `expires_in` semantics). */
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

// ── Mini-program (member) auth ─────────────────────────────────────────

/**
 * Shape of the access-token JWT payload issued for an authenticated member.
 * The `kind: 'member'` discriminator keeps member tokens distinct from admin
 * tokens (which use `kind: 'access'`) even when both are signed by the same
 * `JWT_SECRET`.
 */
export interface MemberAccessTokenPayload {
  /** Discriminator identifying this token as a member access token. */
  readonly kind: 'member';
  /** The `MemberAccount.id` this token authenticates. */
  readonly sub: string;
  /**
   * Whether the bound member account was still provisional (`isProvisional`)
   * at the moment the token was minted. Re-checked server-side on every guarded
   * request, but copied into the JWT for cheap client-side gating.
   */
  readonly provisional: boolean;
  /** Numeric issued-at (seconds since epoch). */
  readonly iat: number;
  /** Numeric expiry (seconds since epoch). 15-minute lifetime. */
  readonly exp: number;
}

/**
 * Principal attached to a request after a valid member access token is
 * verified. The `provisional` flag is the source of truth for whether the
 * caller may reach private (member-only) endpoints — reloaded from the
 * `MemberAccount` row by {@link BoundMemberGuard} so a token minted before
 * phone binding cannot be used to bypass the check after binding.
 */
export interface MemberPrincipal {
  readonly accountId: string;
  readonly provisional: boolean;
}

/** Body of `POST /api/mini/v1/auth/wechat-login`. */
export interface WechatLoginRequest {
  /** The `code` returned by `wx.login` on the mini-program client. */
  readonly code: string;
}

/** Successful WeChat login response. */
export interface WechatLoginResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  /** True until the member binds a verified phone number. */
  readonly provisional: boolean;
  /** The `MemberAccount.id` the WeChat identity was bound to. */
  readonly accountId: string;
}

/** Body of `POST /api/mini/v1/auth/bind-phone`. */
export interface BindPhoneRequest {
  /**
   * The `code` returned by `wx.getPhoneNumber` on the mini-program client.
   * Exchanged server-side for a verified phone number via the WeChat API.
   */
  readonly phoneCode: string;
}

/** Successful phone-binding response. */
export interface BindPhoneResponse {
  /** The account the member is now bound to (may differ from the provisional account). */
  readonly accountId: string;
  /** The normalized phone number now bound to the account. */
  readonly normalizedPhone: string;
}

/** Body of `POST /api/mini/v1/auth/refresh`. */
export interface MemberRefreshRequest {
  readonly refreshToken: string;
}

/** Successful refresh response. Rotates the refresh token on every use. */
export interface MemberRefreshResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

/** Body of `POST /api/mini/v1/auth/logout`. */
export interface MemberLogoutRequest {
  readonly refreshToken: string;
}

/** Standard empty acknowledgement for logout. */
export interface MemberLogoutResponse {
  readonly revoked: boolean;
}
