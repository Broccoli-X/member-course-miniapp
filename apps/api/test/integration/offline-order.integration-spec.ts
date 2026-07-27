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
import { BusinessError } from '../../src/common/errors/business-error.js';
import {
  OFFLINE_ORDER_STATUS,
  type CommandContext,
  type CreateOfflineOrderCommand,
} from '@member-course/contracts';
import { truncateAllTables } from '../helpers/truncate-all-tables.js';
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
      const ledger = new HourLedgerService(
        new HourLockRepository(),
        new IdempotencyService(dbAsService),
      );
      orders = new OfflineOrderService(dbAsService, idempotency, ledger);
      query = new OfflineOrderQueryService(dbAsService);
    });

    beforeEach(async () => {
      if (!ctx) return;
      await truncateAllTables(db);
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

    // ── Idempotent void replay: same key twice → BOTH 200 with equal bodies ─
    //
    // The bug being guarded against: void returned `void`, so
    // IdempotencyService wrote NULL to responseBody. A client retry (same key,
    // after the row was deleted) then failed the replay fast-path and re-ran
    // the work, whose findUnique returned null → 404. With a serializable
    // VoidDraftResult the cached response is non-null JSON, so the SECOND call
    // replays it instead of re-running — both calls return 200 with the same
    // {voided:true, orderId}. This is the documented idempotency contract.
    it('is idempotent on void: same key twice returns 200 both times with equal bodies', async () => {
      if (!ctx) return;
      const { accountId, studentId, productId } = await seedCatalog();
      const draft = await createDraftFromProduct(productId, studentId, accountId);

      // First void deletes the order. SEQUENTIAL — the second is a true replay
      // against an already-deleted row, not a concurrent in-flight dedup.
      const first = await orders.voidDraft(draft.id, adminContext('void-replay'));
      // The second call carries the SAME key. Before the fix this threw
      // RESOURCE_NOT_FOUND (the order was gone); now it replays the cached
      // marker → same body, 200-equivalent (no throw).
      const second = await orders.voidDraft(draft.id, adminContext('void-replay'));

      expect(first).toEqual({ voided: true, orderId: draft.id });
      expect(second).toEqual(first);
      // Order + items remain gone (the replay did NOT re-run any work).
      await expect(db.offlineOrder.findUnique({ where: { id: draft.id } })).resolves.toBeNull();
      expect(await db.orderItem.count()).toBe(0);
      // No idempotency-record re-execution left packages or grants behind.
      expect(await packageCountForOrder(draft.id)).toBe(0);
      expect(await grantCountForOrder(draft.id)).toBe(0);
    });

    // ── Different-key concurrency on the SAME order: exactly one wins ───────
    //
    // IdempotencyService only serializes the SAME-key case. Two operations on
    // the same order with DIFFERENT keys (confirm key-A + void key-B) would
    // otherwise both read PENDING under RR and race. The SELECT ... FOR UPDATE
    // record lock at the top of each *InTx serializes them: one completes, the
    // other re-reads the updated status and its state-machine guard rejects it
    // with a clean BusinessError (STATE_CHANGED), never a 500 / FK error. We
    // assert the disjunction: exactly one transition wins and the other fails
    // cleanly, with no partial state (no orphan packages/grants for a voided
    // order; no double-transition).
    it('serializes a different-key confirm + void on the same order (exactly one wins, no partial state)', async () => {
      if (!ctx) return;
      const { accountId, studentId, productId } = await seedCatalog();
      const draft = await createDraftFromProduct(productId, studentId, accountId);

      // Fire confirm (key-A) and void (key-B) CONCURRENTLY on the same order.
      const confirmP = confirmOrder(draft.id, 'concurrent-confirm').then(
        (dto) => ({ ok: true as const, dto }),
        (err: unknown) => ({ ok: false as const, err }),
      );
      const voidP = orders.voidDraft(draft.id, adminContext('concurrent-void')).then(
        (dto) => ({ ok: true as const, dto }),
        (err: unknown) => ({ ok: false as const, err }),
      );
      const [confirmResult, voidResult] = await Promise.all([confirmP, voidP]);

      // Exactly one wins.
      expect(confirmResult.ok === voidResult.ok).toBe(false);

      // The loser fails with a CLEAN BusinessError — never a 500 or a Prisma/FK
      // error. The exact code depends on which operation won:
      //  - confirm won → the order is CONFIRMED, so the void loser's
      //    assertCanVoid(CONFIRMED) throws STATE_CHANGED (409);
      //  - void won → the order row is DELETED, so the confirm loser's
      //    SELECT ... FOR UPDATE finds nothing → RESOURCE_NOT_FOUND (404).
      // Both are clean client errors; that is the contract being verified (the
      // pre-fix race would produce a 500 / FK fallout or a double-transition).
      const loser = confirmResult.ok ? voidResult : confirmResult;
      expect(loser.ok).toBe(false);
      const loserErr = (loser as { ok: false; err: unknown }).err;
      // Surface a non-BusinessError for diagnosis during the fix; the contract
      // is that the loser is ALWAYS a clean BusinessError (< 500).
      if (!(loserErr instanceof BusinessError)) {
        throw new Error(
          `loser was not a clean BusinessError; got: ${loserErr instanceof Error ? `${loserErr.name}: ${loserErr.message}` : String(loserErr)}`,
        );
      }
      const code = loserErr.code;
      const httpStatus = loserErr.httpStatus;
      expect(['STATE_CHANGED', 'RESOURCE_NOT_FOUND']).toContain(code);
      expect([409, 404]).toContain(httpStatus);
      // Explicitly NOT a server error.
      expect(httpStatus).toBeLessThan(500);

      // No partial state: if confirm won, the order is CONFIRMED with exactly
      // one package + one grant; if void won, the order + items are gone and
      // there are zero packages + zero grants.
      if (confirmResult.ok) {
        expect(await orderStatus(draft.id)).toBe(OFFLINE_ORDER_STATUS.CONFIRMED);
        expect(await packageCountForOrder(draft.id)).toBe(1);
        expect(await grantCountForOrder(draft.id)).toBe(1);
      } else {
        await expect(db.offlineOrder.findUnique({ where: { id: draft.id } })).resolves.toBeNull();
        expect(await db.orderItem.count()).toBe(0);
        expect(await packageCountForOrder(draft.id)).toBe(0);
        expect(await grantCountForOrder(draft.id)).toBe(0);
      }
    });
  },
);

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
