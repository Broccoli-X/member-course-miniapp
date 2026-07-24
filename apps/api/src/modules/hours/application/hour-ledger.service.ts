import { Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  HTTP_STATUS,
  HOUR_ALLOCATION_SOURCE,
  HOUR_TRANSACTION_TYPE,
  type GrantOrderHoursInput,
  type HourPostingAllocation,
  type HourPostingResult,
  type ReverseOrderHoursInput,
} from '@member-course/contracts';
import { Prisma } from '../../../generated/prisma/client.js';
import { BusinessError } from '../../../common/errors/business-error.js';
import {
  HourLockRepository,
  type LockedBalance,
  type LockedPackage,
} from '../infrastructure/hour-lock.repository.js';
import {
  addBuckets,
  bucketsToSummary,
  negateBuckets,
  to2dp,
  toDecimal,
  zeroBuckets,
  type Buckets,
} from '../domain/hour-buckets.js';

/**
 * `HourLedgerService` — the append-only lesson-hour ledger.
 *
 * Two operations, both INSIDE the caller's transaction (the Orders module will
 * wrap confirm+grant in one tx in Task 9):
 *
 *   grantOrder(tx, input)   — append a GRANT HourTransaction that credits
 *                              `units` to (studentId, courseId). The Order's
 *                              CoursePackage already exists (created by the
 *                              caller); the grant lands the full `units` in
 *                              that single package's `available` bucket.
 *
 *   reverseOrder(tx, input) — append a REVERSAL HourTransaction whose deltas
 *                              are the negation of the referenced original
 *                              transaction's deltas. The original transaction
 *                              is NEVER mutated; its allocations are reversed
 *                              against the same packages by negating their
 *                              bucket deltas.
 *
 * ## Invariants enforced here
 *
 * 1. Append-only. HourTransaction and HourAllocation are created, never
 *    updated or deleted. This service exposes no update/delete path for them.
 * 2. Decimal-only arithmetic. Every delta, balance, allocation is computed in
 *    `Prisma.Decimal`; serialized as 2-dp strings on the result.
 * 3. Atomic locking inside the caller's tx. Lock order: StudentCourseBalance
 *    first, then eligible CoursePackages. See {@link HourLockRepository} for
 *    the deadlock-avoidance strategy on a not-yet-existing balance row.
 * 4. businessKey idempotency. A second grant/reverse with the SAME businessKey
 *    returns the original result (re-derived from the existing transaction's
 *    deltas) WITHOUT creating duplicates. A Prisma P2002 on `businessKey`
 *    during the append is caught and mapped to the same idempotent replay
 *    path (covers the race where two concurrent callers slip past the
 *    findUnique before either INSERT lands). IMPORTANT: under MySQL RR, if a
 *    concurrent SAME-businessKey tx has INSERTED but NOT YET COMMITTED, the
 *    loser's INSERT blocks on the unique index, then throws P2002 once the
 *    winner commits/aborts — but the loser can no longer SEE the winner's row
 *    inside its now-poisoned tx. So `grantOrder`/`reverseOrder` may THROW
 *    `PrismaClientKnownRequestError(P2002)` out of the caller's transaction
 *    for the racing-same-businessKey case. The caller (IdempotencyService in
 *    production, or a retry wrapper) is responsible for catching P2002 and
 *    re-invoking; on the retry, the findUnique fast-path returns the original
 *    result. This mirrors how the rest of the system handles racing
 *    idempotent writes (see IdempotencyService's in-flight dedup).
 * 5. Reconcilability. After every posting, `balance.available ===
 *    Σ HourTransaction.availableDelta` for (studentId, courseId) — and
 *    likewise for reserved/consumed/expired. We never write the balance
 *    except by applying a transaction's deltas, so the invariant holds by
 *    construction.
 */
@Injectable()
export class HourLedgerService {
  constructor(private readonly locks: HourLockRepository) {}

  // ── grantOrder ────────────────────────────────────────────────────────

