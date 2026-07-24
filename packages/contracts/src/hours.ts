// Lesson-hour accounting contracts.
//
// The Hour Ledger is the append-only accounting core of the system. Money and
// lesson-hours are the highest-stakes data in the product, so the contracts
// here are deliberately narrow: every decimal is a 2-dp string on the wire
// (per the global constraint), and the only mutators exposed are the two
// posting operations (`grantOrder`/`reverseOrder`). HourTransaction and
// HourAllocation rows are NEVER updated or deleted — the service layer has no
// update/delete path for them; a reversal is a brand-new REVERSAL transaction
// with negated deltas.

/** A decimal value serialized as a string (e.g. `"2.00"`). Re-exported here for ergonomics. */
export type DecimalString = string;

/** Transaction type recorded on `HourTransaction.type`. */
export const HOUR_TRANSACTION_TYPE = {
  /** Hours granted to a student via a confirmed offline order. */
  GRANT: 'GRANT',
  /** Hours consumed by a booking/attendance (future milestone). */
  DEBIT: 'DEBIT',
  /** Hours granted manually by an admin (Adjustments module, Task 10). */
  MANUAL_GRANT: 'MANUAL_GRANT',
  /** Hours deducted manually by an admin (Adjustments module, Task 10). */
  MANUAL_DEDUCT: 'MANUAL_DEDUCT',
  /** Negates a prior GRANT/DEBIT — never mutates the original. */
  REVERSAL: 'REVERSAL',
  /** Hours moved from `available` to `expired` by the daily expiry job (Task 10). */
  EXPIRE: 'EXPIRE',
} as const;

export type HourTransactionType =
  (typeof HOUR_TRANSACTION_TYPE)[keyof typeof HOUR_TRANSACTION_TYPE];

/** Where an `HourAllocation` draws its package bucket from. */
export const HOUR_ALLOCATION_SOURCE = {
  ORDER: 'ORDER',
  MANUAL_GRANT: 'MANUAL_GRANT',
  MANUAL_ADJUSTMENT: 'MANUAL_ADJUSTMENT',
  /** An expiry posting moving available→expired (Task 10 daily job). */
  EXPIRE: 'EXPIRE',
} as const;

export type HourAllocationSource =
  (typeof HOUR_ALLOCATION_SOURCE)[keyof typeof HOUR_ALLOCATION_SOURCE];

/** CoursePackage status. */
export const COURSE_PACKAGE_STATUS = {
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  EXHAUSTED: 'EXHAUSTED',
} as const;

/**
 * CoursePackage `sourceType` (mirrors the schema's VarChar(20)).
 *
 * NOTE on the MANUAL vs MANUAL_GRANT reconciliation: the schema comment for
 * `CoursePackage.sourceType` lists `ORDER | MANUAL_GRANT | MANUAL_ADJUSTMENT`,
 * but Task 10's verbatim integration test asserts
 * `expect(await latestPackage()).toMatchObject({ sourceType: 'MANUAL', ... })`.
 * The column is free-text `VarChar(20)` (no DB enum), so either value stores
 * fine. Per the task instructions ("Check what the test literally asserts and
 * make the code match it"), `grantManual` writes `sourceType: 'MANUAL'`. We
 * keep `MANUAL_GRANT`/`MANUAL_ADJUSTMENT` in the constant union for callers
 * that prefer the more specific labels, but the manual-grant path uses the
 * bare `MANUAL` token to satisfy the test contract.
 */
export const COURSE_PACKAGE_SOURCE = {
  ORDER: 'ORDER',
  /** Used by `grantManual` — the verbatim Task 10 test asserts this exact token. */
  MANUAL: 'MANUAL',
  MANUAL_GRANT: 'MANUAL_GRANT',
  MANUAL_ADJUSTMENT: 'MANUAL_ADJUSTMENT',
} as const;

/**
 * Input to {@link HourLedgerService.grantOrder}. All decimals are strings to
 * keep precision on the wire. `businessKey` is the idempotency anchor: a
 * second grant with the SAME businessKey is a no-op returning the original
 * result. Callers (Orders module, Task 9) typically derive it as
 * `order-grant:${orderItemId}`.
 */
