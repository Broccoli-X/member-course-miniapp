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
  type CommandContext,
} from '@member-course/contracts';
import { truncateAllTables } from '../helpers/truncate-all-tables.js';

/**
 * Manual-hour-adjustment integration tests (Task 10 brief, Step 1 verbatim
 * cases plus the invariants the brief enumerates).
 *
 * Runs against the real MySQL test DB via {@link getMysqlContext} (gated on
 * `RUN_INTEGRATION`). The {@link HourLedgerService} is constructed with a real
 * {@link HourLockRepository} and a real {@link IdempotencyService}, driven
 * through real `PrismaService.$transaction` calls — so every assertion
 * exercises actual InnoDB row locks, the unique `businessKey` index, and the
 * FEFO allocator against real package rows.
 *
 * The brief's verbatim cases:
 *   1. "creates a separate MANUAL package and requires a reason"
 *   2. "allows only one concurrent debit of the final hours"
 *
 * Plus: grant→debit happy path (FEFO), negative protection (debit > available
 * → INSUFFICIENT_HOURS), Decimal precision, idempotent grant/debit (same key
 * twice → one transaction).
 */
describe.skipIf(!process.env.RUN_INTEGRATION)(
  'Manual hour adjustments (integration, real MySQL)',
  () => {
    let ctx: MysqlTestContext | null;
    let db: PrismaClient;
    let ledger: HourLedgerService;
    const STUDENT_ID = 'stu-ma';
    const COURSE_ID = 'crs-ma';

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
      await seedStudentCourse();
    });

    afterAll(async () => {
      if (db) await db.$disconnect();
      if (ctx) await ctx.cleanup();
    });

    // ── Helpers ──────────────────────────────────────────────────────────

    async function seedStudentCourse(opts?: {
      studentId?: string;
      courseId?: string;
    }): Promise<void> {
      const studentId = opts?.studentId ?? STUDENT_ID;
      const courseId = opts?.courseId ?? COURSE_ID;
      await db.memberAccount.upsert({
        where: { id: 'acc-ma' },
        update: {},
        create: { id: 'acc-ma', normalizedPhone: '13800000010' },
      });
      await db.studentProfile.upsert({
        where: { id: studentId },
        update: {},
        create: { id: studentId, displayName: '小调整' },
      });
      await db.accountStudentRelation.upsert({
        where: { accountId_studentId: { accountId: 'acc-ma', studentId } },
        update: {},
        create: { accountId: 'acc-ma', studentId, relationType: 'PARENT' },
      });
      await db.course.upsert({
        where: { id: courseId },
        update: {},
        create: { id: courseId, name: '调整课', type: 'CLASS', description: 'd' },
      });
    }

    function adminContext(key: string): CommandContext {
      return {
        actorType: 'ADMIN',
        actorId: 'admin-1',
        requestId: 'test-trace-ma',
        idempotencyKey: key,
      };
    }

    /**
     * The latest CoursePackage row for the (student, course), ordered newest-first
     * by createdAt. Decimal columns are normalized to 2-dp strings so the brief's
     * verbatim `toMatchObject({ sourceType: 'MANUAL', granted: '2.00' })` passes
     * regardless of how Prisma's Decimal `toString()` renders trailing zeros.
     * Mirrors what the brief's `latestPackage()` helper returns.
     */
    async function latestPackage(
      studentId: string = STUDENT_ID,
      courseId: string = COURSE_ID,
    ) {
      const rows = await db.coursePackage.findMany({
        where: { studentId, courseId },
        orderBy: { createdAt: 'desc' },
      });
      const r = rows[0];
      if (!r) return undefined;
      return {
        ...r,
        granted: r.granted.toFixed(2),
        available: r.available.toFixed(2),
        reserved: r.reserved.toFixed(2),
        consumed: r.consumed.toFixed(2),
        expired: r.expired.toFixed(2),
      };
    }

    async function availableBalance(
      studentId: string = STUDENT_ID,
      courseId: string = COURSE_ID,
    ): Promise<string> {
      const bal = await db.studentCourseBalance.findUnique({
        where: { studentId_courseId: { studentId, courseId } },
      });
      return bal ? bal.available.toFixed(2) : '0.00';
    }

    // ── Brief verbatim case 1: creates a separate MANUAL package + reason ─

    it('creates a separate MANUAL package and requires a reason', async () => {
      if (!ctx) return;
      await ledger.grantManual(
        {
          studentId: STUDENT_ID,
          courseId: COURSE_ID,
          units: '2.00',
          startsOn: '2026-07-23',
          expiresOn: '2026-08-31',
          reason: '补课',
        },
        adminContext('grant-1'),
      );
      const latest = await latestPackage();
      expect(latest).toMatchObject({ sourceType: 'MANUAL', granted: '2.00' });
      expect(latest!.available).toBe('2.00');

      // A blank reason is rejected before any write (400 VALIDATION_FAILED).
      await expect(
        ledger.grantManual(
          {
            studentId: STUDENT_ID,
            courseId: COURSE_ID,
            units: '1.00',
            startsOn: '2026-07-23',
            expiresOn: '2026-08-31',
            reason: '   ',
          },
          adminContext('grant-blank'),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', httpStatus: 400 });
      // No second package should have been created by the rejected call.
      const packages = await db.coursePackage.findMany({
        where: { studentId: STUDENT_ID, courseId: COURSE_ID },
      });
      expect(packages).toHaveLength(1);
    });

    // ── Brief verbatim case 2: only one concurrent debit of final hours ──

    it('allows only one concurrent debit of the final hours', async () => {
      if (!ctx) return;
      // Seed exactly 2.00 available via a manual grant.
      await ledger.grantManual(
        {
          studentId: STUDENT_ID,
          courseId: COURSE_ID,
          units: '2.00',
          startsOn: '2026-07-23',
          expiresOn: '2026-08-31',
          reason: 'seed',
        },
        adminContext('grant-concurrent'),
      );
      expect(await availableBalance()).toBe('2.00');

      // Two concurrent debits of the full 2.00 with DIFFERENT keys. The row
      // lock on the balance serializes them; the loser's locking read observes
      // available=0 (after the winner commits) and rejects INSUFFICIENT_HOURS.
      // Exactly ONE fulfills.
      const results = await Promise.allSettled([
        ledger.debitManual(
          { studentId: STUDENT_ID, courseId: COURSE_ID, units: '2.00', reason: 'first' },
          adminContext('key-1'),
        ),
        ledger.debitManual(
          { studentId: STUDENT_ID, courseId: COURSE_ID, units: '2.00', reason: 'second' },
          adminContext('key-2'),
        ),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(rejected).toHaveLength(1);
      // The rejected one is INSUFFICIENT_HOURS (409).
      await expect(rejected[0]!.reason).toMatchObject({
        code: 'INSUFFICIENT_HOURS',
        httpStatus: 409,
      });
      // Final available balance is exactly 0.00 — not negative, not 2.00.
      expect(await availableBalance()).toBe('0.00');
    });

    // ── Grant → debit happy path (FEFO across multiple packages) ─────────

    it('distributes a manual debit across packages via FEFO (earliest-expiring first)', async () => {
      if (!ctx) return;
      // Two manual packages with different expiries. The earlier-expiring one
      // must be drawn down first.
      const early = await ledger.grantManual(
        {
          studentId: STUDENT_ID,
          courseId: COURSE_ID,
          units: '3.00',
          startsOn: '2026-07-23',
          expiresOn: '2026-08-15',
          reason: 'early pkg',
        },
        adminContext('grant-early'),
      );
      const late = await ledger.grantManual(
        {
          studentId: STUDENT_ID,
          courseId: COURSE_ID,
          units: '4.00',
          startsOn: '2026-07-23',
          expiresOn: '2026-09-30',
          reason: 'late pkg',
        },
        adminContext('grant-late'),
      );
      expect(early.allocations[0]!.packageExpiresOn).toBe('2026-08-15');
      expect(late.allocations![0]!.packageExpiresOn).toBe('2026-09-30');
      expect(await availableBalance()).toBe('7.00');

      // Debit 5.00: FEFO draws the full 3.00 from early + 2.00 from late.
      const debit = await ledger.debitManual(
        { studentId: STUDENT_ID, courseId: COURSE_ID, units: '5.00', reason: 'consume FEFO' },
        adminContext('debit-fefo'),
      );
      expect(debit.balance.available).toBe('2.00');

      // Two allocation slices — one per package, ordered earliest-first.
      expect(debit.allocations).toHaveLength(2);
      const [earlySlice, lateSlice] = debit.allocations;
      expect(earlySlice!.packageExpiresOn).toBe('2026-08-15');
      expect(earlySlice!.availableDelta).toBe('-3.00');
      expect(lateSlice!.packageExpiresOn).toBe('2026-09-30');
      expect(lateSlice!.availableDelta).toBe('-2.00');

      // The earliest-expiring package is fully drained; the later one keeps 2.
      const earlyPkg = await db.coursePackage.findUnique({
        where: { id: early.allocations[0]!.packageId },
      });
      const latePkg = await db.coursePackage.findUnique({
        where: { id: late.allocations[0]!.packageId },
      });
      expect(earlyPkg!.available.toFixed(2)).toBe('0.00');
      expect(latePkg!.available.toFixed(2)).toBe('2.00');
    });

    // ── Negative protection: debit > available → INSUFFICIENT_HOURS ──────

    it('rejects a manual debit that would overdraw (INSUFFICIENT_HOURS, 409)', async () => {
      if (!ctx) return;
      await ledger.grantManual(
        {
          studentId: STUDENT_ID,
          courseId: COURSE_ID,
          units: '1.00',
          startsOn: '2026-07-23',
          expiresOn: '2026-08-31',
          reason: 'seed 1',
        },
        adminContext('grant-overdraw'),
      );
      // Debiting 2.00 against 1.00 available must reject and NOT mutate.
      await expect(
        ledger.debitManual(
          { studentId: STUDENT_ID, courseId: COURSE_ID, units: '2.00', reason: 'too much' },
          adminContext('debit-overdraw'),
        ),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_HOURS', httpStatus: 409 });
      // Balance unchanged.
      expect(await availableBalance()).toBe('1.00');
      // No MANUAL_DEDUCT transaction was written.
      const txs = await db.hourTransaction.findMany({
        where: { studentId: STUDENT_ID, courseId: COURSE_ID },
      });
      expect(txs.map((t) => t.type).sort()).toEqual(['MANUAL_GRANT']);
    });

    // ── Decimal precision: fractional debit sum stays exact ─────────────

    it('keeps exact decimal precision on fractional manual debit (0.10 + 0.20 = 0.30)', async () => {
      if (!ctx) return;
      await ledger.grantManual(
        {
          studentId: STUDENT_ID,
          courseId: COURSE_ID,
          units: '1.00',
          startsOn: '2026-07-23',
          expiresOn: '2026-08-31',
          reason: 'precision seed',
        },
        adminContext('grant-precision'),
      );
      await ledger.debitManual(
        { studentId: STUDENT_ID, courseId: COURSE_ID, units: '0.10', reason: 'first sliver' },
        adminContext('debit-0.10'),
      );
      await ledger.debitManual(
        { studentId: STUDENT_ID, courseId: COURSE_ID, units: '0.20', reason: 'second sliver' },
        adminContext('debit-0.20'),
      );
      // 1.00 - 0.10 - 0.20 = 0.70, no float drift.
      expect(await availableBalance()).toBe('0.70');
    });

    // ── Idempotent grant: same key twice → one transaction, no double grant

    it('is idempotent on grantManual (same idempotency key → one transaction, no double credit)', async () => {
      if (!ctx) return;
      const cmd = {
        studentId: STUDENT_ID,
        courseId: COURSE_ID,
        units: '5.00',
        startsOn: '2026-07-23',
        expiresOn: '2026-08-31',
        reason: 'idempotent grant',
      };
      const first = await ledger.grantManual(cmd, adminContext('idem-grant'));
      const second = await ledger.grantManual(cmd, adminContext('idem-grant'));

      // Same result transaction id (replay), exactly one HourTransaction.
      expect(second.transactionId).toBe(first.transactionId);
      const txs = await db.hourTransaction.findMany({
        where: { studentId: STUDENT_ID, courseId: COURSE_ID },
      });
      expect(txs).toHaveLength(1);
      expect(txs[0]!.type).toBe(HOUR_TRANSACTION_TYPE.MANUAL_GRANT);
      // Balance not doubled.
      expect(await availableBalance()).toBe('5.00');
      // Exactly one MANUAL package created (no second package on replay).
      const packages = await db.coursePackage.findMany({
        where: { studentId: STUDENT_ID, courseId: COURSE_ID },
      });
      expect(packages).toHaveLength(1);
    });

    // ── Idempotent debit: same key twice → one transaction, no double debit

    it('is idempotent on debitManual (same idempotency key → one transaction, no double debit)', async () => {
      if (!ctx) return;
      await ledger.grantManual(
        {
          studentId: STUDENT_ID,
          courseId: COURSE_ID,
          units: '4.00',
          startsOn: '2026-07-23',
          expiresOn: '2026-08-31',
          reason: 'seed for idem debit',
        },
        adminContext('grant-for-idem-debit'),
      );
      const first = await ledger.debitManual(
        { studentId: STUDENT_ID, courseId: COURSE_ID, units: '1.50', reason: 'idem debit' },
        adminContext('idem-debit'),
      );
      const second = await ledger.debitManual(
        { studentId: STUDENT_ID, courseId: COURSE_ID, units: '1.50', reason: 'idem debit' },
        adminContext('idem-debit'),
      );

      expect(second.transactionId).toBe(first.transactionId);
      // One MANUAL_GRANT + one MANUAL_DEDUCT = 2 transactions.
      const txs = await db.hourTransaction.findMany({
        where: { studentId: STUDENT_ID, courseId: COURSE_ID },
      });
      expect(txs.map((t) => t.type).sort()).toEqual(['MANUAL_DEDUCT', 'MANUAL_GRANT']);
      // 4.00 - 1.50 = 2.50 (no double debit).
      expect(await availableBalance()).toBe('2.50');
    });

    // ── Validation: positive units + valid dates ─────────────────────────

    it('rejects zero/negative units and malformed dates before any write', async () => {
      if (!ctx) return;
      // Zero units → HOURS_MUST_BE_POSITIVE (422).
      await expect(
        ledger.grantManual(
          {
            studentId: STUDENT_ID,
            courseId: COURSE_ID,
            units: '0.00',
            startsOn: '2026-07-23',
            expiresOn: '2026-08-31',
            reason: 'zero',
          },
          adminContext('grant-zero'),
        ),
      ).rejects.toMatchObject({
        code: 'HOURS_MUST_BE_POSITIVE',
        httpStatus: 422,
      });
      // Malformed date → VALIDATION_FAILED (400).
      await expect(
        ledger.grantManual(
          {
            studentId: STUDENT_ID,
            courseId: COURSE_ID,
            units: '1.00',
            startsOn: 'not-a-date',
            expiresOn: '2026-08-31',
            reason: 'bad date',
          },
          adminContext('grant-bad-date'),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', httpStatus: 400 });
      // Nothing was written.
      expect(await db.coursePackage.count()).toBe(0);
      expect(await db.hourTransaction.count()).toBe(0);
    });
  },
);

// ── Helpers ──────────────────────────────────────────────────────────────

// Keep the Prisma import referenced for type-only usage in JSDoc / future.
void (undefined as unknown as Prisma.TransactionClient);
