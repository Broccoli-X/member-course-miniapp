import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { getMysqlContext, type MysqlTestContext } from '../helpers/mysql-test-environment.js';
import { HourLedgerService } from '../../src/modules/hours/application/hour-ledger.service.js';
import { HourExpirationService } from '../../src/modules/hours/application/hour-expiration.service.js';
import { HourLockRepository } from '../../src/modules/hours/infrastructure/hour-lock.repository.js';
import { IdempotencyService } from '../../src/common/idempotency/idempotency.service.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import { HOUR_TRANSACTION_TYPE } from '@member-course/contracts';
import { truncateAllTables } from '../helpers/truncate-all-tables.js';

/**
 * Daily lesson-hour expiration integration tests (Task 10 brief, Step 1
 * verbatim boundary case plus the invariants the brief enumerates).
 *
 * Runs against the real MySQL test DB via {@link getMysqlContext} (gated on
 * `RUN_INTEGRATION`). The {@link HourExpirationService} is constructed with a
 * real {@link PrismaService} + {@link HourLedgerService} and calls
 * `expireDuePackages(now, batchSize)` directly with a fixed `now`, so the 00:05
 * Shanghai boundary is deterministic (no reliance on real cron timing).
 *
 * The brief's verbatim boundary case:
 *   "expires packages at 00:05 Shanghai only when expiresOn is before today"
 *
 *   - `now = 2026-08-01T16:04:59Z` (Shanghai 2026-08-02 00:04:59, BEFORE 00:05)
 *     → no expiry, `expiredUnits === '0.00'`
 *   - `now = 2026-08-01T16:05:00Z` (Shanghai 2026-08-02 00:05:00, AT 00:05)
 *     → expiry runs, `expiredUnits === '2.00'`
 *
 * Plus: idempotent rerun (same businessKey twice → one EXPIRE transaction, no
 * double-count), batch with multiple packages, per-package failure isolation.
 */