  /**
   * Append a GRANT transaction crediting `units` to (studentId, courseId),
   * landing the full amount in the order's single CoursePackage. Idempotent on
   * `businessKey`. Must run inside the caller's transaction.
   */
  async grantOrder(
    tx: Prisma.TransactionClient,
    input: GrantOrderHoursInput,
  ): Promise<HourPostingResult> {
    // ── Idempotency fast-path: a prior grant with the same businessKey ──
    // Return its result WITHOUT writing anything. The findUnique is the
    // happy-path dedup; the P2002 catch below covers the concurrent race.
    const existing = await tx.hourTransaction.findUnique({
      where: { businessKey: input.businessKey },
      include: { allocations: true },
    });
    if (existing) {
      return this.replayResultFromExisting(tx, existing);
    }

    // ── Lock order: balance FIRST, then packages ──
    const balance = await this.locks.lockBalance(tx, input.studentId, input.courseId);
    // For an order GRANT the package already exists (created by the caller);
    // lock just that one. Locking under the balance lock keeps the order.
    const packages = await this.locks.lockPackages(tx, [input.packageId]);
    const pkg = packages[0];
    if (!pkg) {
      throw BusinessError.notFound('Course package not found for grant', {
        packageId: input.packageId,
      });
    }
    if (pkg.sourceOrderItemId !== input.orderItemId) {
      throw new BusinessError(
        ERROR_CODES.VALIDATION_FAILED,
        'Course package does not belong to the supplied order item',
        HTTP_STATUS.BAD_REQUEST,
        { packageId: input.packageId, orderItemId: input.orderItemId },
      );
    }

    const units = toDecimal(input.units);
    if (!units.isFinite() || units.lte(0)) {
      throw new BusinessError(
        ERROR_CODES.HOURS_MUST_BE_POSITIVE,
        'grant units must be greater than 0',
        HTTP_STATUS.UNPROCESSABLE_ENTITY,
        { units: input.units },
      );
    }

    // For an order GRANT, the full `units` land in the new package's
    // `available` bucket and the balance's `available` bucket. reserved/
    // consumed/ expired are zero on this transaction. (FEFO allocation across
    // multiple packages matters for consumption/reversal; a grant touches a
    // single brand-new package.)
    const txDeltas: Buckets = {
      available: units,
      reserved: zeroBuckets().reserved,
      consumed: zeroBuckets().consumed,
      expired: zeroBuckets().expired,
    };

    // ── Apply to package + balance, append transaction + allocation ──
    return this.applyPosting(tx, {
      studentId: input.studentId,
      courseId: input.courseId,
      type: HOUR_TRANSACTION_TYPE.GRANT,
      businessKey: input.businessKey,
      occurredAt: input.occurredAt,
      reason: null,
      balance,
      txDeltas,
      allocations: [
        {
          packageId: pkg.id,
          sourceType: HOUR_ALLOCATION_SOURCE.ORDER,
          sourceId: input.orderItemId,
          deltas: txDeltas,
        },
      ],
      packagesById: new Map([[pkg.id, pkg]]),
    });
  }

  // ── reverseOrder ──────────────────────────────────────────────────────

  /**
   * Append a REVERSAL transaction that negates the referenced original
   * transaction's deltas. The original is never mutated; the reversal's
   * allocations negate the original allocations against the SAME packages.
   * Idempotent on `businessKey`. Must run inside the caller's transaction.
   */
  async reverseOrder(
    tx: Prisma.TransactionClient,
    input: ReverseOrderHoursInput,
  ): Promise<HourPostingResult> {
    // ── Idempotency fast-path on this reversal's businessKey ──
    const existing = await tx.hourTransaction.findUnique({
      where: { businessKey: input.businessKey },
      include: { allocations: true },
    });
    if (existing) {
      return this.replayResultFromExisting(tx, existing);
    }

    // ── Load + validate the original transaction (we read but never write it) ──
    const original = await tx.hourTransaction.findUnique({
      where: { id: input.originalTransactionId },
      include: { allocations: { orderBy: { createdAt: 'asc' } } },
    });
    if (!original) {
      throw BusinessError.notFound('Original hour transaction not found', {
        originalTransactionId: input.originalTransactionId,
      });
    }
    if (
      original.type !== HOUR_TRANSACTION_TYPE.GRANT &&
      original.type !== HOUR_TRANSACTION_TYPE.MANUAL_GRANT &&
      original.type !== HOUR_TRANSACTION_TYPE.DEBIT &&
      original.type !== HOUR_TRANSACTION_TYPE.MANUAL_DEDUCT
    ) {
      // Reversing a reversal (or any non-posting type) is not supported in M1.
      throw new BusinessError(
        ERROR_CODES.VALIDATION_FAILED,
        `Cannot reverse a transaction of type ${original.type}`,
        HTTP_STATUS.BAD_REQUEST,
        { originalTransactionId: input.originalTransactionId, type: original.type },
      );
    }

    // ── Lock order: balance FIRST, then the original allocation packages ──
    const balance = await this.locks.lockBalance(tx, original.studentId, original.courseId);
    const packageIds = original.allocations.map((a) => a.packageId);
    const packages = await this.locks.lockPackages(tx, packageIds);
    const packagesById = new Map(packages.map((p) => [p.id, p]));

    // The reversal's transaction deltas are the negation of the original's.
    const originalDeltas: Buckets = {
      available: toDecimal(original.availableDelta),
      reserved: toDecimal(original.reservedDelta),
      consumed: toDecimal(original.consumedDelta),
      expired: toDecimal(original.expiredDelta),
    };
    const txDeltas = negateBuckets(originalDeltas);

    // Build the reversal's allocations by negating each ORIGINAL allocation
    // against the SAME package it originally touched. This restores the
    // package buckets exactly. If a package is missing now (shouldn't happen
    // — packages are append-only), surface a hard error.
    const allocations = original.allocations.map((a) => {
      return {
        packageId: a.packageId,
        sourceType: a.sourceType,
        sourceId: a.sourceId,
        deltas: negateBuckets({
          available: toDecimal(a.availableDelta),
          reserved: toDecimal(a.reservedDelta),
          consumed: toDecimal(a.consumedDelta),
          expired: toDecimal(a.expiredDelta),
        }) as Buckets,
      };
    });

    return this.applyPosting(tx, {
      studentId: original.studentId,
      courseId: original.courseId,
      type: HOUR_TRANSACTION_TYPE.REVERSAL,
      businessKey: input.businessKey,
      occurredAt: input.occurredAt,
      reason: input.reason,
      // Persist the auditability link: this REVERSAL row points back to the
      // transaction it undoes. The link was already validated above (the
      // original exists and is a reversible type). Non-reversal postings
      // (grantOrder) leave this unset → NULL on the row.
      originalTransactionId: input.originalTransactionId,
      balance,
      txDeltas,
      allocations,
      packagesById,
    });
  }

