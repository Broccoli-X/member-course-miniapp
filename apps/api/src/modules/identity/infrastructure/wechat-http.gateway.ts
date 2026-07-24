import { Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES, HTTP_STATUS } from '@member-course/contracts';
import { BusinessError } from '../../../common/errors/business-error.js';
import {
  WechatGateway,
  WechatPhoneNumber,
  WechatSession,
} from '../domain/wechat-gateway.js';

/**
 * Real WeChat Open Platform adapter for {@link WechatGateway}.
 *
 * Calls two WeChat endpoints with the mini-program's `appid` + `secret`:
 *
 *  - `GET https://api.weixin.qq.com/sns/jscode2session` — exchanges a
 *    `wx.login` code for `openid` (+ optional `unionid`).
 *  - `POST https://api.weixin.qq.com/wxa/business/getuserphonenumber` —
 *    exchanges a `wx.getPhoneNumber` code for the verified phone number.
 *    Requires a server-side `access_token` obtained from
 *    `https://api.weixin.qq.com/cgi-bin/token`.
 *
 * Configuration is read from env at construction time:
 *  - `WECHAT_APP_ID` / `WECHAT_APP_SECRET` — mini-program credentials.
 *  - `WECHAT_API_BASE` — optional override (defaults to the public endpoint;
 *    useful for pointing at a corporate proxy).
 *
 * NOTE: this adapter is NOT exercised by the test suite — the test environment
 * has no WeChat credentials or outbound network. Integration/e2e tests inject
 * {@link FakeWechatGateway} via the {@link WECHAT_GATEWAY} DI token override.
 * The adapter is included here so production wiring is complete and the
 * port/adapter boundary is honest (no hidden test-only seams in the service).
 *
 * `fetch` is used (available in Node 18+ / the project targets Node 24) so no
 * new HTTP dependency is introduced.
 */
interface JsCode2SessionResponse {
  openid?: string;
  unionid?: string;
  session_key?: string;
  errcode?: number;
  errmsg?: string;
}

interface GetUserPhoneNumberResponse {
  phone_info?: {
    phoneNumber?: string;
    purePhoneNumber?: string;
    countryCode?: string;
    watermark?: { timestamp?: number; appid?: string };
  };
  errcode?: number;
  errmsg?: string;
}

interface ClientAccessTokenResponse {
  access_token?: string;
  expires_in?: number;
  errcode?: number;
  errmsg?: string;
}

@Injectable()
export class WechatHttpGateway implements WechatGateway {
  private readonly logger = new Logger(WechatHttpGateway.name);
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly apiBase: string;

  // In-process cache of the server-side client access_token. The token is
  // valid for ~2h; we refetch lazily when expired. This is intentionally NOT
  // distributed — for a multi-instance deployment, swap in a shared cache
  // (Redis) by overriding this adapter.
  private cachedClientToken: { token: string; expiresAt: number } | null = null;

  constructor() {
    this.appId = process.env.WECHAT_APP_ID ?? '';
    this.appSecret = process.env.WECHAT_APP_SECRET ?? '';
    this.apiBase = process.env.WECHAT_API_BASE ?? 'https://api.weixin.qq.com';
    if (!this.appId || !this.appSecret) {
      // Don't throw at construction — module loading shouldn't crash just
      // because we're in a test env without WeChat creds. The first call will
      // surface a clear UNAUTHORIZED instead.
      this.logger.warn(
        'WECHAT_APP_ID / WECHAT_APP_SECRET are not set; WeChat calls will fail until they are configured',
      );
    }
  }

  async exchangeCode(code: string): Promise<WechatSession> {
    if (!this.appId || !this.appSecret) {
      throw BusinessError.unauthorized('WeChat credentials are not configured');
    }
    const url =
      `${this.apiBase}/sns/jscode2session` +
      `?appid=${encodeURIComponent(this.appId)}` +
      `&secret=${encodeURIComponent(this.appSecret)}` +
      `&js_code=${encodeURIComponent(code)}` +
      `&grant_type=authorization_code`;

    const body = await this.fetchJson<JsCode2SessionResponse>(url, { method: 'GET' });
    if (body.errcode && body.errcode !== 0) {
      this.logger.warn(`jscode2session failed: ${body.errcode} ${body.errmsg}`);
      throw BusinessError.unauthorized(
        `WeChat code exchange failed: ${body.errmsg ?? 'unknown error'}`,
      );
    }
    if (!body.openid) {
      throw BusinessError.unauthorized('WeChat code exchange returned no openid');
    }
    return { openId: body.openid, unionId: body.unionid };
  }

  async exchangePhoneCode(phoneCode: string): Promise<WechatPhoneNumber> {
    if (!this.appId || !this.appSecret) {
      throw BusinessError.unauthorized('WeChat credentials are not configured');
    }
    const accessToken = await this.getClientAccessToken();
    const url = `${this.apiBase}/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(accessToken)}`;
    const body = await this.fetchJson<GetUserPhoneNumberResponse>(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: phoneCode }),
    });
    if (body.errcode && body.errcode !== 0) {
      this.logger.warn(`getuserphonenumber failed: ${body.errcode} ${body.errmsg}`);
      throw BusinessError.unauthorized(
        `WeChat phone code exchange failed: ${body.errmsg ?? 'unknown error'}`,
      );
    }
    const info = body.phone_info;
    if (!info || !info.purePhoneNumber || !info.countryCode) {
      throw BusinessError.unauthorized('WeChat phone code exchange returned no phone number');
    }
    return {
      phoneNumber: info.phoneNumber ?? `${info.countryCode}${info.purePhoneNumber}`,
      purePhoneNumber: info.purePhoneNumber,
      countryCode: info.countryCode,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private async getClientAccessToken(): Promise<string> {
    if (this.cachedClientToken && this.cachedClientToken.expiresAt > Date.now() + 60_000) {
      return this.cachedClientToken.token;
    }
    const url =
      `${this.apiBase}/cgi-bin/token` +
      `?grant_type=client_credential` +
      `&appid=${encodeURIComponent(this.appId)}` +
      `&secret=${encodeURIComponent(this.appSecret)}`;
    const body = await this.fetchJson<ClientAccessTokenResponse>(url, { method: 'GET' });
    if (body.errcode && body.errcode !== 0) {
      throw new BusinessError(
        ERROR_CODES.INTERNAL_ERROR,
        `WeChat client access_token fetch failed: ${body.errmsg ?? 'unknown error'}`,
        HTTP_STATUS.INTERNAL_ERROR,
      );
    }
    if (!body.access_token) {
      throw new BusinessError(
        ERROR_CODES.INTERNAL_ERROR,
        'WeChat client access_token fetch returned no token',
        HTTP_STATUS.INTERNAL_ERROR,
      );
    }
    const expiresInMs = (body.expires_in ?? 7200) * 1000;
    this.cachedClientToken = {
      token: body.access_token,
      expiresAt: Date.now() + expiresInMs,
    };
    return body.access_token;
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    if (!res.ok) {
      throw new BusinessError(
        ERROR_CODES.INTERNAL_ERROR,
        `WeChat HTTP ${init.method ?? 'GET'} ${url.replace(/secret=[^&]+/, 'secret=***')} failed: HTTP ${res.status}`,
        HTTP_STATUS.INTERNAL_ERROR,
      );
    }
    return (await res.json()) as T;
  }
}
