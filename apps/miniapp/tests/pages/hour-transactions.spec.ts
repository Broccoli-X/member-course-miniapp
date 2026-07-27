import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installWxGlobals } from '../helpers/wx-mock';

// ────────────────────────────────────────────────────────────────────────────
// hour-transactions page: GET /mini/v1/students/:studentId/hour-transactions.
//
// Private. Shows the append-only history: type, amount (delta), occurred time,
// and the manual reason when present. Newest first (server-sorted). The page
// clears cached data on STUDENT_FORBIDDEN and reloads on student switch.
// ────────────────────────────────────────────────────────────────────────────

interface TxnView {
  id: string;
  studentId: string;
  courseId: string;
  type: string;
  businessKey: string;
  originalTransactionId: string | null;
  availableDelta: string;
  reservedDelta: string;
  consumedDelta: string;
  expiredDelta: string;
  reason: string | null;
  occurredAt: string;
  allocations: unknown[];
}

const TXNS: TxnView[] = [
  {
    id: 'tx-2',
    studentId: 'student-1',
    courseId: 'course-1',
    type: 'MANUAL_DEBIT',
    businessKey: 'manual:2',
    originalTransactionId: null,
    availableDelta: '-1.00',
    reservedDelta: '0.00',
    consumedDelta: '1.00',
    expiredDelta: '0.00',
    reason: 'Makeup lesson for absence',
    occurredAt: '2026-07-20T10:00:00.000Z',
    allocations: [],
  },
  {
    id: 'tx-1',
    studentId: 'student-1',
    courseId: 'course-1',
    type: 'GRANT',
    businessKey: 'order:order-1',
    originalTransactionId: null,
    availableDelta: '10.00',
    reservedDelta: '0.00',
    consumedDelta: '0.00',
    expiredDelta: '0.00',
    reason: null,
    occurredAt: '2026-07-15T08:30:00.000Z',
    allocations: [],
  },
];

function stubTxns(
  mock: ReturnType<typeof installWxGlobals>,
  body: unknown,
): void {
  mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
    const url = String(opts.url);
    let res: { statusCode: number; data: unknown };
    if (url.split('?')[0]!.endsWith('/api/mini/v1/students')) {
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
    } else if (url.includes('/hour-transactions')) {
      res = { statusCode: 200, data: { code: 0, message: 'ok', data: body } };
    } else {
      return {};
    }
    if (typeof opts.success === 'function')
      opts.success({ ...res, header: {}, cookies: [] });
    return {};
  });
}

describe('hour-transactions page', () => {
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
    await import('../../miniprogram/pages/hour-transactions/index');
    const page = mock.captured.page!;
    return { page, currentStudentStore };
  }

  it('loads transactions and shows type, amount, occurred time, and manual reason', async () => {
    stubTxns(mock, {
      items: TXNS,
      total: TXNS.length,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });
    const { page } = await bootstrap();
    await page.onShow();

    const txns = page.data.transactions as TxnView[];
    expect(txns.length).toBe(2);
    // Newest first — server already sorted, page preserves order.
    expect(txns[0]!.id).toBe('tx-2');
    // Type + occurred time rendered.
    expect(txns[0]!.type).toBe('MANUAL_DEBIT');
    expect(txns[0]!.occurredAt).toBe('2026-07-20T10:00:00.000Z');
    // Delta amount kept as a 2-dp decimal string.
    expect(txns[0]!.availableDelta).toBe('-1.00');
    expect(typeof txns[0]!.availableDelta).toBe('string');
    // Manual reason surfaced.
    expect(txns[0]!.reason).toBe('Makeup lesson for absence');
    // GRANT row has no reason.
    expect(txns[1]!.reason).toBeNull();
  });

  it('reloads when the active student changes', async () => {
    stubTxns(mock, {
      items: TXNS,
      total: TXNS.length,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });
    const { page } = await bootstrap();
    await page.onShow();

    await page.onStudentChange({ detail: { id: 'student-2' } });
    const lastCall = mock.wx.request.mock.calls.at(-1)![0] as { url: string };
    expect(lastCall.url).toContain('/students/student-2/hour-transactions');
  });

  it('renders the real empty state when the student has no transactions', async () => {
    stubTxns(mock, { items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 });
    const { page } = await bootstrap();
    await page.onShow();

    expect(page.data.transactions).toEqual([]);
    const wxml = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL(
          '../../miniprogram/pages/hour-transactions/index.wxml',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    expect(wxml).toContain('暂无课时记录');
  });

  it('does NOT expose payment, refund, booking, or activity actions', async () => {
    await import('../../miniprogram/pages/hour-transactions/index');
    const wxml = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL(
          '../../miniprogram/pages/hour-transactions/index.wxml',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    // Note: "退款" (refund) is intentionally absent even though reversal rows
    // exist in the ledger — members see the type/delta, not a refund action.
    expect(wxml).not.toContain('支付');
    expect(wxml).not.toContain('退款');
    expect(wxml).not.toContain('预约');
    expect(wxml).not.toContain('活动');
  });

  it('clears cached transactions on STUDENT_FORBIDDEN', async () => {
    // First populate the cache.
    stubTxns(mock, {
      items: TXNS,
      total: TXNS.length,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });
    const { page } = await bootstrap();
    await page.onShow();
    expect((page.data.transactions as unknown[]).length).toBe(2);

    // Now a subsequent load (e.g. on student switch to an unrelated student)
    // returns 403 STUDENT_FORBIDDEN — cached data must be wiped.
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (
        String(opts.url).includes('/api/mini/v1/students/') &&
        String(opts.url).includes('/hour-transactions')
      ) {
        const res = {
          statusCode: 403,
          data: {
            code: 'STUDENT_FORBIDDEN',
            message: 'forbidden',
            traceId: 'trace-1',
          },
          header: {},
          cookies: [],
        };
        if (typeof opts.success === 'function') opts.success(res);
      }
      return {};
    });
    await page.loadStudent('student-2');

    expect(page.data.transactions).toEqual([]);
    expect(mock.wx.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ icon: 'none' }),
    );
  });
});
