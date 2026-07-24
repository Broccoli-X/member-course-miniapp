import { describe, it, expect } from 'vitest';
import {
  normalizePhone,
  NORMALIZED_PHONE_MAX_LENGTH,
} from './phone.js';

describe('normalizePhone', () => {
  it('strips non-digits and returns the canonical digit-only form', () => {
    expect(normalizePhone('86 138-0000-0000')).toBe('8613800000000');
    expect(normalizePhone('+86 13800000000')).toBe('8613800000000');
    expect(normalizePhone('(86) 138 0000 0000')).toBe('8613800000000');
  });

  it('accepts a bare purePhoneNumber with no country code', () => {
    expect(normalizePhone('13800000000')).toBe('13800000000');
  });

  it('rejects an input with no digits', () => {
    expect(() => normalizePhone('++--()')).toThrow(/no digits/);
    expect(() => normalizePhone('')).toThrow(/no digits/);
  });

  it('rejects a number longer than the VarChar(20) column', () => {
    const tooLong = '1'.repeat(NORMALIZED_PHONE_MAX_LENGTH + 1);
    expect(() => normalizePhone(tooLong)).toThrow(/exceeds/);
  });

  it('accepts a number exactly at the column boundary', () => {
    const boundary = '1'.repeat(NORMALIZED_PHONE_MAX_LENGTH);
    expect(normalizePhone(boundary)).toHaveLength(NORMALIZED_PHONE_MAX_LENGTH);
  });
});
