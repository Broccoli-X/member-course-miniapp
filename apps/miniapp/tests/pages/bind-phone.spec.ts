import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installWxGlobals } from '../helpers/wx-mock';

// ────────────────────────────────────────────────────────────────────────────
// Bind-phone page: button open-type="getPhoneNumber" yields a phone CODE that
// is forwarded verbatim to POST /auth/bind-phone. SECURITY: the client never
// sees or sends the decrypted phone number — only the WeChat phone code.
// ────────────────────────────────────────────────────────────────────────────

describe('bind-phone page', () => {
  let mock: ReturnType<typeof installWxGlobals>;

  beforeEach(() => {
    vi.resetModules();
    mock = installWxGlobals();
  });

  it('forwards the getPhoneNumber code to bind-phone, then marks the session bound', async () => {
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (String(opts.url).endsWith('/api/mini/v1/auth/bind-phone')) {
        expect(opts.data).toEqual({ phoneCode: 'phone-code' });
        const res = {
          statusCode: 200,
          data: {
            code: 0,
            message: 'ok',
            data: {
              accountId: 'acc-1',
              normalizedPhone: '13800000000',
              accessToken: 'bind-access-token',
              refreshToken: 'bind-refresh-token',
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

    await import('../../miniprogram/pages/bind-phone/index');
    const page = mock.captured.page!;

    // WeChat calls onGetPhoneNumber with e.detail.code (the phone code).
    await page.onGetPhoneNumber({ detail: { code: 'phone-code' } });

    const { sessionStore } = await import('../../miniprogram/stores/session-store');
    expect(sessionStore.isBound()).toBe(true);
    // M1 final-review fix I-1: the bind response carries a fresh token pair
    // signed for the bound account. setSession MUST rotate onto them so the
    // next private request (which uses getAccessToken) carries the bound token.
    expect(sessionStore.getAccessToken()).toBe('bind-access-token');
    expect(sessionStore.getRefreshToken()).toBe('bind-refresh-token');
    expect(sessionStore.getAccountId()).toBe('acc-1');
  });

  it('navigates to the students list after a successful bind', async () => {
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (String(opts.url).endsWith('/api/mini/v1/auth/bind-phone')) {
        const res = {
          statusCode: 200,
          data: {
            code: 0,
            message: 'ok',
            data: {
              accountId: 'acc-1',
              normalizedPhone: '13800000000',
              accessToken: 'bind-access-token',
              refreshToken: 'bind-refresh-token',
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

    await import('../../miniprogram/pages/bind-phone/index');
    const page = mock.captured.page!;
    await page.onGetPhoneNumber({ detail: { code: 'phone-code' } });

    expect(mock.wx.reLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/pages/students/index' }),
    );
  });

  it('never sends decrypted phone number data from the client', async () => {
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (String(opts.url).endsWith('/api/mini/v1/auth/bind-phone')) {
        const res = {
          statusCode: 200,
          data: {
            code: 0,
            message: 'ok',
            data: {
              accountId: 'acc-1',
              normalizedPhone: '13800000000',
              accessToken: 'bind-access-token',
              refreshToken: 'bind-refresh-token',
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

    await import('../../miniprogram/pages/bind-phone/index');
    const page = mock.captured.page!;
    // Simulate the getPhoneNumber event; even if WeChat leaked a number we must
    // NOT forward it — only the code is sent.
    await page.onGetPhoneNumber({
      detail: {
        code: 'phone-code',
        // A malicious/leaky payload we must ignore:
        phoneNumber: '13800000000',
      },
    });

    const body = mock.wx.request.mock.calls[0][0].data as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['phoneCode']);
    expect(body.phoneCode).toBe('phone-code');
  });

  it('ignores the getPhoneNumber event when the user declines', async () => {
    await import('../../miniprogram/pages/bind-phone/index');
    const page = mock.captured.page!;

    // WeChat sets errMsg / no code when the user refuses authorization.
    await page.onGetPhoneNumber({ detail: { errMsg: 'getPhoneNumber:fail user deny' } });

    expect(mock.wx.request).not.toHaveBeenCalled();
  });

  it('surfaces a toast on bind failure', async () => {
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (String(opts.url).endsWith('/api/mini/v1/auth/bind-phone')) {
        const res = {
          statusCode: 409,
          data: {
            code: 'PHONE_BINDING_CONFLICT',
            message: 'phone already bound to another wechat',
            traceId: 'trace-1',
          },
          header: {},
          cookies: [],
        };
        if (typeof opts.success === 'function') opts.success(res);
      }
      return {};
    });

    await import('../../miniprogram/pages/bind-phone/index');
    const page = mock.captured.page!;
    await page.onGetPhoneNumber({ detail: { code: 'phone-code' } });

    expect(mock.wx.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.any(String) }),
    );
    expect(mock.wx.reLaunch).not.toHaveBeenCalled();
  });
});