export interface GrantOrderHoursInput {
  orderId: string;
  orderItemId: string;
  studentId: string;
  courseId: string;
  /** Pre-created CoursePackage id (created by the caller before grant). */
  packageId: string;
  units: DecimalString;
  occurredAt: Date;
  businessKey: string;
}

/**
 * Input to {@link HourLedgerService.reverseOrder}. The reversal references the
 * original GRANT transaction by id and writes a brand-new REVERSAL transaction
 * with negated deltas; the original is never mutated.
 */
export interface ReverseOrderHoursInput {
  orderId: string;
  orderItemId: string;
  originalTransactionId: string;
  occurredAt: Date;
  businessKey: string;
  reason: string;
}

/**
 * Per-allocation slice of {@link HourPostingResult}. Six fields, fixed by the
 * M1 plan: the package the hours landed in, its expiry (so the caller can show
 * "expires YYYY-MM-DD"), the units allocated, and the four bucket deltas.
 */
export interface HourPostingAllocation {
  packageId: string;
  /** `YYYY-MM-DD` (UTC) of the package's `expiresOn`. */
  packageExpiresOn: string;
  units: DecimalString;
  availableDelta: DecimalString;
  reservedDelta: DecimalString;
  consumedDelta: DecimalString;
  expiredDelta: DecimalString;
}

/**
 * Summary balance snapshot returned after a posting. These mirror
 * `StudentCourseBalance` AFTER the posting has been applied, rendered as 2-dp
 * strings.
 */
export interface HourBalanceSummary {
  available: DecimalString;
  reserved: DecimalString;
  consumed: DecimalString;
  expired: DecimalString;
}

/**
 * Result shape produced by `grantOrder`/`reverseOrder` (defined verbatim in the
 * M1 plan preamble). Every decimal is a 2-dp string. The `balance` snapshot
 * always satisfies the reconcilability invariant:
 *
 *     balance.available === Σ HourTransaction.availableDelta
 *                             for (studentId, courseId)
 *
 * (likewise for reserved/consumed/expired).
 */
export interface HourPostingResult {
  transactionId: string;
  balanceId: string;
  allocations: HourPostingAllocation[];
  balance: HourBalanceSummary;
}

// ── Task 10: manual adjustments + daily expiration ──────────────────────

/**
 * Input to `HourLedgerService.grantManual` (Task 10). Creates a SEPARATE
 * `CoursePackage` with `sourceType: MANUAL` and posts a `MANUAL_GRANT`
 * HourTransaction. `startsOn`/`expiresOn` are `YYYY-MM-DD` strings (Shanghai
 * business dates) — the service parses them to UTC-midnight Dates for the
 * `@db.Date` columns. A nonblank `reason` is required (auditable adjustment).
 */
export interface ManualGrantCommand {
  studentId: string;
  courseId: string;
  units: DecimalString;
  /** `YYYY-MM-DD` Shanghai business date. */
  startsOn: string;
  /** `YYYY-MM-DD` Shanghai business date. */
  expiresOn: string;
  /** Nonblank admin-supplied reason (audited on the HourTransaction row). */
  reason: string;
}

/**
 * Input to `HourLedgerService.debitManual` (Task 10). Draws `units` from
 * `available` across eligible packages via FEFO (earliest-expiring first) and
 * posts a `MANUAL_DEDUCT` HourTransaction with one HourAllocation per package
 * slice. Never makes `available` or `reserved` negative — a debit that would
 * overdraw is rejected with `INSUFFICIENT_HOURS`. Nonblank `reason` required.
 */
export interface ManualDebitCommand {
  studentId: string;
  courseId: string;
  units: DecimalString;
  /** Nonblank admin-supplied reason (audited on the HourTransaction row). */
  reason: string;
}

/**
 * Result of `HourExpirationService.expireDuePackages(now, batchSize)` (Task 10
 * daily job). `scanned` = packages examined, `processed` = successfully
 * expired (available→expired moved), `failed` = packages whose expiry raised
 * (one bad package does NOT abort the batch — the catch is per-package).
 */
export interface ExpireBatchResult {
  scanned: number;
  processed: number;
  failed: number;
}
