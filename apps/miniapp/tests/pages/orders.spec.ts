import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installWxGlobals } from '../helpers/wx-mock';

// ────────────────────────────────────────────────────────────────────────────
// orders page: paginated list of the member's OWN orders (GET /mini/v1/orders).
//
// Each row shows the order id, status, total (2-dp decimal string), confirmed
// time, and the frozen item snapshots (name/price/hours). No payment, refund,
// booking, or activity actions are exposed — M1 is read-only for members.
// ────────────────────────────────────────────────────────────────────────────

const ORDERS_PAYLOAD = {
  items: [
    {
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
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
  totalPages: 1,
};

describe('orders page', () => {
  let mock: ReturnType<typeof installWxGlobals>;

  beforeEach(() => {
    vi.resetModules();
    mock = installWxGlobals();
    mock.storage['member-course:refresh-token'] = 'refresh-jwt';
  });

  function stubOrders(body = ORDERS_PAYLOAD) {
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      const path = String(opts.url).split('?')[0];
      if (path.endsWith('/api/mini/v1/orders')) {
        const res = {
          statusCode: 200,
          data: { code: 0, message: 'ok', data: body },
          header: {},
          cookies: [],
        };
        if (typeof opts.success === 'function') opts.success(res);
      }
      return {};
    });
  }

  it('loads the member orders and keeps decimals as 2-dp strings', async () => {
    stubOrders();
    await import('../../miniprogram/pages/orders/index');
    const page = mock.captured.page!;
    await page.onLoad();

    expect(page.data.orders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'order-1',
          totalAmount: '180.00',
          status: 'CONFIRMED',
        }),
      ]),
    );
    const order = (page.data.orders as Array<Record<string, unknown>>)[0]!;
    // Decimals stay as strings — never coerced through JS number math.
    expect(typeof order.totalAmount).toBe('string');
    // Snapshot fields preserved.
    const item = (order.items as Array<Record<string, unknown>>)[0]!;
    expect(item.productNameSnapshot).toBe('Piano 10-pack');
    expect(item.unitPriceSnapshot).toBe('180.00');
    expect(item.hoursSnapshot).toBe('10.00');
  });

  it('navigates to order-detail with the order id when a row is tapped', async () => {
    await import('../../miniprogram/pages/orders/index');
    const page = mock.captured.page!;

    await page.onOpenOrder({ currentTarget: { dataset: { id: 'order-1' } } });

    expect(mock.wx.navigateTo).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/pages/order-detail/index?id=order-1' }),
    );
  });

  it('renders the real empty state when the member has no orders', async () => {
    stubOrders({ ...ORDERS_PAYLOAD, items: [], total: 0 });
    await import('../../miniprogram/pages/orders/index');
    const page = mock.captured.page!;
    await page.onLoad();

    expect(page.data.orders).toEqual([]);
    const wxml = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../../miniprogram/pages/orders/index.wxml', import.meta.url),
        'utf8',
      ),
    );
    expect(wxml).toContain('暂无订单');
  });

  it('does NOT expose payment, refund, booking, or activity actions', async () => {
    await import('../../miniprogram/pages/orders/index');
    const wxml = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../../miniprogram/pages/orders/index.wxml', import.meta.url),
        'utf8',
      ),
    );
    expect(wxml).not.toContain('支付');
    expect(wxml).not.toContain('退款');
    expect(wxml).not.toContain('预约');
    expect(wxml).not.toContain('活动');
  });

  it('paginates: requests the next page on loadMore and appends', async () => {
    let currentPage = 1;
    const page1 = {
      ...ORDERS_PAYLOAD,
      items: [{ ...ORDERS_PAYLOAD.items[0]!, id: 'order-1' }],
      page: 1,
      totalPages: 2,
    };
    const page2 = {
      ...ORDERS_PAYLOAD,
      items: [{ ...ORDERS_PAYLOAD.items[0]!, id: 'order-2' }],
      page: 2,
      totalPages: 2,
    };
    mock.wx.request.mockImplementation((opts: Record<string, unknown>) => {
      const path = String(opts.url).split('?')[0];
      if (path.endsWith('/api/mini/v1/orders')) {
        const res = {
          statusCode: 200,
          data: {
            code: 0,
            message: 'ok',
            data: currentPage === 1 ? page1 : page2,
          },
          header: {},
          cookies: [],
        };
        if (typeof opts.success === 'function') opts.success(res);
      }
      return {};
    });

    await import('../../miniprogram/pages/orders/index');
    const page = mock.captured.page!;
    await page.onLoad();
    expect((page.data.orders as Array<{ id: string }>).map((o) => o.id)).toEqual([
      'order-1',
    ]);

    currentPage = 2;
    // state (page=1, totalPages=2) persists in page.data between calls because
    // the default setData merges into data.
    await page.onLoadMore();
    expect((page.data.orders as Array<{ id: string }>).map((o) => o.id)).toEqual([
      'order-1',
      'order-2',
    ]);
  });
});
