import { describe, it, expect } from 'vitest';
import { validatePagination } from './pagination.dto.js';

describe('validatePagination', () => {
  it('accepts valid pagination params', () => {
    const result = validatePagination({ page: 1, pageSize: 20 });
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
  });

  it('rejects page < 1', () => {
    expect(() => validatePagination({ page: 0, pageSize: 20 })).toThrow();
  });

  it('rejects pageSize > 100', () => {
    expect(() => validatePagination({ page: 1, pageSize: 101 })).toThrow();
  });

  it('includes error code VALIDATION_FAILED', () => {
    try {
      validatePagination({ page: 0, pageSize: 101 });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });
});
