import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import { AppModule } from '../../src/app.module.js';
import { BusinessErrorFilter } from '../../src/common/errors/business-error.filter.js';
import { WECHAT_GATEWAY } from '../../src/modules/identity/tokens.js';
import { getMysqlContext, type MysqlTestContext } from '../helpers/mysql-test-environment.js';
import { FakeWechatGateway, loginCodeFor, phoneCodeFor, phonePartsFor } from '../doubles/fake-wechat.gateway.js';
import { normalizePhone } from '../../src/modules/identity/domain/phone.js';
import { truncateIdentityTables } from '../helpers/identity-fixtures.js';

/**
 * Mini-program (member) auth e2e — task-5-brief.md.
 *
 * Spins up the full Nest app (AppModule → IdentityModule → real Prisma + argon2
 * + JWT) against the local MySQL test DB, and overrides ONLY the
 * {@link WECHAT_GATEWAY} DI token with a {@link FakeWechatGateway} so the
 * WeChat-side calls are deterministic without network access. The rest of the
 * stack (HTTP routing, the global BusinessErrorFilter, the real
 * WechatAuthService / PhoneBindingService / JwtTokenService) is exercised
 * end-to-end via supertest.
 *
 * Covers:
 *  - wechat-login returns access + refresh tokens (provisional).
 *  - bind-phone on a fresh phone succeeds (new-phone happy path).
 *  - bind-phone conflict → 409 PHONE_BINDING_CONFLICT (pre-created account
 *    owns a different identity; whole tx rolls back).
 *  - refresh rotates the refresh token and rejects reuse.
 *  - logout revokes the session.
 *
 * Each hook/test early-returns when MySQL is unreachable so the suite no-ops
 * (rather than fails) on sandboxes without the DB.
 */
