import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Prisma } from '../../src/generated/prisma/client.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import { AppModule } from '../../src/app.module.js';
import { BusinessErrorFilter } from '../../src/common/errors/business-error.filter.js';
import { WECHAT_GATEWAY } from '../../src/modules/identity/tokens.js';
import { getMysqlContext, type MysqlTestContext } from '../helpers/mysql-test-environment.js';
import {
  FakeWechatGateway,
  loginCodeFor,
  phoneCodeFor,
  phonePartsFor,
} from '../doubles/fake-wechat.gateway.js';
import { normalizePhone } from '../../src/modules/identity/domain/phone.js';
import { seedAdmin } from '../../prisma/seed.js';
import { truncateAllTables } from '../helpers/truncate-all-tables.js';

/**
 * Member asset query e2e — task-11-brief.md.
 *
 * Spins up the full Nest app against the local MySQL test DB and exercises the
 * five mini read routes plus the admin counterparts over HTTP. The WeChat
 * gateway is overridden with a fake so login + phone-binding are deterministic
 * without network.
 *
 * The two brief verbatim cases are reproduced near-verbatim:
 *  1. "returns assets only for a related student" — listBalances(memberToken,
 *     relatedStudent.id) → 200; listBalances(memberToken, unrelatedStudent.id)
 *     → 403 STUDENT_FORBIDDEN.
 *  2. "does not return another buyer account order" — listMiniOrders(memberToken)
 *     → items do NOT contain another buyer's order id.
 *
 * Plus: pagination (page/pageSize respected, total/totalPages correct), buyer
 * isolation on order detail, decimal serialization (balances/deltas are 2-dp
 * strings), admin can read any student's balances (no 403), hour-transactions
 * newest-first, and a provisional/unbound member is rejected by
 * BoundMemberGuard (403) on these private routes.
 */
