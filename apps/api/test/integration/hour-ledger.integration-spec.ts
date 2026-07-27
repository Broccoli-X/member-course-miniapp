import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Prisma } from '../../src/generated/prisma/client.js';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { getMysqlContext, type MysqlTestContext } from '../helpers/mysql-test-environment.js';
import { HourLedgerService } from '../../src/modules/hours/application/hour-ledger.service.js';
import { HourLockRepository } from '../../src/modules/hours/infrastructure/hour-lock.repository.js';
import { IdempotencyService } from '../../src/common/idempotency/idempotency.service.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import {
  HOUR_TRANSACTION_TYPE,
  type GrantOrderHoursInput,
  type HourPostingResult,
} from '@member-course/contracts';
import { truncateAllTables } from '../helpers/truncate-all-tables.js';

/**
 * Hour-ledger integration tests (Task 8 brief, Steps 1 & 4 verbatim cases plus
 * the invariants the brief enumerates).
 *
 * Runs against the real MySQL test DB via {@link getMysqlContext} (gated on
 * `RUN_INTEGRATION`). The {@link HourLedgerService} is constructed with a real
 * {@link HourLockRepository} and driven through a real `PrismaClient`
 * `$transaction` — so every assertion exercises actual InnoDB row locks
 * (`SELECT ... FOR UPDATE`), the unique `businessKey` index, and the
 * append-only transaction/allocation tables.
 *
 * The brief's verbatim reconcilability case:
 *   grant 2.00 → result.balance.available === '2.00' AND
 *                 Σ HourTransaction.availableDelta === '2.00'
 *
 * Plus: FEFO ordering under real DB rows, decimal precision (0.10 + 0.20 =
 * 0.30, no float drift), idempotent grant and reversal, rollback on mid-tx
 * failure, reversal correctness, and three concurrency cases (two distinct
 * businessKeys both succeed; same businessKey → one wins; concurrent
 * first-grant → no deadlock, single balance row).
 */
