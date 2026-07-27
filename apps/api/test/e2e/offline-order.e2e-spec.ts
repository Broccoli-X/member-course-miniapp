import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Prisma } from '../../src/generated/prisma/client.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import { AppModule } from '../../src/app.module.js';
import { BusinessErrorFilter } from '../../src/common/errors/business-error.filter.js';
import { getMysqlContext, type MysqlTestContext } from '../helpers/mysql-test-environment.js';
import { seedAdmin } from '../../prisma/seed.js';
import { truncateAllTables } from '../helpers/truncate-all-tables.js';

/**
 * Offline-order HTTP e2e (Task 9).
 *
 * Spins up the full Nest app against the local MySQL test DB and exercises all
 * six admin order routes over HTTP. Prerequisites (member/student/course/
 * product) are seeded directly via Prisma so the test focuses on the order
 * routes; the admin authenticates via the real login endpoint and carries a
 * real access token + Idempotency-Key header.
 *
 * Covers: paginated list + filters, create draft (snapshot freeze), detail,
 * idempotent confirm (same Idempotency-Key twice → equal bodies + one package),
 * snapshot immutability over HTTP (mutate product, confirm uses frozen price),
 * void draft, reverse success, and ORDER_NOT_REVERSIBLE.
 */
describe('Offline order lifecycle (e2e)', () => {
  const DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/member_course_test';
  const TEST_USERNAME = 'admin';
  const TEST_PASSWORD = 'Admin@123456';

  let ctx: MysqlTestContext | null;
  let app: INestApplication;
  let moduleRef: TestingModule;
  let db: PrismaClient;

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-e2e';

    ctx = await getMysqlContext();
    if (!ctx) return;

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
    await truncateAllTables(db);
    await seedAdmin({ db, username: TEST_USERNAME, password: TEST_PASSWORD });
  });

  // ── Auth + seed helpers ────────────────────────────────────────────────

  async function adminLogin(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/admin/v1/auth/login')
      .send({ username: TEST_USERNAME, password: TEST_PASSWORD })
      .expect(200);
    return res.body.accessToken as string;
  }

  const adminAuth = (tok: string) => ({ Authorization: `Bearer ${tok}` });

  /** Seed member + student + course + ACTIVE product, returning the ids. */
  async function seedPrereqs(opts?: {
    price?: string;
    hours?: string;
    validDays?: number;
  }): Promise<{ accountId: string; studentId: string; courseId: string; productId: string }> {
    const account = await db.memberAccount.create({
      data: { normalizedPhone: '13800000001' },
    });
    const student = await db.studentProfile.create({ data: { displayName: '小明' } });
    await db.accountStudentRelation.create({
      data: {
        accountId: account.id,
        studentId: student.id,
        relationType: 'PARENT',
      },
    });
    const course = await db.course.create({
      data: { name: '编程', type: 'CLASS', description: 'd' },
    });
    const product = await db.packageProduct.create({
      data: {
        courseId: course.id,
        name: '10课时包',
        price: opts?.price ?? 100,
        hours: opts?.hours ?? 10,
        validDays: opts?.validDays ?? 30,
      },
    });
    return {
      accountId: account.id,
      studentId: student.id,
      courseId: course.id,
      productId: product.id,
    };
  }

  async function createDraft(
    token: string,
    accountId: string,
    studentId: string,
    productId: string,
  ): Promise<{ id: string; status: string; totalAmount: string; items: Array<{ unitPriceSnapshot: string; hoursSnapshot: string }> }> {
    const res = await request(app.getHttpServer())
      .post('/api/admin/v1/orders')
      .set(adminAuth(token))
      .send({
        buyerAccountId: accountId,
        items: [{ studentId, productId }],
      })
      .expect(201);
    return res.body;
  }

  // ── The six routes ─────────────────────────────────────────────────────

  it('creates a draft, fetches detail, and lists with filters', async () => {
    if (!ctx) return;
    const token = await adminLogin();
    const { accountId, studentId, productId } = await seedPrereqs();

    const draft = await createDraft(token, accountId, studentId, productId);
    expect(draft.status).toBe('PENDING');
    expect(draft.totalAmount).toBe('100.00');
    expect(draft.items[0]!.unitPriceSnapshot).toBe('100.00');
    expect(draft.items[0]!.hoursSnapshot).toBe('10.00');

    // Detail.
    const detail = await request(app.getHttpServer())
      .get(`/api/admin/v1/orders/${draft.id}`)
      .set(adminAuth(token))
      .expect(200);
    expect(detail.body.id).toBe(draft.id);
    expect(detail.body.items).toHaveLength(1);

    // List (one PENDING order).
    const list = await request(app.getHttpServer())
      .get('/api/admin/v1/orders?status=PENDING')
      .set(adminAuth(token))
      .expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]!.id).toBe(draft.id);

    // Filter by buyer.
    const byBuyer = await request(app.getHttpServer())
      .get(`/api/admin/v1/orders?buyerAccountId=${accountId}`)
      .set(adminAuth(token))
      .expect(200);
    expect(byBuyer.body.total).toBe(1);
  });

  it('confirms idempotently (same Idempotency-Key twice → equal bodies, one package)', async () => {
    if (!ctx) return;
    const token = await adminLogin();
    const { accountId, studentId, productId } = await seedPrereqs();
    const draft = await createDraft(token, accountId, studentId, productId);

    // Two concurrent confirms with the SAME Idempotency-Key.
    const [r1, r2] = await Promise.all([
      request(app.getHttpServer())
        .post(`/api/admin/v1/orders/${draft.id}/confirm`)
        .set(adminAuth(token))
        .set('Idempotency-Key', 'e2e-confirm-key')
        .expect(200),
      request(app.getHttpServer())
        .post(`/api/admin/v1/orders/${draft.id}/confirm`)
        .set(adminAuth(token))
        .set('Idempotency-Key', 'e2e-confirm-key')
        .expect(200),
    ]);
    expect(r1.body).toEqual(r2.body);
    expect(r1.body.status).toBe('CONFIRMED');
    // Exactly one package + the item carries a coursePackageId.
    const packages = await db.coursePackage.findMany({
      where: { sourceOrderItem: { orderId: draft.id } },
    });
    expect(packages).toHaveLength(1);
    expect(r1.body.items[0]!.coursePackageId).toBe(packages[0]!.id);
  });

  it('keeps the frozen snapshot over HTTP when the product is mutated before confirm', async () => {
    if (!ctx) return;
    const token = await adminLogin();
    const { accountId, studentId, productId } = await seedPrereqs();
    const draft = await createDraft(token, accountId, studentId, productId);

    // Mutate the product after draft.
    await db.packageProduct.update({
      where: { id: productId },
      data: { price: 999, hours: 99 },
    });

    const confirmed = await request(app.getHttpServer())
      .post(`/api/admin/v1/orders/${draft.id}/confirm`)
      .set(adminAuth(token))
      .set('Idempotency-Key', 'e2e-snapshot')
      .expect(200);
    // Frozen price/hours survive.
    expect(confirmed.body.items[0]!.unitPriceSnapshot).toBe('100.00');
    expect(confirmed.body.items[0]!.hoursSnapshot).toBe('10.00');
    expect(confirmed.body.totalAmount).toBe('100.00');
  });

  it('voids a PENDING draft over HTTP (order gone)', async () => {
    if (!ctx) return;
    const token = await adminLogin();
    const { accountId, studentId, productId } = await seedPrereqs();
    const draft = await createDraft(token, accountId, studentId, productId);

    await request(app.getHttpServer())
      .post(`/api/admin/v1/orders/${draft.id}/void`)
      .set(adminAuth(token))
      .set('Idempotency-Key', 'e2e-void')
      .expect(200);

    // Subsequent detail → 404 (the draft was removed).
    await request(app.getHttpServer())
      .get(`/api/admin/v1/orders/${draft.id}`)
      .set(adminAuth(token))
      .expect(404);
  });

  it('reverses a confirmed order over HTTP and refuses ORDER_NOT_REVERSIBLE after a later posting', async () => {
    if (!ctx) return;
    const token = await adminLogin();
    const { accountId, studentId, productId } = await seedPrereqs();
    const draft = await createDraft(token, accountId, studentId, productId);

    await request(app.getHttpServer())
      .post(`/api/admin/v1/orders/${draft.id}/confirm`)
      .set(adminAuth(token))
      .set('Idempotency-Key', 'e2e-confirm-rev')
      .expect(200);

    // Clean reverse → REVERSED.
    const reversed = await request(app.getHttpServer())
      .post(`/api/admin/v1/orders/${draft.id}/reverse`)
      .set(adminAuth(token))
      .set('Idempotency-Key', 'e2e-reverse-ok')
      .send({ reason: 'customer cancel' })
      .expect(200);
    expect(reversed.body.status).toBe('REVERSED');

    // A second confirmed order whose package gets a later posting → 409.
    const draft2 = await createDraft(token, accountId, studentId, productId);
    await request(app.getHttpServer())
      .post(`/api/admin/v1/orders/${draft2.id}/confirm`)
      .set(adminAuth(token))
      .set('Idempotency-Key', 'e2e-confirm-blocked')
      .expect(200);
    const detail2 = await request(app.getHttpServer())
      .get(`/api/admin/v1/orders/${draft2.id}`)
      .set(adminAuth(token))
      .expect(200);
    const packageId = detail2.body.items[0]!.coursePackageId as string;
    await seedLaterPosting(db, packageId);

    const blocked = await request(app.getHttpServer())
      .post(`/api/admin/v1/orders/${draft2.id}/reverse`)
      .set(adminAuth(token))
      .set('Idempotency-Key', 'e2e-reverse-blocked')
      .send({ reason: 'too late' })
      .expect(409);
    expect(blocked.body.code).toBe('ORDER_NOT_REVERSIBLE');
  });

  it('rejects unauthenticated requests (401) and re-confirm with STATE_CHANGED (409)', async () => {
    if (!ctx) return;
    const token = await adminLogin();
    const { accountId, studentId, productId } = await seedPrereqs();
    const draft = await createDraft(token, accountId, studentId, productId);

    // No auth → 401.
    await request(app.getHttpServer())
      .get('/api/admin/v1/orders')
      .expect(401);

    // Confirm once.
    await request(app.getHttpServer())
      .post(`/api/admin/v1/orders/${draft.id}/confirm`)
      .set(adminAuth(token))
      .set('Idempotency-Key', 'e2e-confirm-state')
      .expect(200);

    // Re-confirm with a DIFFERENT key → STATE_CHANGED (409), not idempotent replay.
    const again = await request(app.getHttpServer())
      .post(`/api/admin/v1/orders/${draft.id}/confirm`)
      .set(adminAuth(token))
      .set('Idempotency-Key', 'e2e-confirm-state-2')
      .expect(409);
    expect(again.body.code).toBe('STATE_CHANGED');
  });

  // ── Later-posting seeder (self-consistent, no Task 10 dependency) ──────

  async function seedLaterPosting(client: PrismaClient, packageId: string): Promise<void> {
    const pkg = await client.coursePackage.findUniqueOrThrow({ where: { id: packageId } });
    const units = new Prisma.Decimal('1.00');
    const tx = await client.hourTransaction.create({
      data: {
        studentId: pkg.studentId,
        courseId: pkg.courseId,
        type: 'DEBIT',
        businessKey: `e2e-later:${packageId}`,
        availableDelta: units.negated(),
        reservedDelta: new Prisma.Decimal('0.00'),
        consumedDelta: units,
        expiredDelta: new Prisma.Decimal('0.00'),
        reason: 'seeded later posting',
        occurredAt: new Date(),
      },
    });
    await client.hourAllocation.create({
      data: {
        transactionId: tx.id,
        packageId,
        sourceType: 'MANUAL_ADJUSTMENT',
        sourceId: packageId,
        availableDelta: units.negated(),
        reservedDelta: new Prisma.Decimal('0.00'),
        consumedDelta: units,
        expiredDelta: new Prisma.Decimal('0.00'),
      },
    });
  }
});
