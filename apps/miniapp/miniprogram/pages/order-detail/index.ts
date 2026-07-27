import { getOrder, type MiniOrderView } from '../../services/assets';
import { ApiError, isRedirectedError } from '../../services/http';

interface PageData {
  order: MiniOrderView | null;
  notFound: boolean;
  loading: boolean;
}

interface PageInstance extends PageData {
  data: PageData;
  setData(data: Partial<PageData>): void;
}

/**
 * Order detail (`GET /api/mini/v1/orders/:id`, member's own). Shows the
 * frozen item snapshots captured at order time (name/price/hours/validDays).
 * Read-only — no payment/refund/booking/activity actions in M1. A 404 lands
 * on a real "order not found" empty state.
 */
Page({
  data: {
    order: null,
    notFound: false,
    loading: false,
  },

  async onLoad(this: PageInstance, options: { id?: string } | undefined) {
    const id = options?.id;
    if (!id) {
      this.setData({ notFound: true });
      return;
    }
    this.setData({ loading: true });
    try {
      const order = await getOrder(id);
      this.setData({ order, notFound: false });
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 404) {
        this.setData({ notFound: true, order: null });
      } else if (!isRedirectedError(err)) {
        const message = err instanceof ApiError ? err.message : '加载订单失败';
        wx.showToast({ title: message, icon: 'none' });
      }
    } finally {
      this.setData({ loading: false });
    }
  },
});