describe('Mini auth (e2e)', () => {
  const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/member_course_test';

  let ctx: MysqlTestContext | null;
  let app: INestApplication;
  let moduleRef: TestingModule;
  let db: PrismaClient;
  let fakeWechat: FakeWechatGateway;

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-e2e';

    ctx = await getMysqlContext();
    if (!ctx) return;

    fakeWechat = new FakeWechatGateway();
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WECHAT_GATEWAY)
      .useValue(fakeWechat)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new BusinessErrorFilter());
    await app.init();

    db = moduleRef.get(PrismaService) as unknown as PrismaClient;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (ctx) await ctx.cleanup();
  });

  beforeEach(async () => {
    if (!ctx || !db) return;
    fakeWechat.reset();
    await truncateIdentityTables(db);
  });

  afterEach(async () => {
    if (ctx && db) await truncateIdentityTables(db);
  });

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * Drive `POST /api/mini/v1/auth/wechat-login` for a given openId. The fake
   * gateway mapping is set up first so the controller's call to
   * `WechatGateway.exchangeCode` resolves.
   */
  async function wechatLogin(
    openId: string,
    opts: { unionId?: string; expectStatus?: number } = {},
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    provisional: boolean;
    accountId: string;
  }> {
    const code = loginCodeFor(openId);
    fakeWechat.setSession(code, { openId, unionId: opts.unionId });
    const res = await request(app.getHttpServer())
      .post('/api/mini/v1/auth/wechat-login')
      .send({ code })
      .expect(opts.expectStatus ?? 200);
    return res.body as ReturnType<typeof wechatLogin> extends Promise<infer T> ? T : never;
  }

  async function bindPhone(
    accessToken: string,
    phone: string,
    expectStatus = 200,
  ): Promise<{ accountId: string; normalizedPhone: string }> {
    const normalizedPhone = normalizePhone(phone);
    const phoneCode = phoneCodeFor(normalizedPhone);
    fakeWechat.setPhone(phoneCode, phonePartsFor(normalizedPhone));
    const res = await request(app.getHttpServer())
      .post('/api/mini/v1/auth/bind-phone')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ phoneCode })
      .expect(expectStatus);
    return res.body as { accountId: string; normalizedPhone: string };
  }

  async function refresh(
    refreshToken: string,
    expectStatus = 200,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const res = await request(app.getHttpServer())
      .post('/api/mini/v1/auth/refresh')
      .send({ refreshToken })
      .expect(expectStatus);
    return res.body as { accessToken: string; refreshToken: string; expiresIn: number };
  }

  // ── Tests ──────────────────────────────────────────────────────────────

  it('POST /wechat-login returns provisional access + refresh tokens', async () => {
    if (!ctx) return;
    const login = await wechatLogin('openid-e2e-1');
    expect(login.accessToken.split('.')).toHaveLength(3); // JWT shape
    expect(login.refreshToken).toEqual(expect.any(String));
    expect(login.expiresIn).toBe(15 * 60);
    expect(login.provisional).toBe(true);
    expect(login.accountId).toEqual(expect.any(String));
  });

  it('POST /bind-phone on a fresh phone succeeds and flips provisional off', async () => {
    if (!ctx) return;
    const login = await wechatLogin('openid-e2e-2');
    const result = await bindPhone(login.accessToken, '13800000000');
    // Convention: bare 11-digit mobile (no country-code prefix), matching how
    // the fake gateway's phonePartsFor decomposes a non-86-prefixed number.
    expect(result.normalizedPhone).toBe('13800000000');
    // The account is now bound in place (no pre-created account existed).
    const account = await db.memberAccount.findUnique({
      where: { id: login.accountId },
      select: { isProvisional: true, normalizedPhone: true },
    });
    expect(account?.isProvisional).toBe(false);
    expect(account?.normalizedPhone).toBe('13800000000');
  });

  it('POST /bind-phone requires a Bearer token (401 without it)', async () => {
    if (!ctx) return;
    await request(app.getHttpServer())
      .post('/api/mini/v1/auth/bind-phone')
      .send({ phoneCode: 'whatever' })
      .expect(401)
      .expect(({ body }) => expect(body.code).toBe('UNAUTHORIZED'));
  });

  it('POST /bind-phone returns 409 PHONE_BINDING_CONFLICT when the phone is owned by another identity', async () => {
    if (!ctx) return;
    // Pre-created account owns the phone AND has a different identity.
    const precreated = await db.memberAccount.create({
      data: {
        normalizedPhone: '8613900000000',
        isProvisional: false,
        status: 'ACTIVE',
      },
    });
    await db.wechatIdentity.create({
      data: { accountId: precreated.id, openId: 'openid-existing-e2e' },
    });

    // A different visitor logs in provisionally and tries to bind the same phone.
    const login = await wechatLogin('openid-e2e-3');
    // Register the fake phone-code mapping BEFORE the request lands so the
    // controller's gateway call resolves to the colliding phone.
    fakeWechat.setPhone('phone-code-collision', phonePartsFor('8613900000000'));
    await request(app.getHttpServer())
      .post('/api/mini/v1/auth/bind-phone')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .send({ phoneCode: 'phone-code-collision' })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('PHONE_BINDING_CONFLICT'));

    // The provisional account still owns its own identity (tx rolled back).
    const owner = await db.wechatIdentity.findUnique({
      where: { openId: 'openid-e2e-3' },
      select: { accountId: true },
    });
    expect(owner?.accountId).toBe(login.accountId);
  });

  it('POST /refresh rotates the refresh token and rejects reuse', async () => {
    if (!ctx) return;
    const login = await wechatLogin('openid-e2e-4');
    const refreshed = await refresh(login.refreshToken);
    expect(refreshed.refreshToken).not.toBe(login.refreshToken);
    expect(refreshed.accessToken.split('.')).toHaveLength(3);
    // Reuse of the now-revoked token → 401.
    await refresh(login.refreshToken, 401);
  });

  it('serializes concurrent refreshes of one live token to one winner', async () => {
    if (!ctx) return;
    const login = await wechatLogin('openid-e2e-5');
    const responses = await Promise.all([
      request(app.getHttpServer())
        .post('/api/mini/v1/auth/refresh')
        .send({ refreshToken: login.refreshToken }),
      request(app.getHttpServer())
        .post('/api/mini/v1/auth/refresh')
        .send({ refreshToken: login.refreshToken }),
    ]);
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 401]);
  });

  it('POST /logout revokes the session and is idempotent', async () => {
    if (!ctx) return;
    const login = await wechatLogin('openid-e2e-6');
    await request(app.getHttpServer())
      .post('/api/mini/v1/auth/logout')
      .send({ refreshToken: login.refreshToken })
      .expect(200)
      .expect(({ body }) => expect(body.revoked).toBe(true));
    // The logged-out token can no longer be refreshed.
    await refresh(login.refreshToken, 401);
    // Idempotent logout.
    await request(app.getHttpServer())
      .post('/api/mini/v1/auth/logout')
      .send({ refreshToken: login.refreshToken })
      .expect(200)
      .expect(({ body }) => expect(body.revoked).toBe(false));
  });

  it('migration: a provisional account that binds to a pre-created phone ends up DISABLED with its identity moved', async () => {
    if (!ctx) return;
    // Pre-created account and the bindPhone call MUST use the same normalized
    // phone so the merge finds the pre-created row. Both use the bare 11-digit
    // form so they canonicalize identically.
    const precreated = await db.memberAccount.create({
      data: {
        normalizedPhone: '13700000000',
        isProvisional: false,
        status: 'ACTIVE',
      },
    });
    const login = await wechatLogin('openid-e2e-7');
    await bindPhone(login.accessToken, '13700000000');

    // The provisional account is now DISABLED...
    const provisional = await db.memberAccount.findUnique({
      where: { id: login.accountId },
      select: { status: true },
    });
    expect(provisional?.status).toBe('DISABLED');
    // ...and its identity moved to the pre-created account.
    const owner = await db.wechatIdentity.findUnique({
      where: { openId: 'openid-e2e-7' },
      select: { accountId: true },
    });
    expect(owner?.accountId).toBe(precreated.id);
  });
});
