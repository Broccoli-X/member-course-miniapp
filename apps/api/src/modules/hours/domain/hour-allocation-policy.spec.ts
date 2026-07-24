import { describe, it, expect } from 'vitest';
import { Prisma } from '../../../generated/prisma/client.js';
import { allocate, type AllocatablePackage } from './hour-allocation-policy.js';

/**
 * FEFO (First-Expiry-First-Out) allocator unit tests.
 *
 * Task 8 brief, Step 1 verbatim case plus the edge cases the brief enumerates.
 * The allocator is a PURE function — no DB, no Prisma other than
 * `Prisma.Decimal` for exact arithmetic. It runs under the default vitest
 * config (src modules .spec.ts) and must NOT touch MySQL.
 */

/** Build an `AllocatablePackage` for the test cases. `createdAt`/`expiresOn` accept ISO date strings. */
function pkg(
  packageId: string,
  expiresOn: string,
  createdAt: string,
  available: string,
): AllocatablePackage {
  return {
    packageId,
    expiresOn: new Date(`${expiresOn}T00:00:00.000Z`),
    createdAt: new Date(`${createdAt}T00:00:00.000Z`),
    available: new Prisma.Decimal(available),
  };
}

/** Coerce a result to the shape the brief asserts against for brevity. */
function slim(result: ReturnType<typeof allocate>): Array<{ packageId: string; units: string }> {
  return result.map((r) => ({ packageId: r.packageId, units: r.units }));
}

describe('allocate (FEFO)', () => {
  // ── Brief verbatim case ──────────────────────────────────────────────
  it('allocates by expiresOn, createdAt, and id', () => {
    const allocation = allocate(new Prisma.Decimal('5.00'), [
      pkg('b', '2026-08-31', '2026-07-02', '3.00'),
      pkg('a', '2026-08-31', '2026-07-01', '2.00'),
      pkg('c', '2026-09-30', '2026-07-01', '5.00'),
    ]);
    // a and b tie on expiresOn (2026-08-31); createdAt breaks the tie
    // (a: 07-01 before b: 07-02). c expires later so it is untouched.
    expect(slim(allocation)).toEqual([
      { packageId: 'a', units: '2.00' },
      { packageId: 'b', units: '3.00' },
    ]);
  });

  // ── Edge: total exceeds the sum of available → allocate ALL available ─
  it('allocates all available when total exceeds the sum of packages', () => {
    const allocation = allocate(new Prisma.Decimal('10.00'), [
      pkg('a', '2026-08-31', '2026-07-01', '2.00'),
      pkg('b', '2026-09-30', '2026-07-01', '3.00'),
    ]);
    expect(slim(allocation)).toEqual([
      { packageId: 'a', units: '2.00' },
      { packageId: 'b', units: '3.00' },
    ]);
    // No over-allocation — each entry's units equals its package's available.
    const total = allocation.reduce(
      (sum, r) => sum.plus(r.units),
      new Prisma.Decimal('0.00'),
    );
    expect(total.toFixed(2)).toBe('5.00'); // less than the requested 10.00
  });

  // ── Edge: total less than the first package → only one package used ───
  it('uses only the first-expiring package when total fits in it', () => {
    const allocation = allocate(new Prisma.Decimal('1.00'), [
      pkg('early', '2026-08-31', '2026-07-01', '5.00'),
      pkg('late', '2026-09-30', '2026-07-01', '5.00'),
    ]);
    expect(slim(allocation)).toEqual([{ packageId: 'early', units: '1.00' }]);
  });

  // ── Edge: zero total → no allocations ────────────────────────────────
  it('returns no allocations when total is zero', () => {
    const allocation = allocate(new Prisma.Decimal('0.00'), [
      pkg('a', '2026-08-31', '2026-07-01', '5.00'),
    ]);
    expect(allocation).toEqual([]);
  });

  // ── Edge: single package ─────────────────────────────────────────────
  it('allocates the full single package up to total', () => {
    const allocation = allocate(new Prisma.Decimal('3.00'), [
      pkg('only', '2026-08-31', '2026-07-01', '5.00'),
    ]);
    expect(slim(allocation)).toEqual([{ packageId: 'only', units: '3.00' }]);
  });

  // ── Edge: tie on all three keys → stable by packageId ascending ──────
  it('breaks full ties (same expiresOn + createdAt) by packageId ascending', () => {
    const allocation = allocate(new Prisma.Decimal('4.00'), [
      pkg('z', '2026-08-31', '2026-07-01', '2.00'),
      pkg('a', '2026-08-31', '2026-07-01', '2.00'),
      pkg('m', '2026-08-31', '2026-07-01', '2.00'),
    ]);
    expect(slim(allocation)).toEqual([
      { packageId: 'a', units: '2.00' },
      { packageId: 'm', units: '2.00' },
    ]);
  });

  // ── Edge: Decimal precision — no float drift on 0.1 + 0.2 ───────────
  it('keeps exact decimal precision (0.30 across two packages, no float drift)', () => {
    const allocation = allocate(new Prisma.Decimal('0.30'), [
      pkg('a', '2026-08-31', '2026-07-01', '0.10'),
      pkg('b', '2026-09-30', '2026-07-01', '0.20'),
    ]);
    expect(slim(allocation)).toEqual([
      { packageId: 'a', units: '0.10' },
      { packageId: 'b', units: '0.20' },
    ]);
  });

  // ── Edge: empty package list → no allocations even for non-zero total ─
  it('returns no allocations when there are no packages', () => {
    const allocation = allocate(new Prisma.Decimal('5.00'), []);
    expect(allocation).toEqual([]);
  });

  // ── Edge: packages with zero available are skipped ───────────────────
  it('skips packages whose available is zero', () => {
    const allocation = allocate(new Prisma.Decimal('2.00'), [
      pkg('empty', '2026-08-31', '2026-07-01', '0.00'),
      pkg('full', '2026-09-30', '2026-07-01', '5.00'),
    ]);
    expect(slim(allocation)).toEqual([{ packageId: 'full', units: '2.00' }]);
  });

  // ── Each result row always carries the full bucket-delta shape ───────
  it('produces result rows with packageId and 2-dp units string', () => {
    const [row] = allocate(new Prisma.Decimal('1.50'), [
      pkg('p', '2026-08-31', '2026-07-01', '5.00'),
    ]);
    expect(row).toBeDefined();
    expect(row!.packageId).toBe('p');
    expect(row!.units).toBe('1.50');
    expect(typeof row!.units).toBe('string');
  });
});
