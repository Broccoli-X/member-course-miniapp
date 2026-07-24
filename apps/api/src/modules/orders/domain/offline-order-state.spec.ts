import { describe, it, expect } from 'vitest';
import { Prisma } from '../../../generated/prisma/client.js';
import {
  OFFLINE_ORDER_STATUS,
  type OfflineOrderStatus,
} from '@member-course/contracts';
import {
  canConfirm,
  canReverse,
  canVoid,
  assertCanConfirm,
  assertCanReverse,
  assertCanVoid,
  freezeItemSnapshot,
  type FrozenItemSnapshot,
} from './offline-order-state.js';

/**
 * Pure unit tests for the offline-order state machine. No DB, no Nest — just
 * the transition/validation helpers, run under the default vitest glob
 * (src star-star slash star-star.spec.ts).
 */
describe('offline-order-state (pure domain)', () => {
  // ── canConfirm / canVoid / canReverse predicates ────────────────────────

  describe('canConfirm', () => {
    it('is true only for PENDING', () => {
      expect(canConfirm(OFFLINE_ORDER_STATUS.PENDING)).toBe(true);
      expect(canConfirm(OFFLINE_ORDER_STATUS.CONFIRMED)).toBe(false);
      expect(canConfirm(OFFLINE_ORDER_STATUS.REVERSED)).toBe(false);
    });
  });

  describe('canVoid', () => {
    it('is true only for PENDING', () => {
      expect(canVoid(OFFLINE_ORDER_STATUS.PENDING)).toBe(true);
      expect(canVoid(OFFLINE_ORDER_STATUS.CONFIRMED)).toBe(false);
      expect(canVoid(OFFLINE_ORDER_STATUS.REVERSED)).toBe(false);
    });
  });

  describe('canReverse', () => {
    it('is true only for CONFIRMED', () => {
      expect(canReverse(OFFLINE_ORDER_STATUS.PENDING)).toBe(false);
      expect(canReverse(OFFLINE_ORDER_STATUS.CONFIRMED)).toBe(true);
      expect(canReverse(OFFLINE_ORDER_STATUS.REVERSED)).toBe(false);
    });
  });

  // ── assert helpers throw the right BusinessError on bad transitions ─────

  describe('assertCanConfirm', () => {
    it('returns void for PENDING and throws for others', () => {
      expect(assertCanConfirm(OFFLINE_ORDER_STATUS.PENDING)).toBeUndefined();
      expect(() => assertCanConfirm(OFFLINE_ORDER_STATUS.CONFIRMED)).toThrowError(
        /cannot be confirmed/,
      );
      expect(() => assertCanConfirm(OFFLINE_ORDER_STATUS.REVERSED)).toThrowError(
        /cannot be confirmed/,
      );
    });

    it('surfaces a STATE_CHANGED code on the thrown BusinessError', () => {
      try {
        assertCanConfirm(OFFLINE_ORDER_STATUS.CONFIRMED);
        throw new Error('should have thrown');
      } catch (err) {
        expect((err as { code: string }).code).toBe('STATE_CHANGED');
        expect((err as { httpStatus: number }).httpStatus).toBe(409);
      }
    });
  });

  describe('assertCanVoid', () => {
    it('returns void for PENDING and throws for others', () => {
      expect(assertCanVoid(OFFLINE_ORDER_STATUS.PENDING)).toBeUndefined();
      expect(() => assertCanVoid(OFFLINE_ORDER_STATUS.CONFIRMED)).toThrowError(
        /cannot be voided/,
      );
    });
  });

  describe('assertCanReverse', () => {
    it('returns void for CONFIRMED and throws for others', () => {
      expect(assertCanReverse(OFFLINE_ORDER_STATUS.CONFIRMED)).toBeUndefined();
      expect(() => assertCanReverse(OFFLINE_ORDER_STATUS.PENDING)).toThrowError(
        /cannot be reversed/,
      );
      expect(() => assertCanReverse(OFFLINE_ORDER_STATUS.REVERSED)).toThrowError(
        /cannot be reversed/,
      );
    });
  });

  // ── Snapshot freezing ──────────────────────────────────────────────────

  describe('freezeItemSnapshot', () => {
    const product = {
      id: 'pp-1',
      courseId: 'crs-1',
      name: '10课时包',
      price: new Prisma.Decimal('100.00'),
      hours: new Prisma.Decimal('10.00'),
      validDays: 30,
    };

    it('copies name/price/hours/validDays from the product into a snapshot', () => {
      const snap: FrozenItemSnapshot = freezeItemSnapshot(product);
      expect(snap.productNameSnapshot).toBe('10课时包');
      expect(snap.unitPriceSnapshot.toFixed(2)).toBe('100.00');
      expect(snap.hoursSnapshot.toFixed(2)).toBe('10.00');
      expect(snap.validDaysSnapshot).toBe(30);
    });

    it('is decoupled from later product mutation (immutability)', () => {
      const snap = freezeItemSnapshot(product);
      // Mutate the source product AFTER freezing — the snapshot must not move.
      const mutated = {
        ...product,
        name: 'CHANGED',
        price: new Prisma.Decimal('999.00'),
        hours: new Prisma.Decimal('99.00'),
        validDays: 999,
      };
      const snapOfMutated = freezeItemSnapshot(mutated);
      expect(snapOfMutated.unitPriceSnapshot.toFixed(2)).toBe('999.00');
      // Original snapshot frozen earlier is unchanged.
      expect(snap.unitPriceSnapshot.toFixed(2)).toBe('100.00');
      expect(snap.hoursSnapshot.toFixed(2)).toBe('10.00');
      expect(snap.productNameSnapshot).toBe('10课时包');
      expect(snap.validDaysSnapshot).toBe(30);
    });
  });

  // ── Status exhaustiveness sanity ────────────────────────────────────────

  it('covers exactly the three persisted statuses', () => {
    const persisted: OfflineOrderStatus[] = [
      OFFLINE_ORDER_STATUS.PENDING,
      OFFLINE_ORDER_STATUS.CONFIRMED,
      OFFLINE_ORDER_STATUS.REVERSED,
    ];
    // Each status has exactly one allowed "forward" transition target.
    expect(canConfirm(persisted[0])).toBe(true);
    expect(canVoid(persisted[0])).toBe(true);
    expect(canReverse(persisted[1])).toBe(true);
    // REVERSED is terminal — no transitions out.
    expect(canConfirm(persisted[2])).toBe(false);
    expect(canVoid(persisted[2])).toBe(false);
    expect(canReverse(persisted[2])).toBe(false);
  });
});
