import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installWxGlobals } from './helpers/wx-mock';

// ────────────────────────────────────────────────────────────────────────────
// Member asset data-isolation: the two verbatim Task-15 cases.
//
// (1) Switching students MUST clear the previously-loaded student's assets
//     before loading the new student's. Otherwise a member with multiple
//     children could briefly (or permanently, on a half-failure) see student
//     A's packages under student B's heading.
// (2) A 403 STUDENT_FORBIDDEN (member no longer related to the student) MUST
//     clear any previously cached assets for that student. Otherwise stale
//     data from a now-unrelated student would remain on screen.
//
// The packages page is the canonical example; balances/transactions follow the
// same load-on-student-change + clear-on-forbidden contract (covered by their
// own specs).
// ────────────────────────────────────────────────────────────────────────────

interface PackageView {
  id: string;
  studentId: string;
  courseId: string;
  sourceType: string;
  status: string;
  startsOn: string;
  expiresOn: string;
  granted: string;
  available: string;
  reserved: string;
  consumed: string;
  expired: string;
}

const STUDENT_1_PACKAGES: PackageView[] = [
  {
    id: 'student-1-package',
    studentId: 'student-1',
    courseId: 'course-1',
    sourceType: 'ORDER',
    status: 'ACTIVE',
    startsOn: '2026-01-01',
    expiresOn: '2026-12-31',
    granted: '10.00',
    available: '8.00',
    reserved: '1.00',
    consumed: '1.00',
    expired: '0.00',
  },
];

const STUDENT_2_PACKAGES: PackageView[] = [
  {
    id: 'student-2-package',
    studentId: 'student-2',
    courseId: 'course-2',
    sourceType: 'MANUAL',
    status: 'ACTIVE',
    startsOn: '2026-02-01',
    expiresOn: '2027-01-31',
    granted: '20.00',
    available: '20.00',
    reserved: '0.00',
    consumed: '0.00',
    expired: '0.00',
  },
];

function businessError(code: string): {
  code: string;
  message: string;
  traceId: string;
} {
  return { code, message: 'forbidden', traceId: 'trace-forbidden' };
}

function mockListPackages(
  mock: ReturnType<typeof installWxGlobals>,
  fn: (studentId: string) => { statusCode: number; data: unknown },
): void {
  mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
    const url = String(opts.url);
    const match = url.match(
      /\/api\/mini\/v1\/students\/([^/]+)\/course-packages/,
    );
    if (match) {
      const res = fn(match[1]!);
      if (typeof opts.success === 'function') opts.success(res);
    }
    return {};
  });
}

function okPackages(items: PackageView[]): {
  statusCode: number;
  data: unknown;
} {
  return {
    statusCode: 200,
    data: {
      code: 0,
      message: 'ok',
      data: { items, total: items.length, page: 1, pageSize: 20, totalPages: 1 },
    },
  };
}

function forbidden(): { statusCode: number; data: unknown } {
  return { statusCode: 403, data: businessError('STUDENT_FORBIDDEN') };
}

describe('member assets: student-switching data isolation (Task 15 verbatim)', () => {
  let mock: ReturnType<typeof installWxGlobals>;

  beforeEach(() => {
    vi.resetModules();
    mock = installWxGlobals();
    mock.storage['member-course:refresh-token'] = 'refresh-jwt';
  });

  async function bootstrapPage() {
    const { currentStudentStore } = await import(
      '../miniprogram/stores/current-student-store'
    );
    currentStudentStore.restore(
      [{ id: 'student-1' }, { id: 'student-2' }, { id: 'student-other' }],
      null,
    );
    await import('../miniprogram/pages/packages/index');
    const page = mock.captured.page!;
    return { page, currentStudentStore };
  }

  it('clears old assets when switching students', async () => {
    // Per-student canned responses: student-1 → its package, student-2 → its.
    mockListPackages(mock, (sid) =>
      okPackages(sid === 'student-1' ? STUDENT_1_PACKAGES : STUDENT_2_PACKAGES),
    );

    const { page, currentStudentStore } = await bootstrapPage();

    // loadStudent(student-1): packages === student-1-package.
    await page.loadStudent('student-1');
    expect(currentStudentStore.currentId).toBe('student-1');
    expect(page.data.packages).toEqual(STUDENT_1_PACKAGES);

    // switchStudent(student-2): old student-1 data MUST be gone.
    await page.switchStudent('student-2');
    expect(currentStudentStore.currentId).toBe('student-2');
    expect(page.data.packages).toEqual(STUDENT_2_PACKAGES);
    expect(page.data.packages).not.toContainEqual(
      expect.objectContaining({ id: 'student-1-package' }),
    );
  });

  it('clears cached data after STUDENT_FORBIDDEN', async () => {
    // First call (student-other) rejects with STUDENT_FORBIDDEN.
    mockListPackages(mock, () => forbidden());

    const { page } = await bootstrapPage();

    await page.loadStudent('student-other');
    expect(page.data.packages).toEqual([]);
    // The member got a toast explaining why the data is gone.
    expect(mock.wx.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ icon: 'none' }),
    );
  });

  it('renders package effective/expiry dates and all four buckets as strings', async () => {
    mockListPackages(mock, () => okPackages(STUDENT_1_PACKAGES));

    const { page } = await bootstrapPage();
    await page.loadStudent('student-1');

    const pkg = (page.data.packages as PackageView[])[0]!;
    // Dates rendered (effective = startsOn, expiry = expiresOn).
    expect(pkg.startsOn).toBe('2026-01-01');
    expect(pkg.expiresOn).toBe('2026-12-31');
    // All four buckets present as 2-dp decimal STRINGS (no JS number coercion).
    expect(pkg.available).toBe('8.00');
    expect(pkg.reserved).toBe('1.00');
    expect(pkg.consumed).toBe('1.00');
    expect(pkg.expired).toBe('0.00');
    expect(typeof pkg.available).toBe('string');
  });
});
