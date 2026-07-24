import {
  type WechatGateway,
  type WechatPhoneNumber,
  type WechatSession,
} from '../../src/modules/identity/domain/wechat-gateway.js';

/**
 * Deterministic in-process {@link WechatGateway} for integration/e2e tests.
 *
 * The real {@link WechatHttpGateway} makes outbound HTTPS calls to WeChat that
 * are neither reachable nor desirable in the test sandbox. This fake maps
 * incoming `code` / `phoneCode` strings directly to pre-registered outcomes,
 * so tests can drive any WeChat-side scenario (new openId, known openId,
 * specific phone number, WeChat-side rejection) without touching the network.
 *
 * The mapping is plain mutable state — tests register expected outcomes via
 * {@link FakeWechatGateway.setSession} / {@link FakeWechatGateway.setPhone},
 * and the gateway returns them verically when the corresponding code is
 * presented. A code with no registered outcome throws synchronously so a
 * misconfigured test fails loudly rather than silently passing.
 *
 * Convention used by the identity fixtures: login codes look like
 * `wx-login-<openid>` and phone codes look like `wx-phone-<digits>`; the
 * fixtures set both up in one call so individual tests stay terse.
 */
export class FakeWechatGateway implements WechatGateway {
  private readonly sessions = new Map<string, WechatSession>();
  private readonly phones = new Map<string, WechatPhoneNumber>();
  private readonly rejectedCodes = new Set<string>();
  private readonly rejectedPhoneCodes = new Set<string>();

  /** Register the WeChat session (openId/unionId) to return for a login code. */
  setSession(loginCode: string, session: WechatSession): this {
    this.sessions.set(loginCode, session);
    return this;
  }

  /** Register the verified phone to return for a phone code. */
  setPhone(phoneCode: string, phone: WechatPhoneNumber): this {
    this.phones.set(phoneCode, phone);
    return this;
  }

  /** Mark a login code as rejected by WeChat (the next exchange throws). */
  rejectCode(loginCode: string): this {
    this.rejectedCodes.add(loginCode);
    return this;
  }

  /** Mark a phone code as rejected by WeChat (the next exchange throws). */
  rejectPhoneCode(phoneCode: string): this {
    this.rejectedPhoneCodes.add(phoneCode);
    return this;
  }

  /** Clear all registered mappings (called between tests by the fixtures). */
  reset(): this {
    this.sessions.clear();
    this.phones.clear();
    this.rejectedCodes.clear();
    this.rejectedPhoneCodes.clear();
    return this;
  }

  async exchangeCode(code: string): Promise<WechatSession> {
    if (this.rejectedCodes.has(code)) {
      throw new Error(`FakeWechatGateway: code ${code} is configured to be rejected by WeChat`);
    }
    const session = this.sessions.get(code);
    if (!session) {
      throw new Error(
        `FakeWechatGateway: no session registered for login code ${JSON.stringify(code)}`,
      );
    }
    return session;
  }

  async exchangePhoneCode(phoneCode: string): Promise<WechatPhoneNumber> {
    if (this.rejectedPhoneCodes.has(phoneCode)) {
      throw new Error(`FakeWechatGateway: phone code ${phoneCode} is configured to be rejected by WeChat`);
    }
    const phone = this.phones.get(phoneCode);
    if (!phone) {
      throw new Error(
        `FakeWechatGateway: no phone registered for phone code ${JSON.stringify(phoneCode)}`,
      );
    }
    return phone;
  }
}

/**
 * Derive the canonical `loginCode` string the fixtures use for a given
 * `openId`. Centralising the scheme means a test that knows only the openId
 * (e.g. `attachWechatIdentity(db, 'openid-existing')`) can still drive a login
 * for the same identity without duplicating the format string.
 */
export function loginCodeFor(openId: string): string {
  return `wx-login-${openId}`;
}

/**
 * Derive the canonical `phoneCode` string the fixtures use for a given
 * normalized phone (digits only, country-code-prefixed).
 */
export function phoneCodeFor(normalizedPhone: string): string {
  return `wx-phone-${normalizedPhone}`;
}

/**
 * Default country code + pure-number decomposition the fake returns for a
 * normalized phone. Mirrors what WeChat's `getuserphonenumber` would return
 * for a +86 Chinese mobile.
 */
export function phonePartsFor(normalizedPhone: string): WechatPhoneNumber {
  // Default to +86; tests that need a different country code can register
  // their own outcome via FakeWechatGateway.setPhone.
  if (normalizedPhone.startsWith('86')) {
    return {
      phoneNumber: `+${normalizedPhone}`,
      purePhoneNumber: normalizedPhone.slice(2),
      countryCode: '86',
    };
  }
  // If the normalized number doesn't start with 86 we still need to return
  // something; treat the whole thing as a pure number with no country code.
  return {
    phoneNumber: normalizedPhone,
    purePhoneNumber: normalizedPhone,
    countryCode: '',
  };
}
