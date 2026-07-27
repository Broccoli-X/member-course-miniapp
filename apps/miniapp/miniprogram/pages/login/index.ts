import { wechatLogin } from '../../services/auth';

interface PageInstance {
  setData(data: Record<string, unknown>): void;
}

/** Promisified `wx.login` so the page flow is awaitable in tests and runtime. */
function wxLogin(): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res: WechatMiniprogram.LoginSuccessCallbackResult) => resolve(res.code),
      fail: (err: unknown) => reject(err),
    });
  });
}

/**
 * WeChat login landing page.
 *
 * Flow: `wx.login` → forward the CODE to `POST /auth/wechat-login` →
 *   - provisional account → reLaunch to bind-phone (the member must complete
 *     verified-phone binding before any private access).
 *   - bound account → reLaunch to the students list.
 *
 * SECURITY: only the `wx.login` `code` is sent. No decrypted user data leaves
 * the client.
 */
Page({
  data: {
    loading: false,
  },

  async onLogin(this: PageInstance) {
    this.setData({ loading: true });
    try {
      const code = await wxLogin();
      const result = await wechatLogin(code);
      if (result.provisional) {
        wx.reLaunch({ url: '/pages/bind-phone/index' });
      } else {
        wx.reLaunch({ url: '/pages/students/index' });
      }
    } catch (err) {
      wx.showToast({
        title: (err as Error)?.message ?? '登录失败',
        icon: 'none',
      });
    } finally {
      this.setData({ loading: false });
    }
  },
});
