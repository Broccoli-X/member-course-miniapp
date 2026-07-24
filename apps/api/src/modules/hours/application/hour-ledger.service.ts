import { Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  HTTP_STATUS,
  HOUR_ALLOCATION_SOURCE,
  HOUR_TRANSACTION_TYPE,
  COURSE_PACKAGE_SOURCE,
  COURSE_PACKAGE_STATUS,
  type CommandContext,
  type GrantOrderHoursInput,
  type HourPostingAllocation,
  type HourPostingResult,
  type ManualDebitCommand,
  type ManualGrantCommand,
  type ReverseOrderHoursInput,
} from '@member-course/contracts';
import { Prisma } from '../../../generated/prisma/client.js';
import { BusinessError } from '../../../common/errors/business-error.js';
import {
  IdempotencyService,
  type IdempotentRequest,
} from '../../../common/idempotency/idempotency.service.js';
import {
  HourLockRepository,
  type LockedBalance,
  type LockedPackage,
} from '../infrastructure/hour-lock.repository.js';
import { allocate, type AllocatablePackage } from '../domain/hour-allocation-policy.js';
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
  constructor(
    private readonly locks: HourLockRepository,
    private readonly idempotency: IdempotencyService,
  ) {}

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

  // ── grantManual (Task 10) ─────────────────────────────────────────────

  /**
   * Admin-initiated manual grant. Creates a SEPARATE `CoursePackage` with
   * `sourceType: MANUAL` (the verbatim Task 10 test asserts this exact token —
   * see {@link COURSE_PACKAGE_SOURCE.MANUAL} reconciliation note), lands the
   * full `units` in its `available` bucket, and appends a `MANUAL_GRANT`
   * HourTransaction. Idempotent on `context.idempotencyKey`.
   *
   * Unlike {@link grantOrder}, this method owns its transaction (it creates the
   * package AND posts the grant atomically, so a failure rolls back both). The
   * tx is provided by {@link IdempotencyService.execute}, which also dedups on
   * the idempotency key.
   *
   * `reason` MUST be nonblank — a manual adjustment without an audit reason is
   * rejected as `VALIDATION_FAILED` (400) before any DB write.
   */
  async grantManual(
    command: ManualGrantCommand,
    context: CommandContext,
  ): Promise<HourPostingResult> {
    // ── Validate inputs BEFORE opening the tx (cheap rejection first) ──
    assertNonblankReason(command.reason);
    const units = parsePositiveUnits(command.units);
    const startsOn = parseBusinessDate(command.startsOn, 'startsOn');
    const expiresOn = parseBusinessDate(command.expiresOn, 'expiresOn');
    if (expiresOn.getTime() < startsOn.getTime()) {
      throw new BusinessError(
        ERROR_CODES.VALIDATION_FAILED,
        'expiresOn must not be before startsOn',
        HTTP_STATUS.BAD_REQUEST,
        { startsOn: command.startsOn, expiresOn: command.expiresOn },
      );
    }

    const request: IdempotentRequest = {
      scope: 'hour-manual-grant',
      actorId: context.actorId,
      key: context.idempotencyKey,
      requestHash: stableHash({
        studentId: command.studentId,
        courseId: command.courseId,
        units: command.units,
        startsOn: command.startsOn,
        expiresOn: command.expiresOn,
        reason: command.reason,
        intent: 'manual-grant',
      }),
    };
    return this.idempotency.execute<HourPostingResult>(request, (tx) =>
      this.grantManualInTx(tx, command, units, startsOn, expiresOn, context),
    );
  }

  private async grantManualInTx(
    tx: Prisma.TransactionClient,
    command: ManualGrantCommand,
    units: Prisma.Decimal,
    startsOn: Date,
    expiresOn: Date,
    context: CommandContext,
  ): Promise<HourPostingResult> {
    // 1. Create the separate MANUAL CoursePackage on this tx. The package
    //    starts at ZERO available; the grant posting below lands the units and
    //    reconciles the balance (mirroring how `grantOrder` expects the
    //    caller-created package to start at 0). `granted` records the nominal
    //    grant total up-front for display/audit. No sourceOrderItem link —
    //    manual packages are not tied to an order.
    const pkg = await tx.coursePackage.create({
      data: {
        studentId: command.studentId,
        courseId: command.courseId,
        sourceType: COURSE_PACKAGE_SOURCE.MANUAL,
        sourceOrderItemId: null,
        startsOn,
        expiresOn,
        granted: units,
        available: 0,
        reserved: 0,
        consumed: 0,
        expired: 0,
        status: COURSE_PACKAGE_STATUS.ACTIVE,
      },
    });

    // 2. Lock the balance + the just-created package, then post the grant on
    //    the same tx. The businessKey anchors idempotency at the ledger level
    //    (in addition to IdempotencyService's record-level dedup).
    const balance = await this.locks.lockBalance(tx, command.studentId, command.courseId);
    const locked = await this.locks.lockPackages(tx, [pkg.id]);
    const lockedPkg = locked[0];
    if (!lockedPkg) {
      // Unreachable: we just created the package on this tx.
      throw BusinessError.internal('Manually-granted package missing after create');
    }
    const packagesById = new Map<string, LockedPackage>([[lockedPkg.id, lockedPkg]]);

    const txDeltas: Buckets = {
      available: units,
      reserved: zeroBuckets().reserved,
      consumed: zeroBuckets().consumed,
      expired: zeroBuckets().expired,
    };

    return this.applyPosting(tx, {
      studentId: command.studentId,
      courseId: command.courseId,
      type: HOUR_TRANSACTION_TYPE.MANUAL_GRANT,
      businessKey: `manual-grant:${context.idempotencyKey}`,
      occurredAt: new Date(),
      reason: command.reason,
      balance,
      txDeltas,
      allocations: [
        {
          packageId: lockedPkg.id,
          sourceType: HOUR_ALLOCATION_SOURCE.MANUAL_GRANT,
          sourceId: context.actorId,
          deltas: txDeltas,
        },
      ],
      packagesById,
    });
  }

  // ── debitManual (Task 10) ─────────────────────────────────────────────

  /**
   * Admin-initiated manual debit. Draws `units` from `available` across the
   * student's eligible packages via FEFO (earliest-expiring first), appending a
   * `MANUAL_DEDUCT` HourTransaction with one HourAllocation per package slice.
   * Idempotent on `context.idempotencyKey`.
   *
   * ## Overdraft / concurrency guard
   *
   * The balance row is locked FOR UPDATE (via {@link HourLockRepository}) and
   * `available - units` is recomputed in `Prisma.Decimal` UNDER THE LOCK. Two
   * concurrent debits with DIFFERENT keys both want the final 2.00: the row
   * lock serializes them; the second debit's locking read observes the first's
   * committed `available = 0.00`, recomputes `0.00 - 2.00 < 0`, and throws
   * `INSUFFICIENT_HOURS` (HTTP 409) — exactly one debit fulfills. This is the
   * brief's "allows only one concurrent debit of the final hours" case: NOT a
   * same-key idempotency dedup, but a balance-overdraw guard via the row lock.
   *
   * `reason` MUST be nonblank. `reserved` is never touched by a manual debit
   * (M1 only moves available), so reserved cannot go negative either.
   */
  async debitManual(
    command: ManualDebitCommand,
    context: CommandContext,
  ): Promise<HourPostingResult> {
    assertNonblankReason(command.reason);
    const units = parsePositiveUnits(command.units);

    const request: IdempotentRequest = {
      scope: 'hour-manual-debit',
      actorId: context.actorId,
      key: context.idempotencyKey,
      requestHash: stableHash({
        studentId: command.studentId,
        courseId: command.courseId,
        units: command.units,
        reason: command.reason,
        intent: 'manual-debit',
      }),
    };
    return this.idempotency.execute<HourPostingResult>(request, (tx) =>
      this.debitManualInTx(tx, command, units, context),
    );
  }

  private async debitManualInTx(
    tx: Prisma.TransactionClient,
    command: ManualDebitCommand,
    units: Prisma.Decimal,
    context: CommandContext,
  ): Promise<HourPostingResult> {
    // 1. Lock the balance row FIRST (the overdraw guard's serialization point).
    const balance = await this.locks.lockBalance(tx, command.studentId, command.courseId);

    // 2. Overdraw guard: recompute available UNDER THE LOCK in Decimal. The
    //    locked read reflects the latest committed state (locking reads bypass
    //    the RR snapshot), so a concurrent debit that already committed is
    //    visible here and we reject rather than go negative.
    if (balance.buckets.available.minus(units).lt(0)) {
      throw new BusinessError(
        ERROR_CODES.INSUFFICIENT_HOURS,
        'Manual debit would make available balance negative',
        HTTP_STATUS.CONFLICT,
        {
          studentId: command.studentId,
          courseId: command.courseId,
          available: to2dp(balance.buckets.available),
          requested: to2dp(units),
        },
      );
    }

    // 3. Fetch + lock the eligible packages (ACTIVE with available > 0) in
    //    FEFO order. We lock by id after a plain SELECT so the lock set matches
    //    exactly the packages we will draw from. Eligible = same student+course,
    //    ACTIVE, available > 0, and not yet expired-status.
    const eligibleRows = await tx.coursePackage.findMany({
      where: {
        studentId: command.studentId,
        courseId: command.courseId,
        status: COURSE_PACKAGE_STATUS.ACTIVE,
        available: { gt: 0 },
      },
      select: { id: true },
    });
    const eligibleIds = eligibleRows.map((r) => r.id);
    const lockedPkgs = await this.locks.lockPackages(tx, eligibleIds);

    // 4. Run the FEFO allocator against the LOCKED rows (their `available`
    //    values are current as of the lock). The allocator never over-draws a
    //    single package; combined with the balance overdraw guard above, the
    //    total drawn equals exactly `units` (we already proved Σ available ≥
    //    units via the balance check, and Σ package.available === balance.
    //    available by the reconcilability invariant).
    const allocatable: AllocatablePackage[] = lockedPkgs.map((p) => ({
      packageId: p.id,
      expiresOn: p.expiresOn,
      createdAt: p.createdAt,
      available: p.buckets.available,
    }));
    const slices = allocate(units, allocatable);

    // 5. Build the per-package delta buckets (availableDelta negated per slice;
    //    other buckets zero — M1 manual debit only moves `available`) and the
    //    summary tx deltas (Σ slices negated on available).
    const packagesById = new Map<string, LockedPackage>(
      lockedPkgs.map((p) => [p.id, p]),
    );
    let drawnAcc = new Prisma.Decimal('0.00');
    const allocations = slices.map((s) => {
      const sliceUnits = toDecimal(s.units);
      drawnAcc = drawnAcc.plus(sliceUnits);
      const deltas: Buckets = {
        available: sliceUnits.negated(),
        reserved: zeroBuckets().reserved,
        consumed: zeroBuckets().consumed,
        expired: zeroBuckets().expired,
      };
      return {
        packageId: s.packageId,
        sourceType: HOUR_ALLOCATION_SOURCE.MANUAL_ADJUSTMENT,
        sourceId: context.actorId,
        deltas,
      };
    });

    // Defense-in-depth: if no slice was produced (e.g. eligible packages had
    // available but the allocator found none — shouldn't happen given the
    // balance check), reject as insufficient rather than posting a zero debit.
    if (allocations.length === 0) {
      throw new BusinessError(
        ERROR_CODES.INSUFFICIENT_HOURS,
        'No eligible packages available for manual debit',
        HTTP_STATUS.CONFLICT,
        {
          studentId: command.studentId,
          courseId: command.courseId,
          requested: to2dp(units),
        },
      );
    }

    const txDeltas: Buckets = {
      available: drawnAcc.negated(),
      reserved: zeroBuckets().reserved,
      consumed: zeroBuckets().consumed,
      expired: zeroBuckets().expired,
    };

    return this.applyPosting(tx, {
      studentId: command.studentId,
      courseId: command.courseId,
      type: HOUR_TRANSACTION_TYPE.MANUAL_DEDUCT,
      businessKey: `manual-debit:${context.idempotencyKey}`,
      occurredAt: new Date(),
      reason: command.reason,
      balance,
      txDeltas,
      allocations,
      packagesById,
    });
  }

  // ── expireAvailable (Task 10) ─────────────────────────────────────────

  /**
   * Move a package's entire `available` bucket to `expired`: append an
   * `EXPIRE` HourTransaction with `availableDelta = -available,
   * expiredDelta = +available`, plus one HourAllocation against the package
   * carrying the same deltas, and flip the package status to EXPIRED (if it has
   * no remaining hours) or leave it ACTIVE. Idempotent on `businessKey`
   * (typically `expiry:<packageId>:<businessDate>`) — a replay returns the
   * original result with no side effects.
   *
   * Must run inside the caller's transaction (the expiration service opens one
   * locked tx per package). `reserved`/`consumed` are NEVER touched by expiry
   * (M1 only expires available units).
   */
  async expireAvailable(
    tx: Prisma.TransactionClient,
    packageId: string,
    businessKey: string,
  ): Promise<HourPostingResult> {
    // ── Idempotency fast-path on the expiry businessKey ──
    const existing = await tx.hourTransaction.findUnique({
      where: { businessKey },
      include: { allocations: true },
    });
    if (existing) {
      return this.replayResultFromExisting(tx, existing);
    }

    // ── Resolve the package's (studentId, courseId) with a NON-locking read ──
    // (we need the FK values to lock the right balance row, and lockPackageById
    // does not return them). The package row is then re-locked FOR UPDATE under
    // the balance lock below, so the gap between this read and that lock is
    // covered by the balance lock serializing against other posters on the
    // same (studentId, courseId).
    const pkgHeader = await tx.coursePackage.findUnique({
      where: { id: packageId },
      select: { studentId: true, courseId: true },
    });
    if (!pkgHeader) {
      throw BusinessError.notFound('Course package not found for expiry', { packageId });
    }

    // ── Lock order: balance FIRST, then the package — matches grantOrder/ ──
    // reverseOrder/debitManual so there is no cross-deadlock with any other
    // poster on the same (studentId, courseId).
    const balance = await this.locks.lockBalance(tx, pkgHeader.studentId, pkgHeader.courseId);
    const lockedPkgs = await this.locks.lockPackages(tx, [packageId]);
    const pkg = lockedPkgs[0];
    if (!pkg) {
      throw BusinessError.notFound('Course package not found for expiry', { packageId });
    }

    // Expire ONLY available units. A package with available <= 0 has nothing
    // to expire; rather than consuming the businessKey with a zero-delta row,
    // skip the posting entirely. The caller (expiration service) pre-filters
    // available > 0, but defend here too.
    const available = pkg.buckets.available;
    if (available.lte(0)) {
      // Return a synthesized no-op result without writing a transaction row.
      // The businessKey is NOT consumed, so a later run (if available ever
      // becomes positive again — e.g. a fresh grant into this package) can
      // still expire using the same key.
      return {
        transactionId: '',
        balanceId: balance.id,
        allocations: [],
        balance: bucketsToSummary(balance.buckets),
      };
    }

    const packagesById = new Map<string, LockedPackage>([[pkg.id, pkg]]);
    const txDeltas: Buckets = {
      available: available.negated(),
      reserved: zeroBuckets().reserved,
      consumed: zeroBuckets().consumed,
      expired: available,
    };

    const result = await this.applyPosting(tx, {
      studentId: pkgHeader.studentId,
      courseId: pkgHeader.courseId,
      type: HOUR_TRANSACTION_TYPE.EXPIRE,
      businessKey,
      occurredAt: new Date(),
      reason: 'daily expiration',
      balance,
      txDeltas,
      allocations: [
        {
          packageId: pkg.id,
          sourceType: HOUR_ALLOCATION_SOURCE.EXPIRE,
          sourceId: pkg.id,
          deltas: txDeltas,
        },
      ],
      packagesById,
    });

    // A package whose available just went to 0 is EXPIRED. Bounded UPDATE
    // (`available = 0`) so it only fires when truly drained; the package X
    // lock is held for the whole tx so no concurrent post can interleave.
    await tx.$executeRaw`
      UPDATE \`course_package\`
      SET \`status\`   = ${COURSE_PACKAGE_STATUS.EXPIRED},
          \`version\`   = \`version\` + 1,
          \`updatedAt\` = UTC_TIMESTAMP(3)
      WHERE \`id\` = ${packageId} AND \`available\` = 0
    `;

    return result;
  }



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