  // ── Shared posting core ───────────────────────────────────────────────

  /**
   * Apply a posting: append the HourTransaction + one HourAllocation per
   * package slice, mutate the package buckets, and update the summary balance
   * (version bumped). All under the caller's tx. Returns the
   * {@link HourPostingResult} derived from the post-state.
   *
   * The `packagesById` map carries the LOCKED package rows so we can read
   * `expiresOn` for the result without a second query. Mutations go through
   * Prisma (not raw SQL) so they appear in the query log and use the
   * `@updatedAt`/version machinery.
   */
  private async applyPosting(
    tx: Prisma.TransactionClient,
    args: {
      studentId: string;
      courseId: string;
      type: string;
      businessKey: string;
      occurredAt: Date;
      reason: string | null;
      /**
       * For a REVERSAL, the id of the original transaction being undone.
       * Undefined/omitted for non-reversal postings (GRANT leaves the column
       * NULL). Persisted to `HourTransaction.originalTransactionId` so a
       * reversal row carries an auditable link to its source.
       */
      originalTransactionId?: string;
      balance: LockedBalance;
      txDeltas: Buckets;
      allocations: Array<{
        packageId: string;
        sourceType: string;
        sourceId: string;
        deltas: Buckets;
      }>;
      packagesById: Map<string, LockedPackage>;
    },
  ): Promise<HourPostingResult> {
    // Append the HourTransaction FIRST. The unique `businessKey` is our
    // serialization point: if a concurrent caller beat us to this businessKey,
    // the create throws P2002 and we fall through to the replay path. Doing
    // the insert before mutating balance/packages means a P2002 leaves ZERO
    // side effects (the balance lock is held but no rows were changed).
    let transactionId: string;
    try {
      const created = await tx.hourTransaction.create({
        data: {
          studentId: args.studentId,
          courseId: args.courseId,
          type: args.type,
          businessKey: args.businessKey,
          availableDelta: args.txDeltas.available,
          reservedDelta: args.txDeltas.reserved,
          consumedDelta: args.txDeltas.consumed,
          expiredDelta: args.txDeltas.expired,
          reason: args.reason,
          occurredAt: args.occurredAt,
          // Only set when explicitly provided (REVERSAL). Omitting the field
          // for GRANT/etc. writes NULL — do NOT pass `undefined` explicitly
          // through Prisma, which treats an absent key the same as NULL here.
          ...(args.originalTransactionId !== undefined
            ? { originalTransactionId: args.originalTransactionId }
            : {}),
        },
      });
      transactionId = created.id;
    } catch (err) {
      if (isPrismaUniqueViolation(err)) {
        // Race: another caller inserted this businessKey between our
        // findUnique and our create. Treat as idempotent — re-read and replay.
        const raced = await tx.hourTransaction.findUnique({
          where: { businessKey: args.businessKey },
          include: { allocations: true },
        });
        if (raced) {
          return this.replayResultFromExisting(tx, raced);
        }
      }
      throw err;
    }

    // Append one HourAllocation per package slice AND mutate each package's
    // buckets. The allocation records the per-package delta; the package row
    // update applies that delta so the package's buckets reconcile against its
    // own allocation history. Version is bumped for optimistic-concurrency
    // safety (the FOR UPDATE lock already serializes, but the version is the
    // belt to the lock's suspenders).
    const resultAllocations: HourPostingAllocation[] = [];
    for (const a of args.allocations) {
      const pkg = args.packagesById.get(a.packageId);
      if (!pkg) {
        // A package referenced by the posting is not in our locked set. For a
        // grant this is impossible (we locked the package above). For a
        // reversal it would mean the original allocation references a package
        // we didn't lock — throw and let the tx roll back rather than write a
        // dangling allocation.
        throw new BusinessError(
          ERROR_CODES.VALIDATION_FAILED,
          'Posting references a package that was not locked',
          HTTP_STATUS.BAD_REQUEST,
          { packageId: a.packageId },
        );
      }

      const newPkgBuckets = addBuckets(pkg.buckets, a.deltas);
      await tx.hourAllocation.create({
        data: {
          transactionId,
          packageId: a.packageId,
          sourceType: a.sourceType,
          sourceId: a.sourceId,
          availableDelta: a.deltas.available,
          reservedDelta: a.deltas.reserved,
          consumedDelta: a.deltas.consumed,
          expiredDelta: a.deltas.expired,
        },
      });
      // Raw UPDATE (not Prisma's `update`) for the package bucket mutation.
      // Under MySQL RR, Prisma's `update` pre-SELECTs the row using the tx's
      // REPEATABLE READ snapshot — which may NOT yet reflect a row a
      // concurrent tx just committed (e.g. a brand-new balance/package the
      // locking SELECT *did* see, because locking reads bypass the snapshot,
      // but the Prisma pre-SELECT does not). The raw UPDATE is evaluated by
      // InnoDB against the actual current row state, not the snapshot, so it
      // matches the row we just locked. We do NOT use the snapshot here.
      await tx.$executeRaw`
        UPDATE \`course_package\`
        SET \`available\` = ${newPkgBuckets.available},
            \`reserved\`  = ${newPkgBuckets.reserved},
            \`consumed\`  = ${newPkgBuckets.consumed},
            \`expired\`   = ${newPkgBuckets.expired},
            \`version\`   = \`version\` + 1,
            \`updatedAt\` = UTC_TIMESTAMP(3)
        WHERE \`id\` = ${a.packageId}
      `;

      const unitsForSlice = a.deltas.available.plus(a.deltas.reserved).plus(a.deltas.consumed).plus(a.deltas.expired);
      resultAllocations.push({
        packageId: a.packageId,
        packageExpiresOn: toDateOnly(pkg.expiresOn),
        units: to2dp(unitsForSlice.abs()),
        availableDelta: to2dp(a.deltas.available),
        reservedDelta: to2dp(a.deltas.reserved),
        consumedDelta: to2dp(a.deltas.consumed),
        expiredDelta: to2dp(a.deltas.expired),
      });
    }

    // Apply the transaction deltas to the summary balance. Raw UPDATE for the
    // same RR-snapshot reason as the package update above — Prisma's `update`
    // pre-SELECTs against the tx snapshot and would P2025 on a row a concurrent
    // tx just created (the locking SELECT saw it, the snapshot did not). The
    // row is X-locked by `lockBalance`; this UPDATE matches it deterministically.
    const newBalanceBuckets = addBuckets(args.balance.buckets, args.txDeltas);
    await tx.$executeRaw`
      UPDATE \`student_course_balance\`
      SET \`available\` = ${newBalanceBuckets.available},
          \`reserved\`  = ${newBalanceBuckets.reserved},
          \`consumed\`  = ${newBalanceBuckets.consumed},
          \`expired\`   = ${newBalanceBuckets.expired},
          \`version\`   = \`version\` + 1,
          \`updatedAt\` = UTC_TIMESTAMP(3)
      WHERE \`id\` = ${args.balance.id}
    `;

    return {
      transactionId,
      balanceId: args.balance.id,
      allocations: resultAllocations,
      balance: bucketsToSummary(newBalanceBuckets),
    };
  }

