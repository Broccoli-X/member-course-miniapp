import { Prisma } from '../../../generated/prisma/client.js';

/**
 * Pure decimal bucket arithmetic for the four-bucket lesson-hour model:
 * `available`, `reserved`, `consumed`, `expired`.
 *
 * The whole point of this module is to keep ALL money/hours math inside
 * `Prisma.Decimal` (never JavaScript `number`) so that 0.1 + 0.2 doesn't drift
 * and the balance stays exactly reconcilable against the sum of transaction
 * deltas. These helpers are shared between the service, the allocator, and the
 * serialization layer so the arithmetic rules live in exactly one place.
 *
 * A `Buckets` value is treated as immutable — every operation returns a NEW
 * `Buckets` object. Mutating the same object across multiple postings would
 * make reconciliation reasoning much harder.
 */

/** The four lesson-hour buckets, all `Prisma.Decimal`. */
export interface Buckets {
  available: Prisma.Decimal;
  reserved: Prisma.Decimal;
  consumed: Prisma.Decimal;
  expired: Prisma.Decimal;
}

/** A per-bucket delta — same shape as {@link Buckets} but conceptually a change. */
export type BucketDeltas = Buckets;

/** The four bucket keys in a stable order (used for iteration / serialization). */
export const BUCKET_KEYS = ['available', 'reserved', 'consumed', 'expired'] as const;
export type BucketKey = (typeof BUCKET_KEYS)[number];

/** The canonical zero buckets (2-dp zero on every bucket). */
export function zeroBuckets(): Buckets {
  return {
    available: new Prisma.Decimal('0.00'),
    reserved: new Prisma.Decimal('0.00'),
    consumed: new Prisma.Decimal('0.00'),
    expired: new Prisma.Decimal('0.00'),
  };
}

/** Build a Buckets value from four decimal-accepting inputs. */
export function buckets(
  available: Prisma.Decimal | string | number,
  reserved: Prisma.Decimal | string | number,
  consumed: Prisma.Decimal | string | number,
  expired: Prisma.Decimal | string | number,
): Buckets {
  return {
    available: toDecimal(available),
    reserved: toDecimal(reserved),
    consumed: toDecimal(consumed),
    expired: toDecimal(expired),
  };
}

/** Coerce any Prisma.Decimal-constructor-acceptable value to a `Prisma.Decimal`. */
export function toDecimal(value: Prisma.Decimal | string | number): Prisma.Decimal {
  // Re-wrap so callers can't mutate a shared instance. `Prisma.Decimal`
  // constructor is idempotent on a Decimal input.
  return new Prisma.Decimal(value);
}

/** Render a decimal as a fixed 2-dp string (the wire format for HourPostingResult). */
export function to2dp(value: Prisma.Decimal | string | number): string {
  return new Prisma.Decimal(value).toFixed(2);
}

/**
 * Add two buckets element-wise. Returns a NEW Buckets — inputs are untouched.
 * Used to fold per-transaction deltas into the running balance.
 */
export function addBuckets(a: Buckets, b: BucketDeltas): Buckets {
  return {
    available: a.available.plus(b.available),
    reserved: a.reserved.plus(b.reserved),
    consumed: a.consumed.plus(b.consumed),
    expired: a.expired.plus(b.expired),
  };
}

/**
 * Subtract deltas element-wise (`a - b`). Returns a NEW Buckets. Used to apply
 * a reversal's negated deltas as a subtraction of the original deltas.
 */
export function subtractBuckets(a: Buckets, b: BucketDeltas): Buckets {
  return {
    available: a.available.minus(b.available),
    reserved: a.reserved.minus(b.reserved),
    consumed: a.consumed.minus(b.consumed),
    expired: a.expired.minus(b.expired),
  };
}

/**
 * Negate every bucket of a delta. Used to build a REVERSAL transaction's
 * deltas from the original GRANT/DEBIT deltas — the reversal is appended as a
 * new transaction rather than mutating the original.
 */
export function negateBuckets(b: BucketDeltas): Buckets {
  return {
    available: b.available.negated(),
    reserved: b.reserved.negated(),
    consumed: b.consumed.negated(),
    expired: b.expired.negated(),
  };
}

/** Element-wise equality (used in tests / sanity checks). */
export function bucketsEqual(a: Buckets, b: Buckets): boolean {
  return (
    a.available.equals(b.available) &&
    a.reserved.equals(b.reserved) &&
    a.consumed.equals(b.consumed) &&
    a.expired.equals(b.expired)
  );
}

/**
 * Sum a list of bucket-deltas into a single total. Used by the reconcilability
 * check (Σ HourTransaction deltas must equal the balance). Empty → zero.
 */
export function sumBuckets(deltas: Iterable<BucketDeltas>): Buckets {
  let acc = zeroBuckets();
  for (const d of deltas) {
    acc = addBuckets(acc, d);
  }
  return acc;
}

/**
 * Snapshot a Buckets value to the wire shape (2-dp strings). Order matches the
 * `HourPostingResult.balance` interface exactly.
 */
export function bucketsToSummary(b: Buckets): {
  available: string;
  reserved: string;
  consumed: string;
  expired: string;
} {
  return {
    available: to2dp(b.available),
    reserved: to2dp(b.reserved),
    consumed: to2dp(b.consumed),
    expired: to2dp(b.expired),
  };
}
