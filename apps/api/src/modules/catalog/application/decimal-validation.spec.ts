import { describe, it, expect } from 'vitest';
import { Prisma } from '../../../generated/prisma/client.js';
import {
  assertDecimalScale,
  assertPositiveHours,
  assertPositiveValidDays,
  toDecimalString,
} from './decimal-validation.js';
import { BusinessError } from '../../../common/errors/business-error.js';
import { ERROR_CODES, HTTP_STATUS } from '@member-course/contracts';

/**
 * Unit tests for the pure decimal-validation helpers. The validation matrix
 * from task-7-brief.md is exercised at the HTTP layer in the e2e spec; these
 * unit tests cover the function directly so they run under the default
 * `vitest run` glob (no MySQL required).
 */
describe('decimal-validation', () => {
  describe('assertDecimalScale', () => {
    it('accepts whole-number, 1-dp, and 2-dp values', () => {
      for (const ok of ['100', '100.0', '100.00', '100.1', '100.10', '0.99', '99.9', '5']) {
        const { value } = assertDecimalScale(ok, 'price');
        expect(value).toBeInstanceOf(Prisma.Decimal);
      }
    });

    it('rejects more than 2 fractional digits with DECIMAL_SCALE_INVALID at 422', () => {
      const cases = ['100.001', '0.123', '99.999', '1.0001'];
      for (const bad of cases) {
        expect(() => assertDecimalScale(bad, 'price')).toThrow(BusinessError);
        try {
          assertDecimalScale(bad, 'price');
        } catch (e) {
          const err = e as BusinessError;
          expect(err.code).toBe(ERROR_CODES.DECIMAL_SCALE_INVALID);
          expect(err.httpStatus).toBe(HTTP_STATUS.UNPROCESSABLE_ENTITY);
        }
      }
    });

    it('rejects non-string / empty / exponent / junk as VALIDATION_FAILED at 400', () => {
      const bad: Array<unknown> = [null, undefined, '', '   ', '1e2', '1E3', 'abc', 'NaN'];
      for (const value of bad) {
        try {
          assertDecimalScale(value as string, 'price');
          throw new Error(`expected throw for ${String(value)}`);
        } catch (e) {
          if (e instanceof Error && e.message.startsWith('expected throw')) throw e;
          const err = e as BusinessError;
          expect(err.code).toBe(ERROR_CODES.VALIDATION_FAILED);
          expect(err.httpStatus).toBe(HTTP_STATUS.BAD_REQUEST);
        }
      }
    });

    it('trims surrounding whitespace before parsing', () => {
      const { raw, value } = assertDecimalScale('  100.00  ', 'price');
      expect(raw).toBe('100.00');
      expect(value.toFixed(2)).toBe('100.00');
    });

    it('handles negative and zero values (scale only — positivity is separate)', () => {
      // assertDecimalScale is about SCALE, not sign. -5 and 0 pass scale.
      expect(assertDecimalScale('-5.00', 'price').value.toFixed(2)).toBe('-5.00');
      expect(assertDecimalScale('0.00', 'price').value.toFixed(2)).toBe('0.00');
    });
  });

  describe('assertPositiveHours', () => {
    it('accepts strictly positive values', () => {
      expect(assertPositiveHours('10.00').value.toFixed(2)).toBe('10.00');
      expect(assertPositiveHours('0.01').value.toFixed(2)).toBe('0.01');
    });

    it('rejects zero with HOURS_MUST_BE_POSITIVE at 422', () => {
      try {
        assertPositiveHours('0.00');
        throw new Error('expected throw');
      } catch (e) {
        if (e instanceof Error && e.message === 'expected throw') throw e;
        const err = e as BusinessError;
        expect(err.code).toBe(ERROR_CODES.HOURS_MUST_BE_POSITIVE);
        expect(err.httpStatus).toBe(HTTP_STATUS.UNPROCESSABLE_ENTITY);
      }
    });

    it('rejects negative values with HOURS_MUST_BE_POSITIVE', () => {
      try {
        assertPositiveHours('-1.00');
        throw new Error('expected throw');
      } catch (e) {
        if (e instanceof Error && e.message === 'expected throw') throw e;
        const err = e as BusinessError;
        expect(err.code).toBe(ERROR_CODES.HOURS_MUST_BE_POSITIVE);
      }
    });

    it('still enforces the 2-dp scale rule (scale checked before positivity)', () => {
      try {
        assertPositiveHours('1.000');
        throw new Error('expected throw');
      } catch (e) {
        if (e instanceof Error && e.message === 'expected throw') throw e;
        const err = e as BusinessError;
        expect(err.code).toBe(ERROR_CODES.DECIMAL_SCALE_INVALID);
      }
    });
  });

  describe('assertPositiveValidDays', () => {
    it('accepts positive integers (number or numeric string)', () => {
      expect(assertPositiveValidDays(30)).toBe(30);
      expect(assertPositiveValidDays(1)).toBe(1);
      expect(assertPositiveValidDays('15')).toBe(15);
    });

    it('rejects zero, negatives, and non-integers with VALID_DAYS_INVALID at 422', () => {
      for (const bad of [0, -1, 1.5, '0', '-3', 'abc', null, undefined, '', 2.5]) {
        try {
          assertPositiveValidDays(bad);
          throw new Error(`expected throw for ${String(bad)}`);
        } catch (e) {
          if (e instanceof Error && e.message.startsWith('expected throw')) throw e;
          const err = e as BusinessError;
          expect(err.code).toBe(ERROR_CODES.VALID_DAYS_INVALID);
          expect(err.httpStatus).toBe(HTTP_STATUS.UNPROCESSABLE_ENTITY);
        }
      }
    });
  });

  describe('toDecimalString', () => {
    it('renders money/hours with exactly 2 fractional digits', () => {
      expect(toDecimalString(new Prisma.Decimal('100'))).toBe('100.00');
      expect(toDecimalString(new Prisma.Decimal('99.9'))).toBe('99.90');
      expect(toDecimalString(new Prisma.Decimal('0'))).toBe('0.00');
      expect(toDecimalString('5.5')).toBe('5.50');
      expect(toDecimalString(null)).toBeNull();
      expect(toDecimalString(undefined)).toBeNull();
    });
  });
});
