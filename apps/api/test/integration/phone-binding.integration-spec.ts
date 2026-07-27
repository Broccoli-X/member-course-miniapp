import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { getMysqlContext, type MysqlTestContext } from '../helpers/mysql-test-environment.js';
import {
  createIdentityFixtures,
} from '../helpers/identity-fixtures.js';
import { FakeWechatGateway } from '../doubles/fake-wechat.gateway.js';
import { truncateAllTables } from '../helpers/truncate-all-tables.js';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { WechatAuthService } from '../../src/modules/identity/application/wechat-auth.service.js';
import { PhoneBindingService } from '../../src/modules/identity/application/phone-binding.service.js';
import { JwtTokenService } from '../../src/modules/identity/infrastructure/jwt-token.service.js';

/**
 * Phone-binding integration tests — task-5-brief.md, Step 1 verbatim cases
 * plus the happy paths the brief enumerates.
 *
 * Runs against the real MySQL test DB via {@link getMysqlContext} (the suite
 * is gated on `RUN_INTEGRATION` and skips when MySQL is unreachable). The
 * {@link WechatAuthService} + {@link PhoneBindingService} are constructed with
 * real Prisma + a real {@link JwtTokenService} + the {@link FakeWechatGateway}
 * — so every assertion exercises the actual transactional merge logic and the
 * real InnoDB row locks (`SELECT ... FOR UPDATE`).
 *
 * The two verbatim cases from the brief are reproduced exactly:
 *  1. "moves a provisional WeChat identity to one pre-created phone account"
 *  2. "rolls back when the pre-created phone account owns another WeChat
 *      identity"
 *
 * Plus:
 *  - the "new phone binds to provisional" happy path (no pre-created account),
 *  - the brief's Step 4 "repeated-code protection" (a replayed second bind on
 *    the same account → STATE_CHANGED, not a second successful bind).
 */
