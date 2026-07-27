import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installWxGlobals } from '../helpers/wx-mock';

// ────────────────────────────────────────────────────────────────────────────
// Login page: wx.login -> POST /auth/wechat-login. Provisional accounts are
// redirected to bind-phone. SECURITY: only the wx.login CODE is sent — never
// decrypted user data.
// ────────────────────────────────────────────────────────────────────────────

describe('login page', () => {
  let mock: ReturnType<typeof installWxGlobals>;

  beforeEach(() => {
    vi.resetModules();
    mock = installWxGlobals();
  });

  it('calls wx.login then wechat-login with the code, persists refresh token', async () => {
    mock.wx.login.mockImplementation((opts: { success: (r: { code: string }) => void }) => {
      opts.success({ code: 'wx-login-code' });
    });
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (String(opts.url).endsWith('/api/mini/v1/auth/wechat-login')) {
        expect(opts.data).toEqual({ code: 'wx-login-code' });
        const res = {
          statusCode: 200,
          data: {
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'access-jwt',
              refreshToken: 'refresh-jwt',
              expiresIn: 900,
              provisional: true,
              accountId: 'acc-1',
            },
          },
          header: {},
          cookies: [],
        };
        if (typeof opts.success === 'function') opts.success(res);
      }
      return {};
    });

    await import('../../miniprogram/pages/login/index');
    const page = mock.captured.page!;
    await page.onLogin();

    expect(mock.storage['member-course:refresh-token']).toBe('refresh-jwt');
  });

  it('redirects provisional accounts to bind-phone', async () => {
    mock.wx.login.mockImplementation((opts: { success: (r: { code: string }) => void }) => {
      opts.success({ code: 'wx-login-code' });
    });
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (String(opts.url).endsWith('/api/mini/v1/auth/wechat-login')) {
        const res = {
          statusCode: 200,
          data: {
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'access-jwt',
              refreshToken: 'refresh-jwt',
              expiresIn: 900,
              provisional: true,
              accountId: 'acc-1',
            },
          },
          header: {},
          cookies: [],
        };
        if (typeof opts.success === 'function') opts.success(res);
      }
      return {};
    });

    await import('../../miniprogram/pages/login/index');
    const page = mock.captured.page!;
    await page.onLogin();

    expect(mock.wx.reLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/pages/bind-phone/index' }),
    );
  });

  it('navigates bound (non-provisional) accounts straight to students', async () => {
    mock.wx.login.mockImplementation((opts: { success: (r: { code: string }) => void }) => {
      opts.success({ code: 'wx-login-code' });
    });
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (String(opts.url).endsWith('/api/mini/v1/auth/wechat-login')) {
        const res = {
          statusCode: 200,
          data: {
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'access-jwt',
              refreshToken: 'refresh-jwt',
              expiresIn: 900,
              provisional: false,
              accountId: 'acc-1',
            },
          },
          header: {},
          cookies: [],
        };
        if (typeof opts.success === 'function') opts.success(res);
      }
      return {};
    });

    await import('../../miniprogram/pages/login/index');
    const page = mock.captured.page!;
    await page.onLogin();

    expect(mock.wx.reLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/pages/students/index' }),
    );
  });

  it('never sends decrypted phone or user data — only the login code', async () => {
    mock.wx.login.mockImplementation((opts: { success: (r: { code: string }) => void }) => {
      opts.success({ code: 'wx-login-code' });
    });
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (String(opts.url).endsWith('/api/mini/v1/auth/wechat-login')) {
        const res = {
          statusCode: 200,
          data: {
            code: 0,
            message: 'ok',
            data: {
              accessToken: 'access-jwt',
              refreshToken: 'refresh-jwt',
              expiresIn: 900,
              provisional: true,
              accountId: 'acc-1',
            },
          },
          header: {},
          cookies: [],
        };
        if (typeof opts.success === 'function') opts.success(res);
      }
      return {};
    });

    await import('../../miniprogram/pages/login/index');
    const page = mock.captured.page!;
    await page.onLogin();

    const body = mock.wx.request.mock.calls[0][0].data as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['code']);
    expect(body.code).toBe('wx-login-code');
  });

  it('surfaces a toast on login failure without crashing', async () => {
    mock.wx.login.mockImplementation((opts: { success: (r: { code: string }) => void }) => {
      opts.success({ code: 'wx-login-code' });
    });
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (String(opts.url).endsWith('/api/mini/v1/auth/wechat-login')) {
        const res = {
          statusCode: 401,
          data: {
            code: 'UNAUTHORIZED',
            message: 'wechat code invalid',
            traceId: 'trace-1',
          },
          header: {},
          cookies: [],
        };
        if (typeof opts.success === 'function') opts.success(res);
      }
      return {};
    });

    await import('../../miniprogram/pages/login/index');
    const page = mock.captured.page!;
    await page.onLogin();

    expect(mock.wx.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.any(String) }),
    );
    expect(mock.wx.reLaunch).not.toHaveBeenCalled();
  });
});
