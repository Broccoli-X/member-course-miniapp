import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import request from 'supertest';
import {
  FakeWechatGateway,
  loginCodeFor,
  phoneCodeFor,
  phonePartsFor,
} from '../doubles/fake-wechat.gateway.js';
import { normalizePhone } from '../../src/modules/identity/domain/phone.js';

/**
 * M1 end-to-end journey driver (Task 16).
 *
 * Concrete `admin`, `mini`, and `db` drivers consumed by
 * `m1-member-assets-journey.e2e-spec.ts`. Each method issues a real HTTP call
 * against the live NestJS app (no service-level shortcuts), so the journey
 * exercises the full request pipeline: routing, guards, idempotency, the
 * HourLedger FEFO allocator, and the snapshot freeze.
 *
 * The driver is deliberately self-contained: it depends ONLY on artifacts that
 * exist in M1 (the {@link FakeWechatGateway} test double, supertest, and the
 * raw Prisma client exposed by the running app). No globals and no helper from
 * a later milestone.
 */

/** A phone-keyed pre-created member + a single PARENT child student. */
export interface PrecreatedMember {
  readonly accountId: string;
  readonly phone: string;
  readonly childId: string;
}

/** A course + an ACTIVE package product used to place an order. */
export interface CatalogProduct {
  readonly courseId: string;
  readonly id: string;
  readonly hours: string;
  readonly price: string;
}

/** A created PENDING draft order with the single item id surfaced. */
export interface CreatedOrder {
  readonly id: string;
  readonly itemId: string;
}

/** Mini-program session produced by `mini.bindWechatToPhone`. */
export interface MiniSession {
  readonly accessToken: string;
  readonly accountId: string;
}