describe.skipIf(!process.env.RUN_INTEGRATION)(
  'Hour expiration (integration, real MySQL)',
  () => {
    let ctx: MysqlTestContext | null;
    let db: PrismaClient;
    let ledger: HourLedgerService;
    let expiration: HourExpirationService;
    const STUDENT_ID = 'stu-exp';
    const COURSE_ID = 'crs-exp';

    beforeAll(async () => {
      ctx = await getMysqlContext();
      if (!ctx) return;
      db = new PrismaClient({ datasources: { db: { url: ctx.databaseUrl } } });
      const dbAsService = db as unknown as PrismaService;
      ledger = new HourLedgerService(
        new HourLockRepository(),
        new IdempotencyService(dbAsService),
      );
      expiration = new HourExpirationService(dbAsService, ledger);
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

    async function seedStudentCourse(): Promise<void> {
      await db.memberAccount.upsert({
        where: { id: 'acc-exp' },
        update: {},
        create: { id: 'acc-exp', normalizedPhone: '13800000020' },
      });
      await db.studentProfile.upsert({
        where: { id: STUDENT_ID },
        update: {},
        create: { id: STUDENT_ID, displayName: '小到期' },
      });
      await db.accountStudentRelation.upsert({
        where: { accountId_studentId: { accountId: 'acc-exp', studentId: STUDENT_ID } },
        update: {},
        create: { accountId: 'acc-exp', studentId: STUDENT_ID, relationType: 'PARENT' },
      });
      await db.course.upsert({
        where: { id: COURSE_ID },
        update: {},
        create: { id: COURSE_ID, name: '到期课', type: 'CLASS', description: 'd' },
      });
    }

    /**
     * Seed a single CoursePackage directly (bypassing grantManual) with given
     * available + expiresOn, AND keep the summary balance row in sync (the
     * production invariant: every package's available is reflected in the
     * (studentId, courseId) balance). Returns the package id so the test can
     * probe its `expired` bucket via {@link expiredUnits}.
     */
    async function seedPackage(opts: {
      packageId?: string;
      studentId?: string;
      courseId?: string;
      available?: string;
      expiresOn?: Date;
      startsOn?: Date;
    }): Promise<string> {
      const id = opts.packageId ?? `pkg-${Math.random().toString(36).slice(2, 10)}`;
      const studentId = opts.studentId ?? STUDENT_ID;
      const courseId = opts.courseId ?? COURSE_ID;
      const available = opts.available ?? '2.00';
      await db.coursePackage.create({
        data: {
          id,
          studentId,
          courseId,
          sourceType: 'ORDER',
          startsOn: opts.startsOn ?? new Date('2026-07-01T00:00:00.000Z'),
          expiresOn: opts.expiresOn ?? new Date('2026-08-01T00:00:00.000Z'),
          granted: available,
          available,
          reserved: 0,
          consumed: 0,
          expired: 0,
          status: 'ACTIVE',
        },
      });
      // Upsert the summary balance row, accumulating available across multiple
      // packages on the same (student, course). This mirrors what a real grant
      // would leave behind and keeps the expiry's available→expired move from
      // going negative on the balance.
      const existing = await db.studentCourseBalance.findUnique({
        where: { studentId_courseId: { studentId, courseId } },
      });
      if (existing) {
        await db.studentCourseBalance.update({
          where: { id: existing.id },
          data: { available: existing.available.plus(available) },
        });
      } else {
        await db.studentCourseBalance.create({
          data: {
            studentId,
            courseId,
            available,
            reserved: 0,
            consumed: 0,
            expired: 0,
          },
        });
      }
      return id;
    }

    /** The package's `expired` bucket as a 2-dp string (mirrors the brief's helper). */
    async function expiredUnits(packageId: string): Promise<string> {
      const pkg = await db.coursePackage.findUnique({ where: { id: packageId } });
      return pkg ? pkg.expired.toFixed(2) : '0.00';
    }

    /** Wrap expireDuePackages to mirror the brief's `runExpiry(now)` helper. */
    async function runExpiry(nowIso: string): Promise<void> {
      await expiration.expireDuePackages(new Date(nowIso), 100);
    }

    // ── Brief verbatim case: 00:05 Shanghai boundary ─────────────────────

    it('expires packages at 00:05 Shanghai only when expiresOn is before today', async () => {
      if (!ctx) return;
      // Package expiring 2026-08-01, 2.00 available. At the 00:05 run of
      // 2026-08-02 Shanghai, expiresOn (2026-08-01) < today (2026-08-02) → due.
      const packageId = await seedPackage({
        available: '2.00',
        expiresOn: new Date('2026-08-01T00:00:00.000Z'),
      });
      expect(await expiredUnits(packageId)).toBe('0.00');

      // BEFORE 00:05 Shanghai (16:04:59Z = 2026-08-02 00:04:59 Shanghai) →
      // the service's 00:05 gate exits early; no expiry.
      await runExpiry('2026-08-01T16:04:59Z');
      expect(await expiredUnits(packageId)).toBe('0.00');

      // AT 00:05 Shanghai (16:05:00Z = 2026-08-02 00:05:00 Shanghai) → the
      // gate passes AND expiresOn (2026-08-01) < today (2026-08-02) → expiry.
      await runExpiry('2026-08-01T16:05:00Z');
      expect(await expiredUnits(packageId)).toBe('2.00');

      // The package status flips to EXPIRED (available hit 0).
      const pkg = await db.coursePackage.findUnique({ where: { id: packageId } });
      expect(pkg!.status).toBe('EXPIRED');
      expect(pkg!.available.toFixed(2)).toBe('0.00');

      // A summary balance row exists with expired = 2.00 (available moved→expired).
      const bal = await db.studentCourseBalance.findUnique({
        where: { studentId_courseId: { studentId: STUDENT_ID, courseId: COURSE_ID } },
      });
      expect(bal!.expired.toFixed(2)).toBe('2.00');
      expect(bal!.available.toFixed(2)).toBe('0.00');

      // Exactly one EXPIRE HourTransaction was written.
      const txs = await db.hourTransaction.findMany({
        where: { studentId: STUDENT_ID, courseId: COURSE_ID },
      });
      expect(txs).toHaveLength(1);
      expect(txs[0]!.type).toBe(HOUR_TRANSACTION_TYPE.EXPIRE);
      expect(txs[0]!.availableDelta.toFixed(2)).toBe('-2.00');
      expect(txs[0]!.expiredDelta.toFixed(2)).toBe('2.00');
    });

    // ── Idempotent rerun: same businessKey twice → one expiry ────────────

    it('is idempotent on rerun (same business date → one EXPIRE transaction, no double-count)', async () => {
      if (!ctx) return;
      const packageId = await seedPackage({
        available: '3.00',
        expiresOn: new Date('2026-08-01T00:00:00.000Z'),
      });

      // First run at 00:05 Shanghai on 2026-08-02 expires 3.00.
      await runExpiry('2026-08-01T16:05:00Z');
      expect(await expiredUnits(packageId)).toBe('3.00');

      // Rerun the SAME business date — businessKey `expiry:<id>:2026-08-02`
      // already exists, so expireAvailable replays the cached result with zero
      // side effects. expiredUnits stays 3.00 (NOT 6.00).
      await runExpiry('2026-08-01T16:05:00Z');
      expect(await expiredUnits(packageId)).toBe('3.00');

      // Still exactly one EXPIRE transaction.
      const txs = await db.hourTransaction.findMany({
        where: { studentId: STUDENT_ID, courseId: COURSE_ID },
      });
      expect(txs).toHaveLength(1);
    });

    // ── expiresOn == today is NOT due (strict less-than) ─────────────────

    it('does NOT expire a package whose expiresOn equals today (expiresOn < today is strict)', async () => {
      if (!ctx) return;
      // expiresOn 2026-08-02 == today (Shanghai date of the 00:05 run).
      const packageId = await seedPackage({
        available: '2.00',
        expiresOn: new Date('2026-08-02T00:00:00.000Z'),
      });
      // Fire at 00:05 Shanghai 2026-08-02: expiresOn (2026-08-02) is NOT < today
      // (2026-08-02), so the package is not scanned for expiry.
      const result = await expiration.expireDuePackages(
        new Date('2026-08-01T16:05:00Z'),
        100,
      );
      expect(result.scanned).toBe(0);
      expect(result.processed).toBe(0);
      expect(await expiredUnits(packageId)).toBe('0.00');
    });

    // ── Batch: multiple due packages all processed ───────────────────────

    it('expires multiple due packages in one batch', async () => {
      if (!ctx) return;
      // Three due packages across two students on the same course.
      const pkgA = await seedPackage({
        packageId: 'pkg-a',
        studentId: STUDENT_ID,
        available: '2.00',
        expiresOn: new Date('2026-07-31T00:00:00.000Z'),
      });
      const pkgB = await seedPackage({
        packageId: 'pkg-b',
        studentId: STUDENT_ID,
        available: '1.50',
        expiresOn: new Date('2026-08-01T00:00:00.000Z'),
      });
      // A second student on the same course.
      await db.studentProfile.upsert({
        where: { id: 'stu-exp-2' },
        update: {},
        create: { id: 'stu-exp-2', displayName: '小到期2' },
      });
      await db.accountStudentRelation.upsert({
        where: { accountId_studentId: { accountId: 'acc-exp', studentId: 'stu-exp-2' } },
        update: {},
        create: { accountId: 'acc-exp', studentId: 'stu-exp-2', relationType: 'PARENT' },
      });
      const pkgC = await seedPackage({
        packageId: 'pkg-c',
        studentId: 'stu-exp-2',
        available: '4.00',
        expiresOn: new Date('2026-07-15T00:00:00.000Z'),
      });

      const result = await expiration.expireDuePackages(
        new Date('2026-08-01T16:05:00Z'),
        100,
      );
      expect(result.scanned).toBe(3);
      expect(result.processed).toBe(3);
      expect(result.failed).toBe(0);

      expect(await expiredUnits(pkgA)).toBe('2.00');
      expect(await expiredUnits(pkgB)).toBe('1.50');
      expect(await expiredUnits(pkgC)).toBe('4.00');
    });

    // ── Per-package failure isolation: one bad package doesn't abort batch

    it('isolates per-package failures so one bad package does not abort the batch', async () => {
      if (!ctx) return;
      // One healthy due package.
      const healthy = await seedPackage({
        packageId: 'pkg-healthy',
        available: '2.00',
        expiresOn: new Date('2026-07-31T00:00:00.000Z'),
      });
      // A "bad" package: point it at a (studentId, courseId) that satisfies the
      // scan filter, then DELETE the matching student_course_balance row's FK
      // parent mid-test is hard; instead, simulate failure by deleting the
      // package's balance row linkage — simpler: pre-create a package whose
      // studentId has no balance row AND force the lockBalance create path to
      // fail by deleting the student_profile AFTER scan. We instead rely on a
      // guaranteed-to-fail case: a package referencing a non-existent student
      // (FK violation at lockBalance's INSERT). Seed it bypassing FK checks.
      await db.$executeRawUnsafe(`SET FOREIGN_KEY_CHECKS = 0`);
      try {
        await db.coursePackage.create({
          data: {
            id: 'pkg-orphan',
            studentId: 'no-such-student',
            courseId: COURSE_ID,
            sourceType: 'ORDER',
            startsOn: new Date('2026-07-01T00:00:00.000Z'),
            expiresOn: new Date('2026-07-31T00:00:00.000Z'),
            granted: 5,
            available: 5,
            reserved: 0,
            consumed: 0,
            expired: 0,
            status: 'ACTIVE',
          },
        });
      } finally {
        await db.$executeRawUnsafe(`SET FOREIGN_KEY_CHECKS = 1`);
      }

      const result = await expiration.expireDuePackages(
        new Date('2026-08-01T16:05:00Z'),
        100,
      );
      // Both packages were scanned; the healthy one processed, the orphan
      // failed (FK violation when lockBalance INSERTs the balance row) but did
      // NOT abort the batch.
      expect(result.scanned).toBe(2);
      expect(result.processed).toBe(1);
      expect(result.failed).toBe(1);
      expect(await expiredUnits(healthy)).toBe('2.00');
    });
  },
);