  // ── Idempotency replay ────────────────────────────────────────────────

  /**
   * Re-derive a {@link HourPostingResult} from an already-persisted
   * HourTransaction + its allocations, WITHOUT writing anything. Used by both
   * the findUnique fast-path and the P2002 race fallback so a duplicate
   * businessKey returns the original result with zero side effects.
   *
   * `balance` is read fresh (the original posting already updated it) so the
   * returned summary reflects the current state, not a stale snapshot — this
   * is what makes an idempotent replay observably identical to the original
   * call's return value (modulo transactionId, which is the SAME row).
   */
  private async replayResultFromExisting(
    tx: Prisma.TransactionClient,
    existing: {
      id: string;
      studentId: string;
      courseId: string;
      availableDelta: Prisma.Decimal;
      reservedDelta: Prisma.Decimal;
      consumedDelta: Prisma.Decimal;
      expiredDelta: Prisma.Decimal;
      allocations: Array<{
        packageId: string;
        sourceType: string;
        availableDelta: Prisma.Decimal;
        reservedDelta: Prisma.Decimal;
        consumedDelta: Prisma.Decimal;
        expiredDelta: Prisma.Decimal;
      }>;
    },
  ): Promise<HourPostingResult> {
    // Read current balance + package expiries to render the result. These
    // reads are NOT locked (the replay path doesn't mutate anything), which is
    // fine — a concurrent poster would change the balance but this transaction
    // would just observe the post-state, and since the replay returns the
    // ORIGINAL transaction's deltas (not the current balance delta), the
    // transactionId/allocations are stable.
    const balance = await tx.studentCourseBalance.findUnique({
      where: { studentId_courseId: { studentId: existing.studentId, courseId: existing.courseId } },
    });
    if (!balance) {
      // Inconsistent state: a transaction exists but its balance row is gone.
      // Treat as internal error.
      throw new BusinessError(
        ERROR_CODES.INTERNAL_ERROR,
        'Hour transaction exists but balance row is missing',
        HTTP_STATUS.INTERNAL_ERROR,
        { transactionId: existing.id },
      );
    }

    const packageIds = existing.allocations.map((a) => a.packageId);
    const packages =
      packageIds.length === 0
        ? []
        : await tx.coursePackage.findMany({
            where: { id: { in: packageIds } },
            select: { id: true, expiresOn: true },
          });
    const expiresById = new Map(packages.map((p) => [p.id, p.expiresOn]));

    return {
      transactionId: existing.id,
      balanceId: balance.id,
      allocations: existing.allocations.map((a) => {
        const deltas: Buckets = {
          available: toDecimal(a.availableDelta),
          reserved: toDecimal(a.reservedDelta),
          consumed: toDecimal(a.consumedDelta),
          expired: toDecimal(a.expiredDelta),
        };
        const expires = expiresById.get(a.packageId) ?? new Date(0);
        const units = deltas.available
          .plus(deltas.reserved)
          .plus(deltas.consumed)
          .plus(deltas.expired);
        return {
          packageId: a.packageId,
          packageExpiresOn: toDateOnly(expires),
          units: to2dp(units.abs()),
          availableDelta: to2dp(deltas.available),
          reservedDelta: to2dp(deltas.reserved),
          consumedDelta: to2dp(deltas.consumed),
          expiredDelta: to2dp(deltas.expired),
        };
      }),
      balance: bucketsToSummary({
        available: toDecimal(balance.available),
        reserved: toDecimal(balance.reserved),
        consumed: toDecimal(balance.consumed),
        expired: toDecimal(balance.expired),
      }),
    };
  }
}

// ── Module-private helpers ──────────────────────────────────────────────

/**
 * Detect a Prisma P2002 (unique-constraint violation). Used to map a racing
 * INSERT on `businessKey` to the idempotent replay path. We narrow by the
 * Prisma error code (not by `instanceof`, which is fragile across Prisma
 * versions) and additionally check the column name when available so we only
 * swallow P2002s on `businessKey` (a P2002 on some other unique index would
 * indicate a real bug and should still surface).
 */
function isPrismaUniqueViolation(err: unknown, column?: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { target?: string[] } };
  if (e.code !== 'P2002') return false;
  if (column && e.meta?.target && !e.meta.target.includes(column)) return false;
  return true;
}

/**
 * Render a Date as a UTC `YYYY-MM-DD` string for the
 * `HourPostingAllocation.packageExpiresOn` field. The schema stores
 * `expiresOn` as a `@db.Date` (no timezone), so we read its UTC year/month/day
 * to produce a stable wire value regardless of the host's local timezone.
 */
function toDateOnly(d: Date): string {
  // Pad helper kept local — used only here.
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