describe.skipIf(!process.env.RUN_INTEGRATION)(
  'Phone binding (integration, real MySQL)',
  () => {
    let ctx: MysqlTestContext | null;
    let db: PrismaClient;
    let fakeWechat: FakeWechatGateway;
    let auth: WechatAuthService;
    let binding: PhoneBindingService;

    // Helpers bound to the live services via the shared fixture factory so the
    // brief's verbatim call shapes work as written.
    let loginWithWechat: ReturnType<typeof createIdentityFixtures>['loginWithWechat'];
    let createPrecreatedMember: ReturnType<typeof createIdentityFixtures>['createPrecreatedMember'];
    let bindPhone: ReturnType<typeof createIdentityFixtures>['bindPhone'];
    let accountStatus: ReturnType<typeof createIdentityFixtures>['accountStatus'];
    let identityOwner: ReturnType<typeof createIdentityFixtures>['identityOwner'];
    let attachWechatIdentity: ReturnType<typeof createIdentityFixtures>['attachWechatIdentity'];

    beforeAll(async () => {
      ctx = await getMysqlContext();
      if (!ctx) return;

      process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-integration';
      db = new PrismaClient({ datasources: { db: { url: ctx.databaseUrl } } });
      fakeWechat = new FakeWechatGateway();

      // Construct the services directly with `new` (mirroring the admin-auth
      // unit tests) rather than going through the Nest DI container. The
      // integration vitest config does NOT enable SWC, so constructor-injection-
      // by-type (`design:paramtypes` metadata) is unavailable — manual wiring
      // sidesteps that entirely and keeps the test focused on the transactional
      // logic, not the container.
      const jwt = new JwtService({
        secret: process.env.JWT_SECRET,
        signOptions: { algorithm: 'HS256' },
      });
      const tokens = new JwtTokenService(jwt);
      // PrismaService extends PrismaClient, so a raw PrismaClient is a valid
      // stand-in for the `db` parameter the services expect.
      auth = new WechatAuthService(db as unknown as import('../../src/infrastructure/prisma/prisma.service.js').PrismaService, fakeWechat, tokens);
      binding = new PhoneBindingService(db as unknown as import('../../src/infrastructure/prisma/prisma.service.js').PrismaService, fakeWechat);

      const fixtures = createIdentityFixtures({ auth, binding, fake: fakeWechat, db });
      loginWithWechat = fixtures.loginWithWechat;
      createPrecreatedMember = fixtures.createPrecreatedMember;
      bindPhone = fixtures.bindPhone;
      accountStatus = fixtures.accountStatus;
      identityOwner = fixtures.identityOwner;
      attachWechatIdentity = fixtures.attachWechatIdentity;
    });

    beforeEach(async () => {
      if (!ctx) return;
      fakeWechat.reset();
      await truncateAllTables(db);
    });

    afterAll(async () => {
      if (db) await db.$disconnect();
      if (ctx) await ctx.cleanup();
    });

    // ── Brief verbatim case 1 ────────────────────────────────────────────

    it('moves a provisional WeChat identity to one pre-created phone account', async () => {
      if (!ctx) return;
      const provisional = await loginWithWechat(fakeWechat, 'openid-1');
      const precreated = await createPrecreatedMember(db, '13800000000');
      const result = await bindPhone(provisional, 'phone-code-1');
      expect(result.accountId).toBe(precreated.id);
      expect(await accountStatus(db, provisional.accountId)).toBe('DISABLED');
      expect(await identityOwner(db, 'openid-1')).toBe(precreated.id);
    });

    // ── Brief verbatim case 2 ────────────────────────────────────────────

    it('rolls back when the pre-created phone account owns another WeChat identity', async () => {
      if (!ctx) return;
      const provisional = await loginWithWechat(fakeWechat, 'openid-1');
      const precreated = await createPrecreatedMember(db, '13800000000');
      await attachWechatIdentity(precreated.id, 'openid-existing');
      await expect(bindPhone(provisional, 'phone-code-1'))
        .rejects.toMatchObject({ code: 'PHONE_BINDING_CONFLICT' });
      // The whole tx rolled back → the provisional's identity is still on the
      // provisional account, NOT moved to the pre-created one.
      expect(await identityOwner(db, 'openid-1')).toBe(provisional.accountId);
    });

    // ── Happy path: new phone binds to the provisional account ───────────

    it('binds a new phone to the provisional account when no pre-created account matches', async () => {
      if (!ctx) return;
      const provisional = await loginWithWechat(fakeWechat, 'openid-2');
      // No createPrecreatedMember call → there's no non-provisional account
      // with this phone, so the bind should bind-in-place on the provisional.
      // Convention: bare 11-digit mobile (no country-code prefix), matching
      // how createPrecreatedMember stores its phone.
      const result = await bindPhone(provisional, '13900000000');
      expect(result.accountId).toBe(provisional.accountId);

      const account = await db.memberAccount.findUnique({
        where: { id: provisional.accountId },
        select: { normalizedPhone: true, isProvisional: true, status: true },
      });
      expect(account?.normalizedPhone).toBe('13900000000');
      expect(account?.isProvisional).toBe(false);
      expect(account?.status).toBe('ACTIVE');
    });

    // ── Repeated-code protection (brief Step 4) ──────────────────────────

    it('rejects a second bind on an already-bound account with STATE_CHANGED (repeated-code protection)', async () => {
      if (!ctx) return;
      // First bind succeeds (new-phone happy path).
      const provisional = await loginWithWechat(fakeWechat, 'openid-3');
      await bindPhone(provisional, '13700000000');
      // A replayed phone code arrives — the account is no longer provisional,
      // so the binding path must refuse rather than re-bind or migrate.
      await expect(bindPhone(provisional, '13700000000'))
        .rejects.toMatchObject({ code: 'STATE_CHANGED' });
    });

    // ── Bonus: identity move preserves unionId and does not duplicate rows ─

    it('leaves exactly one WechatIdentity per openId after a migration', async () => {
      if (!ctx) return;
      const provisional = await loginWithWechat(fakeWechat, 'openid-4', {
        unionId: 'unionid-4',
      });
      // Pre-created account and the bindPhone call MUST use the same phone so
      // the merge finds the pre-created row. The brief's verbatim case 1 uses
      // 'phone-code-1' (→ 13800000000) for the bind; here we use the same
      // phone explicitly for both sides.
      const precreated = await createPrecreatedMember(db, '13800000000');
      await bindPhone(provisional, 'phone-code-1');

      // Exactly one row for openid-4, now owned by the pre-created account,
      // and its unionId is preserved.
      const identities = await db.wechatIdentity.findMany({
        where: { openId: 'openid-4' },
      });
      expect(identities).toHaveLength(1);
      expect(identities[0].accountId).toBe(precreated.id);
      expect(identities[0].unionId).toBe('unionid-4');

      // The provisional account has no identities left.
      const remaining = await db.wechatIdentity.findMany({
        where: { accountId: provisional.accountId },
      });
      expect(remaining).toHaveLength(0);
    });
  },
);
