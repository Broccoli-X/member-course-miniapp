/**
 * Mini auth service — thin wrappers around the WeChat auth endpoints.
 *
 * SECURITY: this module only ever sends the WeChat *codes* (`wx.login` code,
 * `getPhoneNumber` code). It never decrypts, sees, or transmits the phone
 * number or user data; the server performs the WeChat exchange.
 */

import { request } from './http';
import { sessionStore } from '../stores/session-store';

interface WechatLoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  provisional: boolean;
  accountId: string;
}

interface MemberRefreshResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  /**
   * Whether the account was still provisional at refresh time. Used on cold
   * launch to restore the in-memory `bound` flag (= `!provisional`) so a
   * returning bound member is not locked out of private pages.
   */
  provisional: boolean;
}

interface BindPhoneResponse {
  accountId: string;
  normalizedPhone: string;
}

/**
 * Exchange the `wx.login` code for a session. The caller passes the code in —
 * never call `wx.login` from inside this module to keep it testable.
 *
 * On success the in-memory session is populated and ONLY the refresh token is
 * persisted (see {@link sessionStore}). `bound` reflects `!provisional`.
 */
export async function wechatLogin(code: string): Promise<WechatLoginResponse> {
  const data = await request<WechatLoginResponse>({
    method: 'POST',
    path: '/api/mini/v1/auth/wechat-login',
    data: { code },
    auth: false,
  });
  sessionStore.setSession({
    bound: !data.provisional,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    accountId: data.accountId,
  });
  return data;
}

/**
 * Forward the WeChat `getPhoneNumber` code to the bind endpoint. After bind the
 * member is considered `bound`; the server may have merged accounts (returning
 * a different `accountId`) — setSession handles the rotation/clear of any
 * previously persisted refresh token.
 */
export async function bindPhone(phoneCode: string): Promise<BindPhoneResponse> {
  const data = await request<BindPhoneResponse>({
    method: 'POST',
    path: '/api/mini/v1/auth/bind-phone',
    data: { phoneCode },
  });
  sessionStore.setSession({
    bound: true,
    accessToken: sessionStore.getAccessToken() ?? '',
    accountId: data.accountId,
  });
  return data;
}

/** Best-effort logout; clears the local session regardless of server response. */
export async function logout(): Promise<void> {
  try {
    await request<void>({
      method: 'POST',
      path: '/api/mini/v1/auth/logout',
      data: { refreshToken: sessionStore.getRefreshToken() },
    });
  } finally {
    sessionStore.clearSession();
  }
}

/**
 * Rotate the access token using the persisted refresh token. Returns the new
 * access token or null if no refresh token was available or the refresh
 * failed. On failure the session is cleared so the caller can route to login.
 *
 * The `allowRedirect` flag prevents recursive navigation: refresh calls issued
 * from inside the http layer's 401 handler must not themselves trigger another
 * navigation.
 */
export async function refreshAccessToken(allowRedirect = false): Promise<string | null> {
  const refreshToken = sessionStore.getRefreshToken();
  if (!refreshToken) return null;

  try {
    const data = await refreshViaHttp(refreshToken);
    // The server is authoritative on provisionality. On a cold launch the
    // in-memory `bound` flag is gone (defaulted to false), so we restore it
    // from the refresh response — otherwise returning bound members would be
    // locked out of every private page until they re-bind. During a mid-
    // session 401 retry this also stays correct: if the member bound their
    // phone in another session, the new flag reflects that.
    sessionStore.setSession({
      bound: !data.provisional,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      accountId: sessionStore.getAccountId() ?? undefined,
    });
    return data.accessToken;
  } catch {
    sessionStore.clearSession();
    if (allowRedirect && typeof wx !== 'undefined' && typeof wx.reLaunch === 'function') {
      wx.reLaunch({ url: '/pages/login/index' });
    }
    return null;
  }
}

/**
 * Re-run the refresh flow on cold launch using only the persisted refresh
 * token. Returns true if a session was restored, false otherwise (the caller
 * routes to login when false). The server is the source of truth on
 * provisionality: {@link refreshAccessToken} restores `bound = !provisional`
 * from the refresh response, so a returning bound member is NOT locked out of
 * private pages.
 */
export async function refreshSession(): Promise<boolean> {
  const accessToken = await refreshAccessToken();
  if (!accessToken) return false;
  return sessionStore.getAccessToken() !== null;
}

// Indirection so the http layer can import refreshAccessToken without a cycle
// (http.ts imports refreshAccessToken; this module imports request from http).
function refreshViaHttp(refreshToken: string): Promise<MemberRefreshResponse> {
  return request<MemberRefreshResponse>({
    method: 'POST',
    path: '/api/mini/v1/auth/refresh',
    data: { refreshToken },
    auth: false,
  });
}
