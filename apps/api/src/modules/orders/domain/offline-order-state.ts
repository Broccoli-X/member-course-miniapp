import { Prisma } from '../../../generated/prisma/client.js';
import {
  ERROR_CODES,
  HTTP_STATUS,
  OFFLINE_ORDER_STATUS,
} from '@member-course/contracts';
import { BusinessError } from '../../../common/errors/business-error.js';

/**
 * Pure offline-order state-machine helpers (Task 9 domain layer).
 *
 * Everything here is a pure function — no DB, no Nest, no side effects — so the
 * transitions are unit-testable in isolation (see `offline-order-state.spec.ts`,
 * which runs under the default vitest glob). The application service calls these
 * to guard mutations; the guards throw {@link BusinessError} (mapped to HTTP 409
 * `STATE_CHANGED`) when a transition isn't allowed, so the global filter turns a
 * bad transition into a clean 409 instead of a silent status flip.
 *
 * Persisted statuses are exactly PENDING | CONFIRMED | REVERSED (schema enum).
 * The state machine:
 *
 *     PENDING --confirm--> CONFIRMED
 *     PENDING --void----> (deleted; no VOIDED row status exists)
 *     CONFIRMED --reverse--> REVERSED
 *     REVERSED: terminal
 */

/** Persisted order statuses the state machine reasons about. */
export type PersistedOrderStatus =
  | typeof OFFLINE_ORDER_STATUS.PENDING
  | typeof OFFLINE_ORDER_STATUS.CONFIRMED
  | typeof OFFLINE_ORDER_STATUS.REVERSED;

// ── Transition predicates ─────────────────────────────────────────────────

/** True when an order in `status` may be confirmed (PENDING → CONFIRMED). */
export function canConfirm(status: string): boolean {
  return status === OFFLINE_ORDER_STATUS.PENDING;
}

/**
 * True when an order in `status` may be voided. Voiding is only legal on a
 * PENDING draft (no packages granted yet); the schema has no VOIDED status, so
 * a voided draft is physically removed rather than status-flipped.
 */
export function canVoid(status: string): boolean {
  return status === OFFLINE_ORDER_STATUS.PENDING;
}

/** True when an order in `status` may be reversed (CONFIRMED → REVERSED). */
export function canReverse(status: string): boolean {
  return status === OFFLINE_ORDER_STATUS.CONFIRMED;
}

// ── Asserting variants (throw BusinessError on disallowed transitions) ─────

/** Throws `STATE_CHANGED` (409) unless the order is confirmable. */
export function assertCanConfirm(status: string): void {
  if (!canConfirm(status)) {
    throw new BusinessError(
      ERROR_CODES.STATE_CHANGED,
      `Order in status ${status} cannot be confirmed`,
      HTTP_STATUS.CONFLICT,
      { status, allowedFrom: OFFLINE_ORDER_STATUS.PENDING },
    );
  }
}

/** Throws `STATE_CHANGED` (409) unless the order is voidable. */
export function assertCanVoid(status: string): void {
  if (!canVoid(status)) {
    throw new BusinessError(
      ERROR_CODES.STATE_CHANGED,
      `Order in status ${status} cannot be voided`,
      HTTP_STATUS.CONFLICT,
      { status, allowedFrom: OFFLINE_ORDER_STATUS.PENDING },
    );
  }
}

/** Throws `STATE_CHANGED` (409) unless the order is reversible. */
export function assertCanReverse(status: string): void {
  if (!canReverse(status)) {
    throw new BusinessError(
      ERROR_CODES.STATE_CHANGED,
      `Order in status ${status} cannot be reversed`,
      HTTP_STATUS.CONFLICT,
      { status, allowedFrom: OFFLINE_ORDER_STATUS.CONFIRMED },
    );
  }
}

// ── Snapshot freezing ─────────────────────────────────────────────────────

/**
 * The four product fields frozen onto an OrderItem at draft time. Once frozen,
 * confirm reads THESE values (never the live product), so a later product edit
 * (price/hours change) does not alter an in-flight order. Money/hours are
 * `Prisma.Decimal` (not JS `number`) to preserve precision.
 */
export interface FrozenItemSnapshot {
  productNameSnapshot: string;
  unitPriceSnapshot: Prisma.Decimal;
  hoursSnapshot: Prisma.Decimal;
  validDaysSnapshot: number;
}

/**
 * Freeze a product's name/price/hours/validDays into an immutable snapshot for
 * an OrderItem. The returned Decimals are new `Prisma.Decimal` instances copied
 * from the source, so subsequent mutation of the source product's fields does
 * not move the snapshot.
 */
export function freezeItemSnapshot(product: {
  name: string;
  price: Prisma.Decimal | string;
  hours: Prisma.Decimal | string;
  validDays: number;
}): FrozenItemSnapshot {
  return {
    productNameSnapshot: product.name,
    unitPriceSnapshot: new Prisma.Decimal(product.price),
    hoursSnapshot: new Prisma.Decimal(product.hours),
    validDaysSnapshot: product.validDays,
  };
}
