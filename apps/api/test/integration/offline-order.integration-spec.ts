import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Prisma } from '../../src/generated/prisma/client.js';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { getMysqlContext, type MysqlTestContext } from '../helpers/mysql-test-environment.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import { IdempotencyService } from '../../src/common/idempotency/idempotency.service.js';
import { HourLedgerService } from '../../src/modules/hours/application/hour-ledger.service.js';
import { HourLockRepository } from '../../src/modules/hours/infrastructure/hour-lock.repository.js';
import { OfflineOrderService } from '../../src/modules/orders/application/offline-order.service.js';
import { OfflineOrderQueryService } from '../../src/modules/orders/application/offline-order-query.service.js';
import {
  OFFLINE_ORDER_STATUS,
  type CommandContext,
  type CreateOfflineOrderCommand,
} from '@member-course/contracts';
import { calculateExpiryDate } from '../../src/common/time/business-date.js';

/**
 * Offline-order lifecycle integration tests (Task 9 brief).
 *
 * Runs against the real MySQL test DB. The {@link OfflineOrderService} is wired
 * with a real {@link IdempotencyService}, {@link HourLedgerService}, and a
 * `PrismaClient` pointed at the test DB, so the two verbatim brief cases
 * exercise actual InnoDB transactions: confirm creates the package + posts the
 * grant + flips the status in ONE tx; reverse appends a REVERSAL on the same
 * ledger. A failure rolls back the whole tx (no packages, no grants).
 *
 * Brief verbatim case 1: "confirms once and freezes the product snapshot" — two
 * CONCURRENT confirms with the SAME key → equal results, exactly 1 package,
 * exactly 1 grant, and the confirmed item's unitPrice is the FROZEN original
 * (not the post-mutation 999).
 *
 * Brief verbatim case 2: "reverses only a package with no posting after GRANT"
 * — a clean confirmed order reverses to REVERSED; a confirmed order whose
 * package has a seeded later posting rejects with `ORDER_NOT_REVERSIBLE`.
 */
