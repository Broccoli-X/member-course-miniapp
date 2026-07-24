import { Prisma } from '../../../generated/prisma/client.js';
import { ERROR_CODES, HTTP_STATUS } from '@member-course/contracts';
import { BusinessError } from '../../../common/errors/business-error.js';

/**
 * Decimal-scale validation for package-product `price`/`hours` fields.
 *
 * The schema stores money/hours as `Decimal(10,2)`. The HTTP contract carries
 * them as strings (the global constraint forbids representing money/hours as a
 * JavaScript `number`). To avoid silent truncation of `100.001` → `100.00` on
 * write, the string is parsed with {@link Prisma.Decimal} and its fractional
 * digit count is enforced to be at most 2.
 *
 * Parsing with `Prisma.Decimal` (rather than `Number`) preserves arbitrary
 * precision and rejects non-numeric strings (`DecimalConstructor` throws on
 * `'abc'`), which we surface as a `VALIDATION_FAILED` (400) so a genuinely
 * malformed input is distinguishable from a scale violation (422).
 */

/**
 * Count the fractional digits of a decimal string. Returns 0 when the value
 * has no decimal point (e.g. `'100'` → 0, `'100.1'` → 1, `'100.10'` → 2,
 * `'100.001'` → 3). Trailing zeros after the point ARE counted because the
 * caller rejected `100.10` vs `100.1` distinction is unnecessary — we only
 * care that the scale is at most 2.
 *
 * Implemented by inspecting the raw string (not the parsed `Decimal`) because
 * `Prisma.Decimal('100.10')` normalises to `100.1` internally and would lose
 * the original scale. The raw string is the user's intent.
 */
function countFractionDigits(rawValue: string): number {
  // Strip a leading sign and any exponent form (reject exponents separately).
  const dot = rawValue.indexOf('.');
  if (dot === -1) return 0;
  return rawValue.length - dot - 1;
}

/**
 * Reject values that contain an exponent (`1e2`) or other non-decimal forms.
 * The brief's matrix only exercises plain decimal strings; exponents are
 * pathological for a money field, so reject them as `VALIDATION_FAILED`.
 */
function looksLikeExponent(rawValue: string): boolean {
  return /e/i.test(rawValue);
}

/** Result of successfully validating a decimal string. */
export interface ValidatedDecimal {
  /** The original string, trimmed of surrounding whitespace. */
  readonly raw: string;
  /** The parsed Prisma.Decimal value (safe to hand to Prisma). */
  readonly value: Prisma.Decimal;
}

/**
 * Validate a decimal string intended for a `Decimal(10,2)` column with at most
 * 2 fractional digits. Throws:
 *  - `VALIDATION_FAILED` (400) when the value is not a string, is empty, is an
 *    exponent form, or cannot be parsed by `Prisma.Decimal`.
 *  - `DECIMAL_SCALE_INVALID` (422) when the fractional digit count exceeds 2.
 *
 * The 400-vs-422 split lets callers distinguish "malformed input" (client bug)
 * from "too many decimal places" (a business rule violation).
 *
 * @param fieldName Field name used in the error `details` for client feedback.
 */
export function assertDecimalScale(
  input: string | null | undefined,
  fieldName: string,
): ValidatedDecimal {
  if (typeof input !== 'string') {
    throw BusinessError.validationFailed(`${fieldName} must be a decimal string`, {
      field: fieldName,
    });
  }
  const raw = input.trim();
  if (raw.length === 0) {
    throw BusinessError.validationFailed(`${fieldName} must not be empty`, {
      field: fieldName,
    });
  }
  if (looksLikeExponent(raw)) {
    throw BusinessError.validationFailed(
      `${fieldName} must be a plain decimal (no exponent)`,
      { field: fieldName },
    );
  }
  let value: Prisma.Decimal;
  try {
    value = new Prisma.Decimal(raw);
  } catch {
    throw BusinessError.validationFailed(`${fieldName} must be a valid decimal`, {
      field: fieldName,
    });
  }
  // `Prisma.Decimal` parses successfully but may still be NaN for junk like
  // `Decimal('NaN')` inputs — guard explicitly.
  if (!value.isFinite()) {
    throw BusinessError.validationFailed(`${fieldName} must be a finite decimal`, {
      field: fieldName,
    });
  }
  const scale = countFractionDigits(raw);
  if (scale > 2) {
    throw new BusinessError(
      ERROR_CODES.DECIMAL_SCALE_INVALID,
      `${fieldName} must have at most 2 decimal places`,
      HTTP_STATUS.UNPROCESSABLE_ENTITY,
      { field: fieldName, scale },
    );
  }
  return { raw, value };
}

/**
 * Validate the `hours` field: a strictly-positive decimal string with at most
 * 2 fractional digits. Throws `HOURS_MUST_BE_POSITIVE` (422) when the parsed
 * value is not greater than zero.
 */
export function assertPositiveHours(input: string | null | undefined): ValidatedDecimal {
  const { raw, value } = assertDecimalScale(input, 'hours');
  if (!value.greaterThan(0)) {
    throw new BusinessError(
      ERROR_CODES.HOURS_MUST_BE_POSITIVE,
      'hours must be greater than 0',
      HTTP_STATUS.UNPROCESSABLE_ENTITY,
      { field: 'hours' },
    );
  }
  return { raw, value };
}

/**
 * Validate the `validDays` field: a strictly-positive integer. Throws
 * `VALID_DAYS_INVALID` (422) for non-integers or values <= 0.
 */
export function assertPositiveValidDays(input: unknown): number {
  // Reject anything that is not a finite integer. `typeof input === 'number'`
  // is the wire form (JSON numbers arrive as JS numbers); strings are also
  // tolerated so long as they parse to a positive integer.
  let n: number;
  if (typeof input === 'number') {
    n = input;
  } else if (typeof input === 'string' && input.trim().length > 0) {
    n = Number(input);
  } else {
    throw new BusinessError(
      ERROR_CODES.VALID_DAYS_INVALID,
      'validDays must be a positive integer',
      HTTP_STATUS.UNPROCESSABLE_ENTITY,
      { field: 'validDays' },
    );
  }
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new BusinessError(
      ERROR_CODES.VALID_DAYS_INVALID,
      'validDays must be a positive integer',
      HTTP_STATUS.UNPROCESSABLE_ENTITY,
      { field: 'validDays' },
    );
  }
  return n;
}

/**
 * Format a persisted `Decimal` for the wire as a fixed 2-dp string. Money and
 * lesson-hours are always rendered with 2 fractional digits (e.g. `100` →
 * `"100.00"`) so the mini-program client can parse a stable shape.
 */
export function toDecimalString(value: Prisma.Decimal | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return new Prisma.Decimal(value).toFixed(2);
}
