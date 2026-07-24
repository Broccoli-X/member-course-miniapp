import { describe, it, expect } from 'vitest';
import { calculateExpiryDate } from './business-date.js';

describe('calculateExpiryDate', () => {
  it('includes both confirmation and expiry dates in Shanghai', () => {
    // 2026-07-23T15:59:59Z = 2026-07-23T23:59:59+08:00 (still same day in Shanghai)
    expect(calculateExpiryDate(new Date('2026-07-23T15:59:59Z'), 30)).toBe('2026-08-22');
  });

  it('rolls to next day when UTC is past midnight Shanghai time', () => {
    // 2026-07-23T16:00:01Z = 2026-07-24T00:00:01+08:00
    expect(calculateExpiryDate(new Date('2026-07-23T16:00:01Z'), 30)).toBe('2026-08-23');
  });

  it('handles 7-day validity', () => {
    expect(calculateExpiryDate(new Date('2026-07-23T00:00:00Z'), 7)).toBe('2026-07-30');
  });
});
