import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installWxGlobals } from '../helpers/wx-mock';

// ────────────────────────────────────────────────────────────────────────────
// packages page: GET /mini/v1/students/:studentId/course-packages.
//
// Private — requires a bound member + assertRelated on the server. The page:
//   - Reads the active student from currentStudentStore on show.
//   - Shows effective (startsOn) / expiry (expiresOn) dates.
//   - Shows the available / reserved / consumed / expired buckets as 2-dp
//     decimal strings.
//   - Clears cached packages on STUDENT_FORBIDDEN (member no longer related).
//   - Reloads when the active student changes (data isolation).
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

const PACKAGES: PackageView[] = [
  {
    id: 'pkg-1',
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
  {
    id: 'pkg-2',
    studentId: 'student-1',
    courseId: 'course-1',
    sourceType: 'ORDER',
    status: 'EXPIRED',
    startsOn: '2025-01-01',
    expiresOn: '2025-12-31',
    granted: '5.00',
    available: '0.00',
    reserved: '0.00',
    consumed: '4.00',
    expired: '1.00',
  },
];

function stubPackages(
  mock: ReturnType<typeof installWxGlobals>,
  body: unknown,
): void {
  mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
    const url = String(opts.url);
    let res: { statusCode: number; data: unknown };
    if (url.split('?')[0]!.endsWith('/api/mini/v1/students')) {
      // The page refreshes the related-students list to populate the switcher.
      res = {
        statusCode: 200,
        data: {
          code: 0,
          message: 'ok',
          data: {
            items: [
              { student: { id: 'student-1', displayName: 'Alice' }, relation: { id: 'r1', relationType: 'SELF' } },
              { student: { id: 'student-2', displayName: 'Bob' }, relation: { id: 'r2', relationType: 'SELF' } },
            ],
          },
        },
      };
    } else if (url.includes('/course-packages')) {
      res = { statusCode: 200, data: { code: 0, message: 'ok', data: body } };
    } else {
      return {};
    }
    if (typeof opts.success === 'function')
      opts.success({ ...res, header: {}, cookies: [] });
    return {};
  });
}

describe('packages page', () => {
  let mock: ReturnType<typeof installWxGlobals>;

  beforeEach(() => {
    vi.resetModules();
    mock = installWxGlobals();
    mock.storage['member-course:refresh-token'] = 'refresh-jwt';
  });

  async function bootstrap() {
    const { currentStudentStore } = await import(
      '../../miniprogram/stores/current-student-store'
    );
    currentStudentStore.restore([{ id: 'student-1' }, { id: 'student-2' }], null);
    await import('../../miniprogram/pages/packages/index');
    const page = mock.captured.page!;
    return { page, currentStudentStore };
  }

  it('loads the active student packages on show and renders dates + buckets', async () => {
    stubPackages(mock, {
      items: PACKAGES,
      total: PACKAGES.length,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });
    const { page } = await bootstrap();
    await page.onShow();

    expect((page.data.packages as unknown[]).length).toBe(2);
    const expired = (page.data.packages as PackageView[]).find(
      (p) => p.status === 'EXPIRED',
    )!;
    expect(expired.startsOn).toBe('2025-01-01');
    expect(expired.expiresOn).toBe('2025-12-31');
    expect(expired.expired).toBe('1.00');
    expect(typeof expired.expired).toBe('string');
  });

  it('reloads when the student-switcher changes the active student', async () => {
    stubPackages(mock, {
      items: [PACKAGES[0]!],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });
    const { page } = await bootstrap();
    await page.onShow();
    const firstId = (page.data.packages as PackageView[])[0]!.id;

    // Switcher emits a change → page switches student + reloads.
    await page.onStudentChange({ detail: { id: 'student-2' } });
    // Because the stub returns the same canned body, the request URL changed.
    const lastCall = mock.wx.request.mock.calls.at(-1)![0] as { url: string };
    expect(lastCall.url).toContain('/students/student-2/course-packages');
    // New packages replace (not append to) the previous student's.
    expect((page.data.packages as PackageView[])[0]!.id).toBe(firstId);
    expect((page.data.packages as unknown[]).length).toBe(1);
  });

  it('renders the real empty state when the student has no packages', async () => {
    stubPackages(mock, {
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      totalPages: 0,
    });
    const { page } = await bootstrap();
    await page.onShow();

    expect(page.data.packages).toEqual([]);
    const wxml = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../../miniprogram/pages/packages/index.wxml', import.meta.url),
        'utf8',
      ),
    );
    expect(wxml).toContain('暂无课时包');
  });

  it('does NOT expose payment, refund, booking, or activity actions', async () => {
    await import('../../miniprogram/pages/packages/index');
    const wxml = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../../miniprogram/pages/packages/index.wxml', import.meta.url),
        'utf8',
      ),
    );
    expect(wxml).not.toContain('支付');
    expect(wxml).not.toContain('退款');
    expect(wxml).not.toContain('预约');
    expect(wxml).not.toContain('活动');
  });
});
