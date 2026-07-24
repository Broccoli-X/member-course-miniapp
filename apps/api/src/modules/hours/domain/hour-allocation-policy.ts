import { Prisma } from '../../../generated/prisma/client.js';
import { to2dp } from './hour-buckets.js';

/**
 * FEFO (First-Expiry-First-Out) allocation policy.
 *
 * When a delta needs to be distributed across multiple eligible
 * `CoursePackage` rows (e.g. consumption draws from the earliest-expiring
 * package first; a reversal restores to the packages the original grant
 * touched), the policy is: order packages by
 *
 *     (expiresOn ASC, createdAt ASC, id ASC)
 *
 * and fill them in order until the requested total is exhausted or every
 * package's `available` is consumed.
 *
 * This file is PURE — no Prisma client, no DB. Only `Prisma.Decimal` for exact
 * arithmetic. The unit spec exercises it directly under the default vitest
 * config.
 */

/**
 * The shape `allocate()` needs from a `CoursePackage`. Narrow on purpose so the
 * policy is testable without a DB row: callers project their package list to
 * this shape.
 */
export interface AllocatablePackage {
  packageId: string;
  /** Date the package expires (earlier = drawn first). */
  expiresOn: Date;
  /** Tie-breaker #1 when two packages share an expiry. */
  createdAt: Date;
  /** Currently-available units in the package (>=0). */
  available: Prisma.Decimal;
}

/** A single allocation slice. */
export interface AllocationResult {
  packageId: string;
  /** 2-dp string of units allocated to this package. */
  units: string;
}

/**
 * Allocate `total` units across `packages` using FEFO. Returns the allocation
 * slices in the SAME order they were filled (earliest-expiring first). Never
 * over-allocates: if `total` exceeds Σ package.available, the result's units
 * sum is less than `total` and each entry is bounded by its package's
 * available. Zero/negative-available packages are skipped. A zero total yields
 * no allocations.
 *
 * The sort key is (expiresOn ASC, createdAt ASC, packageId ASC). `packageId`
 * (a uuid) is the final deterministic tie-breaker so two packages that tie on
 * both dates are still ordered consistently across runs and across machines.
 *
 * NOTE: the result `units` is a 2-dp STRING (not a Decimal) because the brief's
 * verbatim test compares against string literals like `'2.00'`. The caller can
 * re-parse with `Prisma.Decimal` if it needs to do more arithmetic.
 */
export function allocate(
  total: Prisma.Decimal | string | number,
  packages: readonly AllocatablePackage[],
): AllocationResult[] {
  const remaining0 = new Prisma.Decimal(total);
  // Zero (or negative) total → nothing to allocate. (Negative should never
  // happen for a grant/consume, but the function is total: return empty.)
  if (remaining0.lte(0)) {
    return [];
  }

  // Defensive copy then stable sort by (expiresOn, createdAt, id). `.slice()`
  // also decouples us from the caller's array so we don't mutate input order.
  const ordered = packages.slice().sort(comparePackagesFEFO);

  const out: AllocationResult[] = [];
  let remaining = remaining0;
  for (const p of ordered) {
    if (remaining.lte(0)) break;
    // Skip packages that can't supply anything.
    if (p.available.lte(0)) continue;
    // Take the smaller of (what we still need, what this package has).
    const take = remaining.lt(p.available) ? remaining : p.available;
    out.push({ packageId: p.packageId, units: to2dp(take) });
    remaining = remaining.minus(take);
  }
  return out;
}

/**
 * Comparator implementing the FEFO ordering: expiresOn ASC, then createdAt ASC,
 * then packageId ASC. Used both by {@link allocate} and by callers that need to
 * fetch/lock eligible packages in the same deterministic order (the lock
 * repository orders its SELECT by these columns for that reason).
 */
export function comparePackagesFEFO(
  a: AllocatablePackage,
  b: AllocatablePackage,
): number {
  const byExpiry = a.expiresOn.getTime() - b.expiresOn.getTime();
  if (byExpiry !== 0) return byExpiry;
  const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
  if (byCreated !== 0) return byCreated;
  // UUID strings — locale-independent lexical compare.
  return a.packageId < b.packageId ? -1 : a.packageId > b.packageId ? 1 : 0;
}
