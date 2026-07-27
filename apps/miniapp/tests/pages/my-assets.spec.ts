import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installWxGlobals } from '../helpers/wx-mock';

// ────────────────────────────────────────────────────────────────────────────
// my page (我的 tab): the member's asset summary + entry points.
//
// Shows the member's own order count / package count summary, embeds the
// student-switcher so the member can change the active student, and offers
// tappable entries to orders / packages / hour-transactions. Read-only.
// ────────────────────────────────────────────────────────────────────────────

const STUDENTS = [
  { id: 'student-a', displayName: 'Alice' },
  { id: 'student-b', displayName: 'Bob' },
];

describe('my page (asset summary + entries)', () => {
  let mock: ReturnType<typeof installWxGlobals>;

  beforeEach(() => {
    vi.resetModules();
    mock = installWxGlobals();
    mock.storage['member-course:refresh-token'] = 'refresh-jwt';
  });

  async function bootstrap(stubbed?: (opts: Record<string, unknown>) => void) {
    const { currentStudentStore } = await import(
      '../../miniprogram/stores/current-student-store'
    );
    const { sessionStore } = await import(
      '../../miniprogram/stores/session-store'
    );
    sessionStore.setSession({ bound: true, accessToken: 'token' });
    currentStudentStore.restore(STUDENTS, null);
    if (stubbed) {
      mock.wx.request.mockImplementation(stubbed);
    }
    await import('../../miniprogram/pages/my/index');
    const page = mock.captured.page!;
    return { page, currentStudentStore, sessionStore };
  }

  function respond(
    opts: Record<string, unknown>,
    body: unknown,
    statusCode = 200,
  ): void {
    const success = opts.success as ((res: unknown) => void) | undefined;
    success?.({ statusCode, data: body, header: {}, cookies: [] });
  }

  it('loads the member summary and exposes entries to orders/packages/hour-transactions', async () => {
    const { page } = await bootstrap((opts) => {
      const url = String(opts.url);
      if (url.endsWith('/api/mini/v1/students')) {
        respond(opts, {
          code: 0,
          message: 'ok',
          data: {
            items: STUDENTS.map((s) => ({
              student: { ...s, birthDate: null },
              relation: { id: `r-${s.id}`, relationType: 'SELF' },
            })),
          },
        });
      }
      if (
        url.includes('/api/mini/v1/students/') &&
        url.includes('/course-balances')
      ) {
        respond(opts, {
          code: 0,
          message: 'ok',
          data: {
            items: [
              {
                id: 'b-1',
                studentId: 'student-a',
                courseId: 'course-1',
                available: '8.00',
                reserved: '1.00',
                consumed: '1.00',
                expired: '0.00',
              },
            ],
            total: 1,
            page: 1,
            pageSize: 20,
            totalPages: 1,
          },
        });
      }
    });

    await page.onShow();

    // The summary carries the active student id and the balance buckets.
    expect(page.data.currentStudentId).toBe('student-a');
    expect(page.data.balances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          studentId: 'student-a',
          available: '8.00',
        }),
      ]),
    );
    // Decimals stay as strings.
    expect(
      typeof (page.data.balances as Array<{ available: string }>)[0]!.available,
    ).toBe('string');
  });

  it('exposes tappable entry points to orders, packages, hour-transactions', async () => {
    const { page } = await bootstrap((opts) => {
      const url = String(opts.url);
      if (url.endsWith('/api/mini/v1/students')) {
        respond(opts, { code: 0, message: 'ok', data: { items: [] } });
      }
    });
    await page.onShow();

    await page.onOpenOrders();
    expect(mock.wx.navigateTo).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/pages/orders/index' }),
    );
    await page.onOpenPackages();
    expect(mock.wx.navigateTo).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/pages/packages/index' }),
    );
    await page.onOpenHourTransactions();
    expect(mock.wx.navigateTo).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/pages/hour-transactions/index' }),
    );
  });

  it('renders the student-switcher and reloads balances when it changes', async () => {
    const { page } = await bootstrap((opts) => {
      const url = String(opts.url);
      if (url.endsWith('/api/mini/v1/students')) {
        respond(opts, {
          code: 0,
          message: 'ok',
          data: {
            items: STUDENTS.map((s) => ({
              student: { ...s, birthDate: null },
              relation: { id: `r-${s.id}`, relationType: 'SELF' },
            })),
          },
        });
      }
      if (
        url.includes('/api/mini/v1/students/') &&
        url.includes('/course-balances')
      ) {
        respond(opts, {
          code: 0,
          message: 'ok',
          data: { items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 },
        });
      }
    });
    await page.onShow();

    // The switcher's `change` event is wired to onStudentChange on the page.
    await page.onStudentChange({ detail: { id: 'student-b' } });
    expect(page.data.currentStudentId).toBe('student-b');
    // Balances were re-requested for the new student.
    const lastCall = mock.wx.request.mock.calls.at(-1)![0] as { url: string };
    expect(lastCall.url).toContain('/students/student-b/course-balances');
  });

  it('declares the student-switcher in its usingComponents', async () => {
    const json = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../../miniprogram/pages/my/index.json', import.meta.url),
        'utf8',
      ),
    );
    const cfg = JSON.parse(json) as { usingComponents: Record<string, string> };
    expect(cfg.usingComponents['student-switcher']).toContain(
      'components/student-switcher/index',
    );
  });

  it('does NOT expose payment, refund, booking, or activity actions', async () => {
    await import('../../miniprogram/pages/my/index');
    const wxml = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../../miniprogram/pages/my/index.wxml', import.meta.url),
        'utf8',
      ),
    );
    expect(wxml).not.toContain('支付');
    expect(wxml).not.toContain('退款');
    expect(wxml).not.toContain('预约');
    expect(wxml).not.toContain('活动');
  });
});