describe('Member asset queries (e2e)', () => {
  const DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/member_course_test';
  const TEST_USERNAME = 'admin';
  const TEST_PASSWORD = 'Admin@123456';

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
    await truncateAllTables(db);
    await seedAdmin({ db, username: TEST_USERNAME, password: TEST_PASSWORD });
  });

  // ── Auth helpers ───────────────────────────────────────────────────────

  async function adminLogin(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/admin/v1/auth/login')
      .send({ username: TEST_USERNAME, password: TEST_PASSWORD })
      .expect(200);
    return res.body.accessToken as string;
  }

  const adminAuth = (tok: string) => ({ Authorization: `Bearer ${tok}` });
  const memberAuth = (tok: string) => ({ Authorization: `Bearer ${tok}` });

  /**
   * Drive the full mini login + bind flow to produce a BOUND (non-provisional)
   * member with a verified phone. Returns a fresh access token minted AFTER
   * binding so `provisional:false` is encoded and the BoundMemberGuard admits
   * the request.
   */
  async function boundMember(
    openId: string,
    phone: string,
  ): Promise<{ accountId: string; accessToken: string }> {
    const code = loginCodeFor(openId);
    fakeWechat.setSession(code, { openId });
    const login = await request(app.getHttpServer())
      .post('/api/mini/v1/auth/wechat-login')
      .send({ code })
      .expect(200);
    const normalized = normalizePhone(phone);
    const phoneCode = phoneCodeFor(normalized);
    fakeWechat.setPhone(phoneCode, phonePartsFor(normalized));
    await request(app.getHttpServer())
      .post('/api/mini/v1/auth/bind-phone')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ phoneCode })
      .expect(200);
    // Re-login to mint a token with provisional:false encoded.
    const relogin = await request(app.getHttpServer())
      .post('/api/mini/v1/auth/wechat-login')
      .send({ code })
      .expect(200);
    return { accountId: relogin.body.accountId, accessToken: relogin.body.accessToken };
  }

  // ── Asset seed helpers ─────────────────────────────────────────────────

  /**
   * Seed, for a given member account: one related student (PARENT), one
   * course, a StudentCourseBalance with 2.30 available, a CoursePackage
   * (granted 2.30), and one GRANT HourTransaction + its HourAllocation. Used
   * to exercise the balance/package/transaction reads + decimal serialization.
   */
  async function seedAssetsFor(studentId: string, courseId: string): Promise<void> {
    await db.studentCourseBalance.create({
      data: {
        studentId,
        courseId,
        available: new Prisma.Decimal('2.30'),
        reserved: new Prisma.Decimal('0.00'),
        consumed: new Prisma.Decimal('0.00'),
        expired: new Prisma.Decimal('0.00'),
      },
    });
    const pkg = await db.coursePackage.create({
      data: {
        studentId,
        courseId,
        sourceType: 'ORDER',
        startsOn: new Date('2026-01-01T00:00:00Z'),
        expiresOn: new Date('2026-04-01T00:00:00Z'),
        granted: new Prisma.Decimal('2.30'),
        available: new Prisma.Decimal('2.30'),
        reserved: new Prisma.Decimal('0.00'),
        consumed: new Prisma.Decimal('0.00'),
        expired: new Prisma.Decimal('0.00'),
        status: 'ACTIVE',
      },
    });
    const tx = await db.hourTransaction.create({
      data: {
        studentId,
        courseId,
        type: 'GRANT',
        businessKey: `e2e-grant:${pkg.id}`,
        availableDelta: new Prisma.Decimal('2.30'),
        reservedDelta: new Prisma.Decimal('0.00'),
        consumedDelta: new Prisma.Decimal('0.00'),
        expiredDelta: new Prisma.Decimal('0.00'),
        reason: 'seeded grant',
        occurredAt: new Date('2026-01-01T10:00:00Z'),
      },
    });
    await db.hourAllocation.create({
      data: {
        transactionId: tx.id,
        packageId: pkg.id,
        sourceType: 'ORDER',
        sourceId: pkg.id,
        availableDelta: new Prisma.Decimal('2.30'),
        reservedDelta: new Prisma.Decimal('0.00'),
        consumedDelta: new Prisma.Decimal('0.00'),
        expiredDelta: new Prisma.Decimal('0.00'),
      },
    });
  }

  /** Create a minimal confirmed order owned by `buyerAccountId`. */
  async function seedOrder(
    buyerAccountId: string,
    studentId: string,
    productId: string,
    courseId: string,
    overrides: { id?: string; status?: string; totalAmount?: string } = {},
  ): Promise<{ id: string }> {
    const order = await db.offlineOrder.create({
      data: {
        ...(overrides.id ? { id: overrides.id } : {}),
        buyerAccountId,
        status: overrides.status ?? 'CONFIRMED',
        totalAmount: new Prisma.Decimal(overrides.totalAmount ?? '100.00'),
        confirmedAt: new Date(),
      },
    });
    await db.orderItem.create({
      data: {
        orderId: order.id,
        studentId,
        productId,
        courseId,
        productNameSnapshot: '10课时包',
        unitPriceSnapshot: new Prisma.Decimal('100.00'),
        hoursSnapshot: new Prisma.Decimal('10.00'),
        validDaysSnapshot: 30,
      },
    });
    return order;
  }

  async function seedCourseAndProduct(): Promise<{ courseId: string; productId: string }> {
    const course = await db.course.create({
      data: { name: '编程', type: 'CLASS', description: 'd' },
    });
    const product = await db.packageProduct.create({
      data: {
        courseId: course.id,
        name: '10课时包',
        price: new Prisma.Decimal('100.00'),
        hours: new Prisma.Decimal('10.00'),
        validDays: 30,
      },
    });
    return { courseId: course.id, productId: product.id };
  }

  // ── Route helpers (the routes under test) ──────────────────────────────

  async function listBalances(
    token: string,
    studentId: string,
    expectStatus = 200,
  ): Promise<{ items: Array<{ available: string }>; total: number; page: number; pageSize: number; totalPages: number }> {
    const res = await request(app.getHttpServer())
      .get(`/api/mini/v1/students/${studentId}/course-balances`)
      .set(memberAuth(token));
    if (expectStatus !== undefined) expect(res.status).toBe(expectStatus);
    return res.body;
  }

  async function listMiniOrders(
    token: string,
    query?: { page?: number; pageSize?: number },
  ): Promise<{ items: Array<{ id: string; totalAmount: string }>; total: number; page: number; pageSize: number; totalPages: number }> {
    const res = await request(app.getHttpServer())
      .get('/api/mini/v1/orders')
      .query(query ?? {})
      .set(memberAuth(token))
      .expect(200);
    return res.body;
  }

  // ── The two brief verbatim cases ───────────────────────────────────────

  it('returns assets only for a related student', async () => {
    if (!ctx) return;
    // Two bound members, each owns their own student.
    const owner = await boundMember('openid-owner-rel', '13800000001');
    const other = await boundMember('openid-other-rel', '13800000002');

    const related = await db.studentProfile.create({ data: { displayName: 'Own Child' } });
    await db.accountStudentRelation.create({
      data: { accountId: owner.accountId, studentId: related.id, relationType: 'PARENT' },
    });
    const unrelated = await db.studentProfile.create({ data: { displayName: 'Other Child' } });
    await db.accountStudentRelation.create({
      data: { accountId: other.accountId, studentId: unrelated.id, relationType: 'PARENT' },
    });

    const { courseId } = await seedCourseAndProduct();
    await seedAssetsFor(related.id, courseId);

    // Related → 200.
    await listBalances(owner.accessToken, related.id, 200);
    // Unrelated → 403 STUDENT_FORBIDDEN.
    const res = await request(app.getHttpServer())
      .get(`/api/mini/v1/students/${unrelated.id}/course-balances`)
      .set(memberAuth(owner.accessToken))
      .expect(403);
    expect(res.body.code).toBe('STUDENT_FORBIDDEN');
  });

  it('does not return another buyer account order', async () => {
    if (!ctx) return;
    const owner = await boundMember('openid-owner-buy', '13800000003');
    const other = await boundMember('openid-other-buy', '13800000004');

    const student = await db.studentProfile.create({ data: { displayName: 'Buyer Child' } });
    await db.accountStudentRelation.create({
      data: { accountId: owner.accountId, studentId: student.id, relationType: 'PARENT' },
    });
    const { courseId, productId } = await seedCourseAndProduct();

    const ownOrder = await seedOrder(owner.accountId, student.id, productId, courseId);
    const otherBuyerOrder = await seedOrder(other.accountId, student.id, productId, courseId);

    const result = await listMiniOrders(owner.accessToken);
    const ids = result.items.map((item) => item.id);
    expect(ids).toContain(ownOrder.id);
    expect(ids).not.toContain(otherBuyerOrder.id);
  });

  // ── Extras ─────────────────────────────────────────────────────────────

  it('paginates balances (page/pageSize respected, total/totalPages correct)', async () => {
    if (!ctx) return;
    const owner = await boundMember('openid-page', '13800000005');
    const student = await db.studentProfile.create({ data: { displayName: 'Pager' } });
    await db.accountStudentRelation.create({
      data: { accountId: owner.accountId, studentId: student.id, relationType: 'PARENT' },
    });
    // Three courses → three balance rows.
    for (let i = 0; i < 3; i++) {
      const course = await db.course.create({
        data: { name: `C${i}`, type: 'CLASS', description: 'd' },
      });
      await db.studentCourseBalance.create({
        data: {
          studentId: student.id,
          courseId: course.id,
          available: new Prisma.Decimal('1.00'),
          reserved: new Prisma.Decimal('0.00'),
          consumed: new Prisma.Decimal('0.00'),
          expired: new Prisma.Decimal('0.00'),
        },
      });
    }
    // pageSize=2 → page 1 has 2 items, total 3, totalPages 2.
    const p1 = await request(app.getHttpServer())
      .get(`/api/mini/v1/students/${student.id}/course-balances`)
      .query({ page: 1, pageSize: 2 })
      .set(memberAuth(owner.accessToken))
      .expect(200);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.total).toBe(3);
    expect(p1.body.totalPages).toBe(2);
    expect(p1.body.page).toBe(1);
    expect(p1.body.pageSize).toBe(2);

    const p2 = await request(app.getHttpServer())
      .get(`/api/mini/v1/students/${student.id}/course-balances`)
      .query({ page: 2, pageSize: 2 })
      .set(memberAuth(owner.accessToken))
      .expect(200);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.page).toBe(2);
  });

  it('serializes balances, packages, and transactions as 2-dp decimal strings', async () => {
    if (!ctx) return;
    const owner = await boundMember('openid-decimal', '13800000006');
    const student = await db.studentProfile.create({ data: { displayName: 'Decimal' } });
    await db.accountStudentRelation.create({
      data: { accountId: owner.accountId, studentId: student.id, relationType: 'PARENT' },
    });
    const { courseId } = await seedCourseAndProduct();
    await seedAssetsFor(student.id, courseId);

    const balances = await request(app.getHttpServer())
      .get(`/api/mini/v1/students/${student.id}/course-balances`)
      .set(memberAuth(owner.accessToken))
      .expect(200);
    expect(balances.body.items[0].available).toBe('2.30');

    const packages = await request(app.getHttpServer())
      .get(`/api/mini/v1/students/${student.id}/course-packages`)
      .set(memberAuth(owner.accessToken))
      .expect(200);
    expect(packages.body.items[0].available).toBe('2.30');
    expect(packages.body.items[0].granted).toBe('2.30');
    expect(packages.body.items[0].startsOn).toBe('2026-01-01');
    expect(packages.body.items[0].expiresOn).toBe('2026-04-01');

    const txs = await request(app.getHttpServer())
      .get(`/api/mini/v1/students/${student.id}/hour-transactions`)
      .set(memberAuth(owner.accessToken))
      .expect(200);
    expect(txs.body.items[0].availableDelta).toBe('2.30');
    expect(txs.body.items[0].allocations[0].availableDelta).toBe('2.30');
    expect(txs.body.items[0].type).toBe('GRANT');
  });

  it('returns hour-transactions newest-first (occurredAt desc)', async () => {
    if (!ctx) return;
    const owner = await boundMember('openid-sort', '13800000007');
    const student = await db.studentProfile.create({ data: { displayName: 'Sort' } });
    await db.accountStudentRelation.create({
      data: { accountId: owner.accountId, studentId: student.id, relationType: 'PARENT' },
    });
    const course = await db.course.create({
      data: { name: 'SortCourse', type: 'CLASS', description: 'd' },
    });
    // Two transactions: an older GRANT then a newer MANUAL_DEDUCT.
    await db.studentCourseBalance.create({
      data: {
        studentId: student.id,
        courseId: course.id,
        available: new Prisma.Decimal('1.00'),
        reserved: new Prisma.Decimal('0.00'),
        consumed: new Prisma.Decimal('1.00'),
        expired: new Prisma.Decimal('0.00'),
      },
    });
    const pkg = await db.coursePackage.create({
      data: {
        studentId: student.id,
        courseId: course.id,
        sourceType: 'ORDER',
        startsOn: new Date('2026-01-01T00:00:00Z'),
        expiresOn: new Date('2026-04-01T00:00:00Z'),
        granted: new Prisma.Decimal('2.00'),
        available: new Prisma.Decimal('1.00'),
        reserved: new Prisma.Decimal('0.00'),
        consumed: new Prisma.Decimal('1.00'),
        expired: new Prisma.Decimal('0.00'),
        status: 'ACTIVE',
      },
    });
    const older = await db.hourTransaction.create({
      data: {
        studentId: student.id,
        courseId: course.id,
        type: 'GRANT',
        businessKey: 'e2e-sort-grant',
        availableDelta: new Prisma.Decimal('2.00'),
        reservedDelta: new Prisma.Decimal('0.00'),
        consumedDelta: new Prisma.Decimal('0.00'),
        expiredDelta: new Prisma.Decimal('0.00'),
        reason: 'grant',
        occurredAt: new Date('2026-01-01T10:00:00Z'),
      },
    });
    const newer = await db.hourTransaction.create({
      data: {
        studentId: student.id,
        courseId: course.id,
        type: 'MANUAL_DEDUCT',
        businessKey: 'e2e-sort-deduct',
        availableDelta: new Prisma.Decimal('-1.00'),
        reservedDelta: new Prisma.Decimal('0.00'),
        consumedDelta: new Prisma.Decimal('1.00'),
        expiredDelta: new Prisma.Decimal('0.00'),
        reason: 'deduct',
        occurredAt: new Date('2026-02-01T10:00:00Z'),
      },
    });
    await db.hourAllocation.create({
      data: {
        transactionId: newer.id,
        packageId: pkg.id,
        sourceType: 'MANUAL_ADJUSTMENT',
        sourceId: pkg.id,
        availableDelta: new Prisma.Decimal('-1.00'),
        reservedDelta: new Prisma.Decimal('0.00'),
        consumedDelta: new Prisma.Decimal('1.00'),
        expiredDelta: new Prisma.Decimal('0.00'),
      },
    });

    const res = await request(app.getHttpServer())
      .get(`/api/mini/v1/students/${student.id}/hour-transactions`)
      .set(memberAuth(owner.accessToken))
      .expect(200);
    expect(res.body.items.map((t: { id: string }) => t.id)).toEqual([newer.id, older.id]);
  });

  it('enforces buyer isolation on order detail (other member order → 404)', async () => {
    if (!ctx) return;
    const owner = await boundMember('openid-owner-detail', '13800000008');
    const other = await boundMember('openid-other-detail', '13800000009');
    const student = await db.studentProfile.create({ data: { displayName: 'DetailChild' } });
    await db.accountStudentRelation.create({
      data: { accountId: owner.accountId, studentId: student.id, relationType: 'PARENT' },
    });
    const { courseId, productId } = await seedCourseAndProduct();
    const ownOrder = await seedOrder(owner.accountId, student.id, productId, courseId);
    const otherOrder = await seedOrder(other.accountId, student.id, productId, courseId);

    // Own order → 200.
    const own = await request(app.getHttpServer())
      .get(`/api/mini/v1/orders/${ownOrder.id}`)
      .set(memberAuth(owner.accessToken))
      .expect(200);
    expect(own.body.id).toBe(ownOrder.id);

    // Another buyer's order → 404 (we do not leak existence).
    await request(app.getHttpServer())
      .get(`/api/mini/v1/orders/${otherOrder.id}`)
      .set(memberAuth(owner.accessToken))
      .expect(404);

    // Missing order → 404.
    await request(app.getHttpServer())
      .get(`/api/mini/v1/orders/00000000-0000-0000-0000-000000000000`)
      .set(memberAuth(owner.accessToken))
      .expect(404);
  });

  it('rejects a provisional member from these private routes (403 STUDENT_FORBIDDEN)', async () => {
    if (!ctx) return;
    const code = loginCodeFor('openid-provisional-assets');
    fakeWechat.setSession(code, { openId: 'openid-provisional-assets' });
    const login = await request(app.getHttpServer())
      .post('/api/mini/v1/auth/wechat-login')
      .send({ code })
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/mini/v1/orders')
      .set(memberAuth(login.body.accessToken))
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('STUDENT_FORBIDDEN'));
  });

  it('admin can read any student balances/packages/transactions without a relation', async () => {
    if (!ctx) return;
    const admin = await adminLogin();
    const student = await db.studentProfile.create({ data: { displayName: 'Any Student' } });
    // NO account_student_relation row — admin reads regardless.
    const { courseId } = await seedCourseAndProduct();
    await seedAssetsFor(student.id, courseId);

    const balances = await request(app.getHttpServer())
      .get(`/api/admin/v1/students/${student.id}/course-balances`)
      .set(adminAuth(admin))
      .expect(200);
    expect(balances.body.items[0].available).toBe('2.30');

    const packages = await request(app.getHttpServer())
      .get(`/api/admin/v1/students/${student.id}/course-packages`)
      .set(adminAuth(admin))
      .expect(200);
    expect(packages.body.items[0].available).toBe('2.30');

    const txs = await request(app.getHttpServer())
      .get(`/api/admin/v1/students/${student.id}/hour-transactions`)
      .set(adminAuth(admin))
      .expect(200);
    expect(txs.body.items[0].type).toBe('GRANT');

    // Reject a member token on the admin route (wrong token kind → 401).
    const member = await boundMember('openid-admin-block', '13800000010');
    await request(app.getHttpServer())
      .get(`/api/admin/v1/students/${student.id}/course-balances`)
      .set(memberAuth(member.accessToken))
      .expect(401);
  });
});
