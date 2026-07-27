import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import { AppModule } from '../../src/app.module.js';
import { BusinessErrorFilter } from '../../src/common/errors/business-error.filter.js';
import { WECHAT_GATEWAY } from '../../src/modules/identity/tokens.js';
import { getMysqlContext, type MysqlTestContext } from '../helpers/mysql-test-environment.js';
import { FakeWechatGateway } from '../doubles/fake-wechat.gateway.js';
import { seedAdmin } from '../../prisma/seed.js';
import { createM1JourneyDriver } from '../helpers/m1-journey-driver.js';

/**
 * M1 end-to-end member-asset journey (Task 16).
 *
 * This is the M1 acceptance gate. A single closed-loop test drives the full
 * product story end-to-end over real HTTP against the live NestJS app + real
 * MySQL: admin pre-creates a member + child (Gate 1), a provisional WeChat
 * identity binds the same phone and atomically migrates onto the pre-created
 * account (Gate 2), admin creates a course + package product (Gate 3), an
 * order is confirmed idempotently to produce exactly one sales package + one
 * GRANT posting (Gate 4), manual grant + FEFO debit preserve exact decimal
 * balances (Gate 5), the related mini-program account reads the correct
 * order/package/balance/transactions (Gate 6), an unrelated account receives
 * `STUDENT_FORBIDDEN` (Gate 7), an untouched order reverses cleanly and any
 * order with a later posting rejects `ORDER_NOT_REVERSIBLE` (Gate 8).
 *
 * The WeChat gateway is overridden with a {@link FakeWechatGateway} so login +
 * phone-binding are deterministic without network access; everything else
 * (HTTP routing, guards, idempotency, the HourLedger FEFO allocator, InnoDB
 * row locks) is the real production stack.
 */
