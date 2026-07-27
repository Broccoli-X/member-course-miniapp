import { bindPhone } from '../../services/auth';
import { isRedirectedError } from '../../services/http';

interface PageInstance {
  setData(data: Record<string, unknown>): void;
}

interface PhoneEvent {
  detail:
    | {
        code?: string;
        errMsg?: string;
      }
    | {
        code?: string;
        errMsg?: string;
        phoneNumber?: string;
      };
}

/**
 * Phone-binding page.
 *
 * Uses a `<button open-type="getPhoneNumber">` whose `bindgetphonenumber`
 * handler receives an event carrying the WeChat phone CODE. That code is
 * forwarded verbatim to `POST /auth/bind-phone` — the server decrypts it via
 * the WeChat API. SECURITY: the client NEVER sees or transmits the decrypted
 * phone number, even if WeChat's payload happened to include one.
 */
Page({
  data: {
    loading: false,
  },

  async onGetPhoneNumber(this: PageInstance, e: PhoneEvent) {
    // The user may decline authorization; WeChat reports it via errMsg.
    if (!e.detail || !e.detail.code) {
      wx.showToast({ title: '需要授权手机号', icon: 'none' });
      return;
    }

    this.setData({ loading: true });
    try {
      await bindPhone(e.detail.code);
      wx.reLaunch({ url: '/pages/students/index' });
    } catch (err) {
      if (!isRedirectedError(err)) {
        wx.showToast({
          title: (err as Error)?.message ?? '手机号绑定失败',
          icon: 'none',
        });
      }
    } finally {
      this.setData({ loading: false });
    }
  },
});
