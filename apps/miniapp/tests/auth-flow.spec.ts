import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installWxGlobals } from './helpers/wx-mock';

// ────────────────────────────────────────────────────────────────────────────
// Auth / session / navigation policy
//
// These specs gate the WeChat login + phone-bind flow and the navigation
// policy that blocks private pages until the member has bound a phone. The
// session store keeps ONLY the refresh token on disk (under the fixed key
// `member-course:refresh-token`); the access token stays in memory.
// ────────────────────────────────────────────────────────────────────────────

const REFRESH_TOKEN_KEY = 'member-course:refresh-token';

describe('auth flow', () => {
  let mock: ReturnType<typeof installWxGlobals>;
  beforeEach(() => {
    vi.resetModules();
    mock = installWxGlobals();
  });

  it('allows public courses before phone binding but blocks private navigation', async () => {
    const { sessionStore } = await import('../miniprogram/stores/session-store');
    const { canOpen } = await import('../miniprogram/services/navigation');

    sessionStore.setSession({ bound: false, accessToken: 'token' });
    expect(canOpen('/pages/courses/index')).toBe(true);
    expect(canOpen('/pages/students/index')).toBe(false);
  });

  it('canOpen allows public pages regardless of binding', async () => {
    const { sessionStore } = await import('../miniprogram/stores/session-store');
    const { canOpen } = await import('../miniprogram/services/navigation');

    sessionStore.clearSession();
    // Public catalog pages remain reachable before login.
    expect(canOpen('/pages/courses/index')).toBe(true);
    expect(canOpen('/pages/course-detail/index?id=course-1')).toBe(true);
    expect(canOpen('/pages/login/index')).toBe(true);
    expect(canOpen('/pages/bind-phone/index')).toBe(true);
  });

  it('canOpen blocks private pages when not bound', async () => {
    const { sessionStore } = await import('../miniprogram/stores/session-store');
    const { canOpen } = await import('../miniprogram/services/navigation');

    sessionStore.clearSession();
    expect(canOpen('/pages/students/index')).toBe(false);
    expect(canOpen('/pages/student-edit/index')).toBe(false);
    expect(canOpen('/pages/my/index')).toBe(false);
  });

  it('canOpen allows private pages when bound', async () => {
    const { sessionStore } = await import('../miniprogram/stores/session-store');
    const { canOpen } = await import('../miniprogram/services/navigation');

    sessionStore.setSession({ bound: true, accessToken: 'token' });
    expect(canOpen('/pages/students/index')).toBe(true);
    expect(canOpen('/pages/student-edit/index')).toBe(true);
    expect(canOpen('/pages/my/index')).toBe(true);
  });

  it('persists only the refresh token under the fixed key', async () => {
    const { sessionStore } = await import('../miniprogram/stores/session-store');

    sessionStore.setSession({
      bound: true,
      accessToken: 'access-jwt',
      refreshToken: 'refresh-jwt',
    });
    // Only the refresh token is persisted; access token and binding state stay
    // in memory so a fresh launch re-runs the refresh flow.
    expect(mock.storage[REFRESH_TOKEN_KEY]).toBe('refresh-jwt');
    // No phone number, no student payloads, no access token on disk.
    expect(Object.keys(mock.storage)).toEqual([REFRESH_TOKEN_KEY]);
  });

  it('clears persisted refresh token on logout / refresh failure / account change', async () => {
    const { sessionStore } = await import('../miniprogram/stores/session-store');

    sessionStore.setSession({
      bound: true,
      accessToken: 'access-jwt',
      refreshToken: 'refresh-jwt',
    });
    expect(mock.storage[REFRESH_TOKEN_KEY]).toBe('refresh-jwt');

    sessionStore.clearSession();
    expect(mock.storage[REFRESH_TOKEN_KEY]).toBeUndefined();
    expect(sessionStore.isBound()).toBe(false);
    expect(sessionStore.getAccessToken()).toBe(null);
  });

  it('restores in-memory access token by re-running refresh on launch', async () => {
    const { sessionStore } = await import('../miniprogram/stores/session-store');
    const { refreshSession } = await import('../miniprogram/services/auth');

    // Simulate a cold launch: only the refresh token is on disk.
    mock.storage[REFRESH_TOKEN_KEY] = 'refresh-jwt';
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      const url = String(opts.url);
      if (url.endsWith('/api/mini/v1/auth/refresh')) {
        const res = {
          statusCode: 200,
          data: {
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'new-access',
              refreshToken: 'new-refresh',
              expiresIn: 900,
              provisional: false,
            },
          },
          header: {},
          cookies: [],
        };
        if (typeof opts.success === 'function') opts.success(res);
      }
      return {};
    });

    const restored = await refreshSession();
    expect(restored).toBe(true);
    expect(sessionStore.getAccessToken()).toBe('new-access');
    // Rotated refresh token is persisted.
    expect(mock.storage[REFRESH_TOKEN_KEY]).toBe('new-refresh');
  });

  it('cold-launch refresh with provisional:false restores bound and opens private pages', async () => {
    const { sessionStore } = await import('../miniprogram/stores/session-store');
    const { refreshSession } = await import('../miniprogram/services/auth');
    const { canOpen } = await import('../miniprogram/services/navigation');

    // Cold launch: in-memory bound defaults to false, only refresh token on disk.
    mock.storage[REFRESH_TOKEN_KEY] = 'refresh-bound';
    expect(sessionStore.isBound()).toBe(false);
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (String(opts.url).endsWith('/api/mini/v1/auth/refresh')) {
        const res = {
          statusCode: 200,
          data: {
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'bound-access',
              refreshToken: 'bound-refresh',
              expiresIn: 900,
              // Server says the account is bound (not provisional).
              provisional: false,
            },
          },
          header: {},
          cookies: [],
        };
        if (typeof opts.success === 'function') opts.success(res);
      }
      return {};
    });

    const restored = await refreshSession();
    expect(restored).toBe(true);
    // Returning bound member is NOT locked out: bound restored from the flag.
    expect(sessionStore.isBound()).toBe(true);
    expect(canOpen('/pages/students/index')).toBe(true);
    expect(canOpen('/pages/my/index')).toBe(true);
  });

  it('cold-launch refresh with provisional:true leaves bound=false and gates private pages', async () => {
    const { sessionStore } = await import('../miniprogram/stores/session-store');
    const { refreshSession } = await import('../miniprogram/services/auth');
    const { canOpen } = await import('../miniprogram/services/navigation');

    mock.storage[REFRESH_TOKEN_KEY] = 'refresh-provisional';
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (String(opts.url).endsWith('/api/mini/v1/auth/refresh')) {
        const res = {
          statusCode: 200,
          data: {
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'provisional-access',
              refreshToken: 'provisional-refresh',
              expiresIn: 900,
              // Account still provisional — member must bind a phone.
              provisional: true,
            },
          },
          header: {},
          cookies: [],
        };
        if (typeof opts.success === 'function') opts.success(res);
      }
      return {};
    });

    const restored = await refreshSession();
    expect(restored).toBe(true);
    expect(sessionStore.isBound()).toBe(false);
    // Private pages stay gated until the member binds a phone.
    expect(canOpen('/pages/students/index')).toBe(false);
    expect(canOpen('/pages/my/index')).toBe(false);
    // ...but public catalog pages remain reachable.
    expect(canOpen('/pages/courses/index')).toBe(true);
  });

  it('clears session and surfaces refresh failure', async () => {
    const { sessionStore } = await import('../miniprogram/stores/session-store');
    const { refreshSession } = await import('../miniprogram/services/auth');

    mock.storage[REFRESH_TOKEN_KEY] = 'stale-refresh';
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      const url = String(opts.url);
      if (url.endsWith('/api/mini/v1/auth/refresh')) {
        const res = {
          statusCode: 401,
          data: {
            code: 'UNAUTHORIZED',
            message: 'refresh token revoked',
            traceId: 'trace-x',
          },
          header: {},
          cookies: [],
        };
        if (typeof opts.success === 'function') opts.success(res);
      }
      return {};
    });

    const restored = await refreshSession();
    expect(restored).toBe(false);
    expect(sessionStore.isBound()).toBe(false);
    expect(mock.storage[REFRESH_TOKEN_KEY]).toBeUndefined();
  });

  it('http layer marks ApiError redirected=true after a 401-refresh-failure redirect', async () => {
    const { sessionStore } = await import('../miniprogram/stores/session-store');
    const { request, ApiError, isRedirectedError } = await import(
      '../miniprogram/services/http'
    );

    // A bound member with an access token that the server now rejects.
    sessionStore.setSession({
      bound: true,
      accessToken: 'expired-access',
      refreshToken: 'dead-refresh',
    });
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      const res = {
        statusCode: 401,
        data: { code: 'UNAUTHORIZED', message: 'bad token', traceId: 't1' },
        header: {},
        cookies: [],
      };
      if (typeof opts.success === 'function') opts.success(res);
      return {};
    });
    // reLaunch must be available for the redirect.
    mock.wx.reLaunch.mockImplementation(() => {});

    let caught: unknown = null;
    try {
      await request({ path: '/api/mini/v1/students' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(isRedirectedError(caught)).toBe(true);
    // The http layer redirected to login and cleared the session.
    expect(mock.wx.reLaunch).toHaveBeenCalledWith({ url: '/pages/login/index' });
    expect(sessionStore.getAccessToken()).toBe(null);
  });

  it('isRedirectedError is false for ordinary (non-redirect) ApiErrors', async () => {
    const { request, ApiError, isRedirectedError } = await import(
      '../miniprogram/services/http'
    );
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      // A 403 (not a 401 session-expiry) does not trigger a redirect.
      const res = {
        statusCode: 403,
        data: { code: 'STUDENT_FORBIDDEN', message: 'no access', traceId: 't2' },
        header: {},
        cookies: [],
      };
      if (typeof opts.success === 'function') opts.success(res);
      return {};
    });
    let caught: unknown = null;
    try {
      await request({ path: '/api/mini/v1/students/xyz', auth: false });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(isRedirectedError(caught)).toBe(false);
    expect(mock.wx.reLaunch).not.toHaveBeenCalled();
  });
});
