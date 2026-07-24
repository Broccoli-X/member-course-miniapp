export type ErrorDetails = Record<string, unknown>;

export interface BusinessErrorShape {
  code: string;
  message: string;
  httpStatus: number;
  traceId?: string;
  details?: ErrorDetails;
}

export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  STATE_CHANGED: 'STATE_CHANGED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  STUDENT_FORBIDDEN: 'STUDENT_FORBIDDEN',
  ADMIN_LOGIN_LOCKED: 'ADMIN_LOGIN_LOCKED',
  /**
   * Raised when a mini-program phone-binding transaction detects that the
   * pre-created member account that owns the verified phone already owns a
   * *different* WeChat identity. Mapped to HTTP 409 CONFLICT, but kept distinct
   * from {@link STATE_CHANGED} so callers can surface a specific message.
   */
  PHONE_BINDING_CONFLICT: 'PHONE_BINDING_CONFLICT',
  /**
   * Raised when a money/hours decimal string carries more than two fractional
   * digits (e.g. `'100.001'`). Catalog package-product validation maps this to
   * HTTP 422 — the schema stores `Decimal(10,2)`, so extra scale would be
   * silently truncated on write; reject it up-front instead.
   */
  DECIMAL_SCALE_INVALID: 'DECIMAL_SCALE_INVALID',
  /**
   * Raised when a package product's `hours` field is not strictly positive
   * (e.g. `'0.00'`). Hours represent lesson quantity and must be > 0.
   */
  HOURS_MUST_BE_POSITIVE: 'HOURS_MUST_BE_POSITIVE',
  /**
   * Raised when a package product's `validDays` field is not a positive
   * integer (e.g. `0`). Valid days represent an expiry duration and must be > 0.
   */
  VALID_DAYS_INVALID: 'VALID_DAYS_INVALID',
  /**
   * Raised when reversing a CONFIRMED order whose lesson-hour package already
   * has a posting (consumption/adjustment) after the original GRANT. A package
   * with downstream activity cannot be cleanly reversed — the order must be
   * reversed before any consumption. Mapped to HTTP 409 CONFLICT.
   */
  ORDER_NOT_REVERSIBLE: 'ORDER_NOT_REVERSIBLE',
  /**
   * Raised when a manual debit (or any draw) would make `available` negative.
   * The balance row is locked FOR UPDATE and `available - units` is recomputed
   * in Prisma.Decimal under the lock; if it would go below zero the debit is
   * rejected. Mapped to HTTP 409 CONFLICT (the available balance is the
   * conflicting state). Also covers the "two concurrent debits of the final
   * hours" race: the second debit's locking read observes the first's commit
   * and rejects rather than overdrawing.
   */
  INSUFFICIENT_HOURS: 'INSUFFICIENT_HOURS',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_ERROR: 500,
} as const;