// ── Task 10 manual-adjustment helpers ───────────────────────────────────

/**
 * Reject a blank/whitespace-only reason. A manual adjustment MUST carry an
 * auditable reason; without one the call is invalid before any DB write.
 * Trimmed emptiness (incl. strings of only spaces) → 400 VALIDATION_FAILED.
 */
function assertNonblankReason(reason: unknown): void {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new BusinessError(
      ERROR_CODES.VALIDATION_FAILED,
      'reason must be a non-blank string',
      HTTP_STATUS.BAD_REQUEST,
      { reason },
    );
  }
}

/**
 * Parse a decimal-string units value, asserting it is a finite, strictly
 * positive Decimal. Rejects non-numeric, zero, and negative inputs as
 * `HOURS_MUST_BE_POSITIVE` (422). Returns the `Prisma.Decimal` form — all
 * downstream arithmetic stays in Decimal (never JS number, per the global
 * constraint).
 */
function parsePositiveUnits(units: unknown): Prisma.Decimal {
  if (typeof units !== 'string' || units.trim().length === 0) {
    throw new BusinessError(
      ERROR_CODES.VALIDATION_FAILED,
      'units must be a non-blank decimal string',
      HTTP_STATUS.BAD_REQUEST,
      { units },
    );
  }
  let parsed: Prisma.Decimal;
  try {
    parsed = new Prisma.Decimal(units.trim());
  } catch {
    throw new BusinessError(
      ERROR_CODES.VALIDATION_FAILED,
      'units must be a valid decimal string',
      HTTP_STATUS.BAD_REQUEST,
      { units },
    );
  }
  if (!parsed.isFinite() || parsed.lte(0)) {
    throw new BusinessError(
      ERROR_CODES.HOURS_MUST_BE_POSITIVE,
      'units must be greater than 0',
      HTTP_STATUS.UNPROCESSABLE_ENTITY,
      { units },
    );
  }
  return parsed;
}

