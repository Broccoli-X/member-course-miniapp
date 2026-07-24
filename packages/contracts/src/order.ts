/**
 * Offline order contracts (Task 9).
 *
 * Offline orders are recorded by administrators only — there is no mini-program
 * order creation, online payment, or refund (M1 global constraint). An order is
 * created as a PENDING draft that freezes a product snapshot (name, unit price,
 * hours, valid days), then CONFIRMED in a single transaction that creates one
 * CoursePackage per item and posts a GRANT into the lesson-hour ledger, or
 * VOIDED while still a draft, or REVERSED after confirmation (which appends a
 * REVERSAL into the ledger).
 *
 * Every money/hours value is a 2-dp decimal string on the wire (global
 * constraint: never represent money/hours as a JS `number`).
 */

// ── Enumerations ──────────────────────────────────────────────────────────

/** Status values stored on `OfflineOrder.status` and surfaced on the wire. */
export const OFFLINE_ORDER_STATUS = {
  /** Draft created, not yet confirmed; no packages granted. */
  PENDING: 'PENDING',
  /** Confirmed: packages created, hours granted. */
  CONFIRMED: 'CONFIRMED',
  /** A confirmed order whose grants have been reversed. Terminal. */
  REVERSED: 'REVERSED',
  /**
   * A draft voided before confirmation. The schema has no VOIDED column value,
   * so a voided draft is physically removed (it had no packages/grants); this
   * constant exists only so callers can name the intent. NOT persisted as a
   * row status.
   */
  VOIDED: 'VOIDED',
} as const;
export type OfflineOrderStatus =
  (typeof OFFLINE_ORDER_STATUS)[keyof typeof OFFLINE_ORDER_STATUS];

// ── Wire shapes ────────────────────────────────────────────────────────────

/** Serializable representation of one order item, with its frozen snapshot. */
export interface OfflineOrderItemDto {
  readonly id: string;
  readonly orderId: string;
  readonly studentId: string;
  readonly productId: string;
  readonly courseId: string;
  /** Frozen at draft time from `PackageProduct.name`. */
  readonly productNameSnapshot: string;
  /** Frozen at draft time; 2-dp decimal string, e.g. `"100.00"`. */
  readonly unitPriceSnapshot: string;
  /** Frozen at draft time; 2-dp decimal string, e.g. `"10.00"`. */
  readonly hoursSnapshot: string;
  /** Frozen at draft time. */
  readonly validDaysSnapshot: number;
  /** The CoursePackage created at confirm time, or null before confirmation. */
  readonly coursePackageId: string | null;
  /** The GRANT HourTransaction id recorded at confirm time, or null. */
  readonly grantTransactionId: string | null;
  readonly version: number;
}

/** Serializable representation of an offline order with its items. */
export interface OfflineOrderDto {
  readonly id: string;
  readonly buyerAccountId: string;
  readonly status: OfflineOrderStatus | string;
  /** Total = Σ item.unitPriceSnapshot, as a 2-dp decimal string. */
  readonly totalAmount: string;
  /** ISO timestamp of confirmation, or null. */
  readonly confirmedAt: string | null;
  readonly items: ReadonlyArray<OfflineOrderItemDto>;
  readonly version: number;
}

// ── Admin request bodies ──────────────────────────────────────────────────

/** One line in a create-draft command. */
export interface CreateOfflineOrderItemInput {
  readonly studentId: string;
  readonly productId: string;
}

/** Body of `POST /api/admin/v1/orders` — create a PENDING draft. */
export interface CreateOfflineOrderCommand {
  readonly buyerAccountId: string;
  readonly items: ReadonlyArray<CreateOfflineOrderItemInput>;
}

/** Body of `POST /api/admin/v1/orders/:id/reverse`. */
export interface ReverseOfflineOrderCommand {
  /** Optional human-readable reason recorded on the reversal posting(s). */
  readonly reason?: string;
}