describe.skipIf(!process.env.RUN_INTEGRATION)(
  'Offline order lifecycle (integration, real MySQL)',
  () => {
    let ctx: MysqlTestContext | null;
    let db: PrismaClient;
    let orders: OfflineOrderService;
    let query: OfflineOrderQueryService;

    beforeAll(async () => {
      ctx = await getMysqlContext();
      if (!ctx) return;
      db = new PrismaClient({ datasources: { db: { url: ctx.databaseUrl } } });
      // PrismaService is the same class as PrismaClient for our purposes; cast
      // so IdempotencyService (which types its dep as PrismaService) is happy.
      const dbAsService = db as unknown as PrismaService;
      const idempotency = new IdempotencyService(dbAsService);
      const ledger = new HourLedgerService(new HourLockRepository());
      orders = new OfflineOrderService(dbAsService, idempotency, ledger);
      query = new OfflineOrderQueryService(dbAsService);
    });

    beforeEach(async () => {
      if (!ctx) return;
      await truncateOrderTables(db);
    });

    afterAll(async () => {
      if (db) await db.$disconnect();
      if (ctx) await ctx.cleanup();
    });

    // ── Helpers ──────────────────────────────────────────────────────────

    /** Seed member + student + course + ACTIVE product; return the ids. */
    async function seedCatalog(opts?: {
      accountId?: string;
      studentId?: string;
      courseId?: string;
      productId?: string;
      price?: string;
      hours?: string;
      validDays?: number;
    }): Promise<{
      accountId: string;
      studentId: string;
      courseId: string;
      productId: string;
    }> {
      const accountId = opts?.accountId ?? 'acc-1';
      const studentId = opts?.studentId ?? 'stu-1';
      const courseId = opts?.courseId ?? 'crs-1';
      const productId = opts?.productId ?? 'pp-1';
      await db.memberAccount.upsert({
        where: { id: accountId },
        update: {},
        create: { id: accountId, normalizedPhone: '13800000001' },
      });
      await db.studentProfile.upsert({
        where: { id: studentId },
        update: {},
        create: { id: studentId, displayName: '小明' },
      });
      await db.accountStudentRelation.upsert({
        where: { accountId_studentId: { accountId, studentId } },
        update: {},
        create: { accountId, studentId, relationType: 'PARENT' },
      });
      await db.course.upsert({
        where: { id: courseId },
        update: {},
        create: { id: courseId, name: '编程', type: 'CLASS', description: 'd' },
      });
      await db.packageProduct.upsert({
        where: { id: productId },
        update: {},
        create: {
          id: productId,
          courseId,
          name: '10课时包',
          price: opts?.price ?? 100,
          hours: opts?.hours ?? 10,
          validDays: opts?.validDays ?? 30,
        },
      });
      return { accountId, studentId, courseId, productId };
    }

    function adminContext(key: string): CommandContext {
      return {
        actorType: 'ADMIN',
        actorId: 'admin-1',
        requestId: 'test-trace',
        idempotencyKey: key,
      };
    }

    async function createDraftFromProduct(
      productId: string,
      studentId: string,
      buyerAccountId: string,
    ): Promise<{ id: string }> {
      const command: CreateOfflineOrderCommand = {
        buyerAccountId,
        items: [{ studentId, productId }],
      };
      const dto = await orders.createDraft(command, 'admin-1');
      return { id: dto.id };
    }

    function confirmOrder(orderId: string, key: string) {
      return orders.confirm(orderId, adminContext(key));
    }
    function reverseOrder(orderId: string, key: string) {
      return orders.reverse(orderId, {}, adminContext(key));
    }
    async function orderStatus(orderId: string): Promise<string> {
      const o = await db.offlineOrder.findUnique({ where: { id: orderId } });
      return o!.status;
    }
    async function packageCountForOrder(orderId: string): Promise<number> {
      return db.coursePackage.count({
        where: { sourceOrderItem: { orderId } },
      });
    }
    async function grantCountForOrder(orderId: string): Promise<number> {
      // A GRANT HourTransaction per item, matched via the order's items.
      const items = await db.orderItem.findMany({
        where: { orderId },
        select: { id: true },
      });
      if (items.length === 0) return 0;
      const keys = items.map((i) => `order-grant:${i.id}`);
      return db.hourTransaction.count({ where: { businessKey: { in: keys } } });
    }

    /**
     * Seed one internally-consistent post-GRANT HourTransaction + HourAllocation
     * for the given package (the "later posting" that blocks reversal). This
     * models what Task 10 (Adjustments) or a future consumption would do — a
     * DEBIT posting that moves units out of `available` into `consumed`. It is
     * self-consistent: the transaction deltas + allocation deltas reconcile
     * against the package + balance after the post. We do NOT depend on Task 10.
     */
    async function seedLaterPostingForPackage(
      client: PrismaClient,
      packageId: string,
    ): Promise<void> {
      const pkg = await client.coursePackage.findUnique({
        where: { id: packageId },
      });
      if (!pkg) throw new Error(`package ${packageId} not found`);
      const units = new Prisma.Decimal('1.00');
      const occurredAt = new Date();

      // Append the DEBIT HourTransaction (a "later posting" after the GRANT).
      const tx = await client.hourTransaction.create({
        data: {
          studentId: pkg.studentId,
          courseId: pkg.courseId,
          type: 'DEBIT',
          businessKey: `later-posting:${packageId}`,
          availableDelta: units.negated(),
          reservedDelta: new Prisma.Decimal('0.00'),
          consumedDelta: units,
          expiredDelta: new Prisma.Decimal('0.00'),
          reason: 'seeded later posting',
          occurredAt,
        },
      });
      // Allocation against the same package, recording the per-package slice.
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
      // Apply the delta to the package buckets (raw UPDATE for consistency
      // with the ledger's own raw updates; mirror the bucket math).
      await client.$executeRaw`
        UPDATE \`course_package\`
        SET \`available\` = \`available\` + ${units.negated()},
            \`consumed\`  = \`consumed\` + ${units},
            \`version\`   = \`version\` + 1,
            \`updatedAt\` = UTC_TIMESTAMP(3)
        WHERE \`id\` = ${packageId}
      `;
    }

    // ── Brief verbatim case 1 ────────────────────────────────────────────

    it('confirms once and freezes the product snapshot', async () => {
      if (!ctx) return;
      const { accountId, studentId, productId } = await seedCatalog({
        price: '100.00',
        hours: '10.00',
        validDays: 30,
      });
      const draft = await createDraftFromProduct(productId, studentId, accountId);

      // Mutate the product AFTER draft — confirm must still use the FROZEN price.
      await db.packageProduct.update({
        where: { id: productId },
        data: { price: 999, hours: 99 },
      });

      // Two CONCURRENT confirms with the SAME idempotency key.
      const [first, second] = await Promise.all([
        confirmOrder(draft.id, 'confirm-key'),
        confirmOrder(draft.id, 'confirm-key'),
      ]);

      // Equal results (idempotent — same key ran the work exactly once).
      expect(first).toEqual(second);
      // Exactly one package and one grant for the order.
      expect(await packageCountForOrder(draft.id)).toBe(1);
      expect(await grantCountForOrder(draft.id)).toBe(1);
      // The frozen unit price survives the product mutation.
      expect(first.items[0]!.unitPriceSnapshot).toBe('100.00');
      expect(first.items[0]!.hoursSnapshot).toBe('10.00');
      expect(first.status).toBe(OFFLINE_ORDER_STATUS.CONFIRMED);
      expect(first.totalAmount).toBe('100.00');
    });

    // ── Brief verbatim case 2 ────────────────────────────────────────────

    it('reverses only a package with no posting after GRANT', async () => {
      if (!ctx) return;
      const { accountId, studentId, productId } = await seedCatalog({
        price: '100.00',
        hours: '10.00',
        validDays: 30,
      });

      // A clean confirmed order → reverses to REVERSED.
      const cleanDraft = await createDraftFromProduct(productId, studentId, accountId);
      await confirmOrder(cleanDraft.id, 'confirm-clean');
      await reverseOrder(cleanDraft.id, 'reverse-1');
      expect(await orderStatus(cleanDraft.id)).toBe(OFFLINE_ORDER_STATUS.REVERSED);

      // A confirmed order whose package has a LATER posting → rejects.
      const usedDraft = await createDraftFromProduct(productId, studentId, accountId);
      await confirmOrder(usedDraft.id, 'confirm-used');
      const usedOrder = await query.detail(usedDraft.id);
      const packageId = usedOrder.items[0]!.coursePackageId!;
      await seedLaterPostingForPackage(db, packageId);
      await expect(reverseOrder(usedDraft.id, 'reverse-2')).rejects.toMatchObject({
        code: 'ORDER_NOT_REVERSIBLE',
        httpStatus: 409,
      });
      // The failed reversal did NOT flip the status (still CONFIRMED).
      expect(await orderStatus(usedDraft.id)).toBe(OFFLINE_ORDER_STATUS.CONFIRMED);
    });

    // ── Draft void (PENDING draft is removed; no ledger side effects) ─────

    it('voids a PENDING draft and leaves no packages or grants', async () => {
      if (!ctx) return;
      const { accountId, studentId, productId } = await seedCatalog();
      const draft = await createDraftFromProduct(productId, studentId, accountId);

      await orders.voidDraft(draft.id, adminContext('void-1'));

      // Order + items are gone; no packages or grants were ever created.
      await expect(db.offlineOrder.findUnique({ where: { id: draft.id } })).resolves.toBeNull();
      expect(await db.orderItem.count()).toBe(0);
      expect(await packageCountForOrder(draft.id)).toBe(0);
      expect(await grantCountForOrder(draft.id)).toBe(0);
    });

    // ── Confirmed immutability: a second confirm (different key) is rejected

    it('refuses to re-confirm an already-confirmed order', async () => {
      if (!ctx) return;
      const { accountId, studentId, productId } = await seedCatalog();
      const draft = await createDraftFromProduct(productId, studentId, accountId);
      await confirmOrder(draft.id, 'confirm-once');

      // A DIFFERENT idempotency key (so the dedup fast-path does not apply)
      // still hits the state-machine guard → STATE_CHANGED (409).
      await expect(confirmOrder(draft.id, 'confirm-twice')).rejects.toMatchObject({
        code: 'STATE_CHANGED',
        httpStatus: 409,
      });
      // Still exactly one package + one grant.
      expect(await packageCountForOrder(draft.id)).toBe(1);
      expect(await grantCountForOrder(draft.id)).toBe(1);
    });

    // ── Rollback: a mid-confirm failure leaves no packages or grants ──────

    it('rolls back everything when the confirm work throws partway', async () => {
      if (!ctx) return;
      const { accountId, studentId, courseId } = await seedCatalog();
      // Two products → a two-item draft. We sabotage the SECOND item's package
      // create by pre-inserting a CoursePackage that claims its (soon-to-exist)
      // sourceOrderItemId, so the confirm's `tx.coursePackage.create` for that
      // item throws P2002 on the unique `sourceOrderItemId` index AFTER the
      // first item's package + grant have been written — proving the whole tx
      // rolls back (no packages, no grants, order stays PENDING).
      await seedCatalog({
        accountId,
        studentId,
        courseId,
        price: '50.00',
        productId: 'pp-2',
      });
      const draft = await orders.createDraft(
        {
          buyerAccountId: accountId,
          items: [
            { studentId, productId: 'pp-1' },
            { studentId, productId: 'pp-2' },
          ],
        },
        'admin-1',
      );
      const items = await db.orderItem.findMany({
        where: { orderId: draft.id },
        orderBy: { createdAt: 'asc' },
      });
      const secondItemId = items[1]!.id;
      // Pre-create a package that collides on the unique sourceOrderItemId.
      await db.coursePackage.create({
        data: {
          studentId,
          courseId,
          sourceType: 'ORDER',
          sourceOrderItemId: secondItemId,
          startsOn: new Date('2026-07-01T00:00:00.000Z'),
          expiresOn: new Date('2026-08-01T00:00:00.000Z'),
          granted: 0,
          available: 0,
          reserved: 0,
          consumed: 0,
          expired: 0,
          status: 'ACTIVE',
        },
      });

      // Confirm must roll back: the second item's package create fails, and the
      // first item's package + grant are undone with it.
      await expect(confirmOrder(draft.id, 'confirm-rollback')).rejects.toThrow();

      // The order's own packages (those with sourceOrderItemId pointing at its
      // items) must NOT exist — the rollback removed the first item's package.
      const orderPkgs = await db.coursePackage.findMany({
        where: { sourceOrderItemId: { in: items.map((i) => i.id) } },
      });
      // Only the pre-seeded collision package remains; the confirm created none.
      expect(orderPkgs).toHaveLength(1);
      expect(orderPkgs[0]!.sourceOrderItemId).toBe(secondItemId);
      // No grant transactions or allocations for this order's items.
      const keys = items.map((i) => `order-grant:${i.id}`);
      expect(await db.hourTransaction.count({ where: { businessKey: { in: keys } } })).toBe(0);
      expect(await db.hourAllocation.count({ where: { sourceId: { in: items.map((i) => i.id) } } })).toBe(0);
      // The order is still PENDING (the status flip was rolled back too).
      expect(await orderStatus(draft.id)).toBe(OFFLINE_ORDER_STATUS.PENDING);
    });

    // ── Idempotent reverse: same key twice → one reversal, REVERSED ───────

    it('is idempotent on reverse (same key runs the work once)', async () => {
      if (!ctx) return;
      const { accountId, studentId, productId } = await seedCatalog();
      const draft = await createDraftFromProduct(productId, studentId, accountId);
      await confirmOrder(draft.id, 'confirm-ir');

      const [first, second] = await Promise.all([
        reverseOrder(draft.id, 'reverse-idem'),
        reverseOrder(draft.id, 'reverse-idem'),
      ]);
      expect(first).toEqual(second);
      expect(await orderStatus(draft.id)).toBe(OFFLINE_ORDER_STATUS.REVERSED);
      // One GRANT + one REVERSAL transaction per item.
      expect(await grantCountForOrder(draft.id)).toBe(1);
      const reversals = await db.hourTransaction.count({
        where: { type: 'REVERSAL' },
      });
      expect(reversals).toBe(1);
    });

    // ── totalAmount is a precise Decimal across multiple items ────────────

    it('computes totalAmount as a Decimal sum of frozen unit prices', async () => {
      if (!ctx) return;
      const { accountId, studentId, courseId } = await seedCatalog({
        price: '100.10',
        productId: 'pp-1',
      });
      // A second product under the same course with a price whose 2dp sum
      // exercises decimal precision (100.10 + 200.20 = 300.30 — no float drift).
      await seedCatalog({
        accountId,
        studentId,
        courseId,
        price: '200.20',
        productId: 'pp-2',
      });
      const dto = await orders.createDraft(
        {
          buyerAccountId: accountId,
          items: [
            { studentId, productId: 'pp-1' },
            { studentId, productId: 'pp-2' },
          ],
        },
        'admin-1',
      );
      expect(dto.totalAmount).toBe('300.30');
      expect(dto.items).toHaveLength(2);
    });

    // ── Inclusive expiry: validDays-1 from the confirm date ───────────────

    it('computes inclusive expiry as validDays - 1 from the confirm date', async () => {
      if (!ctx) return;
      // validDays = 30; confirmed "now". The package's expiresOn should equal
      // calculateExpiryDate(now, 29) — i.e. Shanghai-today + 29 days.
      const { accountId, studentId, productId } = await seedCatalog({
        validDays: 30,
      });
      const draft = await createDraftFromProduct(productId, studentId, accountId);
      const before = Date.now();
      await confirmOrder(draft.id, 'confirm-expiry');
      const after = Date.now();

      const pkg = await db.coursePackage.findFirst({
        where: { sourceOrderItem: { orderId: draft.id } },
      });
      expect(pkg).not.toBeNull();
      // startsOn is the Shanghai date of the confirm instant.
      // expiresOn is Shanghai-confirm-date + 29 days (inclusive validDays=30).
      const expectedExpires = expiryForRange(before, after, 29);
      expect(pkg!.expiresOn.toISOString()).toBe(expectedExpires);
    });
  },
);