describe('M1 member-asset journey (e2e)', () => {
  const DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/member_course_test';
  const TEST_USERNAME = 'admin';
  const TEST_PASSWORD = 'Admin@123456';

  let ctx: MysqlTestContext | null;
  let app: INestApplication;
  let moduleRef: TestingModule;
  let db: PrismaClient;
  let fakeWechat: FakeWechatGateway;
  let admin: ReturnType<typeof createM1JourneyDriver>['admin'];
  let mini: ReturnType<typeof createM1JourneyDriver>['mini'];

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
    const driver = createM1JourneyDriver({
      app,
      db,
      fakeWechat,
      adminUsername: TEST_USERNAME,
      adminPassword: TEST_PASSWORD,
    });
    admin = driver.admin;
    mini = driver.mini;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (ctx) await ctx.cleanup();
  });

  beforeEach(async () => {
    if (!ctx || !db) return;
    fakeWechat.reset();
    await truncateTables(db);
    await seedAdmin({ db, username: TEST_USERNAME, password: TEST_PASSWORD });
    admin.resetAdminToken();
  });

  async function truncateTables(client: PrismaClient): Promise<void> {
    await client.$executeRawUnsafe(`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`hour_allocation\``);
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`hour_transaction\``);
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`course_package\``);
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`student_course_balance\``);
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`order_item\``);
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`offline_order\``);
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`package_product\``);
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`account_student_relation\``);
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`student_profile\``);
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`course\``);
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`member_account\``);
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`idempotency_record\``);
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`refresh_session\``);
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`wechat_identity\``);
      await client.$executeRawUnsafe(`TRUNCATE TABLE \`admin_user\``);
    } finally {
      await client.$executeRawUnsafe(`SET FOREIGN_KEY_CHECKS = 1`);
    }
  }

  // ── The M1 closed-loop journey (Gates 1–8) ──────────────────────────────

  it('completes the M1 member asset journey', async () => {
    if (!ctx) return;

    // Gate 1 — admin pre-creates a member + child.
    const member = await admin.precreateMemberWithChild();

    // Gate 2 — provisional WeChat identity binds the same phone and migrates.
    const session = await mini.bindWechatToPhone(member.phone);
    // The bound session MUST land on the pre-created account (atomic migrate).
    expect(session.accountId).toBe(member.accountId);

    // Gate 3 — admin creates a course + package product.
    const product = await admin.createCourseAndPackage();

    // Order draft for the child + product.
    const order = await admin.createOrder(member.childId, product.id);

    // Gate 4 — repeated order confirmation creates exactly one sales package
    // and one GRANT posting (idempotent on the same Idempotency-Key).
    const [first, retry] = await Promise.all([
      admin.confirmOrder(order.id, 'confirm-order-1'),
      admin.confirmOrder(order.id, 'confirm-order-1'),
    ]);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    // The two concurrent confirms with the SAME key return EQUAL bodies.
    expect(first.body).toEqual(retry.body);
    expect(first.body.status).toBe('CONFIRMED');

    // Exactly one CoursePackage sourced from this order item.
    expect(
      await db.coursePackage.count({ where: { sourceOrderItemId: order.itemId } }),
    ).toBe(1);

    // Exactly one GRANT HourTransaction for the order item.
    //
    // NOTE on businessKey format: the brief's verbatim snippet asserted
    // `'order:' + order.itemId + ':grant'`, but Task 9's
    // `OfflineOrderService.confirmInTx` actually emits the grant posting with
    // the businessKey `order-grant:<orderItemId>` (see
    // apps/api/src/modules/orders/application/offline-order.service.ts). The
    // journey test verifies the REAL system behaviour, so the assertion uses
    // the actual format — a mismatch here would mean the order service or the
    // ledger drifted from its documented idempotency anchor.
    expect(
      await db.hourTransaction.count({
        where: { businessKey: `order-grant:${order.itemId}` },
      }),
    ).toBe(1);

    // Gate 6 — the related mini-program account reads the granted balance.
    expect(await mini.listBalances(session, member.childId)).toContainEqual(
      expect.objectContaining({ available: product.hours }),
    );
  });

  // ── Gate 5: manual grant + FEFO debit preserve exact decimal balances ──

  it('preserves exact decimal balances across manual grant + FEFO debit', async () => {
    if (!ctx) return;

    const member = await admin.precreateMemberWithChild({
      phone: '13800000010',
    });
    const session = await mini.bindWechatToPhone(member.phone);
    const product = await admin.createCourseAndPackage({
      hours: '10.00',
      price: '100.00',
    });
    const order = await admin.createOrder(member.childId, product.id);
    const confirmed = await admin.confirmOrder(order.id, 'm1-grant-confirm');
    expect(confirmed.status).toBe(200);

    // Manual grant of 2.30 on the same course (separate MANUAL package).
    const grant = await admin.manualGrant(
      member.childId,
      product.courseId,
      {
        units: '2.30',
        startsOn: '2026-01-01',
        expiresOn: '2026-04-01',
        reason: 'makeup grant',
      },
      'm1-manual-grant',
    );
    expect(grant.status).toBe(200);
    expect(grant.body.balance.available).toBe('12.30');

    // FEFO debit of 1.00 — draws from the earliest-expiring package first.
    // MANUAL_DEDUCT reduces `available` only (the `consumed` bucket is reserved
    // for future booking/attendance postings, which M1 does not produce).
    const debit = await admin.manualDebit(
      member.childId,
      product.courseId,
      { units: '1.00', reason: 'single class' },
      'm1-manual-debit',
    );
    expect(debit.status).toBe(200);
    expect(debit.body.balance.available).toBe('11.30');

    // The mini-program reads the exact same 2-dp decimal balance.
    const balances = await mini.listBalances(session, member.childId);
    expect(balances[0]!.available).toBe('11.30');
  });

  // ── Gate 6 (extended): related account reads order/package/transactions ─

  it('lets the related mini-program account read order, package, and transactions', async () => {
    if (!ctx) return;

    const member = await admin.precreateMemberWithChild({
      phone: '13800000020',
    });
    const session = await mini.bindWechatToPhone(member.phone);
    const product = await admin.createCourseAndPackage();
    const order = await admin.createOrder(member.childId, product.id);
    const confirmed = await admin.confirmOrder(order.id, 'm1-read-confirm');
    expect(confirmed.status).toBe(200);

    // Orders: the member sees exactly their own order.
    const orders = await mini.listOrders(session);
    expect(orders.map((o) => o.id)).toContain(order.id);
    expect(orders[0]!.status).toBe('CONFIRMED');
    expect(orders[0]!.buyerAccountId).toBe(member.accountId);

    // Packages: exactly one ORDER package sourced from this order item. The
    // mini CoursePackageView exposes `sourceType` but not `sourceOrderItemId`,
    // so the order↔package link is verified via the DB (source of truth).
    const packages = await mini.listPackages(session, member.childId);
    expect(packages).toHaveLength(1);
    expect(packages[0]!.sourceType).toBe('ORDER');
    expect(packages[0]!.available).toBe(product.hours);
    expect(
      await db.coursePackage.count({ where: { sourceOrderItemId: order.itemId } }),
    ).toBe(1);

    // Transactions: the GRANT posting is visible, newest-first.
    const txs = await mini.listTransactions(session, member.childId);
    expect(txs[0]!.type).toBe('GRANT');
    expect(txs[0]!.availableDelta).toBe(product.hours);
  });

  // ── Gate 7: an unrelated account receives STUDENT_FORBIDDEN ────────────

  it('rejects an unrelated account with STUDENT_FORBIDDEN (no stale-data leak)', async () => {
    if (!ctx) return;

    // Owner member + child with granted hours.
    const owner = await admin.precreateMemberWithChild({
      phone: '13800000030',
      childDisplayName: 'Owner Child',
    });
    const ownerSession = await mini.bindWechatToPhone(owner.phone);
    const product = await admin.createCourseAndPackage();
    const order = await admin.createOrder(owner.childId, product.id);
    const confirmed = await admin.confirmOrder(order.id, 'm1-forbidden-confirm');
    expect(confirmed.status).toBe(200);

    // A SECOND, unrelated member (own child, own phone) logs in.
    const other = await admin.precreateMemberWithChild({
      phone: '13800000031',
      childDisplayName: 'Other Child',
    });
    const otherSession = await mini.bindWechatToPhone(other.phone);

    // The other account cannot read the owner's child balances → 403.
    const denied = await mini.listBalancesExpecting(
      otherSession,
      owner.childId,
      403,
    );
    expect(denied.body.code).toBe('STUDENT_FORBIDDEN');

    // No stale-data leakage: the other account can read their OWN child.
    const own = await mini.listBalances(otherSession, other.childId);
    expect(own).toEqual([]);

    // And the owner can still read their own child (the denial was scoped).
    const ownerBalances = await mini.listBalances(ownerSession, owner.childId);
    expect(ownerBalances[0]!.available).toBe(product.hours);
  });

  // ── Gate 8: untouched order reverses; later posting blocks reversal ────

  it('reverses an untouched order and refuses ORDER_NOT_REVERSIBLE after a later posting', async () => {
    if (!ctx) return;

    const member = await admin.precreateMemberWithChild({
      phone: '13800000040',
    });
    await mini.bindWechatToPhone(member.phone);
    const product = await admin.createCourseAndPackage();

    // Order A: clean reverse → REVERSED.
    const orderA = await admin.createOrder(member.childId, product.id);
    const confirmedA = await admin.confirmOrder(orderA.id, 'm1-reverse-a-confirm');
    expect(confirmedA.status).toBe(200);
    const reversed = await admin.reverseOrder(
      orderA.id,
      'm1-reverse-a',
      'customer cancel',
    );
    expect(reversed.status).toBe(200);
    expect(reversed.body.status).toBe('REVERSED');

    // Order B: a later posting on its package blocks reversal.
    const orderB = await admin.createOrder(member.childId, product.id);
    const confirmedB = await admin.confirmOrder(orderB.id, 'm1-reverse-b-confirm');
    expect(confirmedB.status).toBe(200);
    const packageId = confirmedB.body.items[0]!.coursePackageId as string;
    await admin.seedLaterPosting(packageId);

    const blocked = await admin.reverseOrder(orderB.id, 'm1-reverse-b', 'too late');
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('ORDER_NOT_REVERSIBLE');
  });
});
