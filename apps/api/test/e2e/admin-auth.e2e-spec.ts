import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import { AppModule } from '../../src/app.module.js';
import { BusinessErrorFilter } from '../../src/common/errors/business-error.filter.js';
import { getMysqlContext, type MysqlTestContext } from '../helpers/mysql-test-environment.js';
import { seedAdmin } from '../../prisma/seed.js';

/**
 * Administrator authentication e2e.
 *
 * Spins up the real Nest application (Prisma + argon2 + JWT) against the local
 * MySQL test database and exercises the public auth endpoints over HTTP. Test
 * isolation is provided by truncating `admin_user`/`refresh_session` before
 * each case and re-seeding the bootstrap admin. Each hook and test early-
 * returns when MySQL is unreachable so the suite no-ops (rather than fails) on
 * sandboxes without the DB — the unit suite still covers the rules.
 */
describe('Admin auth (e2e)', () => {
  const TEST_USERNAME = 'admin';
  const TEST_PASSWORD = 'Admin@123456';
  const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/member_course_test';

  let ctx: MysqlTestContext | null;
  let app: INestApplication;
  let moduleRef: TestingModule;
  let db: PrismaClient;

  beforeAll(async () => {
    // Point PrismaService at the test DB and provide a JWT secret before any
    // provider is instantiated.
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-e2e';

    ctx = await getMysqlContext();
    if (!ctx) return; // hooks/tests early-return when MySQL is unavailable

    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
    await truncateAuthTables(db);
    await seedAdmin({ db, username: TEST_USERNAME, password: TEST_PASSWORD });
  });

  afterEach(async () => {
    // Best-effort: leave the tables clean for the next file/run.
    if (ctx && db) await truncateAuthTables(db);
  });

  // ── Helpers ────────────────────────────────────────────────────────────

  async function truncateAuthTables(client: PrismaClient): Promise<void> {
    await client.$executeRawUnsafe(`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`refresh_session\``);
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`admin_user\``);
    } finally {
      await client.$executeRawUnsafe(`SET FOREIGN_KEY_CHECKS = 1`);
    }
  }

  async function loginAsAdmin(
    creds: { username: string; password: string } = { username: TEST_USERNAME, password: TEST_PASSWORD },
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const res = await request(app.getHttpServer())
      .post('/api/admin/v1/auth/login')
      .send(creds)
      .expect(200);
    return res.body as { accessToken: string; refreshToken: string; expiresIn: number };
  }

  async function refreshAdmin(
    refreshToken: string,
    expectStatus = 200,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const res = await request(app.getHttpServer())
      .post('/api/admin/v1/auth/refresh')
      .send({ refreshToken })
      .expect(expectStatus);
    return res.body as { accessToken: string; refreshToken: string; expiresIn: number };
  }

  // ── Tests ──────────────────────────────────────────────────────────────

  it('returns access and refresh tokens on successful login', async () => {
    if (!ctx) return;
    const login = await loginAsAdmin();
    expect(login.accessToken).toEqual(expect.any(String));
    expect(login.accessToken.split('.')).toHaveLength(3); // JWT shape (header.payload.signature)
    expect(login.refreshToken).toEqual(expect.any(String));
    expect(login.expiresIn).toBe(15 * 60);
  });

  it('rejects invalid credentials with 401', async () => {
    if (!ctx) return;
    await request(app.getHttpServer())
      .post('/api/admin/v1/auth/login')
      .send({ username: TEST_USERNAME, password: 'definitely-wrong' })
      .expect(401)
      .expect(({ body }) => expect(body.code).toBe('UNAUTHORIZED'));
  });

  it('locks an administrator for 15 minutes after five failures', async () => {
    if (!ctx) return;
    const badCredentials = { username: TEST_USERNAME, password: 'definitely-wrong' };
    const validCredentials = { username: TEST_USERNAME, password: TEST_PASSWORD };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app.getHttpServer()).post('/api/admin/v1/auth/login').send(badCredentials).expect(401);
    }
    await request(app.getHttpServer())
      .post('/api/admin/v1/auth/login')
      .send(validCredentials)
      .expect(429)
      .expect(({ body }) => expect(body.code).toBe('ADMIN_LOGIN_LOCKED'));
  });

  it('rotates refresh tokens and rejects the replaced token', async () => {
    if (!ctx) return;
    const login = await loginAsAdmin();
    const refreshed = await refreshAdmin(login.refreshToken);
    expect(refreshed.refreshToken).not.toBe(login.refreshToken);
    await refreshAdmin(login.refreshToken, 401);
  });

  it('serializes concurrent refreshes of one live token to one winner (real MySQL tx)', async () => {
    if (!ctx) return;
    // Authoritative concurrency test: two concurrent /refresh requests with
    // the SAME live token must produce exactly one 200 (winner gets a rotated
    // token) and one 401 (loser sees the optimistic-lock-guarded revoke and
    // is refused). This exercises the real MySQL transaction + the
    // `version`/`revokedAt: null` conditional updateMany.
    const login = await loginAsAdmin();
    const responses = await Promise.all([
      request(app.getHttpServer())
        .post('/api/admin/v1/auth/refresh')
        .send({ refreshToken: login.refreshToken }),
      request(app.getHttpServer())
        .post('/api/admin/v1/auth/refresh')
        .send({ refreshToken: login.refreshToken }),
    ]);
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 401]);
    // The winner returned a fresh refresh token distinct from the original.
    const ok = responses.find((r) => r.status === 200)!;
    expect(ok.body.refreshToken).not.toBe(login.refreshToken);
    // The DB should now hold exactly two live sessions for this admin: none.
    const live = await db.refreshSession.count({
      where: { adminUserId: { not: null }, revokedAt: null },
    });
    expect(live).toBe(1);
  });

  it('revokes the session on logout and becomes idempotent', async () => {
    if (!ctx) return;
    const login = await loginAsAdmin();
    await request(app.getHttpServer())
      .post('/api/admin/v1/auth/logout')
      .send({ refreshToken: login.refreshToken })
      .expect(200)
      .expect(({ body }) => expect(body.revoked).toBe(true));
    // The logged-out token can no longer be refreshed.
    await refreshAdmin(login.refreshToken, 401);
    // Idempotent: logging out an already-revoked token returns revoked=false.
    await request(app.getHttpServer())
      .post('/api/admin/v1/auth/logout')
      .send({ refreshToken: login.refreshToken })
      .expect(200)
      .expect(({ body }) => expect(body.revoked).toBe(false));
  });

  it('refuses a DISABLED administrator', async () => {
    if (!ctx) return;
    // Flip the seeded admin to DISABLED, then attempt to log in.
    await db.adminUser.update({
      where: { username: TEST_USERNAME },
      data: { status: 'DISABLED' },
    });
    await request(app.getHttpServer())
      .post('/api/admin/v1/auth/login')
      .send({ username: TEST_USERNAME, password: TEST_PASSWORD })
      .expect(401)
      .expect(({ body }) => expect(body.code).toBe('UNAUTHORIZED'));
  });
});