// ── Truncate helper ───────────────────────────────────────────────────────

async function truncateOrderTables(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(`SET FOREIGN_KEY_CHECKS = 0`);
  try {
    await db.$executeRawUnsafe(`TRUNCATE TABLE \`hour_allocation\``);
    await db.$executeRawUnsafe(`TRUNCATE TABLE \`hour_transaction\``);
    await db.$executeRawUnsafe(`TRUNCATE TABLE \`course_package\``);
    await db.$executeRawUnsafe(`TRUNCATE TABLE \`student_course_balance\``);
    await db.$executeRawUnsafe(`TRUNCATE TABLE \`order_item\``);
    await db.$executeRawUnsafe(`TRUNCATE TABLE \`offline_order\``);
    await db.$executeRawUnsafe(`TRUNCATE TABLE \`package_product\``);
    await db.$executeRawUnsafe(`TRUNCATE TABLE \`account_student_relation\``);
    await db.$executeRawUnsafe(`TRUNCATE TABLE \`student_profile\``);
    await db.$executeRawUnsafe(`TRUNCATE TABLE \`course\``);
    await db.$executeRawUnsafe(`TRUNCATE TABLE \`member_account\``);
    await db.$executeRawUnsafe(`TRUNCATE TABLE \`idempotency_record\``);
  } finally {
    await db.$executeRawUnsafe(`SET FOREIGN_KEY_CHECKS = 1`);
  }
}

/**
 * Compute the expected expiresOn (UTC midnight ISO) for a confirm that happened
 * somewhere inside [beforeMs, afterMs], using inclusive `validDays - 1` over
 * the Shanghai date. The confirm instant could fall on either side of the
 * Shanghai midnight boundary only if the window straddles 16:00 UTC, which the
 * test never does (it runs in well under a second) — so a single Shanghai date
 * is deterministic. We compute it for both endpoints and return the one that
 * matches, throwing if they disagree (which would indicate a boundary straddle
 * that would make the test flaky — worth surfacing).
 */
function expiryForRange(beforeMs: number, afterMs: number, minusDays: number): string {
  const a = shanghaiExpiry(new Date(beforeMs), minusDays);
  const b = shanghaiExpiry(new Date(afterMs), minusDays);
  if (a !== b) {
    throw new Error(
      `Shanghai date changed during confirm window (${a} vs ${b}); re-run the test.`,
    );
  }
  return a;
}

function shanghaiExpiry(utc: Date, minusDays: number): string {
  const ymd = calculateExpiryDate(utc, minusDays);
  return `${ymd}T00:00:00.000Z`;
}
