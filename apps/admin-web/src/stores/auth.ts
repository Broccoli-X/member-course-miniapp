/**
 * Auth store.
 *
 * Holds the short-lived `accessToken` in memory only and persists the opaque
 * `refreshToken` to `localStorage` (rotated on every refresh). Registers itself
 * as the {@link TokenProvider} for the http layer at construction so 401s can
 * transparently refresh and so refresh failures clear + redirect to login.
 */
import { defineStore } from 'pinia';
import authApi from '../api/auth';
import { setTokenProvider } from '../api/http';

const REFRESH_TOKEN_KEY = 'mc.admin.refreshToken';

function readRefreshToken(): string | null {
  try {
    return window.localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeRefreshToken(token: string | null): void {
  try {
    if (token) {
      window.localStorage.setItem(REFRESH_TOKEN_KEY, token);
    } else {
      window.localStorage.removeItem(REFRESH_TOKEN_KEY);
    }
  } catch {
    /* ignore storage errors (private mode, etc.) */
  }
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    accessToken: null,
    refreshToken: readRefreshToken(),
  }),
  getters: {
    isAuthenticated: (state): boolean => state.accessToken !== null,
  },
  actions: {
    /**
     * Exchange username/password for tokens. On success stores both tokens and
     * persists the refresh token.
     */
    async login(credentials: { username: string; password: string }): Promise<void> {
      const result = await authApi.login(credentials);
      this.accessToken = result.accessToken;
      this.refreshToken = result.refreshToken;
      writeRefreshToken(result.refreshToken);
    },
    /**
     * Rotate the tokens via the refresh endpoint. Called by the http layer on a
     * 401. Throws if the server rejects the refresh — the caller (http) then
     * clears + redirects.
     */
    async refresh(): Promise<string> {
      if (!this.refreshToken) {
        throw new Error('No refresh token');
      }
      const result = await authApi.refresh(this.refreshToken);
      this.accessToken = result.accessToken;
      this.refreshToken = result.refreshToken;
      writeRefreshToken(result.refreshToken);
      return result.accessToken;
    },
    /** Best-effort server-side logout, then clear local state regardless. */
    async logout(): Promise<void> {
      const rt = this.refreshToken;
      this.clear();
      if (rt) {
        try {
          await authApi.logout(rt);
        } catch {
          /* even if the server call fails, local state is already cleared */
        }
      }
    },
    /** Clear both tokens (in-memory + persisted refresh token). */
    clear(): void {
      this.accessToken = null;
      this.refreshToken = null;
      writeRefreshToken(null);
    },
    /** TokenProvider interface for the http layer. */
    getAccessToken(): string | null {
      return this.accessToken;
    },
    getRefreshToken(): string | null {
      return this.refreshToken;
    },
  },
});

/**
 * Wire the store into the http layer. Called once from `main.ts` after Pinia
 * is active. The store instance is captured so http can read live token state.
 */
export function installTokenProvider(): void {
  const store = useAuthStore();
  setTokenProvider({
    getAccessToken: () => store.accessToken,
    getRefreshToken: () => store.refreshToken,
    refresh: () => store.refresh(),
    clear: () => store.clear(),
  });
}
