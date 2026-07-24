import { describe, it, expect, vi } from 'vitest';
import { ERROR_CODES } from '@member-course/contracts';
import {
  StudentProfileService,
  DISPLAY_NAME_MAX_LENGTH,
} from './student-profile.service.js';

/**
 * Unit tests for the pure validation rules in {@link StudentProfileService}.
 *
 * The persistence paths (create/update with a real Prisma tx) are covered by
 * the e2e suite — these specs exercise the deterministic, DB-free rules so
 * they run under the default `vitest run` glob (no MySQL needed):
 *   - displayName length / non-empty
 *   - relationType enum
 *   - the ONE-active-SELF-per-member invariant (mocked tx, asserts the
 *     pre-existing-SELF branch throws STATE_CHANGED before any write).
 */
describe('StudentProfileService.assertDisplayName', () => {
  it('accepts a non-empty name within the limit', () => {
    expect(() => StudentProfileService.assertDisplayName('Chen')).not.toThrow();
    expect(() =>
      StudentProfileService.assertDisplayName('a'.repeat(DISPLAY_NAME_MAX_LENGTH)),
    ).not.toThrow();
  });

  it('rejects an empty / whitespace-only name', () => {
    expect(() => StudentProfileService.assertDisplayName('')).toThrow();
    expect(() => StudentProfileService.assertDisplayName('   ')).toThrow();
  });

  it('rejects a name longer than the column limit', () => {
    expect(() =>
      StudentProfileService.assertDisplayName('a'.repeat(DISPLAY_NAME_MAX_LENGTH + 1)),
    ).toThrow();
  });
});

describe('StudentProfileService.assertRelationType', () => {
  it.each(['SELF', 'GUARDIAN', 'PARENT'])('accepts %s', (rt) => {
    expect(() => StudentProfileService.assertRelationType(rt)).not.toThrow();
  });

  it('rejects an unknown value', () => {
    expect(() => StudentProfileService.assertRelationType('FRIEND')).toThrow();
  });
});

describe('StudentProfileService.createForMember (SELF-uniqueness)', () => {
  /**
   * Build a StudentProfileService with a fake PrismaService whose `$transaction`
   * runs the callback against an in-memory tx-like object. We only need the
   * `accountStudentRelation.findFirst` and `.create` + `studentProfile.create`
   * delegates to satisfy the code paths under test.
   */
  function makeService(opts: {
    existingSelf?: { id: string } | null;
  }): { service: StudentProfileService; created: { studentProfile: number; relation: number } } {
    const created = { studentProfile: 0, relation: 0 };
    const tx = {
      accountStudentRelation: {
        findFirst: vi.fn(async () => opts.existingSelf ?? null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.relation += 1;
          return {
            id: 'rel-' + created.relation,
            accountId: data.accountId,
            studentId: data.studentId,
            relationType: data.relationType,
            verifiedByAdminId: data.verifiedByAdminId ?? null,
            version: 1,
          };
        }),
      },
      studentProfile: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.studentProfile += 1;
          return {
            id: 'stu-' + created.studentProfile,
            displayName: data.displayName,
            birthDate: data.birthDate ?? null,
            status: 'ACTIVE',
            version: 1,
          };
        }),
      },
    };
    const db = {
      $transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Parameters<typeof StudentProfileService.prototype.createForMember>[0] extends object
      ? never
      : never;
    // Cast: the service only uses $transaction + the tx delegates above.
    const service = new StudentProfileService(db as never);
    return { service, created };
  }

  it('creates a SELF profile when none exists yet', async () => {
    const { service, created } = makeService({ existingSelf: null });
    const result = await service.createForMember({
      accountId: 'acc-1',
      displayName: 'Chen',
      relationType: 'SELF',
    });
    expect(result.relation.relationType).toBe('SELF');
    expect(result.student.displayName).toBe('Chen');
    expect(created.studentProfile).toBe(1);
    expect(created.relation).toBe(1);
  });

  it('rejects a second SELF with STATE_CHANGED (conflict)', async () => {
    const { service, created } = makeService({
      existingSelf: { id: 'existing-self-rel' },
    });
    await expect(
      service.createForMember({
        accountId: 'acc-1',
        displayName: 'Two',
        relationType: 'SELF',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.STATE_CHANGED });
    // No write should have happened.
    expect(created.studentProfile).toBe(0);
    expect(created.relation).toBe(0);
  });

  it('allows multiple GUARDIAN profiles for one account', async () => {
    // Even if a SELF exists, a GUARDIAN create bypasses the SELF check.
    const { service, created } = makeService({ existingSelf: { id: 'self-rel' } });
    const result = await service.createForMember({
      accountId: 'acc-1',
      displayName: 'Kid',
      relationType: 'GUARDIAN',
    });
    expect(result.relation.relationType).toBe('GUARDIAN');
    expect(created.studentProfile).toBe(1);
    expect(created.relation).toBe(1);
  });
});
