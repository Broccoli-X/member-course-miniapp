import { describe, it, expect, vi } from 'vitest';
import { ERROR_CODES } from '@member-course/contracts';
import { StudentAccessService } from './student-access.service.js';

/**
 * Unit tests for {@link StudentAccessService}. The DB count is mocked so the
 * forbidden/allowed branches are exercised deterministically under the default
 * `vitest run` glob (no MySQL needed).
 */
describe('StudentAccessService', () => {
  function makeService(countResult: number): StudentAccessService {
    const db = {
      accountStudentRelation: {
        count: vi.fn(async () => countResult),
      },
    } as unknown as ConstructorParameters<typeof StudentAccessService>[0];
    return new StudentAccessService(db);
  }

  it('isRelated returns true when a relation row exists', async () => {
    const service = makeService(1);
    await expect(service.isRelated('acc-1', 'stu-1')).resolves.toBe(true);
  });

  it('isRelated returns false when no relation row exists', async () => {
    const service = makeService(0);
    await expect(service.isRelated('acc-1', 'stu-1')).resolves.toBe(false);
  });

  it('assertRelated throws STUDENT_FORBIDDEN (403) when unrelated', async () => {
    const service = makeService(0);
    await expect(service.assertRelated('acc-1', 'stu-1')).rejects.toMatchObject({
      code: ERROR_CODES.STUDENT_FORBIDDEN,
      httpStatus: 403,
    });
  });

  it('assertRelated resolves when related', async () => {
    const service = makeService(1);
    await expect(service.assertRelated('acc-1', 'stu-1')).resolves.toBeUndefined();
  });
});
