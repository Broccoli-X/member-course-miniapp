/**
 * Request DTOs for the admin manual-hour-adjustment endpoints (Task 10).
 *
 * These mirror {@link ManualGrantCommand} / {@link ManualDebitCommand}. The
 * `studentId`/`courseId` come from the path; `units` is a decimal string;
 * `startsOn`/`expiresOn` are `YYYY-MM-DD` Shanghai business dates. The service
 * layer enforces the nonblank-reason and positive-units rules (it owns the
 * BusinessError mapping); the DTOs carry the raw wire values.
 */

/** Body of `POST /api/admin/v1/students/:studentId/courses/:courseId/hour-adjustments/grant`. */
export class ManualGrantAdjustmentDto {
  /** Decimal string, e.g. `"2.00"`. Must be > 0. */
  units!: string;
  /** `YYYY-MM-DD` Shanghai business date — the package's first valid day. */
  startsOn!: string;
  /** `YYYY-MM-DD` Shanghai business date — inclusive last valid day. */
  expiresOn!: string;
  /** Nonblank admin-supplied reason (audited on the HourTransaction row). */
  reason!: string;
}

/** Body of `POST /api/admin/v1/students/:studentId/courses/:courseId/hour-adjustments/debit`. */
export class ManualDebitAdjustmentDto {
  /** Decimal string, e.g. `"2.00"`. Must be > 0. */
  units!: string;
  /** Nonblank admin-supplied reason (audited on the HourTransaction row). */
  reason!: string;
}
