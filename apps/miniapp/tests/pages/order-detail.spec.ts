import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installWxGlobals } from '../helpers/wx-mock';

// ────────────────────────────────────────────────────────────────────────────
// order-detail page: GET /mini/v1/orders/:id — the member's OWN order.
//
// Renders the order status, total (2-dp decimal string), confirmed time, and
// the frozen item snapshots (productNameSnapshot / unitPriceSnapshot /
// hoursSnapshot / validDaysSnapshot). Read-only — no payment/refund/booking.
// ────────────────────────────────────────────────────────────────────────────

const ORDER_DETAIL = {
  id: 'order-1',
  buyerAccountId: 'acc-1',
  status: 'CONFIRMED',
  totalAmount: '180.00',
  confirmedAt: '2026-07-15T08:30:00.000Z',
  items: [
    {
      id: 'item-1',
      orderId: 'order-1',
      studentId: 'student-1',
      productId: 'pkg-1',
      courseId: 'course-1',
      productNameSnapshot: 'Piano 10-pack',
      unitPriceSnapshot: '180.00',
      hoursSnapshot: '10.00',
      validDaysSnapshot: 180,
      coursePackageId: 'cp-1',
      grantTransactionId: 'tx-1',
    },
  ],
};

describe('order-detail page', () => {
  let mock: ReturnType<typeof installWxGlobals>;

  beforeEach(() => {
    vi.resetModules();
    mock = installWxGlobals();
    mock.storage['member-course:refresh-token'] = 'refresh-jwt';
  });

  it('loads the order and renders the frozen item snapshots as strings', async () => {
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (String(opts.url).endsWith('/api/mini/v1/orders/order-1')) {
        const res = {
          statusCode: 200,
          data: { code: 0, message: 'ok', data: ORDER_DETAIL },
          header: {},
          cookies: [],
        };
        if (typeof opts.success === 'function') opts.success(res);
      }
      return {};
    });

    await import('../../miniprogram/pages/order-detail/index');
    const page = mock.captured.page!;
    await page.onLoad({ id: 'order-1' });

    expect(page.data.order).toEqual(
      expect.objectContaining({
        id: 'order-1',
        status: 'CONFIRMED',
        totalAmount: '180.00',
      }),
    );
    const order = page.data.order as typeof ORDER_DETAIL;
    const item = order.items[0]!;
    expect(item.productNameSnapshot).toBe('Piano 10-pack');
    expect(item.unitPriceSnapshot).toBe('180.00');
    expect(item.hoursSnapshot).toBe('10.00');
    expect(typeof item.unitPriceSnapshot).toBe('string');
  });

  it('lands on a not-found empty state on 404', async () => {
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      if (String(opts.url).endsWith('/api/mini/v1/orders/missing')) {
        const res = {
          statusCode: 404,
          data: { code: 'NOT_FOUND', message: 'gone', traceId: 'trace-1' },
          header: {},
          cookies: [],
        };
        if (typeof opts.success === 'function') opts.success(res);
      }
      return {};
    });

    await import('../../miniprogram/pages/order-detail/index');
    const page = mock.captured.page!;
    await page.onLoad({ id: 'missing' });

    expect(page.data.notFound).toBe(true);
  });

  it('does NOT expose payment, refund, booking, or activity actions', async () => {
    await import('../../miniprogram/pages/order-detail/index');
    const wxml = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../../miniprogram/pages/order-detail/index.wxml', import.meta.url),
        'utf8',
      ),
    );
    expect(wxml).not.toContain('支付');
    expect(wxml).not.toContain('退款');
    expect(wxml).not.toContain('预约');
    expect(wxml).not.toContain('活动');
  });
});