/** Build the journey driver set from the running app + fake gateway + db. */
export function createM1JourneyDriver(deps: {
  app: INestApplication;
  db: PrismaClient;
  fakeWechat: FakeWechatGateway;
  adminUsername: string;
  adminPassword: string;
}): {
  admin: AdminDriver;
  mini: MiniDriver;
  db: PrismaClient;
} {
  const { app, db, fakeWechat, adminUsername, adminPassword } = deps;
  const http = () => app.getHttpServer();

  let cachedAdminToken: string | null = null;

  async function adminToken(): Promise<string> {
    if (cachedAdminToken) return cachedAdminToken;
    const res = await request(http())
      .post('/api/admin/v1/auth/login')
      .send({ username: adminUsername, password: adminPassword })
      .expect(200);
    cachedAdminToken = res.body.accessToken as string;
    return cachedAdminToken;
  }

  /** Reset the cached admin token (call between tests so a re-seed is picked up). */
  function resetAdminToken(): void {
    cachedAdminToken = null;
  }

  const adminAuth = (tok: string) => ({ Authorization: `Bearer ${tok}` });

  const admin: AdminDriver = {
    resetAdminToken,

    /** Gate 1: pre-create a member + a single PARENT child student. */
    async precreateMemberWithChild(opts?: {
      phone?: string;
      childDisplayName?: string;
    }): Promise<PrecreatedMember> {
      const phone = opts?.phone ?? '13800000001';
      const token = await adminToken();
      const member = await request(http())
        .post('/api/admin/v1/members')
        .set(adminAuth(token))
        .send({ normalizedPhone: phone, status: 'ACTIVE' })
        .expect(201);
      const student = await request(http())
        .post(`/api/admin/v1/members/${member.body.id}/students`)
        .set(adminAuth(token))
        .send({
          displayName: opts?.childDisplayName ?? '小明',
          relationType: 'PARENT',
        })
        .expect(201);
      return {
        accountId: member.body.id as string,
        phone,
        childId: student.body.student.id as string,
      };
    },

    /** Gate 3: create a course + ACTIVE package product. */
    async createCourseAndPackage(opts?: {
      courseName?: string;
      packageName?: string;
      price?: string;
      hours?: string;
      validDays?: number;
    }): Promise<CatalogProduct> {
      const token = await adminToken();
      const course = await request(http())
        .post('/api/admin/v1/courses')
        .set(adminAuth(token))
        .send({
          name: opts?.courseName ?? '编程课',
          type: 'CLASS',
          description: 'M1 journey course',
        })
        .expect(201);
      const price = opts?.price ?? '100.00';
      const hours = opts?.hours ?? '10.00';
      const product = await request(http())
        .post(`/api/admin/v1/courses/${course.body.id}/package-products`)
        .set(adminAuth(token))
        .send({
          name: opts?.packageName ?? '10课时包',
          price,
          hours,
          validDays: opts?.validDays ?? 30,
        })
        .expect(201);
      return {
        courseId: course.body.id as string,
        id: product.body.id as string,
        hours,
        price,
      };
    },

    /** Create a single-item PENDING draft for the given student + product. */
    async createOrder(
      studentId: string,
      productId: string,
      buyerAccountId?: string,
    ): Promise<CreatedOrder> {
      const token = await adminToken();
      // Resolve the buyer account id: default to the account that owns the
      // student (looked up via the relation) so a caller that only knows the
      // student + product still works.
      let buyer = buyerAccountId;
      if (!buyer) {
        const rel = await db.accountStudentRelation.findFirst({
          where: { studentId },
          select: { accountId: true },
        });
        buyer = rel?.accountId;
        if (!buyer) {
          throw new Error(
            `m1-journey-driver.createOrder: no buyer account linked to student ${studentId}`,
          );
        }
      }
      const draft = await request(http())
        .post('/api/admin/v1/orders')
        .set(adminAuth(token))
        .send({
          buyerAccountId: buyer,
          items: [{ studentId, productId }],
        })
        .expect(201);
      return {
        id: draft.body.id as string,
        itemId: draft.body.items[0]!.id as string,
      };
    },

    /**
     * Confirm a draft. `idempotencyKey` is sent as the `Idempotency-Key`
     * header so a retried/doubled confirm executes the work exactly once and
     * replays the cached 200 body.
     */
    async confirmOrder(
      orderId: string,
      idempotencyKey: string,
    ): Promise<request.Response> {
      const token = await adminToken();
      return request(http())
        .post(`/api/admin/v1/orders/${orderId}/confirm`)
        .set(adminAuth(token))
        .set('Idempotency-Key', idempotencyKey);
    },

    /** Reverse a confirmed order (clean → REVERSED). */
    async reverseOrder(
      orderId: string,
      idempotencyKey: string,
      reason?: string,
    ): Promise<request.Response> {
      const token = await adminToken();
      return request(http())
        .post(`/api/admin/v1/orders/${orderId}/reverse`)
        .set(adminAuth(token))
        .set('Idempotency-Key', idempotencyKey)
        .send(reason !== undefined ? { reason } : {});
    },

    /** Void a PENDING draft. */
    async voidOrder(
      orderId: string,
      idempotencyKey: string,
    ): Promise<request.Response> {
      const token = await adminToken();
      return request(http())
        .post(`/api/admin/v1/orders/${orderId}/void`)
        .set(adminAuth(token))
        .set('Idempotency-Key', idempotencyKey);
    },

    /** Post a manual grant (Gate 5: preserve exact decimal balances). */
    async manualGrant(
      studentId: string,
      courseId: string,
      body: {
        units: string;
        startsOn: string;
        expiresOn: string;
        reason: string;
      },
      idempotencyKey: string,
    ): Promise<request.Response> {
      const token = await adminToken();
      return request(http())
        .post(
          `/api/admin/v1/students/${studentId}/courses/${courseId}/hour-adjustments/grant`,
        )
        .set(adminAuth(token))
        .set('Idempotency-Key', idempotencyKey)
        .send(body);
    },

    /** Post a manual FEFO debit (Gate 5). */
    async manualDebit(
      studentId: string,
      courseId: string,
      body: { units: string; reason: string },
      idempotencyKey: string,
    ): Promise<request.Response> {
      const token = await adminToken();
      return request(http())
        .post(
          `/api/admin/v1/students/${studentId}/courses/${courseId}/hour-adjustments/debit`,
        )
        .set(adminAuth(token))
        .set('Idempotency-Key', idempotencyKey)
        .send(body);
    },

    /** Seed a later posting directly on a package (forces ORDER_NOT_REVERSIBLE). */
    async seedLaterPosting(packageId: string): Promise<void> {
      const { Prisma } = await import('../../src/generated/prisma/client.js');
      const pkg = await db.coursePackage.findUniqueOrThrow({
        where: { id: packageId },
      });
      const units = new Prisma.Decimal('1.00');
      const tx = await db.hourTransaction.create({
        data: {
          studentId: pkg.studentId,
          courseId: pkg.courseId,
          type: 'DEBIT',
          businessKey: `m1-later:${packageId}`,
          availableDelta: units.negated(),
          reservedDelta: new Prisma.Decimal('0.00'),
          consumedDelta: units,
          expiredDelta: new Prisma.Decimal('0.00'),
          reason: 'seeded later posting',
          occurredAt: new Date(),
        },
      });
      await db.hourAllocation.create({
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
    },
  };

  const mini: MiniDriver = {
    /**
     * Gate 2: drive the full mini login + bind flow for a phone that the admin
     * pre-created. The provisional WeChat identity binds to the same phone and
     * atomically migrates onto the pre-created account. Returns a fresh access
     * token minted AFTER binding so `provisional:false` is encoded and the
     * BoundMemberGuard admits subsequent private requests.
     */
    async bindWechatToPhone(
      phone: string,
      opts?: { openId?: string },
    ): Promise<MiniSession> {
      const openId = opts?.openId ?? `openid-m1-${normalizePhone(phone)}`;
      const code = loginCodeFor(openId);
      fakeWechat.setSession(code, { openId });
      const login = await request(http())
        .post('/api/mini/v1/auth/wechat-login')
        .send({ code })
        .expect(200);
      const normalized = normalizePhone(phone);
      const phoneCode = phoneCodeFor(normalized);
      fakeWechat.setPhone(phoneCode, phonePartsFor(normalized));
      await request(http())
        .post('/api/mini/v1/auth/bind-phone')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .send({ phoneCode })
        .expect(200);
      // Re-login to mint a token with provisional:false encoded.
      const relogin = await request(http())
        .post('/api/mini/v1/auth/wechat-login')
        .send({ code })
        .expect(200);
      return {
        accessToken: relogin.body.accessToken as string,
        accountId: relogin.body.accountId as string,
      };
    },

    /** Gate 6: list the member's own course balances for a student. */
    async listBalances(
      session: MiniSession,
      studentId: string,
    ): Promise<Array<{ available: string }>> {
      const res = await request(http())
        .get(`/api/mini/v1/students/${studentId}/course-balances`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(200);
      return res.body.items as Array<{ available: string }>;
    },

    /** Gate 6: list the member's own course packages for a student. */
    async listPackages(
      session: MiniSession,
      studentId: string,
    ): Promise<
      Array<{
        available: string;
        granted: string;
        sourceType: string;
        status: string;
      }>
    > {
      const res = await request(http())
        .get(`/api/mini/v1/students/${studentId}/course-packages`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(200);
      return res.body.items;
    },

    /** Gate 6: list the member's own hour transactions for a student. */
    async listTransactions(
      session: MiniSession,
      studentId: string,
    ): Promise<
      Array<{ type: string; businessKey: string; availableDelta: string }>
    > {
      const res = await request(http())
        .get(`/api/mini/v1/students/${studentId}/hour-transactions`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(200);
      return res.body.items;
    },

    /** Gate 6: list the member's own orders (buyer isolation). */
    async listOrders(session: MiniSession): Promise<
      Array<{
        id: string;
        buyerAccountId: string;
        status: string;
        totalAmount: string;
      }>
    > {
      const res = await request(http())
        .get('/api/mini/v1/orders')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(200);
      return res.body.items;
    },

    /** Gate 7: attempt to read another account's student assets (expect 403). */
    async listBalancesExpecting(
      session: MiniSession,
      studentId: string,
      status: number,
    ): Promise<request.Response> {
      return request(http())
        .get(`/api/mini/v1/students/${studentId}/course-balances`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(status);
    },
  };

  return { admin, mini, db };
}

/** Admin-side journey operations (real HTTP). */
export interface AdminDriver {
  resetAdminToken(): void;
  precreateMemberWithChild(opts?: {
    phone?: string;
    childDisplayName?: string;
  }): Promise<PrecreatedMember>;
  createCourseAndPackage(opts?: {
    courseName?: string;
    packageName?: string;
    price?: string;
    hours?: string;
    validDays?: number;
  }): Promise<CatalogProduct>;
  createOrder(
    studentId: string,
    productId: string,
    buyerAccountId?: string,
  ): Promise<CreatedOrder>;
  confirmOrder(orderId: string, idempotencyKey: string): Promise<request.Response>;
  reverseOrder(
    orderId: string,
    idempotencyKey: string,
    reason?: string,
  ): Promise<request.Response>;
  voidOrder(orderId: string, idempotencyKey: string): Promise<request.Response>;
  manualGrant(
    studentId: string,
    courseId: string,
    body: {
      units: string;
      startsOn: string;
      expiresOn: string;
      reason: string;
    },
    idempotencyKey: string,
  ): Promise<request.Response>;
  manualDebit(
    studentId: string,
    courseId: string,
    body: { units: string; reason: string },
    idempotencyKey: string,
  ): Promise<request.Response>;
  seedLaterPosting(packageId: string): Promise<void>;
}

/** Mini-program-side journey operations (real HTTP). */
export interface MiniDriver {
  bindWechatToPhone(phone: string, opts?: { openId?: string }): Promise<MiniSession>;
  listBalances(
    session: MiniSession,
    studentId: string,
  ): Promise<Array<{ available: string }>>;
  listPackages(
    session: MiniSession,
    studentId: string,
  ): Promise<
    Array<{
      available: string;
      granted: string;
      sourceType: string;
      status: string;
    }>
  >;
  listTransactions(
    session: MiniSession,
    studentId: string,
  ): Promise<
    Array<{ type: string; businessKey: string; availableDelta: string }>
  >;
  listOrders(session: MiniSession): Promise<
    Array<{
      id: string;
      buyerAccountId: string;
      status: string;
      totalAmount: string;
    }>
  >;
  listBalancesExpecting(
    session: MiniSession,
    studentId: string,
    status: number,
  ): Promise<request.Response>;
}
