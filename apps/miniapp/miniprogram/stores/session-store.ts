/**
 * In-memory session store for the bound member.
 *
 * SECURITY/PRIVACY DESIGN (per task-14 brief Step 3):
 *   - The access token lives only in memory. It is never written to storage.
 *   - ONLY the refresh token is persisted, under the fixed key
 *     `member-course:refresh-token`, via `wx.setStorageSync`. The server rotates
 *     it on every refresh, so we re-persist after each refresh.
 *   - On logout, refresh failure, or account change (`accountId` changes after
 *     a phone bind/merge) the persisted refresh token is cleared.
 *   - Phone numbers and student profile payloads are NEVER persisted here —
 *     those flows keep them strictly in-memory and on the server.
 *
 * `bound` reflects whether the member has completed the verified-phone bind
 * step. A provisional account (`bound === false`) may still hold an access
 * token but cannot reach private endpoints.
 */

/** Fixed storage key — never reuse it for anything other than the refresh token. */
export const REFRESH_TOKEN_STORAGE_KEY = 'member-course:refresh-token';

export interface SessionState {
  /** Whether the verified-phone bind step has completed. */
  bound: boolean;
  /** In-memory access token (JWT). Never persisted. */
  accessToken: string;
  /** Rotating refresh token. Persisted under the fixed key when present. */
  refreshToken?: string;
  /** Member account id (changes after a phone-bind merge). */
  accountId?: string;
}

interface InternalSession {
  bound: boolean;
  accessToken: string | null;
  refreshToken: string | null;
  accountId: string | null;
}

let session: InternalSession = {
  bound: false,
  accessToken: null,
  refreshToken: null,
  accountId: null,
};

function readPersistedRefreshToken(): string | null {
  const value = wx.getStorageSync(REFRESH_TOKEN_STORAGE_KEY);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function persistRefreshToken(token: string | null): void {
  if (token && token.length > 0) {
    wx.setStorageSync(REFRESH_TOKEN_STORAGE_KEY, token);
  } else {
    wx.removeStorageSync(REFRESH_TOKEN_STORAGE_KEY);
  }
}

export const sessionStore = {
  /** Replace the in-memory session. Persists the refresh token (rotating). */
  setSession(next: SessionState): void {
    const accountChanged =
      session.accountId !== null && next.accountId !== undefined && next.accountId !== session.accountId;
    session = {
      bound: next.bound,
      accessToken: next.accessToken,
      refreshToken: next.refreshToken ?? null,
      accountId: next.accountId ?? session.accountId,
    };
    // On account change (e.g. phone bind merged into a different account) wipe
    // any previously persisted refresh token before storing the new one.
    if (accountChanged) {
      persistRefreshToken(null);
    }
    persistRefreshToken(session.refreshToken);
  },

  /** Wipe everything: in-memory session AND the persisted refresh token. */
  clearSession(): void {
    session = { bound: false, accessToken: null, refreshToken: null, accountId: null };
    persistRefreshToken(null);
  },

  isBound(): boolean {
    return session.bound;
  },

  getAccessToken(): string | null {
    return session.accessToken;
  },

  getRefreshToken(): string | null {
    // Prefer the in-memory value; fall back to storage so a cold launch that
    // never re-ran refresh can still read it.
    return session.refreshToken ?? readPersistedRefreshToken();
  },

  getAccountId(): string | null {
    return session.accountId;
  },
};