describe.skipIf(!process.env.RUN_INTEGRATION)(
  'Hour ledger (integration, real MySQL)',
  () => {
    let ctx: MysqlTestContext | null;
    let db: PrismaClient;
    let ledger: HourLedgerService;

    beforeAll(async () => {
      ctx = await getMysqlContext();
      if (!ctx) return;
      db = new PrismaClient({ datasources: { db: { url: ctx.databaseUrl } } });
      const dbAsService = db as unknown as PrismaService;
      ledger = new HourLedgerService(
        new HourLockRepository(),
        new IdempotencyService(dbAsService),
      );
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

    /** Seed the member/student/course/order/order-item/package prerequisites for a grant. */
    async function seedStudentCourseOrder(opts?: {
      studentId?: string;
      courseId?: string;
      orderItemId?: string;
      packageId?: string;
      expiresOn?: Date;
    }): Promise<{
      studentId: string;
      courseId: string;
      orderItemId: string;
      packageId: string;
    }> {
      const studentId = opts?.studentId ?? 'stu-1';
      const courseId = opts?.courseId ?? 'crs-1';
      const orderItemId = opts?.orderItemId ?? 'oi-1';
      const packageId = opts?.packageId ?? 'pkg-1';

      await db.memberAccount.upsert({
        where: { id: 'acc-1' },
        update: {},
        create: { id: 'acc-1', normalizedPhone: '13800000001' },
      });
      await db.studentProfile.upsert({
        where: { id: studentId },
        update: {},
        create: { id: studentId, displayName: '小明' },
      });
      await db.accountStudentRelation.upsert({
        where: { accountId_studentId: { accountId: 'acc-1', studentId } },
        update: {},
        create: { accountId: 'acc-1', studentId, relationType: 'PARENT' },
      });
      await db.course.upsert({
        where: { id: courseId },
        update: {},
        create: { id: courseId, name: '编程', type: 'CLASS', description: 'd' },
      });
      await db.packageProduct.upsert({
        where: { id: 'pp-1' },
        update: {},
        create: { id: 'pp-1', courseId, name: 'p', price: 100, hours: 10, validDays: 90 },
      });
      await db.offlineOrder.upsert({
        where: { id: 'ord-1' },
        update: {},
        create: {
          id: 'ord-1',
          buyerAccountId: 'acc-1',
          status: 'CONFIRMED',
          totalAmount: 100,
          confirmedAt: new Date(),
        },
      });
      await db.orderItem.upsert({
        where: { id: orderItemId },
        update: {},
        create: {
          id: orderItemId,
          orderId: 'ord-1',
          studentId,
          productId: 'pp-1',
          courseId,
          productNameSnapshot: 'p',
          unitPriceSnapshot: 100,
          hoursSnapshot: 10,
          validDaysSnapshot: 90,
        },
      });
      // The grant path expects the CoursePackage to already exist (the caller
      // creates it; in M1 the Orders module will). Seed it here.
      const starts = new Date('2026-07-01T00:00:00.000Z');
      const expires = opts?.expiresOn ?? new Date('2026-09-30T00:00:00.000Z');
      await db.coursePackage.upsert({
        where: { id: packageId },
        update: {
          startsOn: starts,
          expiresOn: expires,
          sourceOrderItemId: orderItemId,
        },
        create: {
          id: packageId,
          studentId,
          courseId,
          sourceType: 'ORDER',
          sourceOrderItemId: orderItemId,
          startsOn: starts,
          expiresOn: expires,
          granted: 0,
          available: 0,
          reserved: 0,
          consumed: 0,
          expired: 0,
          status: 'ACTIVE',
        },
      });

      return { studentId, courseId, orderItemId, packageId };
    }

    /** Build a GrantOrderHoursInput with sensible defaults. */
    function orderGrantInput(
      overrides: Partial<GrantOrderHoursInput> & Pick<GrantOrderHoursInput, 'units'>,
    ): GrantOrderHoursInput {
      return {
        orderId: 'ord-1',
        orderItemId: 'oi-1',
        studentId: 'stu-1',
        courseId: 'crs-1',
        packageId: 'pkg-1',
        occurredAt: new Date('2026-07-15T00:00:00.000Z'),
        businessKey: `order-grant:${overrides.orderItemId ?? 'oi-1'}:${overrides.units}`,
        ...overrides,
      };
    }

    /** Run a posting inside a real transaction (mirrors how the Orders module will call us). */
    async function grantInTx(input: GrantOrderHoursInput): Promise<HourPostingResult> {
      return db.$transaction((tx) => ledger.grantOrder(tx, input));
    }
    /**
     * Run a posting with P2002 retry. Models how the production caller
     * (`IdempotencyService`) handles a racing-same-businessKey insert: the
     * loser's `$transaction` rolls back on P2002 (the tx is poisoned once the
     * unique violation fires); the wrapper retries, and the retry's
     * `findUnique` fast-path returns the original result. Without this
     * wrapper the loser would surface P2002 — which is the documented
     * contract for the racing-same-key case (see HourLedgerService doc).
     */
    async function grantInTxWithRetry(input: GrantOrderHoursInput): Promise<HourPostingResult> {
      for (let attempt = 0; ; attempt++) {
        try {
          return await grantInTx(input);
        } catch (err) {
          if (isP2002(err) && attempt < 5) continue;
          throw err;
        }
      }
    }
    async function reverseInTx(input: {
      orderId: string;
      orderItemId: string;
      originalTransactionId: string;
      occurredAt: Date;
      businessKey: string;
      reason: string;
    }): Promise<HourPostingResult> {
      return db.$transaction((tx) => ledger.reverseOrder(tx, input));
    }

    /** Σ of HourTransaction.availableDelta for (student, course), as a 2-dp string. */
    async function sumAvailableTransactionDeltas(
      studentId: string,
      courseId: string,
    ): Promise<string> {
      const rows = await db.hourTransaction.findMany({
        where: { studentId, courseId },
        select: { availableDelta: true },
      });
      const sum = rows.reduce(
        (acc, r) => acc.plus(r.availableDelta),
        new Prisma.Decimal('0.00'),
      );
      return sum.toFixed(2);
    }

    // ── Brief verbatim case: reconcilable single grant ──────────────────

    it('posts one order grant and keeps the balance reconcilable', async () => {
      if (!ctx) return;
      await seedStudentCourseOrder();
      const result = await grantInTx(orderGrantInput({ units: '2.00' }));

      expect(result.balance.available).toBe('2.00');
      // The core accounting invariant: balance === Σ transaction deltas.
      expect(await sumAvailableTransactionDeltas('stu-1', 'crs-1')).toBe('2.00');

      // One transaction, one allocation, balance row present.
      const txs = await db.hourTransaction.findMany({ where: { studentId: 'stu-1' } });
      expect(txs).toHaveLength(1);
      expect(txs[0]!.type).toBe(HOUR_TRANSACTION_TYPE.GRANT);
      const allocations = await db.hourAllocation.findMany({});
      expect(allocations).toHaveLength(1);
      expect(allocations[0]!.packageId).toBe('pkg-1');
      const balance = await db.studentCourseBalance.findUnique({
        where: { studentId_courseId: { studentId: 'stu-1', courseId: 'crs-1' } },
      });
      expect(balance).not.toBeNull();
      expect(balance!.available.toFixed(2)).toBe('2.00');
    });

    // ── Decimal precision (no float drift) ──────────────────────────────

    it('keeps exact decimal precision across multiple grants (0.10 + 0.20 = 0.30)', async () => {
      if (!ctx) return;
      await seedStudentCourseOrder({ packageId: 'pkg-a' });
      // Grant 0.10 into pkg-a, then 0.20 into pkg-b (a second package for the
      // same student+course). Both land in `available`; the sum must be
      // exactly 0.30 with no binary-float drift.
      await seedStudentCourseOrder({
        packageId: 'pkg-b',
        orderItemId: 'oi-2',
        expiresOn: new Date('2026-10-31T00:00:00.000Z'),
      });
      await grantInTx(
        orderGrantInput({ units: '0.10', packageId: 'pkg-a', orderItemId: 'oi-1' }),
      );
      await grantInTx(
        orderGrantInput({ units: '0.20', packageId: 'pkg-b', orderItemId: 'oi-2' }),
      );

      const balance = await db.studentCourseBalance.findUnique({
        where: { studentId_courseId: { studentId: 'stu-1', courseId: 'crs-1' } },
      });
      expect(balance!.available.toFixed(2)).toBe('0.30');
      expect(await sumAvailableTransactionDeltas('stu-1', 'crs-1')).toBe('0.30');
    });

    // ── FEFO ordering under the real DB ─────────────────────────────────

    it('locks and allocates packages in FEFO order', async () => {
      if (!ctx) return;
      // Two packages for the same student+course with different expiries.
      await seedStudentCourseOrder({ packageId: 'pkg-late', orderItemId: 'oi-late',
        expiresOn: new Date('2026-09-30T00:00:00.000Z') });
      await seedStudentCourseOrder({ packageId: 'pkg-early', orderItemId: 'oi-early',
        expiresOn: new Date('2026-08-31T00:00:00.000Z') });

      // Grant into each.
      const early = await grantInTx(
        orderGrantInput({ units: '2.00', packageId: 'pkg-early', orderItemId: 'oi-early' }),
      );
      const late = await grantInTx(
        orderGrantInput({ units: '3.00', packageId: 'pkg-late', orderItemId: 'oi-late' }),
      );
      expect(early.allocations[0]!.packageExpiresOn).toBe('2026-08-31');
      expect(late.allocations[0]!.packageExpiresOn).toBe('2026-09-30');

      // Reverse the early grant — the reversal's allocation must land on the
      // SAME package the original grant touched (pkg-early), restoring its
      // buckets. pkg-late is untouched.
      const reversal = await reverseInTx({
        orderId: 'ord-1',
        orderItemId: 'oi-early',
        originalTransactionId: early.transactionId,
        occurredAt: new Date('2026-07-20T00:00:00.000Z'),
        businessKey: `order-reverse:oi-early`,
        reason: 'cancel early',
      });
      expect(reversal.allocations[0]!.packageId).toBe('pkg-early');
      expect(reversal.balance.available).toBe('3.00'); // 2 - 2 + 3
      expect(await sumAvailableTransactionDeltas('stu-1', 'crs-1')).toBe('3.00');

      const earlyPkg = await db.coursePackage.findUnique({ where: { id: 'pkg-early' } });
      expect(earlyPkg!.available.toFixed(2)).toBe('0.00'); // restored
      const latePkg = await db.coursePackage.findUnique({ where: { id: 'pkg-late' } });
      expect(latePkg!.available.toFixed(2)).toBe('3.00'); // untouched
    });

    // ── Idempotent grant (same businessKey twice) ───────────────────────

    it('is idempotent on grant businessKey (no duplicate transaction, no double-count)', async () => {
      if (!ctx) return;
      await seedStudentCourseOrder();
      const input = orderGrantInput({ units: '5.00', businessKey: 'order-grant:oi-1:stable' });

      const first = await grantInTx(input);
      const second = await grantInTx(input);

      // Same transaction id, no duplicate row.
      expect(second.transactionId).toBe(first.transactionId);
      const txs = await db.hourTransaction.findMany({});
      expect(txs).toHaveLength(1);
      // Balance unchanged on the second call (no double credit).
      expect(second.balance.available).toBe('5.00');
      expect(await sumAvailableTransactionDeltas('stu-1', 'crs-1')).toBe('5.00');
      // Allocations also deduped.
      const allocations = await db.hourAllocation.findMany({});
      expect(allocations).toHaveLength(1);
    });

    // ── Idempotent reversal (same businessKey twice) ────────────────────

    it('is idempotent on reversal businessKey', async () => {
      if (!ctx) return;
      await seedStudentCourseOrder();
      const grant = await grantInTx(orderGrantInput({ units: '4.00' }));

      const reverseInput = {
        orderId: 'ord-1',
        orderItemId: 'oi-1',
        originalTransactionId: grant.transactionId,
        occurredAt: new Date('2026-07-20T00:00:00.000Z'),
        businessKey: 'order-reverse:oi-1:stable',
        reason: 'cancel',
      };
      const first = await reverseInTx(reverseInput);
      const second = await reverseInTx(reverseInput);

      expect(second.transactionId).toBe(first.transactionId);
      // Two transactions total: the grant + one reversal (NOT two reversals).
      const txs = await db.hourTransaction.findMany({ orderBy: { createdAt: 'asc' } });
      expect(txs).toHaveLength(2);
      expect(txs.map((t) => t.type).sort()).toEqual(['GRANT', 'REVERSAL']);
      // Balance net-zero (4 granted, 4 reversed).
      expect(second.balance.available).toBe('0.00');
      expect(await sumAvailableTransactionDeltas('stu-1', 'crs-1')).toBe('0.00');
    });

    // ── Rollback: a mid-tx failure leaves no partial writes ─────────────

    it('rolls back the whole posting when the caller throws inside the tx', async () => {
      if (!ctx) return;
      await seedStudentCourseOrder();

      // Wrap grant + an explicit throw in one tx. Prisma aborts the tx → no
      // transaction/allocation/balance/package writes should persist.
      await expect(
        db.$transaction(async (tx) => {
          await ledger.grantOrder(tx, orderGrantInput({ units: '7.00' }));
          throw new Error('caller abort');
        }),
      ).rejects.toThrow('caller abort');

      const txs = await db.hourTransaction.findMany({});
      expect(txs).toHaveLength(0);
      const allocations = await db.hourAllocation.findMany({});
      expect(allocations).toHaveLength(0);
      // Balance row may have been created by lockBalance's upsert before the
      // rollback, but the rollback should UNDO that too. Verify it's gone (or
      // zeroed — either is acceptable; what matters is no partial delta).
      const balance = await db.studentCourseBalance.findUnique({
        where: { studentId_courseId: { studentId: 'stu-1', courseId: 'crs-1' } },
      });
      expect(balance).toBeNull();
    });

    // ── Reversal negates deltas; original untouched ─────────────────────

    it('reverses a grant by appending a negated transaction (original untouched)', async () => {
      if (!ctx) return;
      await seedStudentCourseOrder();
      const grant = await grantInTx(orderGrantInput({ units: '6.00' }));
      const grantRow = await db.hourTransaction.findUnique({
        where: { id: grant.transactionId },
      });
      expect(grantRow!.availableDelta.toFixed(2)).toBe('6.00');

      const reversal = await reverseInTx({
        orderId: 'ord-1',
        orderItemId: 'oi-1',
        originalTransactionId: grant.transactionId,
        occurredAt: new Date('2026-07-21T00:00:00.000Z'),
        businessKey: 'order-reverse:oi-1:solo',
        reason: 'refund',
      });
      expect(reversal.balance.available).toBe('0.00');
      // The reversal's deltas are the negation of the grant's.
      const reversalRow = await db.hourTransaction.findUnique({
        where: { id: reversal.transactionId },
      });
      expect(reversalRow!.type).toBe(HOUR_TRANSACTION_TYPE.REVERSAL);
      expect(reversalRow!.availableDelta.toFixed(2)).toBe('-6.00');

      // The original transaction is UNCHANGED (append-only — never mutated).
      const grantRowAfter = await db.hourTransaction.findUnique({
        where: { id: grant.transactionId },
      });
      expect(grantRowAfter!.availableDelta.toFixed(2)).toBe('6.00');
      expect(grantRowAfter!.type).toBe(HOUR_TRANSACTION_TYPE.GRANT);
      // Reconciles: +6 + (-6) = 0.
      expect(await sumAvailableTransactionDeltas('stu-1', 'crs-1')).toBe('0.00');
    });

    // ── Reversal persists originalTransactionId; grant row has null ──────

    it('persists originalTransactionId on the REVERSAL row (and null on the grant)', async () => {
      if (!ctx) return;
      await seedStudentCourseOrder();
      const grant = await grantInTx(orderGrantInput({ units: '6.00' }));

      // The GRANT row has no original (the column is NULL for non-reversal
      // types).
      const grantRow = await db.hourTransaction.findUnique({
        where: { id: grant.transactionId },
        select: { originalTransactionId: true, type: true },
      });
      expect(grantRow!.type).toBe(HOUR_TRANSACTION_TYPE.GRANT);
      expect(grantRow!.originalTransactionId).toBeNull();

      const reversal = await reverseInTx({
        orderId: 'ord-1',
        orderItemId: 'oi-1',
        originalTransactionId: grant.transactionId,
        occurredAt: new Date('2026-07-21T00:00:00.000Z'),
        businessKey: 'order-reverse:oi-1:link',
        reason: 'audit-link',
      });

      // The REVERSAL row carries the auditable link back to the grant: given
      // just the reversal row you can query which grant it undid, without
      // parsing businessKey/reason text.
      const reversalRow = await db.hourTransaction.findUnique({
        where: { id: reversal.transactionId },
        select: { originalTransactionId: true, type: true },
      });
      expect(reversalRow!.type).toBe(HOUR_TRANSACTION_TYPE.REVERSAL);
      expect(reversalRow!.originalTransactionId).toBe(grant.transactionId);

      // The link is queryable: "find all reversals of this grant".
      const reversalsOfGrant = await db.hourTransaction.findMany({
        where: { originalTransactionId: grant.transactionId },
      });
      expect(reversalsOfGrant).toHaveLength(1);
      expect(reversalsOfGrant[0]!.id).toBe(reversal.transactionId);
    });

    // ── Concurrency: two distinct businessKeys both succeed ─────────────

    it('serializes two concurrent grants with distinct businessKeys (both land, balance reconciles)', async () => {
      if (!ctx) return;
      await seedStudentCourseOrder({ packageId: 'pkg-c1', orderItemId: 'oi-c1' });
      await seedStudentCourseOrder({
        packageId: 'pkg-c2',
        orderItemId: 'oi-c2',
        expiresOn: new Date('2026-10-15T00:00:00.000Z'),
      });

      const [r1, r2] = await Promise.all([
        grantInTx(
          orderGrantInput({ units: '1.00', packageId: 'pkg-c1', orderItemId: 'oi-c1',
            businessKey: 'order-grant:oi-c1' }),
        ),
        grantInTx(
          orderGrantInput({ units: '2.00', packageId: 'pkg-c2', orderItemId: 'oi-c2',
            businessKey: 'order-grant:oi-c2' }),
        ),
      ]);

      // Both succeeded, distinct transaction ids.
      expect(r1.transactionId).not.toBe(r2.transactionId);
      // Final balance is the sum (1 + 2 = 3), and it reconciles.
      expect(await sumAvailableTransactionDeltas('stu-1', 'crs-1')).toBe('3.00');
      const balance = await db.studentCourseBalance.findUnique({
        where: { studentId_courseId: { studentId: 'stu-1', courseId: 'crs-1' } },
      });
      expect(balance!.available.toFixed(2)).toBe('3.00');
      // Two transactions, two allocations.
      expect(await db.hourTransaction.count()).toBe(2);
      expect(await db.hourAllocation.count()).toBe(2);
    });

    // ── Concurrency: same businessKey → one wins, other idempotent ──────

    it('deduplicates two concurrent grants with the SAME businessKey (one wins, one idempotent)', async () => {
      if (!ctx) return;
      await seedStudentCourseOrder();
      const input = orderGrantInput({
        units: '5.00',
        businessKey: 'order-grant:oi-1:race',
      });

      // Use the retry wrapper — the racing-same-key loser's tx rolls back on
      // P2002 (poisoned tx); the wrapper retries and the findUnique fast-path
      // returns the winner's result. Mirrors IdempotencyService in production.
      const [r1, r2] = await Promise.all([
        grantInTxWithRetry(input),
        grantInTxWithRetry(input),
      ]);

      // Exactly one transaction row; both calls return the same id.
      expect(await db.hourTransaction.count()).toBe(1);
      expect(r1.transactionId).toBe(r2.transactionId);
      // No double credit.
      expect(await sumAvailableTransactionDeltas('stu-1', 'crs-1')).toBe('5.00');
      expect(await db.hourAllocation.count()).toBe(1);
    });

    // ── Concurrency: first-grant (no balance row) → no deadlock ─────────

    it('does not deadlock on two concurrent FIRST grants (balance row absent) — one balance row created', async () => {
      if (!ctx) return;
      // Seed only the FK prerequisites — DO NOT pre-create the balance row.
      // Both calls will hit the create-or-lock path simultaneously.
      await seedStudentCourseOrder({ packageId: 'pkg-f1', orderItemId: 'oi-f1' });
      await seedStudentCourseOrder({
        packageId: 'pkg-f2',
        orderItemId: 'oi-f2',
        expiresOn: new Date('2026-11-01T00:00:00.000Z'),
      });

      const [r1, r2] = await Promise.all([
        grantInTx(
          orderGrantInput({ units: '1.50', packageId: 'pkg-f1', orderItemId: 'oi-f1',
            businessKey: 'order-grant:oi-f1' }),
        ),
        grantInTx(
          orderGrantInput({ units: '2.50', packageId: 'pkg-f2', orderItemId: 'oi-f2',
            businessKey: 'order-grant:oi-f2' }),
        ),
      ]);

      // Both succeeded (no deadlock victim). Exactly one balance row exists.
      expect(r1.balanceId).toBe(r2.balanceId);
      const balanceRows = await db.studentCourseBalance.findMany({
        where: { studentId: 'stu-1', courseId: 'crs-1' },
      });
      expect(balanceRows).toHaveLength(1);
      // Reconciles: 1.5 + 2.5 = 4.0.
      expect(balanceRows[0]!.available.toFixed(2)).toBe('4.00');
      expect(await sumAvailableTransactionDeltas('stu-1', 'crs-1')).toBe('4.00');
    });

    // ── Append-only invariant: no update/delete paths exist on the schema ─

    it('exposes only the two append operations on its public surface (no update/delete)', async () => {
      if (!ctx) return;
      // The PUBLIC surface of the ledger (the methods the Orders/Adjustments
      // modules call) is grantOrder + reverseOrder — both appenders. Assert
      // the prototype contains NO mutator-named methods (update*/delete*) that
      // would violate append-only. We don't enumerate the full method list
      // (private helpers like applyPosting are implementation detail); we
      // scan for forbidden verbs instead.
      const proto = Object.getPrototypeOf(ledger);
      const allNames = new Set<string>();
      for (const name of Object.getOwnPropertyNames(proto)) {
        allNames.add(name);
      }
      const forbidden = [...allNames].filter((n) =>
        /update|delete|remove|truncate/i.test(n),
      );
      expect(forbidden).toEqual([]);

      // The two public entry points exist.
      expect(typeof ledger.grantOrder).toBe('function');
      expect(typeof ledger.reverseOrder).toBe('function');
    });
  },
);

// ── Truncate helper ─────────────────────────────────────────────────────

/**
 * Truncate the hour-ledger tables and their FK parents between tests. The
 * hours tables reference student_profile / course / order_item / course_package,
 * so we clear children first, then parents, with FK checks disabled. The
 * shared {@link truncateAllTables} helper performs the full-DB version.
 */

/** True when `err` is a Prisma P2002 (unique-constraint violation). */
function isP2002(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { code?: string }).code === 'P2002';
}
