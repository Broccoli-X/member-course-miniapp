import { describe, it, expect, vi } from 'vitest';
import { ERROR_CODES } from '@member-course/contracts';
import {
  StudentProfileService,
  DISPLAY_NAME_MAX_LENGTH,
} from './student-profile.service.js';
import { Prisma } from '../../../generated/prisma/client.js';

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

describe('StudentProfileService.assertRelationType (admin set)', () => {
  it.each(['SELF', 'GUARDIAN', 'PARENT'])('accepts %s', (rt) => {
    expect(() => StudentProfileService.assertRelationType(rt)).not.toThrow();
  });

  it('rejects an unknown value', () => {
    expect(() => StudentProfileService.assertRelationType('FRIEND')).toThrow();
  });
});

describe('StudentProfileService.assertSelfServiceRelationType (mini set)', () => {
  it.each(['SELF', 'GUARDIAN'])('accepts %s', (rt) => {
    expect(() => StudentProfileService.assertSelfServiceRelationType(rt)).not.toThrow();
  });

  it('rejects PARENT (admin-mediated only) with VALIDATION_FAILED', () => {
    expect(() => StudentProfileService.assertSelfServiceRelationType('PARENT')).toThrow();
  });

  it('rejects an unknown value', () => {
    expect(() => StudentProfileService.assertSelfServiceRelationType('FRIEND')).toThrow();
  });
});

describe('StudentProfileService.createForMember (SELF-uniqueness)', () => {
  /**
   * Build a StudentProfileService with a fake PrismaService whose `$transaction`
   * runs the callback against an in-memory tx-like object. The SELF guard now
   * uses a locking `SELECT ... FOR UPDATE` via `tx.$queryRaw`, so the mock
   * returns `existingSelf` as the (typed) raw rows.
   */
  function makeService(opts: {
    existingSelf?: { id: string }[] | null;
  }): { service: StudentProfileService; created: { studentProfile: number; relation: number } } {
    const created = { studentProfile: 0, relation: 0 };
    const tx = {
      accountStudentRelation: {
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
      $queryRaw: vi.fn(async () => opts.existingSelf ?? []),
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
    const { service, created } = makeService({ existingSelf: [] });
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
      existingSelf: [{ id: 'existing-self-rel' }],
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
    // Even if a SELF exists, a GUARDIAN create bypasses the SELF check, so
    // the mock's existingSelf value is never consulted.
    const { service, created } = makeService({ existingSelf: [{ id: 'self-rel' }] });
    const result = await service.createForMember({
      accountId: 'acc-1',
      displayName: 'Kid',
      relationType: 'GUARDIAN',
    });
    expect(result.relation.relationType).toBe('GUARDIAN');
    expect(created.studentProfile).toBe(1);
    expect(created.relation).toBe(1);
  });

  it('mini path (createForMember) rejects PARENT with VALIDATION_FAILED before any write', async () => {
    const { service, created } = makeService({ existingSelf: [] });
    await expect(
      service.createForMember({
        accountId: 'acc-1',
        displayName: 'Parent',
        relationType: 'PARENT' as never,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });
    expect(created.studentProfile).toBe(0);
    expect(created.relation).toBe(0);
  });

  it('admin path (createForAdmin) still accepts PARENT', async () => {
    const { service, created } = makeService({ existingSelf: [] });
    const result = await service.createForAdmin({
      accountId: 'acc-1',
      displayName: 'Parent',
      relationType: 'PARENT',
      verifiedByAdminId: 'admin-1',
    });
    expect(result.relation.relationType).toBe('PARENT');
    expect(result.relation.verifiedByAdminId).toBe('admin-1');
    expect(created.relation).toBe(1);
  });
});

describe('StudentProfileService.create (deadlock retry)', () => {
  /**
   * The SELF guard uses `SELECT ... FOR UPDATE`, which under REPEATABLE READ
   * can deadlock when two SELF creates race (gap-lock vs INSERT). The loser's
   * tx is aborted with Prisma `P2034`; the service retries, re-reads, and
   * observes the winner's committed SELF row → clean `STATE_CHANGED` (409).
   * These specs pin that retry behaviour at the unit level.
   */
  function deadlockErr(): unknown {
    // Construct a real Prisma.PrismaClientKnownRequestError so `instanceof`
    // in the service matches.
    return new Prisma.PrismaClientKnownRequestError(
      'Transaction failed due to a write conflict or a deadlock. Please retry your transaction',
      { code: 'P2034', clientVersion: 'test' },
    );
  }

  /** A tx whose $transaction throws P2034 on the first N calls then succeeds. */
  function makeRetryService(opts: {
    deadlockTimes: number;
    existingSelf: { id: string }[];
  }): { service: StudentProfileService; getTxCalls: () => number } {
    let txCalls = 0;
    const tx = {
      accountStudentRelation: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'rel-1',
          accountId: data.accountId,
          studentId: data.studentId,
          relationType: data.relationType,
          verifiedByAdminId: data.verifiedByAdminId ?? null,
          version: 1,
        })),
      },
      studentProfile: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'stu-1',
          displayName: data.displayName,
          birthDate: data.birthDate ?? null,
          status: 'ACTIVE',
          version: 1,
        })),
      },
      // $queryRaw returns the SELF rows; the service sees them after the
      // deadlock-retry re-reads.
      $queryRaw: vi.fn(async () => opts.existingSelf),
    };
    const db = {
      $transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => {
        txCalls += 1;
        if (txCalls <= opts.deadlockTimes) throw deadlockErr();
        return cb(tx);
      }),
    } as never;
    return { service: new StudentProfileService(db), getTxCalls: () => txCalls };
  }

  it('retries on Prisma P2034 (deadlock) and then succeeds', async () => {
    const { service, getTxCalls } = makeRetryService({ deadlockTimes: 1, existingSelf: [] });
    const result = await service.createForMember({
      accountId: 'acc-1',
      displayName: 'Self',
      relationType: 'SELF',
    });
    expect(result.relation.relationType).toBe('SELF');
    expect(getTxCalls()).toBe(2); // first attempt deadlocked, second succeeded
  });

  it('retries on P2034 and converts to STATE_CHANGED when the winner committed', async () => {
    // After the deadlock retry, the locking read sees the winner's SELF row.
    const { service, getTxCalls } = makeRetryService({
      deadlockTimes: 1,
      existingSelf: [{ id: 'winner-self' }],
    });
    await expect(
      service.createForMember({
        accountId: 'acc-1',
        displayName: 'Loser',
        relationType: 'SELF',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.STATE_CHANGED });
    expect(getTxCalls()).toBe(2);
  });

  it('does NOT retry a BusinessError (invariant violation propagates at once)', async () => {
    const { service, getTxCalls } = makeRetryService({
      deadlockTimes: 0,
      existingSelf: [{ id: 'existing' }],
    });
    await expect(
      service.createForMember({
        accountId: 'acc-1',
        displayName: 'Dup',
        relationType: 'SELF',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.STATE_CHANGED });
    expect(getTxCalls()).toBe(1); // no retry — BusinessError is not P2034
  });
});
