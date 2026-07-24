/**
 * WeChat platform port.
 *
 * The mini-program auth flow needs two pieces of information from WeChat that
 * can only be obtained server-side by calling WeChat's APIs with the app
 * secret:
 *  1. The `openId` (and optional `unionId`) for a `wx.login` code — used by
 *     {@link WechatAuthService.login} to find-or-create a `MemberAccount`.
 *  2. The verified phone number for a `wx.getPhoneNumber` code — used by
 *     {@link PhoneBindingService.bind} to bind a phone to an account.
 *
 * Both calls are behind this single port so the auth services stay unit-
 * testable: production wires {@link WechatHttpGateway} (real HTTPS calls to
 * `api.weixin.qq.com`); tests wire {@link FakeWechatGateway} (deterministic
 * per-code mapping). The DI token {@link WECHAT_GATEWAY} is exported from
 * `tokens.ts`.
 */

/** Result of exchanging a `wx.login` code with WeChat. */
export interface WechatSession {
  /** Stable per-app user identifier; the lookup key for `WechatIdentity`. */
  readonly openId: string;
  /**
   * Cross-app identifier within the same WeChat Open Platform account. Optional
   * because not every mini-program is part of an Open Platform account; stored
   * when present so a future account-merge by unionId is possible.
   */
  readonly unionId?: string;
}

/** Result of exchanging a `wx.getPhoneNumber` code with WeChat. */
export interface WechatPhoneNumber {
  /**
   * The full phone number including country code, as WeChat returned it. Kept
   * for diagnostics; the binding path normalizes via the country code + pure
   * number.
   */
  readonly phoneNumber: string;
  /** Phone number without the country code (digits only). */
  readonly purePhoneNumber: string;
  /** Country code without the leading `+`, e.g. `86`. */
  readonly countryCode: string;
}

/**
 * Server-side gateway to WeChat's `sns/jscode2session` and
 * `wamov/getPhoneNumber` endpoints. Implementations MUST surface a
 * {@link BusinessError} (UNAUTHORIZED) when WeChat rejects a code so the
 * caller surfaces a 401 rather than a 500.
 */
export interface WechatGateway {
  /** Exchange a `wx.login` `code` for the user's `openId`/`unionId`. */
  exchangeCode(code: string): Promise<WechatSession>;
  /** Exchange a `wx.getPhoneNumber` `code` for the verified phone number. */
  exchangePhoneCode(phoneCode: string): Promise<WechatPhoneNumber>;
}