/**
 * Parse a `YYYY-MM-DD` business-date string into a UTC-midnight Date for the
 * `@db.Date` columns (`startsOn`/`expiresOn`). The schema stores date-only
 * columns without timezone, so we anchor at UTC 00:00 to preserve the exact
 * year/month/day the caller supplied. Rejects malformed dates as 400.
 */
function parseBusinessDate(value: unknown, field: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BusinessError(
      ERROR_CODES.VALIDATION_FAILED,
      `${field} must be a YYYY-MM-DD string`,
      HTTP_STATUS.BAD_REQUEST,
      { field, value },
    );
  }
  // Validate the actual calendar date (rejects 2026-13-40 etc.).
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new BusinessError(
      ERROR_CODES.VALIDATION_FAILED,
      `${field} is not a valid calendar date`,
      HTTP_STATUS.BAD_REQUEST,
      { field, value },
    );
  }
  return date;
}

/**
 * Build a deterministic request hash for an idempotency key. Two requests that
 * carry the same key MUST carry the same body (per the idempotency contract); a
 * mismatched hash surfaces as `IDEMPOTENCY_KEY_REUSED` (409). Mirrors the
 * implementation in OfflineOrderService — FNV-1a (32-bit) over sorted-key JSON
 * of the identifying fields. Kept local (not shared) so the hours module has no
 * cross-module helper dependency for a 10-line function.
 */
function stableHash(value: Record<string, unknown>): string {
  const json = JSON.stringify(sortKeys(value));
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}
