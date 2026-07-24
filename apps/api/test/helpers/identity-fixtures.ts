import type { PrismaClient } from '../../src/generated/prisma/client.js';
import type { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import type { MemberPrincipal } from '@member-course/contracts';
import { WechatAuthService } from '../../src/modules/identity/application/wechat-auth.service.js';
import { PhoneBindingService } from '../../src/modules/identity/application/phone-binding.service.js';
import { normalizePhone } from '../../src/modules/identity/domain/phone.js';
import {
  FakeWechatGateway,
  loginCodeFor,
  phoneCodeFor,
  phonePartsFor,
} from '../doubles/fake-wechat.gateway.js';

/**
 * Test fixtures for the mini-program (member) auth flow.
 *
 * The brief's integration cases (task-5-brief.md) are written against these
 * helper names verbatim:
 *  - `loginWithWechat(fakeWechat, 'openid-1')`
 *  - `createPrecreatedMember(db, '13800000000')`
 *  - `bindPhone(provisional, 'phone-code-1')`
 *  - `accountStatus(db, provisional.accountId)`
 *  - `identityOwner(db, 'openid-1')`
 *  - `attachWechatIdentity(precreated.id, 'openid-existing')`
 *
 * To honour those exact call shapes while still binding the helpers to the
 * real services + fake gateway under test, the spec calls
 * {@link createIdentityFixtures} once with its `{ auth, binding, fake, db }`
 * dependencies and destructures the bound helpers. The helpers below are
 * thin: each one wires the fake gateway mapping (openId → login code, phone →
 * phone code) and then delegates to the real service method.
 *
 * `db` is a union of `PrismaClient` (integration) and `PrismaService` (e2e);
 * both expose the same delegate surface.
 */

/** Union of "looks like a Prisma client" — accepts both real and service forms. */
export type DbLike = PrismaClient | PrismaService;

/** Result of `loginWithWechat`. */
export interface LoginFixture {
  readonly accountId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly provisional: boolean;
}

/**
 * Build the bound helper set the brief's tests call. The returned helpers
 * close over the supplied services so call sites stay terse and match the
 * brief's verbatim signatures.
 */
export function createIdentityFixtures(deps: {
  auth: WechatAuthService;
  binding: PhoneBindingService;
  fake: FakeWechatGateway;
  db: DbLike;
}): {
  loginWithWechat: (fake: FakeWechatGateway, openId: string, opts?: { unionId?: string }) => Promise<LoginFixture>;
  createPrecreatedMember: (db: DbLike, phone: string, overrides?: { id?: string; status?: string }) => Promise<{ id: string; normalizedPhone: string }>;
  bindPhone: (principal: LoginFixture | MemberPrincipal, phoneCodeOrPhone: string) => Promise<{ accountId: string; normalizedPhone: string }>;
  accountStatus: (db: DbLike, accountId: string) => Promise<string>;
  identityOwner: (db: DbLike, openId: string) => Promise<string | null>;
  attachWechatIdentity: (accountId: string, openId: string, opts?: { unionId?: string }) => Promise<{ id: string; accountId: string; openId: string }>;
} {
  const { auth, binding, db } = deps;

  return {
    /**
     * Register the openId on `fake` (the FIRST positional arg, per the brief)
     * and drive `WechatAuthService.login`. The login code uses the convention
     * `wx-login-<openId>` so the caller only needs to know the openId.
     */
    async loginWithWechat(fake, openId, opts = {}) {
      const code = loginCodeFor(openId);
      fake.setSession(code, { openId, unionId: opts.unionId });
      const result = await auth.login(code);
      return {
        accountId: result.accountId,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        provisional: result.provisional,
      };
    },

    /**
     * Insert a non-provisional `MemberAccount` with the given phone. `db` is
     * the FIRST positional arg, per the brief.
     */
    async createPrecreatedMember(targetDb, phone, overrides = {}) {
      const normalizedPhone = normalizePhone(phone);
      const account = await targetDb.memberAccount.create({
        data: {
          ...(overrides.id ? { id: overrides.id } : {}),
          normalizedPhone,
          isProvisional: false,
          status: overrides.status ?? 'ACTIVE',
        },
        select: { id: true, normalizedPhone: true },
      });
      return account;
    },

    /**
     * Register the verified phone on the bound fake gateway, then drive
     * `PhoneBindingService.bind` as `principal`. The SECOND positional arg is
     * the phone code (per the brief); to keep the fixtures ergonomic, a caller
     * may pass either:
     *  - a raw phone string (e.g. `'13800000000'`) — normalized and mapped to
     *    the conventional phone code `wx-phone-<normalized>`, OR
     *  - an already-registered phone code (e.g. `'phone-code-1'` from the
     *    brief). When the value starts with `phone-code-` it is treated as a
     *    literal phone code and a default phone mapping is registered behind
     *    it (default phone `13800000000`) so the brief's literal
     *    `'phone-code-1'` works out of the box.
     */
    async bindPhone(principal, phoneCodeOrPhone) {
      const principalArg: MemberPrincipal =
        'provisional' in principal
          ? { accountId: principal.accountId, provisional: principal.provisional }
          : principal;

      let phoneCode: string;
      let normalizedPhone: string;
      if (phoneCodeOrPhone.startsWith('phone-code-')) {
        // Literal phone code from the brief (e.g. 'phone-code-1'): register a
        // default phone behind it so the test doesn't also have to call setPhone.
        phoneCode = phoneCodeOrPhone;
        normalizedPhone = normalizePhone('13800000000');
      } else {
        // Raw phone string: derive the conventional phone code.
        phoneCode = phoneCodeFor(normalizePhone(phoneCodeOrPhone));
        normalizedPhone = normalizePhone(phoneCodeOrPhone);
      }
      deps.fake.setPhone(phoneCode, phonePartsFor(normalizedPhone));

      return binding.bind(principalArg, phoneCode);
    },

    /** Read `MemberAccount.status` for an account id. */
    async accountStatus(targetDb, accountId) {
      const row = await targetDb.memberAccount.findUnique({
        where: { id: accountId },
        select: { status: true },
      });
      return row?.status ?? 'MISSING';
    },

    /** Read the `accountId` that owns the `WechatIdentity` for an openId. */
    async identityOwner(targetDb, openId) {
      const row = await targetDb.wechatIdentity.findUnique({
        where: { openId },
        select: { accountId: true },
      });
      return row?.accountId ?? null;
    },

    /**
     * Attach a `WechatIdentity` directly to an account (bypassing login).
     * Uses the module-level `db` the fixture was constructed with — the
     * brief's verbatim call `attachWechatIdentity(precreated.id,
     * 'openid-existing')` takes only two args.
     */
    async attachWechatIdentity(accountId, openId, opts = {}) {
      return db.wechatIdentity.create({
        data: { accountId, openId, unionId: opts.unionId ?? null },
        select: { id: true, accountId: true, openId: true },
      });
    },
  };
}

/**
 * Truncate the three tables the member-auth flow touches. Wraps the truncate
 * loop in `SET FOREIGN_KEY_CHECKS = 0` so child tables (`wechat_identity`,
 * `refresh_session`) can be cleared before the parent `member_account`. Also
 * clears `admin_user` so admin-side tests in the same DB run don't interfere.
 *
 * Exported standalone (not part of the bound fixture set) because it doesn't
 * need the auth services — just a DB client.
 */
export async function truncateIdentityTables(db: DbLike): Promise<void> {
  await db.$executeRawUnsafe(`SET FOREIGN_KEY_CHECKS = 0`);
  try {
    await db.$executeRawUnsafe(`TRUNCATE TABLE \`refresh_session\``);
    await db.$executeRawUnsafe(`TRUNCATE TABLE \`wechat_identity\``);
    await db.$executeRawUnsafe(`TRUNCATE TABLE \`member_account\``);
    await db.$executeRawUnsafe(`TRUNCATE TABLE \`admin_user\``);
  } finally {
    await db.$executeRawUnsafe(`SET FOREIGN_KEY_CHECKS = 1`);
  }
}
